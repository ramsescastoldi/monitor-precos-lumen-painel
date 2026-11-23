// Nota MT (Sefaz-MT) — API menor preço por NFC-e, todas as cidades de MT.
// Cobre o buraco da ANP (que só amostra 7 cidades de MT). Quase tempo real.
//
// AUTENTICAÇÃO: Keycloak password grant (realm mt-realm, client sistema-sefaz-notamt).
// Client secret vem exposto no bundle do próprio app. CPF+senha do Ramsés no cofre
// (~/.config/castoldi/chaves.env): NOTAMT_CPF, NOTAMT_SENHA. Token dura ~5min —
// renova sozinho. NUNCA commitar as chaves.
//
// FONTE: só descProduto (texto) na resposta, sem código ANP. Classificação = palavra
// no descProduto + faixa de preço (1–15). Dedupe por estabelecimento (NFC-e mais
// recente = preço vigente), agrega min/média/máx por cidade sobre os POSTOS.
//
// SAÍDA: municipios-notamt.json (MT only) — arquivo à parte. O site faz overlay sobre
// o municipios.json da ANP (Nota MT ganha nas cidades de MT). update.mjs não encosta aqui.
//
// RODA LOCAL (Mac): a ANP recusa IP de runner do GitHub e aqui precisa das credenciais
// dele. launchd diário + wrangler deploy do Mac.

import fs from 'node:fs';

const TOKEN_URL = 'https://login.mt.gov.br/auth/realms/mt-realm/protocol/openid-connect/token';
const API = 'https://www.sefaz.mt.gov.br/notamt/api/pesquisapreco/v1';
const CLIENT_ID = 'sistema-sefaz-notamt';
const CLIENT_SECRET = 'GKXMZyzfgof0lOjWxcFTCsU27S2AZOd9';
const IBGE_MT = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados/MT/municipios';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// termo de busca + guarda de classificação no descProduto (maiúsculo, sem acento)
const FUELS = {
  gc:   { termo: 'gasolina comum', ok: d => d.includes('GASOLINA') && !/ADITIV|PODIUM|GRID|V-?POWER|SUPREMA/.test(d) },
  etanol:{ termo: 'etanol',        ok: d => /ETANOL|ALCOOL/.test(d) && !d.includes('GEL') },
  s10:  { termo: 'diesel s10',     ok: d => d.includes('DIESEL') && /S-?10/.test(d) },
  s500: { termo: 'diesel s500',    ok: d => d.includes('DIESEL') && /S-?500/.test(d) },
};
const VALOR_MIN = 1, VALOR_MAX = 15;
const PAGINA_TAM = 50;
const PAUSA_MS = 1200;
const pausa = ms => new Promise(r => setTimeout(r, ms));
const up = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

async function getToken() {
  const cpf = process.env.NOTAMT_CPF, senha = process.env.NOTAMT_SENHA;
  if (!cpf || !senha) throw new Error('NOTAMT_CPF/NOTAMT_SENHA ausentes no cofre');
  const body = new URLSearchParams({
    grant_type: 'password', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    username: cpf, password: senha,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error('login falhou HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return (await r.json()).access_token;
}

async function buscar(token, codigoMunicipio, termo, pagina) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'User-Agent': UA },
    body: JSON.stringify({ pesquisa: termo, codigoMunicipio, quantidadeRegistros: PAGINA_TAM, pagina }),
  });
  if (r.status === 401) throw new Error('401');          // token expirou
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function cidadesMT() {
  const r = await fetch(IBGE_MT, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('IBGE HTTP ' + r.status);
  return (await r.json()).map(m => ({ id: m.id, nome: up(m.nome) }));
}

export async function coletarNotaMT(opts = {}) {
  const { log = console.log, deadlineMin = +(process.env.NOTAMT_DEADLINE_MIN || 40), limiteCidades = +(process.env.NOTAMT_LIMITE || 999) } = opts;
  const fim = Date.now() + deadlineMin * 60000;
  let token = await getToken();
  const cidades = (await cidadesMT()).slice(0, limiteCidades);
  log(`Nota MT: ${cidades.length} municípios, deadline ${deadlineMin}min`);

  const out = {};
  let req = 0, descartados = 0, cidadesOk = 0;

  for (const cid of cidades) {
    if (Date.now() > fim) { log('  deadline — parcial'); break; }
    const postos = {}; // chave estabelecimento -> { fuel: {v, t} } NFC-e mais recente
    for (const [fuel, cfg] of Object.entries(FUELS)) {
      for (let pg = 0; pg < 3; pg++) {             // ponytail: 3 páginas/fuel cobre a cidade; sobe se faltar
        if (Date.now() > fim) break;
        await pausa(PAUSA_MS);
        let json;
        try { json = await buscar(token, cid.id, cfg.termo, pg); }
        catch (e) {
          if (e.message === '401') { token = await getToken(); pg--; continue; }
          log(`  ${cid.nome} ${fuel} pg${pg}: ${e.message}`); break;
        }
        req++;
        const itens = Array.isArray(json) ? json : (json.resultado || json.conteudo || []);
        for (const it of itens) {
          const desc = up(it.descProduto);
          const valor = parseFloat(it.valorUnidadeComercial);
          const quando = Date.parse(it.dataEmissao) || 0;
          if (!cfg.ok(desc) || !(valor >= VALOR_MIN && valor <= VALOR_MAX)) { descartados++; continue; }
          const chave = up(it.nomeEmissor) + '|' + up(it.enderecoCompleto);
          postos[chave] ??= {};
          const atual = postos[chave][fuel];
          if (!atual || atual.t < quando) postos[chave][fuel] = { v: +valor.toFixed(2), t: quando };
        }
        if (itens.length < PAGINA_TAM) break;       // última página
      }
    }
    // agrega sobre os postos: min/média/máx por fuel
    const ag = {};
    for (const fuel of Object.keys(FUELS)) {
      const vs = Object.values(postos).map(p => p[fuel]?.v).filter(v => v != null).sort((a, b) => a - b);
      if (vs.length) ag[fuel] = {
        n: vs.length, min: vs[0], max: vs[vs.length - 1],
        media: +(vs.reduce((s, v) => s + v, 0) / vs.length).toFixed(3),
      };
    }
    if (Object.keys(ag).length) { out[cid.nome] = ag; cidadesOk++; }
  }

  log(`Nota MT: ${cidadesOk} cidades com preço · ${req} requisições · ${descartados} descartados`);
  return out;
}

async function telegram(texto) {
  const token = process.env.TELEGRAM_MAESTRO_BOT_TOKEN;
  const chat = process.env.TELEGRAM_MAESTRO_CHAT || process.env.TELEGRAM_RAMSES_CHAT;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto }),
  });
  if (!r.ok) throw new Error('Telegram HTTP ' + r.status);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // self-check: 1 cidade (Cuiabá IBGE 5103403), 1 fuel — valida token + endpoint + shape.
  // --vigia (launchd semanal com.ramses.notamt-vigia): avisa no Telegram se voltou a ter
  // dados ou se o login quebrou; silêncio enquanto seguir vazio.
  const VIGIA = process.argv.includes('--vigia');
  (async () => {
    const token = await getToken();
    console.log('token OK (' + token.length + ' chars)');
    const json = await buscar(token, 5103403, 'gasolina', 0);
    const itens = Array.isArray(json) ? json : (json.resultado || json.conteudo || []);
    console.log(new Date().toISOString(), 'Cuiabá gasolina: ' + itens.length + ' itens. Amostra:',
      JSON.stringify(itens[0] || json).slice(0, 300));
    if (VIGIA && itens.length) await telegram(`✅ Nota MT voltou a ter dados: busca de gasolina em Cuiabá trouxe ${itens.length} resultados (ex.: ${itens[0].descProduto} R$ ${itens[0].valorUnidadeComercial}). Dá pra ligar a varredura das 141 cidades de MT no monitor.`);
  })().catch(async e => {
    console.error('ERRO:', e.message);
    if (VIGIA) await telegram(`⚠️ Teste semanal do Nota MT falhou: ${e.message}. Se for login, confira a senha NOTAMT_SENHA no cofre ou o cadastro no site.`).catch(() => {});
    process.exit(1);
  });
}
