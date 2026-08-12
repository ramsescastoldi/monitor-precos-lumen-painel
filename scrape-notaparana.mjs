// Nota Paraná (PR) — API pública menorpreco.notaparana.pr.gov.br, NFC-e por posto,
// quase tempo real. Sem CNPJ na resposta: merge por endereço, igual ao Busca Preço AM.
//
// Headers obrigatórios (User-Agent de navegador + Referer + Accept) — sem eles a API
// devolve registro ENVENENADO (mun/uf trocados, valor absurdo). Confirmado em 12/08/2026:
// mesmo COM os headers certos uma fração das respostas ainda vem misturada com lixo —
// por isso as guardas abaixo (uf/valor/data/município) são obrigatórias, não paranoia.
//
// Rate limit por cota, não por IP: 2 pedidos rápidos passam, o 3º trava — pausa ≥4s
// entre pedidos e 1 retry após 30s em falha de rede.

import { chaveANP } from './scrape-buscapreco-am.mjs';

const BASE = 'https://menorpreco.notaparana.pr.gov.br/api/v1/produtos';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// termos aceitos pela busca (fuelTermMP do cliente, index.html) — sem diesel comum:
// a API mistura demais com S10 nesse termo e o radar não prioriza d500 aqui
const TERMOS = { gc: 'gasolina comum', ga: 'gasolina aditivada', et: 'etanol', d10: 'diesel s10' };
const RAIO_KM = 20;
const PAUSA_MS_PADRAO = 4000;
const DIAS_MAX = 10;
const VALOR_MIN = 1, VALOR_MAX = 15;

const pausa = ms => new Promise(r => setTimeout(r, ms));

// geohash base32 → {lat,lng} (mesmo algoritmo do cliente em index.html)
function geohashDecode(g) {
  const B = '0123456789bcdefghjkmnpqrstuvwxyz';
  let even = true, lat = [-90, 90], lon = [-180, 180];
  for (const ch of String(g || '')) {
    const cd = B.indexOf(ch);
    if (cd < 0) continue;
    for (let m = 16; m >= 1; m >>= 1) {
      const bit = cd & m;
      if (even) { const mid = (lon[0] + lon[1]) / 2; if (bit) lon[0] = mid; else lon[1] = mid; }
      else { const mid = (lat[0] + lat[1]) / 2; if (bit) lat[0] = mid; else lat[1] = mid; }
      even = !even;
    }
  }
  return { lat: (lat[0] + lat[1]) / 2, lng: (lon[0] + lon[1]) / 2 };
}

// "local" vem como geohash OU "lat,lng" cru, dependendo da resposta
function localParaCoord(local) {
  const s = String(local || '');
  if (s.includes(',')) {
    const [lat, lng] = s.split(',').map(Number);
    return (isNaN(lat) || isNaN(lng)) ? { lat: null, lng: null } : { lat, lng };
  }
  return geohashDecode(s);
}

async function consultar({ lat, lng, termo }) {
  const url = `${BASE}?local=${lat},${lng}&termo=${encodeURIComponent(termo)}&raio=${RAIO_KM}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://menorpreco.notaparana.pr.gov.br/',
      Accept: 'application/json'
    }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// 1 retry após 30s de cooldown — cota do servidor, não erro passageiro
async function consultarComRetry(params) {
  try { return await consultar(params); }
  catch { await pausa(30000); return consultar(params); }
}

// cidades: [{ mu, m, lat, lng }] — titulo/slug: mesmos helpers do export-radar.
// Retorna Map<chaveEndereco, { n, b, mu, m, e, p:{comb:{v,d}}, lat, lng }>
export async function coletarNotaParana(cidades, opts) {
  const { titulo, slug, log = console.log } = opts;
  const pausaMs = +(opts.pausaMs || process.env.NP_PAUSA_MS || PAUSA_MS_PADRAO);
  const deadlineMin = +(opts.deadlineMin || process.env.NP_DEADLINE_MIN || 25);
  const fim = Date.now() + deadlineMin * 60000;
  const corteData = Date.now() - DIAS_MAX * 86400000;

  const postos = new Map();
  let requisicoes = 0, erros = 0, cidadesOk = 0, descartados = 0;

  for (const cidade of cidades) {
    if (Date.now() > fim) { log('  NP: deadline — devolvendo parcial'); break; }
    let achouCidade = 0;
    for (const [comb, termo] of Object.entries(TERMOS)) {
      if (Date.now() > fim) break;
      await pausa(pausaMs);
      let json;
      try { json = await consultarComRetry({ lat: cidade.lat, lng: cidade.lng, termo }); }
      catch (e) {
        erros++;
        log(`  NP ${cidade.mu} ${comb}: ${e.message}`);
        if (erros > 10) throw new Error('API instável — encerrando varredura');
        continue;
      }
      requisicoes++;

      for (const p of json.produtos || []) {
        const est = p.estabelecimento || {};
        const valor = parseFloat(p.valor);
        const quando = Date.parse(p.datahora);
        // guardas anti-envenenamento: UF, faixa de preço, frescor, município
        const ok = est.uf === 'PR' && slug(est.mun) === cidade.m &&
          valor >= VALOR_MIN && valor <= VALOR_MAX && !isNaN(quando) && quando >= corteData;
        if (!ok) { descartados++; continue; }

        const rua = `${est.tp_logr || ''} ${est.nm_logr || ''}`.trim();
        const chave = chaveANP(rua, est.nr_logr, est.mun);
        const coord = localParaCoord(p.local);
        const posto = postos.get(chave) || {
          n: titulo(est.nm_fan || est.nm_emp), b: '',
          mu: titulo(cidade.mu), m: cidade.m,
          e: titulo([rua, est.nr_logr].filter(Boolean).join(', ') +
                    (est.bairro ? ' - ' + est.bairro : '')),
          p: {}, lat: coord.lat, lng: coord.lng
        };
        const atual = posto.p[comb];
        // NFC-e mais recente do posto = preço de bomba vigente
        if (!atual || atual._t < quando)
          posto.p[comb] = { v: +valor.toFixed(2), d: new Date(quando).toISOString().slice(0, 10), _t: quando };
        postos.set(chave, posto);
        achouCidade++;
      }
    }
    if (achouCidade) cidadesOk++;
  }

  for (const posto of postos.values())
    for (const f of Object.values(posto.p)) delete f._t;
  log(`  Nota Paraná: ${postos.size} postos · ${cidadesOk}/${cidades.length} cidades · ` +
      `${requisicoes} requisições · ${descartados} descartados (guarda anti-envenenamento)`);
  return postos;
}

// self-check: só Curitiba, imprime contagem
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = s => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const titulo = s => String(s || '').toLowerCase().replace(/(^|\s|\.)([a-zà-ú])/g, m => m.toUpperCase())
    .replace(/\b(De|Da|Do|Dos|Das|E)\b/g, m => m.toLowerCase());
  const cidades = [{ mu: 'Curitiba', m: 'curitiba', lat: -25.4284, lng: -49.2733 }];
  coletarNotaParana(cidades, { titulo, slug })
    .then(postos => console.log(`\nSelf-check Curitiba: ${postos.size} postos válidos`))
    .catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
