// Build script — roda no Netlify build (e tambem localmente).
// 1) Conecta no Supabase
// 2) Consulta revendedores ativos + ultima coleta de precos (7 dias) + medias ANP por estado (14 dias)
// 3) Calcula disparidade revendedor LIVE vs media ANP estadual (R$ e %)
// 4) Agregados por estado (media/min/max LIVE e ANP)
// 5) Anonimiza revendedores (MT-A, MT-B, ...)
// 6) Injeta dados em index.html no marcador `const DATA = {};  // END_DATA`

import pg from 'pg';
import fs from 'node:fs';

const { Client } = pg;
const DATABASE_URL = process.env.SUPABASE_DB_URL;
if (!DATABASE_URL) {
  console.error('ERRO: SUPABASE_DB_URL nao definido. Setar env var no Netlify (Settings -> Environment).');
  process.exit(1);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const COMBUSTIVEIS = [
  { key: 'gasolina', col: 'gasolina_comum', anpProd: 'GASOLINA' },
  { key: 'etanol', col: 'etanol', anpProd: 'ETANOL' },
  { key: 's10', col: 'diesel_s10', anpProd: 'DIESEL S10' },
  { key: 's500', col: 'diesel_s500', anpProd: 'DIESEL' }
];

function statsOf(values) {
  const arr = values.filter(v => v !== null && v !== undefined && !isNaN(parseFloat(v))).map(parseFloat);
  if (arr.length === 0) return null;
  arr.sort((a, b) => a - b);
  const media = arr.reduce((s, x) => s + x, 0) / arr.length;
  return {
    n: arr.length,
    media: Number(media.toFixed(3)),
    min: Number(arr[0].toFixed(3)),
    max: Number(arr[arr.length - 1].toFixed(3))
  };
}

function disparidade(precoLive, mediaAnp) {
  if (precoLive == null || mediaAnp == null) return { rs: null, pct: null };
  const diff = precoLive - mediaAnp;
  const pct = (diff / mediaAnp) * 100;
  return {
    rs: Number(diff.toFixed(3)),
    pct: Number(pct.toFixed(2))
  };
}

(async () => {
  try {
    await client.connect();

    // 1) Revendedores LIVE com ultima coleta (7 dias)
    const sqlLive = `
      with ultima_coleta as (
        select distinct on (revendedor_id)
               revendedor_id, gasolina_comum, etanol, diesel_s10, diesel_s500, coletado_em
        from precos_revendedor
        where coletado_em > now() - interval '7 days'
        order by revendedor_id, coletado_em desc
      )
      select r.id, r.estado, r.cidade, r.whatsapp_jid,
             u.gasolina_comum, u.etanol, u.diesel_s10, u.diesel_s500, u.coletado_em
      from revendedores r
      left join ultima_coleta u on u.revendedor_id = r.id
      where r.ativo = true
      order by r.estado, r.id
    `;
    const { rows: revRows } = await client.query(sqlLive);

    // 2) Agregados ANP por estado x produto — usa a SEMANA mais recente DOS DADOS DISPONIVEIS
    //    (nao 'current_date - 14 days', porque ANP tem delay de ~2 semanas no processamento)
    const sqlAnp = `
      with ref as (select max(data_coleta) as max_d from precos_externos_anp)
      select estado, produto,
             avg(valor_venda)::numeric(5,3) as media,
             min(valor_venda)::numeric(5,3) as min,
             max(valor_venda)::numeric(5,3) as max,
             count(*) as n,
             max(data_coleta) as data_ref
      from precos_externos_anp, ref
      where data_coleta > ref.max_d - interval '7 days'
      group by estado, produto
    `;
    const { rows: anpRows } = await client.query(sqlAnp);
    // Re-estrutura: anpByEstado[estado][produto] = { media, min, max, n, data_ref }
    const anpByEstado = {};
    let anpUltimaData = null;
    for (const r of anpRows) {
      if (!anpByEstado[r.estado]) anpByEstado[r.estado] = {};
      anpByEstado[r.estado][r.produto] = {
        media: Number(r.media),
        min: Number(r.min),
        max: Number(r.max),
        n: Number(r.n),
        data_ref: r.data_ref
      };
      if (!anpUltimaData || r.data_ref > anpUltimaData) anpUltimaData = r.data_ref;
    }

    // 3) Anonimiza revendedores + calcula disparidade vs ANP
    const counters = {};
    const revendedores = revRows.map(r => {
      counters[r.estado] = (counters[r.estado] || 0) + 1;
      const letra = String.fromCharCode(65 + counters[r.estado] - 1);
      const anpEstado = anpByEstado[r.estado] || {};

      const out = {
        id_anonimo: `${r.estado}-${letra}`,
        estado: r.estado,
        respondeu: r.coletado_em != null,
        coletado_em: r.coletado_em ? new Date(r.coletado_em).toISOString() : null
      };

      for (const c of COMBUSTIVEIS) {
        const precoLive = r[c.col] != null ? Number(r[c.col]) : null;
        const anp = anpEstado[c.anpProd] || null;
        const mediaAnp = anp ? anp.media : null;
        const disp = disparidade(precoLive, mediaAnp);
        out[c.key] = precoLive;
        out[`${c.key}_vs_anp_rs`] = disp.rs;
        out[`${c.key}_vs_anp_pct`] = disp.pct;
      }
      return out;
    });

    // 4) Agregados por estado: LIVE + ANP
    const porEstado = {};
    for (const r of revendedores) {
      if (!porEstado[r.estado]) porEstado[r.estado] = [];
      porEstado[r.estado].push(r);
    }
    const agregados_estado = {};
    for (const [uf, lista] of Object.entries(porEstado)) {
      const respondentes = lista.filter(x => x.respondeu);
      const anpEstado = anpByEstado[uf] || {};
      const ag = {
        total_revendedores: lista.length,
        responderam: respondentes.length
      };
      for (const c of COMBUSTIVEIS) {
        ag[c.key] = statsOf(respondentes.map(x => x[c.key]));
        const anpC = anpEstado[c.anpProd];
        ag[`${c.key}_anp`] = anpC ? {
          n: anpC.n,
          media: anpC.media,
          min: anpC.min,
          max: anpC.max
        } : null;
      }
      agregados_estado[uf] = ag;
    }

    const totalRespondentes = revendedores.filter(r => r.respondeu).length;
    const atualizado = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const data = {
      atualizado_em: atualizado,
      anp_semana_referencia: anpUltimaData ? new Date(anpUltimaData).toISOString().substring(0, 10) : null,
      total_revendedores: revendedores.length,
      responderam_semana: totalRespondentes,
      revendedores,
      agregados_estado
    };

    // Lê o template index.html e injeta o data.json
    const template = fs.readFileSync('index.html', 'utf-8');
    const out = template.replace(
      /const DATA = \{[\s\S]*?\};\s*\/\/ END_DATA/,
      `const DATA = ${JSON.stringify(data, null, 2)};  // END_DATA`
    );
    fs.writeFileSync('index.html', out);
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));

    console.log(`OK build: ${revendedores.length} revendedores, ${totalRespondentes} responderam`);
    console.log(`ANP: ${anpRows.length} agregados (estado x produto), semana ref: ${data.anp_semana_referencia}`);
    console.log(`Estados: ${Object.keys(agregados_estado).join(', ')}`);
  } catch (e) {
    console.error('ERRO build:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
