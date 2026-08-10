// Scraper ANP — baixa CSVs semanais oficiais, parseia, filtra estados de interesse,
// UPSERT no Supabase em precos_externos_anp.
// Roda via GitHub Actions a cada 3 dias (seg/qui) e também sob demanda local.
// Requer env var SUPABASE_DB_URL.

import pg from 'pg';
import { parse } from 'csv-parse/sync';
import https from 'node:https';

const { Client } = pg;

const ESTADOS = new Set(['MT', 'RS', 'GO', 'DF', 'PR', 'MG', 'SP', 'RO', 'RJ', 'CE', 'SC', 'PA', 'MS', 'BA', 'ES']);
const PRODUTOS_VALIDOS = new Set(['GASOLINA', 'ETANOL', 'DIESEL', 'DIESEL S10']);

const URLS = [
  'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-gasolina-etanol.csv',
  'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-diesel-gnv.csv'
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function normalizar(s) {
  if (!s) return null;
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
function parsePrecoBR(s) {
  if (!s) return null;
  const num = parseFloat(String(s).replace(',', '.').trim());
  if (isNaN(num) || num < 0.5 || num > 30) return null;
  return Number(num.toFixed(3));
}
function parseDateBR(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const DATABASE_URL = process.env.SUPABASE_DB_URL;
if (!DATABASE_URL) {
  console.error('ERRO: SUPABASE_DB_URL nao definido.');
  process.exit(1);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  await client.connect();
  console.log(`Iniciando scraper ANP em ${new Date().toISOString()}`);

  let totalInserted = 0, totalUpdated = 0, totalSkipped = 0;

  for (const url of URLS) {
    const fileName = url.split('/').pop();
    console.log(`\n[${fileName}] Baixando...`);
    const csvText = await fetch(url);
    console.log(`[${fileName}] ${(csvText.length / 1024).toFixed(0)} KB. Parseando...`);

    const records = parse(csvText, {
      delimiter: ';',
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
      trim: true
    });
    console.log(`[${fileName}] ${records.length} linhas no CSV.`);

    let filtered = 0;
    const batch = [];
    for (const r of records) {
      const estado = r['Estado - Sigla'];
      if (!ESTADOS.has(estado)) { filtered++; continue; }
      const produto = r['Produto'];
      if (!PRODUTOS_VALIDOS.has(produto)) continue;
      const valor = parsePrecoBR(r['Valor de Venda']);
      const data = parseDateBR(r['Data da Coleta']);
      if (!valor || !data) continue;

      batch.push([
        r['Regiao - Sigla'] || null,
        estado,
        r['Municipio'] || null,
        normalizar(r['Municipio']),
        r['Revenda'] || null,
        (r['CNPJ da Revenda'] || '').trim(),
        r['Bandeira'] || null,
        produto,
        valor,
        data
      ]);
    }
    console.log(`[${fileName}] ${batch.length} relevantes (${filtered} fora dos estados de interesse).`);

    // Bulk INSERT em chunks de 500
    const CHUNK = 500;
    let inserted = 0, updated = 0;
    for (let i = 0; i < batch.length; i += CHUNK) {
      const chunk = batch.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      chunk.forEach((row, idx) => {
        const base = idx * 10;
        values.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10})`);
        params.push(...row);
      });
      const sql = `
        insert into precos_externos_anp (regiao, estado, municipio, municipio_normalizado, revenda, cnpj, bandeira, produto, valor_venda, data_coleta)
        values ${values.join(',')}
        on conflict (cnpj, produto, data_coleta) do update
          set valor_venda = excluded.valor_venda,
              coletado_em = now()
        returning (xmax = 0) as was_inserted
      `;
      try {
        const res = await client.query(sql, params);
        for (const row of res.rows) {
          if (row.was_inserted) inserted++; else updated++;
        }
      } catch (e) {
        totalSkipped += chunk.length;
        console.error(`[${fileName}] chunk ${i}-${i+chunk.length} falhou:`, e.message);
      }
      if (i % 2000 === 0) console.log(`[${fileName}]   processado ${i + chunk.length}/${batch.length}`);
    }
    console.log(`[${fileName}] OK: ${inserted} inseridos, ${updated} atualizados.`);
    totalInserted += inserted;
    totalUpdated += updated;
  }

  // Limpa dados antigos (>60 dias)
  const cleanup = await client.query("delete from precos_externos_anp where data_coleta < current_date - interval '60 days'");
  console.log(`\nCleanup: ${cleanup.rowCount} registros >60 dias removidos.`);

  const tot = await client.query("select count(*) as t, count(distinct estado) as e, max(data_coleta) as last_d from precos_externos_anp");
  console.log(`\n=== Resumo final ===`);
  console.log(`Total inseridos novos: ${totalInserted}`);
  console.log(`Total atualizados: ${totalUpdated}`);
  console.log(`Pulados (erro): ${totalSkipped}`);
  console.log(`Registros na tabela: ${tot.rows[0].t}, estados: ${tot.rows[0].e}, última coleta: ${tot.rows[0].last_d}`);
  await client.end();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
