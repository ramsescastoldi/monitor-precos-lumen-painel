// Gerador do data.json — roda nos GitHub Actions (scrape-anp / scrape-distribuidoras).
// Painel 100% ANP: agregados por estado, top postos mais baratos, comparativo por bandeira.
// Fonte unica: tabela precos_externos_anp + precos_distribuicao_manual (alimentadas pelos scrapers).
//
// ARQUITETURA (desde 2026-05-18): este script gera SOMENTE data.json. O index.html
// consome data.json via fetch() em runtime. Os GitHub Actions rodam este script,
// commitam o data.json resultante (diff real) e o Cloudflare faz deploy do estatico.
// Se SUPABASE_DB_URL nao estiver definido (ex: build do Cloudflare sem a env var),
// saimos com exit 0 SEM regenerar — o data.json ja commitado continua servindo.

import pg from 'pg';
import fs from 'node:fs';

const { Client } = pg;
const DATABASE_URL = process.env.SUPABASE_DB_URL;
if (!DATABASE_URL) {
  console.warn('AVISO: SUPABASE_DB_URL nao definido. Pulando regeneracao — mantendo data.json commitado.');
  process.exit(0);
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

    // 7) Distribuidoras (planilha manual) - media por estado/produto, ultima semana de dados
    //    + calcula margem aparente: revenda ANP (media estado) - distribuicao
    const distriRes = await client.query(`
      with ref as (select coalesce(max(data_coleta), current_date) as max_d from precos_distribuicao_manual)
      select estado,
             avg(gasolina_comum)::numeric(5,3) as gasolina,
             avg(etanol)::numeric(5,3) as etanol,
             avg(diesel_s10)::numeric(5,3) as s10,
             avg(diesel_s500)::numeric(5,3) as s500,
             count(*) as n_cotacoes,
             count(distinct distribuidora) as n_distri,
             max(data_coleta) as data_ref
      from precos_distribuicao_manual, ref
      where data_coleta > ref.max_d - interval '14 days'
      group by estado
    `);
    const distribuicao_estado = {};
    let distri_ultima_data = null;
    for (const r of distriRes.rows) {
      distribuicao_estado[r.estado] = {
        n_cotacoes: Number(r.n_cotacoes),
        n_distribuidoras: Number(r.n_distri),
        data_ref: r.data_ref,
        gasolina: r.gasolina != null ? Number(r.gasolina) : null,
        etanol: r.etanol != null ? Number(r.etanol) : null,
        s10: r.s10 != null ? Number(r.s10) : null,
        s500: r.s500 != null ? Number(r.s500) : null
      };
      if (!distri_ultima_data || r.data_ref > distri_ultima_data) distri_ultima_data = r.data_ref;

      // Calcula margem aparente = revenda media ANP - distribuicao media planilha
      const revAnp = agregados_estado[r.estado];
      if (revAnp) {
        const m = {};
        for (const c of COMBUSTIVEIS) {
          const rev = revAnp[c.key]?.media;
          const dist = distribuicao_estado[r.estado][c.key];
          if (rev != null && dist != null) {
            const diff = rev - dist;
            m[c.key] = {
              revenda: Number(rev.toFixed(3)),
              distribuicao: Number(dist.toFixed(3)),
              margem_rs: Number(diff.toFixed(3)),
              margem_pct: Number(((diff / dist) * 100).toFixed(2))
            };
          } else {
            m[c.key] = null;
          }
        }
        distribuicao_estado[r.estado].margem = m;
      }
    }

    // 8) Lista detalhada de distribuidoras (ultima cotação por estado x distribuidora x cidade)
    //    Mesma janela de 14 dias do agregado (#7) — assim a tabela e a margem ficam consistentes
    //    (cotações fora da janela não aparecem nem contam na margem).
    const distriDetalheRes = await client.query(`
      with ref as (select coalesce(max(data_coleta), current_date) as max_d from precos_distribuicao_manual),
      ranked as (
        select estado, distribuidora, cidade,
               gasolina_comum, etanol, diesel_s10, diesel_s500,
               modalidade, observacoes, data_coleta,
               row_number() over (
                 partition by estado, distribuidora, coalesce(cidade, '')
                 order by data_coleta desc, importado_em desc
               ) as rn
        from precos_distribuicao_manual, ref
        where data_coleta > ref.max_d - interval '14 days'
      )
      select estado, distribuidora, cidade,
             gasolina_comum, etanol, diesel_s10, diesel_s500,
             modalidade, observacoes, data_coleta
      from ranked
      where rn = 1
      order by estado, distribuidora, cidade
    `);
    const distribuidoras_detalhe = distriDetalheRes.rows.map(r => ({
      estado: r.estado,
      distribuidora: r.distribuidora,
      cidade: r.cidade,
      gasolina: r.gasolina_comum != null ? Number(r.gasolina_comum) : null,
      etanol: r.etanol != null ? Number(r.etanol) : null,
      s10: r.diesel_s10 != null ? Number(r.diesel_s10) : null,
      s500: r.diesel_s500 != null ? Number(r.diesel_s500) : null,
      modalidade: r.modalidade,
      observacoes: r.observacoes,
      data_coleta: r.data_coleta ? new Date(r.data_coleta).toISOString().substring(0, 10) : null
    }));

    // 9) VOLUMES (mercado de combustíveis líquidos ANP) — 3 visões
    //    Tabela volumes_distribuidor (entregas por distribuidor x produto x regiao x mês, mil m³)
    let volumes = null;
    try {
      const ultPeriodoRes = await client.query('select max(ano*100+mes) as p from volumes_distribuidor');
      const p = ultPeriodoRes.rows[0]?.p;
      if (p) {
        const anoU = Math.floor(p / 100), mesU = p % 100;
        const MESES_PT = ['', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

        // 9a) Share por distribuidora no último mês (top 8 + "Outras")
        const shareRes = await client.query(
          `select distribuidor, sum(quantidade_mil_m3) as vol
           from volumes_distribuidor where ano=$1 and mes=$2
           group by distribuidor order by vol desc`, [anoU, mesU]);
        const totalMes = shareRes.rows.reduce((s, r) => s + Number(r.vol), 0);
        const top8 = shareRes.rows.slice(0, 8);
        const outras = shareRes.rows.slice(8).reduce((s, r) => s + Number(r.vol), 0);
        const share_distribuidora = top8.map(r => ({
          distribuidora: r.distribuidor,
          volume: Number(Number(r.vol).toFixed(1)),
          pct: Number((Number(r.vol) / totalMes * 100).toFixed(1))
        }));
        if (outras > 0) share_distribuidora.push({ distribuidora: 'Outras', volume: Number(outras.toFixed(1)), pct: Number((outras / totalMes * 100).toFixed(1)) });

        // 9b) Evolução mensal do volume total (12-13 meses)
        const evolRes = await client.query(
          `select ano, mes, sum(quantidade_mil_m3) as vol
           from volumes_distribuidor group by ano, mes order by ano, mes`);
        const evolucao_mensal = evolRes.rows.map(r => ({
          label: `${MESES_PT[r.mes]}/${String(r.ano).slice(2)}`,
          volume: Number(Number(r.vol).toFixed(0))
        }));

        // 9c) Volume por região no último mês
        const regRes = await client.query(
          `select regiao, sum(quantidade_mil_m3) as vol
           from volumes_distribuidor where ano=$1 and mes=$2
           group by regiao order by vol desc`, [anoU, mesU]);
        const REG_NOME = { N: 'Norte', NE: 'Nordeste', CO: 'Centro-Oeste', SE: 'Sudeste', S: 'Sul' };
        const totalReg = regRes.rows.reduce((s, r) => s + Number(r.vol), 0);
        const por_regiao = regRes.rows.map(r => ({
          regiao: r.regiao,
          nome: REG_NOME[r.regiao] || r.regiao,
          volume: Number(Number(r.vol).toFixed(1)),
          pct: Number((Number(r.vol) / totalReg * 100).toFixed(1))
        }));

        volumes = {
          mes_referencia: `${MESES_PT[mesU]}/${anoU}`,
          total_mil_m3: Number(totalMes.toFixed(0)),
          share_distribuidora,
          evolucao_mensal,
          por_regiao
        };
      }
    } catch (e) {
      console.warn('AVISO: volumes_distribuidor indisponível:', e.message);
    }

    const atualizado = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const data = {
      atualizado_em: atualizado,
      semana_referencia: semanaRef,
      distribuicao_ultima_data: distri_ultima_data ? new Date(distri_ultima_data).toISOString().substring(0, 10) : null,
      volumes,
      kpis: {
        n_postos: Number(kpi.n_postos),
        n_cidades: Number(kpi.n_cidades),
        n_estados: Number(kpi.n_estados),
        n_coletas: Number(kpi.n_coletas)
      },
      agregados_estado,
      distribuicao_estado,
      distribuidoras_detalhe,
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

    // O index.html agora consome data.json em runtime (fetch). Não injetamos mais.
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
