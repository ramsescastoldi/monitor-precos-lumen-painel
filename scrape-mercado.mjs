// Mercado de importação e biocombustíveis → mercado.json (roda no Mac: gov.br recusa runner do GitHub
// e a tabela da ABICOM é imagem, lida com o OCR nativo do macOS em tools/ocr.swift).
//
// Fontes (todas públicas, nenhuma inventada):
//  - abicom: tabela diária ABICOM/StoneX (post "PPI – DD/MM/AAAA" em abicom.com.br) — preço doméstico,
//    PPI e defasagem por polo (5 Petrobras + Acelen/Aratu). Validação: preço − PPI = defasagem em todo polo.
//  - ppi_anp: PPI semanal S&P Global publicado pela ANP (arq-ppi/ppi.xlsx), 16 pontos, cruzado com o preço
//    atual da tabela Petrobras no mesmo ponto (petrobras-distribuidoras.json).
//  - produtor: preço médio ponderado semanal de produtores e importadores por região (ANP ppidp .xls) —
//    gasolina A, diesel S10/S500 e biodiesel B100.
//  - etanol: CEPEA/ESALQ — diário Paulínia (hidratado), semanal SP e MT (hidratado e anidro).
// Cada fonte é independente: se uma falhar, mantém o valor anterior do mercado.json.
//   node scrape-mercado.mjs          → grava mercado.json
//   node scrape-mercado.mjs --teste  → só imprime

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import XLSX from 'xlsx';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, 'mercado.json');
const TESTE = process.argv.includes('--teste');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mercado-'));
const curl = (url, ...a) => execFileSync('curl', ['-sfL', '-m', '90', '--retry', '2', '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36', ...a, url], { maxBuffer: 64 << 20 });
const br = (s) => +String(s).trim().replace(/\./g, '').replace(',', '.');
const r4 = (v) => +v.toFixed(4);
const anterior = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

// ---------- ABICOM (diário) ----------
function ocr(img) {
  const bin = path.join(DIR, 'tools/ocr');
  if (!fs.existsSync(bin)) execFileSync('swiftc', ['-O', path.join(DIR, 'tools/ocr.swift'), '-o', bin]);
  return execFileSync(bin, [img]).toString().trim().split('\n').map((l) => {
    const [x, y, w, h, ...t] = l.split('\t');
    return { cx: +x + +w / 2, cy: +y + +h / 2, t: t.join('\t') };
  });
}

const POLOS = [['Itaqui', 'MA', 'Petrobras'], ['Suape', 'PE', 'Petrobras'], ['Paulínia', 'SP', 'Petrobras'], ['Araucária', 'PR', 'Petrobras'], ['Itacoatiara', 'AM', 'Petrobras'], ['Aratu', 'BA', 'Acelen']];

export function lerAbicom(ws) {
  const linhas = (re) => ws.filter((w) => re.test(w.t)).sort((a, b) => a.cy - b.cy).map((w) => w.cy);
  const [pd, pg] = linhas(/^Pre[çc]o \(R/), [id, ig] = linhas(/^PPI \(R/), [dd, dg] = linhas(/^Defasagem \(R/), [cd, cg] = linhas(/^% Defasado/);
  if ([pd, pg, id, ig, dd, dg, cd, cg].some((v) => v == null)) throw new Error('rótulos da tabela não encontrados');
  const polos = POLOS.map(([nome, uf, empresa]) => {
    const h = ws.find((w) => w.t.trim() === nome);
    if (!h) throw new Error('polo não encontrado: ' + nome);
    const cel = (y, re) => {
      const w = ws.find((w) => Math.abs(w.cx - h.cx) < 45 && Math.abs(w.cy - y) < 8 && re.test(w.t));
      if (!w) throw new Error(`${nome}: célula vazia`);
      return w.t.match(re)[0];
    };
    const prod = (p, i, d, c) => {
      const v = { preco: br(cel(p, /-?\d+,\d{4}/)), ppi: br(cel(i, /-?\d+,\d{4}/)), defasagem: br(cel(d, /-?\d+,\d{4}/)), pct: parseInt(cel(c, /-?\d+(?=%)/)) };
      // the table must be internally consistent; one bad OCR digit fails the whole read
      if (Math.abs(v.preco - v.ppi - v.defasagem) > 0.0015) throw new Error(`${nome}: preço − PPI ≠ defasagem (${JSON.stringify(v)})`);
      if (Math.abs((v.defasagem / v.preco) * 100 - v.pct) > 1.5) throw new Error(`${nome}: % não confere (${JSON.stringify(v)})`);
      return v;
    };
    return { polo: nome, uf, empresa, diesel: prod(pd, id, dd, cd), gasolina: prod(pg, ig, dg, cg) };
  });
  const media = (ps, k) => ({ defasagem: r4(ps.reduce((s, p) => s + p[k].defasagem, 0) / ps.length) });
  const petro = polos.filter((p) => p.empresa === 'Petrobras');
  return { polos, media_petrobras: { diesel: media(petro, 'diesel'), gasolina: media(petro, 'gasolina') }, media_principais: { diesel: media(polos, 'diesel'), gasolina: media(polos, 'gasolina') } };
}

async function abicom() {
  const slug = curl('https://abicom.com.br/categoria/ppi/').toString().match(/ppi-(\d{2})-(\d{2})-(\d{4})/);
  if (!slug) throw new Error('post PPI não encontrado');
  const data = `${slug[3]}-${slug[2]}-${slug[1]}`;
  if (anterior.abicom?.data === data) return anterior.abicom;
  const url = `https://abicom.com.br/ppi/${slug[0]}/`;
  const post = curl(url).toString();
  const imgs = [...new Set(post.match(new RegExp(`https://abicom\\.com\\.br/src/uploads/${slug[3]}/${slug[2]}/[^"'\\s>]+\\.(?:jpe?g|png)`, 'gi')) || [])]
    .filter((s) => !/-\d{2,4}x\d{2,4}\.\w+$/.test(s) && !/logo|tag/i.test(s));
  for (const src of imgs) {
    const f = path.join(TMP, path.basename(src));
    curl(src, '-o', f);
    const ws = ocr(f);
    if (ws.some((w) => /ACOMPANHAMENTO/i.test(w.t))) return { data, fonte: url, ...lerAbicom(ws) };
  }
  throw new Error('tabela "Acompanhamento diário" não encontrada nas imagens do post ' + data);
}

// ---------- ANP: PPI semanal por ponto (S&P Global) × preço Petrobras no ponto ----------
const xls = (url) => { const f = path.join(TMP, path.basename(url)); curl(url, '-o', f); const w = XLSX.readFile(f); return w; };
const linhasAba = (w, aba) => XLSX.utils.sheet_to_json(w.Sheets[aba], { header: 1, raw: false });
// ANP point → Petrobras supply point in the official table (only exact/obvious matches)
const PETRO_PONTO = { Manaus: 'Itacoatiara', Itaqui: 'São Luís', Suape: 'Ipojuca', Santos: 'Santos', Paranagua: 'Paranaguá', 'Duque de Caxias': 'Duque de Caxias', Betim: 'Betim', 'Cubatão': 'Cubatão', 'Paulínia': 'Paulínia', 'São José dos Campos': 'São José dos Campos', 'Araucária': 'Araucária', Canoas: 'Canoas' };
const UF_PONTO = { Manaus: 'AM', Itaqui: 'MA', Suape: 'PE', Aratu: 'BA', Santos: 'SP', Paranagua: 'PR', Tramandai: 'RS', 'Guamaré': 'RN', 'Duque de Caxias': 'RJ', Betim: 'MG', 'Cubatão': 'SP', 'Mauá': 'SP', 'Paulínia': 'SP', 'São José dos Campos': 'SP', 'Araucária': 'PR', Canoas: 'RS' };

function ppiAnp() {
  const w = xls('https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arq-ppi/ppi.xlsx');
  const petro = JSON.parse(fs.readFileSync(path.join(DIR, 'petrobras-distribuidoras.json'), 'utf8')).produtos;
  const minPetro = (k, local) => { const v = (petro[k]?.pontos || []).filter((x) => x.local === local).map((x) => x.rs_l); return v.length ? Math.min(...v) : null; };
  const aba = (re) => {
    const r = linhasAba(w, w.SheetNames.find((n) => re.test(n)));
    const hi = r.findIndex((l) => l.some((c) => /^Data$/i.test(String(c ?? '').trim())));
    const col0 = r[hi].findIndex((c) => /^Data$/i.test(String(c ?? '').trim()));
    const nomes = []; for (let i = col0 + 1; r[hi][i]; i++) nomes.push(String(r[hi][i]).trim());
    const dados = r.slice(hi + 1).filter((l) => /\d{2}\/\d{2}\/\d{4}/.test(l[col0] || ''));
    const ult = dados[dados.length - 1], pen = dados[dados.length - 2];
    return { semana: String(ult[col0]).trim().replace(/\s+A\s+/i, ' a '), v: Object.fromEntries(nomes.map((n, i) => [n, [+ult[col0 + 1 + i], +pen[col0 + 1 + i]]])) };
  };
  const g = aba(/Gasolina/i), d = aba(/Diesel/i);
  const pontos = Object.keys(g.v).map((n) => {
    const local = PETRO_PONTO[n];
    const [pg, pga] = g.v[n], [pd, pda] = d.v[n];
    const gas = minPetro('gasolina_a', local), s10 = minPetro('diesel_s10', local);
    return { ponto: n === 'Paranagua' ? 'Paranaguá' : n === 'Tramandai' ? 'Tramandaí' : n, uf: UF_PONTO[n] || '', local_petrobras: local || null,
      gasolina: { ppi: pg, ppi_ant: pga, petrobras: gas, arbitragem: gas == null ? null : r4(gas - pg) },
      diesel_s10: { ppi: pd, ppi_ant: pda, petrobras: s10, arbitragem: s10 == null ? null : r4(s10 - pd) } };
  });
  if (pontos.length < 10 || pontos.some((p) => !(p.gasolina.ppi > 1.5 && p.gasolina.ppi < 9 && p.diesel_s10.ppi > 1.5 && p.diesel_s10.ppi < 12))) throw new Error('PPI ANP fora da faixa ou layout mudou');
  if (g.semana !== d.semana) throw new Error(`semanas diferentes: ${g.semana} × ${d.semana}`);
  return { semana: g.semana, fonte: 'https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/precos-de-paridade-de-importacao', pontos };
}

// ---------- ANP: preço médio de produtores e importadores por região ----------
function produtor() {
  const w = xls('https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/ppidp/precos-medios-ponderados-semanais-2013.xls');
  const r = linhasAba(w, w.SheetNames[0]);
  const REG = ['Norte', 'Nordeste', 'Centro-Oeste', 'Sul', 'Sudeste', 'Brasil'];
  const iso = (s) => { const [m, d, y] = s.split('/'); return `20${y.slice(-2)}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };
  const prod = (re) => {
    const ls = r.filter((l) => re.test(l[0] || '') && /\d+\/\d+\/\d+/.test(l[1] || ''));
    const [a, u] = ls.slice(-2);
    const reg = (l) => Object.fromEntries(REG.map((k, i) => [k, /^\d/.test(l[3 + i] || '') ? +(+l[3 + i]).toFixed(4) : null]));
    return { de: iso(u[1]), ate: iso(u[2]), regioes: reg(u), anterior: reg(a) };
  };
  const out = { gasolina_a: prod(/^Gasolina A Comum/), diesel_s10: prod(/^Óleo Diesel S-10 /), diesel_s500: prod(/^Óleo Diesel S-500 /), biodiesel: prod(/^Biodiesel B-100/) };
  for (const [k, p] of Object.entries(out)) if (!(p.regioes.Brasil > 1.5 && p.regioes.Brasil < 10)) throw new Error(`${k}: média Brasil fora da faixa`);
  return { ...out, fonte: 'https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/precos-de-produtores-e-importadores-de-derivados-de-petroleo-e-biodiesel' };
}

// ---------- CEPEA etanol ----------
function cepea() {
  const tabelas = (pag) => {
    const s = curl(`https://www.cepea.org.br/br/indicador/${pag}.aspx`).toString();
    return [...s.matchAll(/<table[^>]*id="imagenet-indicador\d"[^>]*>([\s\S]*?)<\/table>/g)].map((t) =>
      [...t[1].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) => [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim())).slice(1));
  };
  const ind = (tab) => {
    const v = (row) => { const n = br(row[1]); return +(n > 100 ? n / 1000 : n).toFixed(4); }; // R$/m³ → R$/L
    const o = { periodo: tab[0][0], rs_l: v(tab[0]), anterior: tab[1] ? v(tab[1]) : null };
    if (!(o.rs_l > 1 && o.rs_l < 6)) throw new Error('etanol fora da faixa: ' + JSON.stringify(o));
    return o;
  };
  const [dia] = tabelas('etanol-diario-paulinia'), sp = tabelas('etanol'), mt = tabelas('etanol-semanal-mt');
  return { hidratado_paulinia_diario: ind(dia), hidratado_sp: ind(sp[0]), anidro_sp: ind(sp[1]), hidratado_mt: ind(mt[0]), anidro_mt: ind(mt[1]), fonte: 'https://www.cepea.org.br/br/indicador/etanol.aspx' };
}

const out = { atualizado_em: new Date().toISOString() };
const erros = [];
for (const [k, fn] of Object.entries({ abicom, ppi_anp: ppiAnp, produtor, etanol: cepea })) {
  try { out[k] = await fn(); } catch (e) { erros.push(`${k}: ${e.message}`); if (anterior[k]) out[k] = anterior[k]; }
}
fs.rmSync(TMP, { recursive: true, force: true });
if (erros.length) console.error('AVISO (mantido o anterior):\n  ' + erros.join('\n  '));
if (TESTE) console.log(JSON.stringify(out, null, 1));
else if (JSON.stringify({ ...out, atualizado_em: 0 }) === JSON.stringify({ ...anterior, atualizado_em: 0 })) console.log('mercado.json: sem mudança');
else if (Object.keys(out).length > 1) {
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('mercado.json:', ['abicom', 'ppi_anp', 'produtor', 'etanol'].map((k) => `${k} ${out[k] ? '✓' : '✗'}`).join(' · '), out.abicom ? `· ABICOM ${out.abicom.data}` : '');
}
