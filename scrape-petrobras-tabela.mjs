// Petrobras price to distributors: the official table of gasolina A / diesel S10 / S500
// prices "sem tributos, à vista", per supply point (local) and delivery modality.
// Source: PDFs listed on precos.petrobras.com.br/web/precos-dos-combustiveis (updated on
// every price change). Each PDF is a history: one column per vigência; we take the rightmost
// column of the section's last page (current price) and the last different one (previous).
//
// Needs `pdftotext` (poppler) with -tsv. Output: petrobras-distribuidoras.json.
//   node scrape-petrobras-tabela.mjs           → writes the JSON
//   node scrape-petrobras-tabela.mjs --teste   → prints, writes nothing

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = 'https://precos.petrobras.com.br';
const PAGINA = BASE + '/web/precos-dos-combustiveis';
const OUT = new URL('petrobras-distribuidoras.json', import.meta.url);
const TESTE = process.argv.includes('--teste');
// node fetch gets 403 from the Petrobras WAF (TLS fingerprint); curl passes
const curl = (url, ...args) => execFileSync('curl', ['-sfL', '-m', '90', '--retry', '2', '-A', 'Mozilla/5.0', ...args, url], { maxBuffer: 64 << 20 });

// which PDF of the site list feeds which product; section title inside the PDF → key
const PDFS = [/Gasolina\s*-\s*\d/i, /Diesel S500 e S10/i];
const SECAO = [[/Gasolina A/i, 'gasolina_a'], [/Diesel S10/i, 'diesel_s10'], [/Diesel S500/i, 'diesel_s500']];

const DATA = /^(\d\d)\.(\d\d)\.(\d{4})$/;
const VALOR = /^\d{1,3}(\.\d{3})*,\d{2}$/;
const iso = (d) => d.replace(DATA, '$3-$2-$1');
const num = (s) => +s.replace(/\./g, '').replace(',', '.');

async function listaPdfs() {
  const html = curl(PAGINA).toString();
  const m = html.match(/var listaTabelaJson = (\[.*?\]);/s);
  if (!m) throw new Error('lista de tabelas não encontrada na página da Petrobras');
  const lista = JSON.parse(m[1]);
  return PDFS.map((re) => {
    const t = lista.find((x) => re.test(x.titulo));
    if (!t) throw new Error('tabela não encontrada: ' + re);
    return { titulo: t.titulo, url: BASE + t.urlTabelaPrecos };
  });
}

// word boxes from pdftotext -tsv: [{pag, x, y, w, t}]
function palavras(arquivo) {
  const tsv = execFileSync('pdftotext', ['-tsv', arquivo, '-'], { maxBuffer: 64 << 20 }).toString();
  return tsv.split('\n').slice(1).map((l) => l.split('\t')).filter((c) => c[0] === '5' && c[11] && !c[11].startsWith('###'))
    .map((c) => ({ pag: +c[1], x: +c[6], y: +c[7], w: +c[8], t: c[11] }));
}

export function lerTabela(ws) {
  const paginas = [...new Set(ws.map((w) => w.pag))];
  const secoes = {}; // key → last page of that section
  for (const p of paginas) {
    const titulo = ws.filter((w) => w.pag === p && w.y < 40).map((w) => w.t).join(' ');
    const s = SECAO.find(([re]) => re.test(titulo));
    if (s && ws.some((w) => w.pag === p && DATA.test(w.t))) secoes[s[1]] = p;
  }
  const out = {};
  for (const [key, p] of Object.entries(secoes)) {
    const pw = ws.filter((w) => w.pag === p);
    const linhas = pw.filter((w) => /^\([A-Z]{2}\)$/.test(w.t));
    const topo = Math.min(...linhas.map((w) => w.y));
    // date columns in the header; a "desconto" label right above/below marks a discounted column
    const cols = pw.filter((w) => DATA.test(w.t) && w.y < topo).map((w) => ({ data: iso(w.t), cx: w.x + w.w / 2 }))
      .map((c) => ({ ...c, desconto: pw.some((w) => /desconto/i.test(w.t) && w.y < topo && Math.abs(w.x + w.w / 2 - c.cx) < 14) }))
      .sort((a, b) => a.cx - b.cx);
    // Discount columns = government subsidy (MP 1.358/1.363/1.391): Petrobras charges the
    // discounted price, so per vigência the effective price is discount ?? list.
    const datas = [...new Set(cols.map((c) => c.data))].sort();
    const ult = datas[datas.length - 1];
    const lr = (v) => (v == null ? null : +(v / 1000).toFixed(4));
    const pontos = [];
    for (const uf of linhas) {
      const linha = pw.filter((w) => Math.abs(w.y - uf.y) < 1.5);
      const local = linha.filter((w) => w.x < uf.x).map((w) => w.t).join(' ');
      const mod = linha.find((w) => w.x > uf.x && /^[A-Z]{3}$/.test(w.t))?.t || '';
      const valores = linha.filter((w) => VALOR.test(w.t)).map((w) => ({ v: num(w.t), cx: w.x + w.w / 2 }));
      const em = (c) => c && valores.find((v) => Math.abs(v.cx - c.cx) < 12)?.v;
      const lista = (d) => em(cols.find((c) => c.data === d && !c.desconto));
      const desc = (d) => em(cols.find((c) => c.data === d && c.desconto));
      const efetivo = (d) => desc(d) ?? lista(d);
      const v = efetivo(ult);
      if (!v) continue; // point not supplied in the current vigência
      let anterior = null, desde = ult;
      for (let i = datas.length - 2; i >= 0; i--) {
        const a = efetivo(datas[i]);
        if (a == null) continue;
        if (a !== v) { anterior = { vigencia: datas[i], rs_l: lr(a) }; break; }
        desde = datas[i];
      }
      pontos.push({ local, uf: uf.t.slice(1, 3), modalidade: mod, rs_l: lr(v), tabela: lr(lista(ult)), subvencao: desc(ult) ? lr(lista(ult) - v) : 0, desde, anterior });
    }
    out[key] = { vigencia: ult, pontos };
  }
  return out;
}

const pdfs = await listaPdfs();
const produtos = {};
for (const pdf of pdfs) {
  const arq = path.join(os.tmpdir(), 'petro-' + Date.now() + '.pdf');
  curl(pdf.url, '-o', arq);
  for (const [k, v] of Object.entries(lerTabela(palavras(arq)))) produtos[k] = { ...v, fonte: pdf.titulo };
  fs.unlinkSync(arq);
}

// sanity: all 3 products, enough points, prices in a plausible R$/L band
for (const k of ['gasolina_a', 'diesel_s10', 'diesel_s500']) {
  const p = produtos[k];
  if (!p || p.pontos.length < 15) throw new Error(`${k}: só ${p?.pontos.length || 0} pontos — layout do PDF mudou?`);
  const fora = p.pontos.filter((x) => x.rs_l < 1.5 || x.rs_l > 8);
  if (fora.length) throw new Error(`${k}: preço fora da faixa em ${fora.map((x) => x.local).join(', ')}`);
}

// per-UF summary: cheapest point price in the state (what a distributor there can buy at)
const por_uf = {};
for (const [k, p] of Object.entries(produtos))
  for (const x of p.pontos) {
    const u = (por_uf[x.uf] ??= {});
    if (!u[k] || x.rs_l < u[k].min) u[k] = { min: x.rs_l, local: x.local, modalidade: x.modalidade };
  }

const json = { atualizado_em: new Date().toISOString(), fonte: PAGINA, produtos, por_uf };
if (TESTE) {
  for (const [k, p] of Object.entries(produtos)) console.log(k, p.vigencia, p.pontos.length, 'pontos', JSON.stringify(p.pontos.filter((x) => x.uf === 'MT')));
} else {
  fs.writeFileSync(OUT, JSON.stringify(json, null, 1));
  console.log('petrobras-distribuidoras.json:', Object.entries(produtos).map(([k, p]) => `${k} ${p.vigencia} (${p.pontos.length})`).join(' · '));
}
