// Pump prices per city from state NFC-e price tools (open, no login):
//   PR — Menor Preço / Nota Paraná  (menorpreco.notaparana.pr.gov.br/api/v1/produtos)
//   BA — Preço da Hora Bahia        (precodahora.ba.gov.br/produtos/, cookie + csrf)
// Both return the ANP product code, so fuel is classified by code (not by text alone).
//
// Sweep: one radius query per municipality centre (kelvins/municipios-brasileiros
// coordinates), but each price is filed under the STATION's own municipality, and
// stations are de-duplicated across overlapping radii. Latest NFC-e per station and
// fuel within HORAS = current price; aggregate min / mean / max / n over stations.
//
// Output: municipios-nfce.json. The site overlays it on the ANP municipios.json
// (NFC-e wins where present). A failed source keeps its previous data.
// Runs on the Mac (launchd com.ramses.monitor-nfce via rodar-nfce.sh).
//   node scrape-nfce.mjs          → full sweep, writes the file
//   node scrape-nfce.mjs --teste  → Curitiba + Salvador only, prints, writes nothing

import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HORAS = 72;
const RAIO_KM = 10;
const VALOR_MIN = 2, VALOR_MAX = 12;
const TERMOS = ['gasolina comum', 'etanol', 'diesel'];
const SAIDA = new URL('municipios-nfce.json', import.meta.url);
const TESTE = process.argv.includes('--teste');
const corte = Date.now() - HORAS * 3600e3;
const up = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// ANP code + description → fuel key (description decides S10 × S500: stations mislabel codes)
export function fuelDe(cod, desc) {
  cod = String(cod || ''); const d = up(desc);
  if (cod === '320102001') return 'gasolina';
  if (cod === '810101001') return 'etanol';
  if (!cod.startsWith('8201010')) return null;
  if (/S\s?-?\s?500/.test(d)) return 's500';
  if (/S\s?-?\s?10(?!\d)/.test(d)) return 's10';
  if (cod === '820101033' || cod === '820101034') return 's10';
  if (cod === '820101011' || cod === '820101012') return 's500';
  return null;
}

function geohash(lat, lon, len = 9) {
  const B = '0123456789bcdefghjkmnpqrstuvwxyz';
  let la = [-90, 90], lo = [-180, 180], h = '', bit = 0, ch = 0, par = true;
  while (h.length < len) {
    const r = par ? lo : la, v = par ? lon : lat, m = (r[0] + r[1]) / 2;
    if (v >= m) { ch = (ch << 1) | 1; r[0] = m; } else { ch <<= 1; r[1] = m; }
    par = !par;
    if (++bit === 5) { h += B[ch]; bit = 0; ch = 0; }
  }
  return h;
}

async function tentar(fn, n = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= n || /429/.test(e.message)) throw e; await pausa(3000 * i); } // 429 = BA rate limit: give up, retrying only extends the block
  }
}

// ---------- PR ----------
async function buscarPR(c, termo) {
  const out = [];
  for (let off = 0; off < 400; off += 50) {           // ponytail: 8 pages cap; newest first, stops at the HORAS cut
    const url = `https://menorpreco.notaparana.pr.gov.br/api/v1/produtos?local=${geohash(c.lat, c.lon)}` +
      `&termo=${encodeURIComponent(termo)}&offset=${off}&raio=${RAIO_KM}&data=-1&ordem=2`;
    const j = await tentar(async () => {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('PR HTTP ' + r.status);
      return r.json();
    });
    const p = j.produtos || [];
    for (const x of p) out.push({
      posto: 'PR:' + x.estabelecimento?.codigo, mun: up(x.estabelecimento?.mun), uf: x.estabelecimento?.uf, cod: x.cdanp, desc: x.desc,
      valor: +x.valor_tabela || +x.valor, quando: Date.parse(x.datahora),
    });
    if (p.length < 20 || Date.parse(p.at(-1).datahora) < corte) break;
  }
  return out;
}

// ---------- BA ----------
let BA = null; // { cookie, csrf }
async function sessaoBA() {
  const r = await fetch('https://precodahora.ba.gov.br/produtos/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  const html = await r.text();
  const csrf = html.match(/name="csrf_token" type="hidden" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('BA sem csrf');
  BA = { csrf, cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}
async function buscarBA(c, termo) {
  const out = [];
  for (let pg = 1; pg <= 8; pg++) {                    // ponytail: 8 pages × 25 cap per city/term
    const j = await tentar(async () => {
      if (!BA) await sessaoBA();
      const body = new URLSearchParams({ termo, horas: HORAS, latitude: c.lat, longitude: c.lon, raio: RAIO_KM, pagina: pg,
        ordenar: 'preco.asc', categorias: '', processo: 'carregar', totalCategorias: '', totalRegistros: 0, totalPaginas: 0, pageview: 'lista' });
      const r = await fetch('https://precodahora.ba.gov.br/produtos/', { method: 'POST', body, signal: AbortSignal.timeout(30000), headers: {
        'User-Agent': UA, Cookie: BA.cookie, 'X-CSRFToken': BA.csrf, 'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://precodahora.ba.gov.br/produtos/', 'Content-Type': 'application/x-www-form-urlencoded' } });
      const t = await r.text();
      try { const j = JSON.parse(t); if (j.resultado || j.codigo === 80) return j; } catch {}
      BA = null; throw new Error('BA HTTP ' + r.status + ' ' + t.slice(0, 80)); // session expired → new one on retry
    });
    const res = j.resultado || [];
    for (const x of res) {
      const e = x.estabelecimento || {};
      out.push({ posto: 'BA:' + (e.cnpj || e.nomeEstabelecimento + '|' + e.endLogradouro + e.endNumero), mun: up(e.municipio),
        cod: x.produto?.codProduto, desc: x.produto?.descricao, valor: +x.produto?.precoUnitario, quando: Date.parse(x.produto?.data) });
    }
    if (pg >= (j.totalPaginas || 1)) break;
  }
  return out;
}

const FONTES = {
  // PR serves FAKE data (invented cities, uf PE, random prices) once it flags bulk access — polite pace, big cities only
  PR: { uf: 41, conc: 1, pausa: 5000, buscar: buscarPR, so: ['CURITIBA', 'LONDRINA', 'MARINGA', 'PONTA GROSSA', 'CASCAVEL',
    'SAO JOSE DOS PINHAIS', 'FOZ DO IGUACU', 'COLOMBO', 'GUARAPUAVA', 'PARANAGUA', 'ARAUCARIA', 'TOLEDO', 'APUCARANA',
    'CAMPO LARGO', 'PINHAIS', 'ARAPONGAS', 'ALMIRANTE TAMANDARE', 'PIRAQUARA', 'UMUARAMA', 'CAMBE', 'FAZENDA RIO GRANDE',
    'SARANDI', 'CAMPO MOURAO', 'FRANCISCO BELTRAO', 'PARANAVAI', 'PATO BRANCO', 'CIANORTE', 'TELEMACO BORBA', 'CASTRO',
    'ROLANDIA'], nome: 'Menor Preço — Nota Paraná (Sefaz-PR)' },
  // ponytail: BA rate-limits hard (429 after a handful of calls) — only the biggest cities, slow; widen if the limit allows
  BA: { uf: 29, conc: 1, pausa: 10000, buscar: buscarBA, so: ['SALVADOR', 'FEIRA DE SANTANA', 'VITORIA DA CONQUISTA', 'CAMACARI',
    'JUAZEIRO', 'LAURO DE FREITAS', 'ITABUNA', 'ILHEUS', 'JEQUIE', 'TEIXEIRA DE FREITAS', 'BARREIRAS', 'ALAGOINHAS',
    'PORTO SEGURO', 'PAULO AFONSO', 'LUIS EDUARDO MAGALHAES', 'SANTO ANTONIO DE JESUS', 'GUANAMBI'], nome: 'Preço da Hora Bahia (Sefaz-BA)' },
};

let BRASIL = null; // every municipality: { nome, lat, lon, uf }
async function cidades(codUf) {
  if (!BRASIL) {
    const r = await fetch('https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv');
    if (!r.ok) throw new Error('coordenadas HTTP ' + r.status);
    BRASIL = (await r.text()).split('\n').slice(1).map((l) => l.split(',')).filter((c) => c[5])
      .map((c) => ({ nome: up(c[1]), lat: +c[2], lon: +c[3], uf: +c[5] }));
  }
  return BRASIL.filter((c) => c.uf === codUf);
}

function agrega(itens) {
  const postos = {}; // posto → { mun, fuel: {v, t} }
  const descartados = { produto: 0, valor: 0, velho: 0, sem_mun: 0 };
  for (const x of itens) {
    const f = fuelDe(x.cod, x.desc);
    const motivo = !f ? 'produto' : !(x.valor >= VALOR_MIN && x.valor <= VALOR_MAX) ? 'valor' : !(x.quando >= corte) ? 'velho' : !x.mun ? 'sem_mun' : null;
    if (motivo) { descartados[motivo]++; continue; }
    const p = (postos[x.posto] ??= { mun: x.mun });
    if (!p[f] || p[f].t < x.quando) p[f] = { v: x.valor, t: x.quando };
  }
  const stats = (vs) => { vs.sort((a, b) => a - b); return { n: vs.length, min: +vs[0].toFixed(2), max: +vs.at(-1).toFixed(2), media: +(vs.reduce((s, v) => s + v, 0) / vs.length).toFixed(3) }; };
  const porMun = {}, estado = {};
  for (const p of Object.values(postos)) for (const f of ['gasolina', 'etanol', 's10', 's500']) if (p[f]) {
    ((porMun[p.mun] ??= {})[f] ??= []).push(p[f].v);
    (estado[f] ??= []).push(p[f].v);
  }
  for (const m of Object.values(porMun)) for (const f in m) m[f] = stats(m[f]);
  for (const f in estado) estado[f] = stats(estado[f]);
  return { municipios: porMun, estado, postos: Object.keys(postos).length, descartados };
}

async function coletar(sigla) {
  const { uf, buscar, conc, pausa: espera, so } = FONTES[sigla]; // PR: 2 parallel + 1 s pause
  let lista = await cidades(uf);
  if (so) lista = lista.filter((c) => so.includes(c.nome));
  if (TESTE) lista = lista.filter((c) => c.nome === (sigla === 'PR' ? 'CURITIBA' : 'SALVADOR'));
  const tarefas = lista.flatMap((c) => TERMOS.map((t) => [c, t]));
  const existe = new Set(BRASIL.map((c) => c.nome));
  const itens = []; let falhas = 0, i = 0, falso = null;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < tarefas.length) {
      const [c, t] = tarefas[i++];
      try {
        const r = await buscar(c, t);
        falso ??= r.find((x) => x.mun && !existe.has(x.mun)); // invented city = anti-bot poison: whole run untrusted
        if (falso) { i = tarefas.length; break; }
        itens.push(...r.filter((x) => !x.uf || x.uf === sigla)); // neighbour-state stations near the border
      } catch (e) {
        if (++falhas <= 3) console.error(`  ${sigla} ${c.nome} "${t}": ${e.message}`);
        if (/429/.test(e.message)) { falhas += tarefas.length - i; i = tarefas.length; } // blocked for the day: stop this source
      }
      await pausa(espera);
    }
  }));
  if (falso) throw new Error(`${sigla}: fonte devolveu dado falso (anti-robô: cidade "${falso.mun}"/${falso.uf || '?'})`);
  if (falhas > Math.max(1, tarefas.length * 0.3)) throw new Error(`${sigla}: ${falhas}/${tarefas.length} consultas falharam`);
  const ag = agrega(itens);
  console.log(`${sigla}: ${lista.length} centros · ${tarefas.length} consultas (${falhas} falhas) · ${ag.postos} postos · ${Object.keys(ag.municipios).length} cidades com preço · descartados ${JSON.stringify(ag.descartados)}`);
  return ag;
}

const anterior = fs.existsSync(SAIDA) ? JSON.parse(fs.readFileSync(SAIDA, 'utf8')) : { municipios: {}, estados: {}, fontes: {} };
const out = { gerado_em: new Date().toISOString(), horas: HORAS, fontes: {}, estados: {}, municipios: {} };
for (const sigla of Object.keys(FONTES)) {
  try {
    const ag = await coletar(sigla);
    if (TESTE) { console.log(JSON.stringify(ag.estado), JSON.stringify(Object.entries(ag.municipios).slice(0, 3))); continue; }
    out.fontes[sigla] = { nome: FONTES[sigla].nome, coletado_em: out.gerado_em, postos: ag.postos };
    out.estados[sigla] = ag.estado;
    out.municipios[sigla] = ag.municipios;
  } catch (e) {
    console.error(`${sigla} FALHOU: ${e.message} — mantém a coleta anterior`);
    if (anterior.municipios[sigla]) {
      out.fontes[sigla] = anterior.fontes[sigla]; out.estados[sigla] = anterior.estados[sigla]; out.municipios[sigla] = anterior.municipios[sigla];
    }
  }
}
if (!TESTE) fs.writeFileSync(SAIDA, JSON.stringify(out));
