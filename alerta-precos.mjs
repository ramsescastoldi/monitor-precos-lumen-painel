// Daily Telegram alert for the "Quem fica com o quê" numbers, every state with
// distributor or cost data. The text is laid out by region and state with WhatsApp
// *bold*, so Ramsés can paste it into the group as is: members find their own
// state there (no individual sends; WhatsApp bulk is forbidden since 16/11).
// Reads data.json + custo-distribuicao.json straight from GitHub main (fresh right
// after the workflows commit, no wait for the hourly deploy), compares with the
// snapshot saved on the previous run, and sends one message only if something moved.
//
// Runs from launchd once a day (com.ramses.monitor-alerta). Keys come from
// ~/.config/castoldi/chaves.env via `node --env-file`.
//   node --env-file=... alerta-precos.mjs        → compare, send, save snapshot
//   node --env-file=... alerta-precos.mjs --dry  → print message only, touch nothing

import fs from 'node:fs';

const REGIAO = { Norte: 'AC AM AP PA RO RR TO', Nordeste: 'AL BA CE MA PB PE PI RN SE', 'Centro-Oeste': 'DF GO MS MT', Sudeste: 'ES MG RJ SP', Sul: 'PR RS SC' };
const RAW = 'https://raw.githubusercontent.com/ramsescastoldi/monitor-precos-lumen-painel/main/';
const ESTADO = new URL('.alerta-estado.json', import.meta.url);
const DRY = process.argv.includes('--dry');

const get = async (f) => {
  const r = await fetch(RAW + f + '?t=' + Date.now());
  if (!r.ok) throw new Error(f + ' HTTP ' + r.status);
  return r.json();
};

// snapshot: { "UF|produto": { nível: R$ } } — same numbers the site shows; "BR|…" = national
function snapshot(data, custo, nfce, petro) {
  const s = {};
  const ufs = new Set([...Object.keys(data.distribuicao_estado || {}), ...Object.keys(custo.estados || {})]);
  for (const uf of ufs) {
    const comp = custo.estados?.[uf] || {};
    const dist = data.distribuicao_estado?.[uf] || {};
    const bomba = data.agregados_estado?.[uf] || {};
    s[uf + '|Gasolina'] = { distribuidora: comp.gasolina?.custo_antes_dist, petrobras: comp.gasolina?.parcela_petrobras?.rs, posto_paga: dist.gasolina, bomba: bomba.gasolina?.media };
    s[uf + '|Diesel S10'] = { distribuidora: comp.diesel?.custo_antes_dist, petrobras: comp.diesel?.parcela_petrobras?.rs, posto_paga: dist.s10, bomba: bomba.s10?.media };
    s[uf + '|Diesel S500'] = { posto_paga: dist.s500, bomba: bomba.s500?.media };
    s[uf + '|Etanol'] = { posto_paga: dist.etanol, bomba: bomba.etanol?.media };
  }
  // pump average from state NFC-e tools (scrape-nfce.mjs), one block per state
  for (const [uf, e] of Object.entries(nfce?.estados || {}))
    s[uf + '|Bomba média (notas fiscais)'] = { gasolina: e.gasolina?.media, etanol: e.etanol?.media, s10: e.s10?.media, s500: e.s500?.media };
  // Petrobras price to distributors (scrape-petrobras-tabela.mjs): Brazil average + each supply point (cheapest modality)
  const P = petro?.produtos || {};
  const media = (k) => { const v = (P[k]?.pontos || []).map((x) => x.rs_l); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  if (P.gasolina_a) {
    s['BR|Petrobras → distribuidoras (média Brasil)'] = { gasolina_a: media('gasolina_a'), diesel_s10: media('diesel_s10'), diesel_s500: media('diesel_s500') };
    for (const k of ['gasolina_a', 'diesel_s10', 'diesel_s500'])
      for (const x of P[k]?.pontos || []) {
        const b = (s[x.uf + '|Petrobras → distribuidoras'] ??= {}), c = `${NOME[k]} ${x.local}`;
        if (b[c] == null || x.rs_l < b[c]) b[c] = x.rs_l;
      }
  }
  for (const p of Object.values(s)) {
    for (const k of Object.keys(p)) if (p[k] == null) delete p[k]; else p[k] = +(+p[k]).toFixed(3);
    if (p.posto_paga != null && p.bomba != null) p.margem_posto = +(p.bomba - p.posto_paga).toFixed(3);
    if (p.posto_paga != null && p.distribuidora != null) p.margem_distribuidora = +(p.posto_paga - p.distribuidora).toFixed(3);
  }
  return s;
}

const NOME = { petrobras: 'Petrobras (refinaria)', distribuidora: 'Custo distribuidora', posto_paga: 'Posto paga', bomba: 'Bomba (ANP)', margem_distribuidora: 'Margem distribuidora', margem_posto: 'Margem posto',
  gasolina: 'Gasolina', etanol: 'Etanol', s10: 'Diesel S10', s500: 'Diesel S500',
  gasolina_a: 'Gasolina A', diesel_s10: 'Diesel S10', diesel_s500: 'Diesel S500' };
const brl = (v) => v.toFixed(2).replace('.', ',');
const pct = (a, b) => { const p = (b - a) / Math.abs(a) * 100; return (p > 0 ? '+' : '') + p.toFixed(1).replace('.', ',') + '%'; };

// lines only for levels that moved at least 1 centavo, grouped region → state → product
// (a level with no previous value is a new baseline: saved, not announced)
export function diff(antes, agora) {
  const uf = {};
  for (const [chave, niveis] of Object.entries(agora)) {
    const linhas = [];
    for (const [k, v] of Object.entries(niveis)) {
      const a = antes?.[chave]?.[k];
      if (a == null || Math.abs(v - a) < 0.01) continue;
      linhas.push(`• ${NOME[k] || k}: R$ ${brl(a)} → R$ ${brl(v)} (${pct(a, v)})`);
    }
    const [u, prod] = chave.split('|');
    if (linhas.length) (uf[u] ??= []).push(`${prod}\n` + linhas.join('\n'));
  }
  const out = [];
  if (uf.BR) out.push('*BRASIL*\n' + uf.BR.join('\n\n'));
  for (const [reg, lista] of Object.entries(REGIAO)) {
    const est = lista.split(' ').filter((u) => uf[u]).map((u) => `*${u}*\n` + uf[u].join('\n\n'));
    if (est.length) out.push(`*${reg.toUpperCase()}*\n\n` + est.join('\n\n'));
  }
  return out;
}

// plain text (WhatsApp *bold* survives copy-paste); split at region boundaries under Telegram's 4096 limit
async function telegram(blocos) {
  const msgs = [''];
  for (const b of blocos) msgs[msgs.length - 1].length + b.length > 3900 ? msgs.push(b) : (msgs[msgs.length - 1] += (msgs[msgs.length - 1] ? '\n\n' : '') + b);
  for (const m of msgs) await enviar(m);
}
async function enviar(texto) {
  const token = process.env.TELEGRAM_MAESTRO_BOT_TOKEN;
  const chat = process.env.TELEGRAM_MAESTRO_CHAT || process.env.TELEGRAM_RAMSES_CHAT;
  if (!token || !chat) throw new Error('TELEGRAM_MAESTRO_BOT_TOKEN / chat ausentes no cofre');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error('Telegram HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

const [data, custo, nfce, petro] = await Promise.all([get('data.json'), get('custo-distribuicao.json'), get('municipios-nfce.json').catch(() => null), get('petrobras-distribuidoras.json').catch(() => null)]);
const agora = snapshot(data, custo, nfce, petro);
const antes = fs.existsSync(ESTADO) ? JSON.parse(fs.readFileSync(ESTADO, 'utf8')).valores : null;
const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Cuiaba' });

// first run (no snapshot): silent baseline
const blocos = antes ? diff(antes, agora) : [];
const msg = blocos.length ? [`⛽ *Monitor de Preços — mudanças por região* (${hoje})\nProcure o seu estado 👇`, ...blocos, 'monitor.lumenclubpainel.com.br'] : null;

if (DRY) { console.log(msg ? msg.join('\n\n') : 'sem mudança'); process.exit(0); }
if (msg) await telegram(msg);
fs.writeFileSync(ESTADO, JSON.stringify({ em: new Date().toISOString(), valores: agora }, null, 1));
console.log(new Date().toISOString(), msg ? 'enviado' : 'sem mudança');
