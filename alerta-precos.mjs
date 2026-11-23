// Daily Telegram alert for the "Quem fica com o quê" numbers (MT).
// Reads data.json + custo-distribuicao.json straight from GitHub main (fresh right
// after the workflows commit, no wait for the hourly deploy), compares with the
// snapshot saved on the previous run, and sends one message only if something moved.
//
// Runs from launchd once a day (com.ramses.monitor-alerta). Keys come from
// ~/.config/castoldi/chaves.env via `node --env-file`.
//   node --env-file=... alerta-precos.mjs        → compare, send, save snapshot
//   node --env-file=... alerta-precos.mjs --dry  → print message only, touch nothing

import fs from 'node:fs';

const UF = 'MT'; // ponytail: one state; turn into a list if other UFs need alerts
const RAW = 'https://raw.githubusercontent.com/ramsescastoldi/monitor-precos-lumen-painel/main/';
const ESTADO = new URL('.alerta-estado.json', import.meta.url);
const DRY = process.argv.includes('--dry');

const get = async (f) => {
  const r = await fetch(RAW + f + '?t=' + Date.now());
  if (!r.ok) throw new Error(f + ' HTTP ' + r.status);
  return r.json();
};

// snapshot: { produto: { nível: R$ } } — same numbers the site shows
function snapshot(data, custo) {
  const comp = custo.estados?.[UF] || {};
  const dist = data.distribuicao_estado?.[UF] || {};
  const bomba = data.agregados_estado?.[UF] || {};
  const s = {
    'Gasolina':  { distribuidora: comp.gasolina?.custo_antes_dist, petrobras: comp.gasolina?.parcela_petrobras?.rs, posto_paga: dist.gasolina, bomba: bomba.gasolina?.media },
    'Diesel S10': { distribuidora: comp.diesel?.custo_antes_dist, petrobras: comp.diesel?.parcela_petrobras?.rs, posto_paga: dist.s10, bomba: bomba.s10?.media },
    'Diesel S500': { posto_paga: dist.s500, bomba: bomba.s500?.media },
    'Etanol':    { posto_paga: dist.etanol, bomba: bomba.etanol?.media },
  };
  for (const p of Object.values(s)) {
    for (const k of Object.keys(p)) if (p[k] == null) delete p[k]; else p[k] = +(+p[k]).toFixed(3);
    if (p.posto_paga != null && p.bomba != null) p.margem_posto = +(p.bomba - p.posto_paga).toFixed(3);
    if (p.posto_paga != null && p.distribuidora != null) p.margem_distribuidora = +(p.posto_paga - p.distribuidora).toFixed(3);
  }
  return s;
}

const NOME = { petrobras: 'Petrobras (refinaria)', distribuidora: 'Custo distribuidora', posto_paga: 'Posto paga', bomba: 'Bomba (ANP)', margem_distribuidora: 'Margem distribuidora', margem_posto: 'Margem posto' };
const brl = (v) => v.toFixed(2).replace('.', ',');
const pct = (a, b) => { const p = (b - a) / Math.abs(a) * 100; return (p > 0 ? '+' : '') + p.toFixed(1).replace('.', ',') + '%'; };

// lines only for levels that moved at least 1 centavo
export function diff(antes, agora) {
  const out = [];
  for (const [prod, niveis] of Object.entries(agora)) {
    const linhas = [];
    for (const [k, v] of Object.entries(niveis)) {
      const a = antes?.[prod]?.[k];
      if (a == null || Math.abs(v - a) < 0.01) continue;
      linhas.push(`• ${NOME[k]}: R$ ${brl(a)} → R$ ${brl(v)} (${pct(a, v)})`);
    }
    if (linhas.length) out.push(`<b>${prod}</b>\n` + linhas.join('\n'));
  }
  return out;
}

async function telegram(texto) {
  const token = process.env.TELEGRAM_MAESTRO_BOT_TOKEN;
  const chat = process.env.TELEGRAM_MAESTRO_CHAT || process.env.TELEGRAM_RAMSES_CHAT;
  if (!token || !chat) throw new Error('TELEGRAM_MAESTRO_BOT_TOKEN / chat ausentes no cofre');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error('Telegram HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

const [data, custo] = await Promise.all([get('data.json'), get('custo-distribuicao.json')]);
const agora = snapshot(data, custo);
const antes = fs.existsSync(ESTADO) ? JSON.parse(fs.readFileSync(ESTADO, 'utf8')).valores : null;
const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Cuiaba' });

let msg = null;
if (!antes) {
  // first run: baseline so he sees it is alive
  const linhas = Object.entries(agora).map(([p, n]) => `<b>${p}</b>\n` + Object.entries(n).map(([k, v]) => `• ${NOME[k]}: R$ ${brl(v)}`).join('\n'));
  msg = `⛽ <b>Monitor ${UF} — alerta diário ligado</b> (${hoje})\nValores de partida. Daqui pra frente só aviso quando mudar.\n\n` + linhas.join('\n\n');
} else {
  const blocos = diff(antes, agora);
  if (blocos.length) msg = `⛽ <b>Monitor ${UF} — mudança de preço</b> (${hoje})\n\n` + blocos.join('\n\n') +
    `\n\nmonitor.lumenclubpainel.com.br`;
}

if (DRY) { console.log(msg || 'sem mudança'); process.exit(0); }
if (msg) await telegram(msg);
fs.writeFileSync(ESTADO, JSON.stringify({ em: new Date().toISOString(), valores: agora }, null, 1));
console.log(new Date().toISOString(), msg ? 'enviado' : 'sem mudança');
