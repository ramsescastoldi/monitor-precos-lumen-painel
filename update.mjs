// Build script — roda no Netlify build (e tambem localmente).
// 1) Conecta no Supabase
// 2) Consulta revendedores ativos + precos coletados nos ultimos 7 dias
// 3) Calcula agregados por estado
// 4) Anonimiza revendedores (MT-A, MT-B, ...)
// 5) Injeta o data.json em index.html no marcador `const DATA = {};`
// 6) Grava index.html final

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

(async () => {
  try {
    await client.connect();

    // Revendedores ativos com sua coleta MAIS RECENTE nos ultimos 7 dias
    const sql = `
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
    const { rows } = await client.query(sql);

    // Anonimiza: MT-A, MT-B, GO-A, ...
    const counters = {};
    const revendedores = rows.map(r => {
      counters[r.estado] = (counters[r.estado] || 0) + 1;
      const letra = String.fromCharCode(65 + counters[r.estado] - 1);
      return {
        id_anonimo: `${r.estado}-${letra}`,
        estado: r.estado,
        cidade: r.cidade || null,
        gasolina: r.gasolina_comum != null ? Number(r.gasolina_comum) : null,
        etanol: r.etanol != null ? Number(r.etanol) : null,
        s10: r.diesel_s10 != null ? Number(r.diesel_s10) : null,
        s500: r.diesel_s500 != null ? Number(r.diesel_s500) : null,
        respondeu: r.coletado_em != null,
        coletado_em: r.coletado_em ? new Date(r.coletado_em).toISOString() : null
      };
    });

    // Agregados por estado
    const porEstado = {};
    for (const r of revendedores) {
      if (!porEstado[r.estado]) porEstado[r.estado] = [];
      porEstado[r.estado].push(r);
    }
    const agregados_estado = {};
    for (const [uf, lista] of Object.entries(porEstado)) {
      const respondentes = lista.filter(x => x.respondeu);
      agregados_estado[uf] = {
        total_revendedores: lista.length,
        responderam: respondentes.length,
        gasolina: statsOf(respondentes.map(x => x.gasolina)),
        etanol: statsOf(respondentes.map(x => x.etanol)),
        s10: statsOf(respondentes.map(x => x.s10)),
        s500: statsOf(respondentes.map(x => x.s500))
      };
    }

    const totalRespondentes = revendedores.filter(r => r.respondeu).length;
    const atualizado = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const data = {
      atualizado_em: atualizado,
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

    // E grava o data.json bruto pra inspecao
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));

    console.log(`OK build: ${revendedores.length} revendedores, ${totalRespondentes} responderam, ${Object.keys(agregados_estado).length} estados`);
  } catch (e) {
    console.error('ERRO build:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
