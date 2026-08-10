// Preço da Hora (BA) — preços por posto via NFC-e, estado inteiro, quase tempo real.
// Handshake: GET / entrega cookies de sessão + token CSRF no <meta id="validate">;
// POST /produtos/ com X-CSRFToken + cookies responde JSON (sem sessão retorna 401).
// O limitador do PRODEB trabalha por COTA (não só ritmo): rajadas tomam 429 por
// vários minutos. Por isso a varredura é lenta, com cooldown e deadline, e devolve
// o que conseguiu coletar — o export usa o parcial e a ANP cobre o resto.
// Usado pelo export-radar.mjs pra enriquecer a camada "pesquisa oficial" da BA.

const BASE = 'https://precodahora.ba.gov.br';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CATEGORIA_COMBUSTIVEIS = '11';
const TERMOS = ['gasolina', 'etanol', 'diesel', 'diesel s10'];
const MAX_PAGINAS = 4;
const COOLDOWN_429_MS = 5 * 60000;

const pausa = ms => new Promise(r => setTimeout(r, ms));
const digitos = s => String(s || '').replace(/\D/g, '');

function combDoRegistro(produto) {
  const anp = String(produto.anp || '').toUpperCase();
  const desc = String(produto.descricao || '').toUpperCase();
  if (anp === 'GASOLINA ADITIVADA') return 'ga';
  if (anp === 'GASOLINA') return /ADITIVADA/.test(desc) ? 'ga' : 'gc';
  if (anp === 'ETANOL') return 'et';
  if (anp === 'DIESEL S10') return 'd10';
  if (anp === 'DIESEL') return /S\s*-?\s*10/.test(desc) ? 'd10' : 'd500';
  if (anp === 'GNV') return null;   // radar não exibe GNV por posto hoje
  return null;
}

async function abrirSessao() {
  const r = await fetch(BASE + '/', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('handshake HTTP ' + r.status);
  const html = await r.text();
  const token = html.match(/id="validate"\s+data-id="([^"]+)"/)?.[1];
  if (!token) throw new Error('token CSRF não encontrado na home');
  const cookies = (r.headers.getSetCookie?.() || [])
    .map(c => c.split(';')[0]).join('; ');
  if (!cookies) throw new Error('sessão sem cookies');
  return { token, cookies };
}

async function consultar(sessao, { lat, lng, pagina, termo = '', categorias = '' }) {
  const body = new URLSearchParams({
    termo, categorias, horas: '72', latitude: String(lat), longitude: String(lng),
    raio: '15', precomax: '0', precomin: '0', pagina: String(pagina),
    ordenar: 'preco.asc', item: '', gtin: ''
  });
  const r = await fetch(BASE + '/produtos/', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Cookie': sessao.cookies,
      'X-CSRFToken': sessao.token, 'X-Requested-With': 'XMLHttpRequest',
      'Referer': BASE + '/',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  if (r.status === 401 || r.status === 403) return { expirou: true };
  if (r.status === 429) return { limitado: true };
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const texto = await r.text();
  try { return JSON.parse(texto); } catch { return { expirou: true }; }
}

// cidades: [{ mu, m, lat, lng }] — ordenar as mais importantes primeiro: se o
// deadline chegar, o parcial cobre os mercados maiores.
// titulo/slug: mesmos helpers do export-radar.
// Retorna Map<cnpjDigitos, { n, b, mu, m, e, p:{comb:{v,d}}, lat, lng }>
export async function coletarPrecoDaHora(cidades, opts) {
  const { titulo, slug, log = console.log } = opts;
  const pausaMs = +(opts.pausaMs || process.env.PDH_PAUSA_MS || 6000);
  const deadlineMin = +(opts.deadlineMin || process.env.PDH_DEADLINE_MIN || 35);
  const fim = Date.now() + deadlineMin * 60000;

  let sessao = await abrirSessao();
  const postos = new Map();
  let requisicoes = 0, errosRede = 0, cidadesOk = 0;
  let modo = 'categoria';           // 1 consulta/cidade; cai pra termos se não render

  // pede uma página respeitando cota (429→cooldown) e sessão (expirou→refaz)
  async function pedir(params) {
    for (let tent = 1; tent <= 3; tent++) {
      if (Date.now() > fim) return null;
      await pausa(pausaMs);
      const json = await consultar(sessao, params);
      if (json.limitado) {
        log(`  PDH: 429 — cooldown de ${COOLDOWN_429_MS / 60000} min`);
        await pausa(COOLDOWN_429_MS);
        continue;
      }
      if (json.expirou) { sessao = await abrirSessao(); continue; }
      return json;
    }
    return null;                    // cota não aliviou — quem chamou decide seguir
  }

  function absorver(json) {
    let combustiveis = 0;
    for (const reg of json.resultado || []) {
      const comb = combDoRegistro(reg.produto || {});
      const est = reg.estabelecimento || {};
      const cnpj = digitos(est.cnpj);
      const preco = +reg.produto?.precoUnitario;
      const quando = String(reg.produto?.data || '');
      const data = quando.slice(0, 10);
      if (!comb || !cnpj || !data || isNaN(preco) || preco < 0.5 || preco > 30) continue;
      combustiveis++;

      const posto = postos.get(cnpj) || {
        n: titulo(est.nomeEstabelecimento),
        b: '',
        mu: titulo(est.municipio),
        m: slug(est.municipio),
        e: titulo([est.endLogradouro, est.endNumero].filter(Boolean).join(', ') +
                  (est.bairro ? ' - ' + est.bairro : '')),
        p: {},
        lat: est.latitude ?? null,
        lng: est.longitude ?? null
      };
      const atual = posto.p[comb];
      // NFC-e mais recente do posto = preço de bomba vigente
      if (!atual || atual._t < quando) {
        posto.p[comb] = { v: +preco.toFixed(2), d: data, _t: quando };
      }
      postos.set(cnpj, posto);
    }
    return combustiveis;
  }

  async function varrer(cidade, params) {
    let totalPaginas = 1, achou = 0, respostas = 0;
    for (let pagina = 1; pagina <= Math.min(totalPaginas, MAX_PAGINAS); pagina++) {
      let json;
      try { json = await pedir({ ...cidade, ...params, pagina }); }
      catch (e) {
        errosRede++;
        log(`  PDH ${cidade.mu} p${pagina}: ${e.message}`);
        if (errosRede > 8) throw new Error('rede instável — encerrando varredura');
        break;
      }
      if (!json) break;             // deadline ou cota persistente
      requisicoes++; respostas++;
      totalPaginas = json.totalPaginas || 1;
      achou += absorver(json);
    }
    return { achou, respostas };
  }

  for (const cidade of cidades) {
    if (Date.now() > fim) { log('  PDH: deadline — devolvendo parcial'); break; }
    let achou = 0;
    if (modo === 'categoria') {
      const r = await varrer(cidade, { categorias: CATEGORIA_COMBUSTIVEIS });
      achou = r.achou;
      // só desiste da categoria se o servidor RESPONDEU e veio sem combustível
      // (429/deadline não contam — senão uma cota fechada dobra o custo à toa)
      if (!achou && r.respostas > 0 && cidadesOk === 0) {
        log('  PDH: busca por categoria não rendeu — mudando pra termos');
        modo = 'termos';
      }
    }
    if (modo === 'termos') {
      for (const termo of TERMOS) {
        if (Date.now() > fim) break;
        achou += (await varrer(cidade, { termo })).achou;
      }
    }
    if (achou) cidadesOk++;
  }

  for (const posto of postos.values())
    for (const f of Object.values(posto.p)) delete f._t;
  log(`  PDH BA: ${postos.size} postos · ${cidadesOk}/${cidades.length} cidades · ` +
      `${requisicoes} requisições (modo ${modo})`);
  return postos;
}
