// Exportador Radar de Preços — baixa os CSVs semanais oficiais da ANP (por posto,
// Brasil inteiro, 27 UFs), fica com a coleta mais recente de cada posto/produto e
// envia 1 pacote por UF pro KV do radar (lumen-radar.pages.dev/api/anp-sync).
// Roda via GitHub Actions seg+qui e sob demanda local. Não usa Supabase.

import { parse } from 'csv-parse/sync';
import https from 'node:https';
import { chaveANP } from './scrape-buscapreco-am.mjs';

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
  const indiceAM = {};              // chave de endereço → posto (merge do Busca Preço AM)
  const indicePR = {};              // chave de endereço → posto (merge do Nota Paraná)
  const somenteUF = process.env.ONLY_UF; // roda só uma UF: pula as outras fontes vivas e o índice de cidades
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
      const novo = !porUF[uf][cnpj];
      const posto = porUF[uf][cnpj] = porUF[uf][cnpj] || {
        n: titulo(r['Revenda']),
        b: titulo(r['Bandeira']),
        mu: titulo(r['Municipio']),
        m: slug(r['Municipio']),
        e: titulo([r['Nome da Rua'], r['Numero Rua']].filter(Boolean).join(', ') +
                  (r['Bairro'] ? ' - ' + r['Bairro'] : '')),
        p: {}
      };
      // AM não tem CNPJ na NFC-e do Busca Preço: o merge é por endereço
      if (uf === 'AM' && novo)
        indiceAM[chaveANP(r['Nome da Rua'], r['Numero Rua'], r['Municipio'])] = posto;
      if (uf === 'PR' && novo)
        indicePR[chaveANP(r['Nome da Rua'], r['Numero Rua'], r['Municipio'])] = posto;
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
    if (uf) coords[uf + ':' + slug(c[1])] = { lat: +c[2], lng: +c[3], nome: c[1], ibge: +c[0], uf };
  }

  // fonte NFC-e (Map<cnpjDigitos, posto>) sobre a base ANP da UF: preço mais novo
  // vence e posto que a ANP não visitou entra na pesquisa
  function mesclarPorCNPJ(uf, vivos) {
    const porDigito = {};
    for (const [cnpj, rec] of Object.entries(porUF[uf] || {}))
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
        (porUF[uf] = porUF[uf] || {})[dig] = rec;
        novos++;
      }
    }
    console.log(`  merge ${uf}: ${atualizados} postos atualizados · ${novos} novos`);
  }

  // BA quase tempo real (Preço da Hora / NFC-e por posto) — atualiza preço e
  // amplia a pesquisa da UF com postos que a ANP não visitou na semana
  try {
    if (process.env.SKIP_PDH) throw new Error('SKIP_PDH ligado (rodada só-ANP)');
    if (somenteUF && somenteUF !== 'BA') throw new Error('ONLY_UF ativo, pulando BA');
    const { coletarPrecoDaHora } = await import('./scrape-precodahora.mjs');
    const porSlugBA = {};
    for (const p of Object.values(porUF.BA || {}))
      porSlugBA[p.m] = (porSlugBA[p.m] || 0) + 1;
    // mercados maiores primeiro: se a cota do PRODEB cortar, o parcial vale mais.
    // Top 5 todo dia; o resto RODA por dia do ano pra nenhuma cidade ficar
    // eternamente atrás do deadline.
    const ordenadas = Object.keys(porSlugBA)
      .sort((a, b) => porSlugBA[b] - porSlugBA[a])
      .map(m => coords['BA:' + m] &&
        { mu: coords['BA:' + m].nome, m, lat: coords['BA:' + m].lat, lng: coords['BA:' + m].lng })
      .filter(Boolean);
    const giro = ordenadas.slice(5);
    const dia = Math.floor(Date.now() / 86400000);
    const corte = giro.length ? dia % giro.length : 0;
    const cidadesBA = [...ordenadas.slice(0, 5), ...giro.slice(corte), ...giro.slice(0, corte)];
    if (cidadesBA.length) {
      console.log(`\n[Preço da Hora BA] varrendo ${cidadesBA.length} cidades…`);
      const vivos = await coletarPrecoDaHora(cidadesBA, { titulo, slug });
      mesclarPorCNPJ('BA', vivos);
    }
  } catch (e) {
    console.error('[Preço da Hora BA] falhou (segue só ANP):', e.message);
  }

  // AL quase tempo real (Economiza Alagoas / NFC-e por posto, API oficial da Sefaz).
  // Mesmo papel do Preço da Hora na BA — e aqui a cobertura vai além da ANP:
  // Maceió passa de ~20 postos da pesquisa semanal pra 100+ com preço do dia.
  try {
    if (process.env.SKIP_PDH) throw new Error('SKIP_PDH ligado (rodada só-ANP)');
    if (somenteUF && somenteUF !== 'AL') throw new Error('ONLY_UF ativo, pulando AL');
    const { coletarEconomizaAL } = await import('./scrape-economiza-al.mjs');
    const porSlugAL = {};
    for (const p of Object.values(porUF.AL || {}))
      porSlugAL[p.m] = (porSlugAL[p.m] || 0) + 1;
    // toda cidade de AL entra (a API cobre o estado inteiro, não só o que a ANP
    // visitou); as praças com mais postos na ANP primeiro, pro parcial valer mais.
    // Top 10 todo dia; o resto gira por dia do ano — a varredura completa não cabe
    // no deadline e sem giro o rabo da lista ficaria eternamente sem coleta.
    const ordenadasAL = Object.values(coords)
      .filter(c => c.uf === 'AL')
      .map(c => ({ mu: c.nome, m: slug(c.nome), ibge: c.ibge }))
      .sort((a, b) => (porSlugAL[b.m] || 0) - (porSlugAL[a.m] || 0));
    const giroAL = ordenadasAL.slice(10);
    const corteAL = giroAL.length ? Math.floor(Date.now() / 86400000) % giroAL.length : 0;
    const cidadesAL = [...ordenadasAL.slice(0, 10),
      ...giroAL.slice(corteAL), ...giroAL.slice(0, corteAL)];
    if (cidadesAL.length) {
      console.log(`\n[Economiza AL] varrendo ${cidadesAL.length} cidades…`);
      const vivos = await coletarEconomizaAL(cidadesAL, { titulo, slug });
      mesclarPorCNPJ('AL', vivos);
    }
  } catch (e) {
    console.error('[Economiza AL] falhou (segue só ANP):', e.message);
  }

  // AM quase tempo real (Busca Preço Amazonas / NFC-e por posto). Mesmo papel do
  // Preço da Hora na BA, mas casando por endereço — lá não vem CNPJ.
  try {
    if (process.env.SKIP_BPAM) throw new Error('SKIP_BPAM ligado (rodada só-ANP)');
    if (somenteUF && somenteUF !== 'AM') throw new Error('ONLY_UF ativo, pulando AM');
    const { coletarBuscaPrecoAM } = await import('./scrape-buscapreco-am.mjs');
    console.log('\n[Busca Preço AM] varrendo municípios…');
    const vivos = await coletarBuscaPrecoAM({ titulo, slug });
    let atualizados = 0, novos = 0;
    for (const [chave, rec] of vivos) {
      const alvo = indiceAM[chave];
      if (alvo) {
        for (const [comb, f] of Object.entries(rec.p))
          if (!alvo.p[comb] || alvo.p[comb].d <= f.d) alvo.p[comb] = f;
        if (rec.lat != null) { alvo.lat = rec.lat; alvo.lng = rec.lng; }
        atualizados++;
      } else {
        (porUF.AM = porUF.AM || {})['am:' + chave] = rec;
        novos++;
      }
    }
    console.log(`  merge AM: ${atualizados} postos atualizados · ${novos} novos`);
  } catch (e) {
    console.error('[Busca Preço AM] falhou (segue só ANP):', e.message);
  }

  // PR quase tempo real (Nota Paraná / NFC-e por posto, API oficial da Sefaz) — mesmo
  // papel do Preço da Hora na BA (top-5 cidades + giro diário pro resto), mas casando
  // por endereço como o AM: a API do Nota Paraná não devolve CNPJ.
  try {
    if (process.env.SKIP_NP) throw new Error('SKIP_NP ligado (rodada só-ANP)');
    if (somenteUF && somenteUF !== 'PR') throw new Error('ONLY_UF ativo, pulando PR');
    const { coletarNotaParana } = await import('./scrape-notaparana.mjs');
    const porSlugPR = {};
    for (const p of Object.values(porUF.PR || {}))
      porSlugPR[p.m] = (porSlugPR[p.m] || 0) + 1;
    const ordenadas = Object.keys(porSlugPR)
      .sort((a, b) => porSlugPR[b] - porSlugPR[a])
      .map(m => coords['PR:' + m] &&
        { mu: coords['PR:' + m].nome, m, lat: coords['PR:' + m].lat, lng: coords['PR:' + m].lng })
      .filter(Boolean);
    const giro = ordenadas.slice(5);
    const dia = Math.floor(Date.now() / 86400000);
    const corte = giro.length ? dia % giro.length : 0;
    const cidadesPR = [...ordenadas.slice(0, 5), ...giro.slice(corte), ...giro.slice(0, corte)];
    if (cidadesPR.length) {
      console.log(`\n[Nota Paraná] varrendo ${cidadesPR.length} cidades…`);
      const vivos = await coletarNotaParana(cidadesPR, { titulo, slug });
      let atualizados = 0, novos = 0;
      for (const [chave, rec] of vivos) {
        const alvo = indicePR[chave];
        if (alvo) {
          for (const [comb, f] of Object.entries(rec.p))
            if (!alvo.p[comb] || alvo.p[comb].d <= f.d) alvo.p[comb] = f;
          if (rec.lat != null) { alvo.lat = rec.lat; alvo.lng = rec.lng; }
          atualizados++;
        } else {
          (porUF.PR = porUF.PR || {})['np:' + chave] = rec;
          novos++;
        }
      }
      console.log(`  merge PR: ${atualizados} postos atualizados · ${novos} novos`);
    }
  } catch (e) {
    console.error('[Nota Paraná] falhou (segue só ANP):', e.message);
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
  if (process.env.DRY_RUN) {           // conferir a coleta sem escrever no KV
    console.log('DRY_RUN: nada enviado ao KV.');
    for (const [uf, mapa] of Object.entries(porUF))
      console.log(`  ${uf}: ${Object.keys(mapa).length} postos`);
    return;
  }
  if (somenteUF) {
    console.log(`  ONLY_UF=${somenteUF}: pulando índice de cidades (não mexe nas outras UFs).`);
  } else {
    try {
      const r = await fetch(SYNC_URL, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: SYNC_KEY, cidades }) });
      const j = await r.json().catch(() => ({}));
      console.log('  índice de cidades →', r.ok && j.ok ? 'ok' : 'FALHOU ' + r.status);
    } catch (e) { console.error('  índice de cidades FALHOU:', e.message); }
  }

  let totalPostos = 0, falhas = 0;
  for (const [uf, mapa] of Object.entries(porUF)) {
    if (somenteUF && uf !== somenteUF) continue;
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
