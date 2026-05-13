// Build script — roda no Netlify build.
// Painel 100% ANP: agregados por estado, top postos mais baratos, comparativo por bandeira.
// Fonte unica: tabela precos_externos_anp (alimentada pelo scraper GH Action).

import pg from 'pg';
import fs from 'node:fs';

const { Client } = pg;
const DATABASE_URL = process.env.SUPABASE_DB_URL;
if (!DATABASE_URL) {
  console.error('ERRO: SUPABASE_DB_URL nao definido.');
  process.exit(1);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const COMBUSTIVEIS = [
  { key: 'gasolina', label: 'Gasolina', anpProd: 'GASOLINA' },
  { key: 'etanol', label: 'Etanol', anpProd: 'ETANOL' },
  { key: 's10', label: 'Diesel S10', anpProd: 'DIESEL S10' },
  { key: 's500', label: 'Diesel S500', anpProd: 'DIESEL' }
];

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : Number(n.toFixed(3));
}

(async () => {
  try {
    await client.connect();

    // 1) Janela de tempo: usa a SEMANA mais recente DOS DADOS DISPONIVEIS na tabela ANP
    const refRes = await client.query("select max(data_coleta) as max_d from precos_externos_anp");
    const maxD = refRes.rows[0].max_d;
    if (!maxD) {
      console.error('ERRO: tabela precos_externos_anp vazia. Rode o scraper.');
      process.exit(1);
    }
    const semanaRef = new Date(maxD).toISOString().substring(0, 10);

    // 2) Agregados por estado x produto (ultima semana)
    const aggByEstadoRes = await client.query(`
      with ref as (select max(data_coleta) as max_d from precos_externos_anp)
      select estado, produto,
             avg(valor_venda)::numeric(5,3) as media,
             min(valor_venda)::numeric(5,3) as min,
             max(valor_venda)::numeric(5,3) as max,
             count(*) as n
      from precos_externos_anp, ref
      where data_coleta > ref.max_d - interval '7 days'
      group by estado, produto
      order by estado, produto
    `);

    const agregados_estado = {};
    for (const r of aggByEstadoRes.rows) {
      if (!agregados_estado[r.estado]) {
        agregados_estado[r.estado] = { total_postos: 0 };
        for (const c of COMBUSTIVEIS) agregados_estado[r.estado][c.key] = null;
      }
      const c = COMBUSTIVEIS.find(x => x.anpProd === r.produto);
      if (c) {
        agregados_estado[r.estado][c.key] = {
          n: Number(r.n),
          media: toNum(r.media),
          min: toNum(r.min),
          max: toNum(r.max)
        };
      }
    }
    // Total de postos distintos por estado (CNPJ)
    const postosByEstadoRes = await client.query(`
      with ref as (select max(data_coleta) as max_d from precos_externos_anp)
      select estado, count(distinct cnpj) as n_postos
      from precos_externos_anp, ref
      where data_coleta > ref.max_d - interval '7 days'
      group by estado
    `);
    for (const r of postosByEstadoRes.rows) {
      if (agregados_estado[r.estado]) agregados_estado[r.estado].total_postos = Number(r.n_postos);
    }

    // 3) Top 10 postos mais baratos por estado (gasolina, ultima semana)
    const topPostosRes = await client.query(`
      with ref as (select max(data_coleta) as max_d from precos_externos_anp),
      recente as (
        select estado, municipio, revenda, bandeira, cnpj, valor_venda, data_coleta,
               row_number() over (partition by estado order by valor_venda asc) as rn
        from precos_externos_anp, ref
        where data_coleta > ref.max_d - interval '7 days'
          and produto = 'GASOLINA'
      )
      select estado, municipio, revenda, bandeira, cnpj, valor_venda, data_coleta
      from recente
      where rn <= 10
      order by estado, valor_venda asc
    `);
    const top_postos = {};
    for (const r of topPostosRes.rows) {
      if (!top_postos[r.estado]) top_postos[r.estado] = [];
      top_postos[r.estado].push({
        municipio: r.municipio,
        revenda: r.revenda,
        bandeira: r.bandeira,
        cnpj_curto: r.cnpj ? r.cnpj.substring(0, 10) + '...' : null,
        gasolina: toNum(r.valor_venda),
        data_coleta: r.data_coleta ? new Date(r.data_coleta).toISOString().substring(0, 10) : null
      });
    }

    // 4) Comparativo por bandeira x estado (gasolina, ultima semana) - so bandeiras com >= 3 postos
    const bandeirasRes = await client.query(`
      with ref as (select max(data_coleta) as max_d from precos_externos_anp)
      select estado, bandeira, count(*) as n,
             avg(valor_venda)::numeric(5,3) as media,
             min(valor_venda)::numeric(5,3) as min,
             max(valor_venda)::numeric(5,3) as max
      from precos_externos_anp, ref
      where data_coleta > ref.max_d - interval '7 days'
        and produto = 'GASOLINA'
      group by estado, bandeira
      having count(*) >= 3
      order by estado, media asc
    `);
    const bandeiras_estado = {};
    for (const r of bandeirasRes.rows) {
      if (!bandeiras_estado[r.estado]) bandeiras_estado[r.estado] = [];
      bandeiras_estado[r.estado].push({
        bandeira: r.bandeira || '(sem bandeira)',
        n: Number(r.n),
        media: toNum(r.media),
        min: toNum(r.min),
        max: toNum(r.max)
      });
    }

    // 5) Ranking municipal: top 15 cidades mais baratas (gasolina) e top 15 mais caras
    const ranking_municipal_baratas = await client.query(`
      with ref as (select max(data_coleta) as max_d from precos_externos_anp)
      select estado, municipio,
             avg(valor_venda)::numeric(5,3) as media,
             count(*) as n
      from precos_externos_anp, ref
      where data_coleta > ref.max_d - interval '7 days'
        and produto = 'GASOLINA'
      group by estado, municipio
      having count(*) >= 3
      order by media asc
      limit 15
    `);
    const ranking_municipal_caras = await client.query(`
      with ref as (select max(data_coleta) as max_d from precos_externos_anp)
      select estado, municipio,
             avg(valor_venda)::numeric(5,3) as media,
             count(*) as n
      from precos_externos_anp, ref
      where data_coleta > ref.max_d - interval '7 days'
        and produto = 'GASOLINA'
      group by estado, municipio
      having count(*) >= 3
      order by media desc
      limit 15
    `);

    // 6) KPIs globais
    const kpiRes = await client.query(`
      with ref as (select max(data_coleta) as max_d from precos_externos_anp)
      select count(*) as n_coletas,
             count(distinct cnpj) as n_postos,
             count(distinct municipio) as n_cidades,
             count(distinct estado) as n_estados
      from precos_externos_anp, ref
      where data_coleta > ref.max_d - interval '7 days'
    `);
    const kpi = kpiRes.rows[0];

    const atualizado = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const data = {
      atualizado_em: atualizado,
      semana_referencia: semanaRef,
      kpis: {
        n_postos: Number(kpi.n_postos),
        n_cidades: Number(kpi.n_cidades),
        n_estados: Number(kpi.n_estados),
        n_coletas: Number(kpi.n_coletas)
      },
      agregados_estado,
      top_postos,
      bandeiras_estado,
      ranking_municipal: {
        baratas: ranking_municipal_baratas.rows.map(r => ({
          estado: r.estado, municipio: r.municipio, media: toNum(r.media), n: Number(r.n)
        })),
        caras: ranking_municipal_caras.rows.map(r => ({
          estado: r.estado, municipio: r.municipio, media: toNum(r.media), n: Number(r.n)
        }))
      }
    };

    const template = fs.readFileSync('index.html', 'utf-8');
    const out = template.replace(
      /const DATA = \{[\s\S]*?\};\s*\/\/ END_DATA/,
      `const DATA = ${JSON.stringify(data, null, 2)};  // END_DATA`
    );
    fs.writeFileSync('index.html', out);
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));

    console.log(`OK build: ${kpi.n_postos} postos, ${kpi.n_cidades} cidades, ${kpi.n_estados} estados (semana ref ${semanaRef})`);
    console.log(`Estados: ${Object.keys(agregados_estado).join(', ')}`);
  } catch (e) {
    console.error('ERRO build:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
