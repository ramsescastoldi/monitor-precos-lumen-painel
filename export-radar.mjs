// Exportador Radar de Preços — baixa os CSVs semanais oficiais da ANP (por posto,
// Brasil inteiro, 27 UFs), fica com a coleta mais recente de cada posto/produto e
// envia 1 pacote por UF pro KV do radar (lumen-radar.pages.dev/api/anp-sync).
// Roda via GitHub Actions seg+qui e sob demanda local. Não usa Supabase.

import { parse } from 'csv-parse/sync';
import https from 'node:https';

const URLS = [
  'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-gasolina-etanol.csv',
  'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-diesel-gnv.csv'
];
const SYNC_URL = 'https://lumen-radar.pages.dev/api/anp-sync';
const SYNC_KEY = 'radar_anp_sync_2026_Jx7cV3t';
const PRODUTO_COMB = {
  'GASOLINA': 'gc', 'GASOLINA ADITIVADA': 'ga', 'ETANOL': 'et',
  'DIESEL S10': 'd10', 'DIESEL': 'd500'
};

// https.get pelado, idêntico ao scraper-anp que roda no GitHub sem falhar
// (gov.br derruba conexão de datacenter quando mandamos User-Agent de navegador)
function baixarUma(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return baixarUma(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// gov.br/ANP oscila e às vezes reseta conexão de datacenter — tenta até 4x
async function baixar(url) {
  let ultimoErro;
  for (let tent = 1; tent <= 4; tent++) {
    try {
      return await baixarUma(url);
    } catch (e) {
      ultimoErro = e;
      console.log(`  download falhou (tentativa ${tent}/4): ${e.message || e.code || 'erro de rede'} — reintentando…`);
      await new Promise(r => setTimeout(r, tent * 5000));
    }
  }
  throw new Error('download falhou após 4 tentativas: ' + (ultimoErro?.message || ultimoErro?.code || ''));
}

const slug = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function titulo(s) {
  return String(s || '').toLowerCase().replace(/(^|\s|\.)([a-zà-ú])/g, m => m.toUpperCase())
    .replace(/\b(De|Da|Do|Dos|Das|E)\b/g, m => m.toLowerCase());
}
function parsePrecoBR(s) {
  const n = parseFloat(String(s || '').replace(',', '.').trim());
  return (isNaN(n) || n < 0.5 || n > 30) ? null : +n.toFixed(2);
}
function parseDateBR(s) {
  const m = String(s || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

(async () => {
  console.log('Export Radar — início', new Date().toISOString());
  // porUF[uf][cnpj] = { n, b, mu, m, e, p:{comb:{v,d}} }
  const porUF = {};
  let linhas = 0;

  for (const url of URLS) {
    const nomeArq = url.split('/').pop();
    console.log(`[${nomeArq}] baixando…`);
    const csv = await baixar(url);
    const recs = parse(csv, { delimiter: ';', columns: true, skip_empty_lines: true,
      bom: true, relax_quotes: true, relax_column_count: true, trim: true });
    console.log(`[${nomeArq}] ${recs.length} linhas`);
    linhas += recs.length;

    for (const r of recs) {
      const comb = PRODUTO_COMB[r['Produto']];
      if (!comb) continue;
      const uf = r['Estado - Sigla'];
      const preco = parsePrecoBR(r['Valor de Venda']);
      const data = parseDateBR(r['Data da Coleta']);
      const cnpj = String(r['CNPJ da Revenda'] || '').trim();
      if (!uf || !preco || !data || !cnpj) continue;

      porUF[uf] = porUF[uf] || {};
      const posto = porUF[uf][cnpj] = porUF[uf][cnpj] || {
        n: titulo(r['Revenda']),
        b: titulo(r['Bandeira']),
        mu: titulo(r['Municipio']),
        m: slug(r['Municipio']),
        e: titulo([r['Nome da Rua'], r['Numero Rua']].filter(Boolean).join(', ') +
                  (r['Bairro'] ? ' - ' + r['Bairro'] : '')),
        p: {}
      };
      // fica só com a coleta mais recente por produto
      if (!posto.p[comb] || posto.p[comb].d < data) posto.p[comb] = { v: preco, d: data };
    }
  }

  // coordenadas dos municípios (dataset público kelvins/municipios-brasileiros)
  const UF_COD = {11:'RO',12:'AC',13:'AM',14:'RR',15:'PA',16:'AP',17:'TO',21:'MA',22:'PI',23:'CE',
    24:'RN',25:'PB',26:'PE',27:'AL',28:'SE',29:'BA',31:'MG',32:'ES',33:'RJ',35:'SP',41:'PR',
    42:'SC',43:'RS',50:'MS',51:'MT',52:'GO',53:'DF'};
  const coordsCsv = await baixar('https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv');
  const coords = {};
  for (const linha of coordsCsv.split('\n').slice(1)) {
    const c = linha.split(',');
    if (c.length < 6) continue;
    const uf = UF_COD[+c[5]];
    if (uf) coords[uf + ':' + slug(c[1])] = { lat: +c[2], lng: +c[3], nome: c[1] };
  }

  // BA quase tempo real (Preço da Hora / NFC-e por posto) — atualiza preço e
  // amplia a pesquisa da UF com postos que a ANP não visitou na semana
  try {
    if (process.env.SKIP_PDH) throw new Error('SKIP_PDH ligado (rodada só-ANP)');
    const { coletarPrecoDaHora } = await import('./scrape-precodahora.mjs');
    const porSlugBA = {};
    for (const p of Object.values(porUF.BA || {}))
      porSlugBA[p.m] = (porSlugBA[p.m] || 0) + 1;
    // mercados maiores primeiro: se a cota do PRODEB cortar, o parcial vale mais
    const cidadesBA = Object.keys(porSlugBA)
      .sort((a, b) => porSlugBA[b] - porSlugBA[a])
      .map(m => coords['BA:' + m] &&
        { mu: coords['BA:' + m].nome, m, lat: coords['BA:' + m].lat, lng: coords['BA:' + m].lng })
      .filter(Boolean);
    if (cidadesBA.length) {
      console.log(`\n[Preço da Hora BA] varrendo ${cidadesBA.length} cidades…`);
      const vivos = await coletarPrecoDaHora(cidadesBA, { titulo, slug });
      const porDigito = {};
      for (const [cnpj, rec] of Object.entries(porUF.BA || {}))
        porDigito[cnpj.replace(/\D/g, '')] = rec;
      let atualizados = 0, novos = 0;
      for (const [dig, rec] of vivos) {
        const alvo = porDigito[dig];
        if (alvo) {
          for (const [comb, f] of Object.entries(rec.p))
            if (!alvo.p[comb] || alvo.p[comb].d <= f.d) alvo.p[comb] = f;
          if (rec.lat != null) { alvo.lat = rec.lat; alvo.lng = rec.lng; }
          atualizados++;
        } else {
          (porUF.BA = porUF.BA || {})[dig] = rec;
          novos++;
        }
      }
      console.log(`  merge BA: ${atualizados} postos atualizados · ${novos} novos`);
    }
  } catch (e) {
    console.error('[Preço da Hora BA] falhou (segue só ANP):', e.message);
  }

  // resumo por cidade pesquisada (menor/média/maior por combustível + coordenada)
  const cidades = [];
  for (const [uf, mapa] of Object.entries(porUF)) {
    const porCidade = {};
    for (const posto of Object.values(mapa)) {
      const c = porCidade[posto.m] = porCidade[posto.m] || { uf, mu: posto.mu, m: posto.m, p: {} };
      for (const [comb, { v }] of Object.entries(posto.p)) {
        const f = c.p[comb] = c.p[comb] || { min: v, max: v, soma: 0, n: 0 };
        f.min = Math.min(f.min, v); f.max = Math.max(f.max, v);
        f.soma += v; f.n++;
      }
    }
    for (const c of Object.values(porCidade)) {
      for (const f of Object.values(c.p)) { f.med = +(f.soma / f.n).toFixed(2); delete f.soma; }
      const geo = coords[uf + ':' + c.m];
      if (geo) { c.lat = geo.lat; c.lng = geo.lng; c.mu = geo.nome; cidades.push(c); }
    }
  }
  console.log(`\nCidades pesquisadas com coordenada: ${cidades.length}`);
  try {
    const r = await fetch(SYNC_URL, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: SYNC_KEY, cidades }) });
    const j = await r.json().catch(() => ({}));
    console.log('  índice de cidades →', r.ok && j.ok ? 'ok' : 'FALHOU ' + r.status);
  } catch (e) { console.error('  índice de cidades FALHOU:', e.message); }

  let totalPostos = 0, falhas = 0;
  for (const [uf, mapa] of Object.entries(porUF)) {
    const postos = Object.values(mapa);
    totalPostos += postos.length;
    const semana = postos.reduce((mx, p) =>
      Object.values(p.p).reduce((m2, x) => x.d > m2 ? x.d : m2, mx), '');
    const body = JSON.stringify({ key: SYNC_KEY, uf, semana, postos });
    try {
      const r = await fetch(SYNC_URL, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(r.status + ' ' + JSON.stringify(j).slice(0, 120));
      console.log(`  ${uf}: ${postos.length} postos (${(body.length / 1024).toFixed(0)} KB) → ok`);
    } catch (e) {
      falhas++;
      console.error(`  ${uf}: FALHOU — ${e.message}`);
    }
  }

  console.log(`\nResumo: ${linhas} linhas → ${totalPostos} postos em ${Object.keys(porUF).length} UFs · ${falhas} falha(s)`);
  if (falhas > 3) process.exit(1);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
