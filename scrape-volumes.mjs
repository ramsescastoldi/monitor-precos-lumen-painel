// Scraper ANP Volumes — baixa liquidos.zip, extrai Liquidos_Entregas_Distribuidor_Atual.csv,
// parseia (entregas por distribuidor x produto x regiao x mes) e UPSERT em volumes_distribuidor.
// Fonte: Painel Dinâmico do Mercado Brasileiro de Combustíveis Líquidos (dados abertos ANP).
// Atualiza dia 1 e dia 20 de cada mês. Requer SUPABASE_DB_URL.

import pg from 'pg';
import { parse } from 'csv-parse/sync';
import https from 'node:https';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Client } = pg;
const DATABASE_URL = process.env.SUPABASE_DB_URL;
if (!DATABASE_URL) {
  console.error('ERRO: SUPABASE_DB_URL nao definido.');
  process.exit(1);
}

const ZIP_URL = 'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/mdpg/liquidos.zip';
const CSV_NAME = 'Liquidos_Entregas_Distribuidor_Atual.csv';
// Só mantém os últimos N meses no banco (mantém o painel leve e relevante)
// 25 meses = ano corrente + ano anterior inteiro → permite comparativo acumulado YoY
const MESES_JANELA = 25;

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LumenMonitorBot/1.0)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ao baixar ZIP`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseNumBR(s) {
  if (s === null || s === undefined || s === '') return null;
  const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.').trim());
  return isNaN(n) ? null : Number(n.toFixed(4));
}

const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anpvol-'));
  const zipPath = path.join(tmp, 'liquidos.zip');

  console.log('Baixando liquidos.zip...');
  const buf = await fetchBuffer(ZIP_URL);
  fs.writeFileSync(zipPath, buf);
  console.log(`Baixado ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  // Extrai só o CSV de entregas (leve). unzip está disponível no runner ubuntu.
  execSync(`unzip -o -q "${zipPath}" "${CSV_NAME}" -d "${tmp}"`);
  const csvLatin = fs.readFileSync(path.join(tmp, CSV_NAME));
  // CSV é latin-1
  const csvText = new TextDecoder('latin1').decode(csvLatin);
  console.log(`CSV lido: ${(csvText.length / 1024).toFixed(0)} KB`);

  const records = parse(csvText, {
    delimiter: ';',
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: true
  });
  console.log(`Total linhas: ${records.length}`);

  // Colunas: Ano | Mês | Distribuidor | Código do Produto | Nome do Produto | Região | Quantidade de Produto (mil m³)
  // (nomes com acento/encoding — pego por índice de chave robusto)
  function col(row, ...candidates) {
    for (const key of Object.keys(row)) {
      const norm = key.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      for (const c of candidates) {
        if (norm.includes(c)) return row[key];
      }
    }
    return null;
  }

  // Descobre os meses presentes e mantém só os MESES_JANELA mais recentes
  const periodos = new Set();
  for (const r of records) {
    const ano = parseInt(col(r, 'ano'), 10);
    const mes = parseInt(col(r, 'mes', 'mês'), 10);
    if (ano && mes) periodos.add(ano * 100 + mes);
  }
  const ordenados = [...periodos].sort((a, b) => b - a).slice(0, MESES_JANELA);
  const janela = new Set(ordenados);
  console.log(`Períodos no CSV: ${periodos.size}. Mantendo ${ordenados.length} mais recentes (${ordenados[ordenados.length-1]} a ${ordenados[0]}).`);

  const rows = [];
  for (const r of records) {
    const ano = parseInt(col(r, 'ano'), 10);
    const mes = parseInt(col(r, 'mes', 'mês'), 10);
    if (!ano || !mes || !janela.has(ano * 100 + mes)) continue;
    const distribuidor = (col(r, 'distribuidor') || '').trim();
    const produto = (col(r, 'nome do produto', 'produto') || '').trim();
    const regiao = (col(r, 'regiao', 'região') || '').trim();
    const qtd = parseNumBR(col(r, 'quantidade'));
    if (!distribuidor || !produto || !regiao || qtd === null) continue;
    rows.push([ano, mes, distribuidor, produto, regiao, qtd]);
  }
  console.log(`Linhas válidas na janela: ${rows.length}`);

  await client.connect();
  // Limpa a janela e re-insere (idempotente, simples)
  await client.query('begin');
  await client.query(
    `delete from volumes_distribuidor where (ano * 100 + mes) = any($1)`,
    [ordenados]
  );
  const CHUNK = 1000;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const vals = [];
    const params = [];
    chunk.forEach((row, idx) => {
      const b = idx * 6;
      vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`);
      params.push(...row);
    });
    await client.query(
      `insert into volumes_distribuidor (ano, mes, distribuidor, produto, regiao, quantidade_mil_m3)
       values ${vals.join(',')}
       on conflict (ano, mes, distribuidor, produto, regiao) do update set quantidade_mil_m3 = excluded.quantidade_mil_m3, importado_em = now()`,
      params
    );
    inserted += chunk.length;
  }
  // Remove meses fora da janela (limpeza de histórico antigo)
  const del = await client.query(
    `delete from volumes_distribuidor where (ano * 100 + mes) <> all($1)`,
    [ordenados]
  );
  await client.query('commit');

  const tot = await client.query('select count(*) as t, count(distinct distribuidor) as d, min(ano*100+mes) as min_p, max(ano*100+mes) as max_p from volumes_distribuidor');
  console.log(`\nSync OK: ${inserted} inseridos, ${del.rowCount} antigos removidos.`);
  console.log(`Tabela: ${tot.rows[0].t} registros, ${tot.rows[0].d} distribuidores, período ${tot.rows[0].min_p}-${tot.rows[0].max_p}`);
  await client.end();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(async (e) => {
  console.error('ERRO:', e.message);
  try { await client.query('rollback'); } catch {}
  try { await client.end(); } catch {}
  process.exit(1);
});
