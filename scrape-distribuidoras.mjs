// Scraper Google Sheets -> Supabase pra precos de distribuidoras (alimentado manualmente).
// Estrategia: DELETE ALL + INSERT ALL (planilha eh fonte de verdade).
// Protecao: se planilha vier com 0 linhas validas, NAO trunca (mantem dados anteriores).
// Requer env vars: SUPABASE_DB_URL, SHEET_ID

import pg from 'pg';
import { parse } from 'csv-parse/sync';
import https from 'node:https';

const { Client } = pg;
const DATABASE_URL = process.env.SUPABASE_DB_URL;
const SHEET_ID = process.env.SHEET_ID || '1fwwkFeRKrDfhKto2SylEKzS9xaLYb5lRxzyk0cQ2qHw';

if (!DATABASE_URL) {
  console.error('ERRO: SUPABASE_DB_URL nao definido.');
  process.exit(1);
}

// Sem &gid=0 -> exporta a primeira aba (que era nosso default mesmo).
// Com gid=0 explicito, Google retorna HTTP 400 em algumas planilhas.
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

function fetch(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LumenMonitorBot/1.0)'
      }
    };
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} ao baixar planilha. Verifique se a planilha esta com permissao "Qualquer pessoa com o link pode VER".`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parsePrecoBR(s) {
  if (s === null || s === undefined || s === '') return null;
  const num = parseFloat(String(s).replace(',', '.').trim());
  if (isNaN(num) || num < 0.5 || num > 30) return null;
  return Number(num.toFixed(3));
}

function parseDateBR(s) {
  if (!s) return null;
  const t = String(s).trim();
  // DD/MM/YYYY
  let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // DD/MM/YY (assume 20YY)
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (m) return `20${m[3]}-${m[2]}-${m[1]}`;
  // ISO YYYY-MM-DD
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  return null;
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  await client.connect();
  console.log(`Baixando planilha: ${CSV_URL}`);
  const csv = await fetch(CSV_URL);
  console.log(`Baixado ${(csv.length / 1024).toFixed(1)} KB`);

  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: true
  });

  console.log(`Total linhas brutas: ${records.length}`);

  const rows = [];
  let skipped = 0;
  records.forEach((r, idx) => {
    const data = parseDateBR(r['Data Coleta']);
    const estado = (r['Estado'] || '').trim();
    const distribuidora = (r['Distribuidora'] || '').trim();
    // Pular linhas sem campos essenciais
    if (!data || !estado || !distribuidora) {
      skipped++;
      return;
    }
    const gasolina = parsePrecoBR(r['Gasolina C (R$/L)']);
    const etanol = parsePrecoBR(r['Etanol Hidratado (R$/L)']);
    const s10 = parsePrecoBR(r['Diesel S10 (R$/L)']);
    const s500 = parsePrecoBR(r['Diesel S500 (R$/L)']);
    // Linha sem nenhum preco - pula
    if (gasolina === null && etanol === null && s10 === null && s500 === null) {
      skipped++;
      return;
    }
    rows.push({
      data_coleta: data,
      estado,
      distribuidora,
      cidade: (r['Cidade Base'] || '').trim() || null,
      gasolina_comum: gasolina,
      etanol,
      diesel_s10: s10,
      diesel_s500: s500,
      modalidade: (r['Modalidade'] || '').trim() || null,
      observacoes: (r['Observações'] || r['Observacoes'] || '').trim() || null,
      fonte_linha: idx + 2 // header + 1
    });
  });

  console.log(`Linhas validas: ${rows.length} | Linhas puladas: ${skipped}`);

  if (rows.length === 0) {
    console.log('PROTECAO: 0 linhas validas. NAO truncando tabela. Saindo.');
    await client.end();
    process.exit(0);
  }

  await client.query('begin');
  await client.query('truncate precos_distribuicao_manual');
  for (const row of rows) {
    await client.query(
      `insert into precos_distribuicao_manual (data_coleta, estado, distribuidora, cidade, gasolina_comum, etanol, diesel_s10, diesel_s500, modalidade, observacoes, fonte_linha)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [row.data_coleta, row.estado, row.distribuidora, row.cidade, row.gasolina_comum, row.etanol, row.diesel_s10, row.diesel_s500, row.modalidade, row.observacoes, row.fonte_linha]
    );
  }
  await client.query('commit');

  const tot = await client.query('select count(*) as t, count(distinct estado) as e, count(distinct distribuidora) as d, max(data_coleta) as last_d from precos_distribuicao_manual');
  console.log(`\nSync OK: ${tot.rows[0].t} registros, ${tot.rows[0].e} estados, ${tot.rows[0].d} distribuidoras. Ultima data: ${tot.rows[0].last_d}`);
  await client.end();
})().catch(async (e) => {
  console.error('ERRO:', e.message);
  try { await client.query('rollback'); } catch {}
  try { await client.end(); } catch {}
  process.exit(1);
});
