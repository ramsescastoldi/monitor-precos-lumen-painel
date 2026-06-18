// Healthcheck de frescor do bloco VOLUMES do monitor de preços.
// Lê o data.json publicado, compara volumes.periodo_iso com o mês atual.
// A ANP publica o mês M-2 por volta do dia 1 de cada mês; o scraper roda dia 2 e 21.
// Estado saudável: periodo ~2 meses atrás. Se >= 3 meses atrás (e já passou do dia 5),
// algum ciclo de scrape falhou/não rodou → alerta Telegram.
//
// Roda via GitHub Action diária. Requer secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.

import https from 'node:https';

const URL = 'https://monitor.lumenclubpainel.com.br/data.json';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const LIMITE_MESES = 3; // alerta se periodo_iso ficar >= 3 meses atrás do mês atual

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url + '?cb=' + Date.now(), { headers: { 'User-Agent': 'lumen-freshness/1.0' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.error('Sem TELEGRAM_BOT_TOKEN/CHAT_ID — não alerta.'); return Promise.resolve(); }
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'Markdown', disable_web_page_preview: true });
  return new Promise((resolve) => {
    const req = https.request('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let s=''; res.on('data',c=>s+=c); res.on('end',()=>resolve(s)); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

(async () => {
  const now = new Date();
  const diaDoMes = now.getUTCDate();
  let data;
  try {
    data = await getJSON(URL);
  } catch (e) {
    await telegram(`🚨 *Monitor de Volumes* — data.json inacessível\n\nErro: ${e.message}\nO painel pode estar fora do ar.`);
    console.error('data.json inacessível:', e.message);
    process.exit(0); // não falha o job; já alertou
  }

  const v = data.volumes;
  if (!v || !v.periodo_iso) {
    await telegram('🚨 *Monitor de Volumes* — bloco `volumes` ausente no data.json. O scraper de volumes pode ter quebrado.');
    console.log('volumes ausente.');
    return;
  }

  const [py, pm] = v.periodo_iso.split('-').map(Number);
  const mesesAtras = (now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1)) - (py * 12 + pm);
  console.log(`periodo_iso=${v.periodo_iso} | mesesAtras=${mesesAtras} | diaDoMes=${diaDoMes}`);

  // Janela de carência: no início do mês a ANP ainda não publicou; só alerta após dia 5.
  if (mesesAtras >= LIMITE_MESES && diaDoMes >= 6) {
    await telegram(
      `⚠️ *Monitor de Volumes DESATUALIZADO*\n\n` +
      `Última referência: *${v.mes_referencia}* (${mesesAtras} meses atrás)\n` +
      `Esperado: no máximo 2 meses de defasagem.\n\n` +
      `O scraper de volumes (dia 2 e 21) pode ter falhado ou o cron foi desativado.\n` +
      `Verifique: https://github.com/ramsescastoldi/monitor-precos-lumen-painel/actions/workflows/scrape-volumes.yml`
    );
    console.log('ALERTA enviado: volumes desatualizado.');
  } else {
    console.log('OK: volumes dentro do esperado.');
  }
})();
