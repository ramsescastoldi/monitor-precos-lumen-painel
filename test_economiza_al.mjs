// Auto-teste do parser do Economiza Alagoas: node test_economiza_al.mjs
// Roda offline numa resposta real da API salva em fixtures/ e nas regras que
// quebram em silêncio: preço declarado x rateado, S10 no tipo errado, geo 0/0.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { absorverConteudo } from './scrape-economiza-al.mjs';

const slug = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const titulo = s => String(s || '').toLowerCase()
  .replace(/(^|\s|\.)([a-zà-ú])/g, m => m.toUpperCase());
const opts = { titulo, slug, cidade: { mu: 'Maceió', m: 'maceio' } };

// preço de bomba = valorDeclarado (valorVenda vem rateado por desconto da NFC-e)
const um = (venda, descricao = 'DIESEL S10') => ([{
  produto: { descricao, venda },
  estabelecimento: { cnpj: '15503894000100', nomeFantasia: 'POSTO SENA',
    endereco: { municipio: 'MACEIO', latitude: 0, longitude: 0 } }
}]);
let postos = new Map();
absorverConteudo(um({ dataVenda: '2026-08-12T13:20:34Z', valorDeclarado: 6.58, valorVenda: 6.19 }),
  5, postos, opts);
assert.equal(postos.get('15503894000100').p.d10.v, 6.58);
assert.equal(postos.get('15503894000100').p.d10.d, '2026-08-12');
assert.equal(postos.get('15503894000100').lat, null);   // 0/0 não é coordenada

// tipo 4 é "diesel comum", mas posto cadastra S10 lá dentro — a descrição decide
postos = new Map();
absorverConteudo(um({ dataVenda: '2026-08-12T10:00:00Z', valorDeclarado: 6.68 },
  'OLEO DIESEL S10 ADITIVADO'), 4, postos, opts);
assert.deepEqual(Object.keys(postos.get('15503894000100').p), ['d10']);
postos = new Map();
absorverConteudo(um({ dataVenda: '2026-08-12T10:00:00Z', valorDeclarado: 6.20 },
  'OLEO DIESEL B S500'), 4, postos, opts);
assert.deepEqual(Object.keys(postos.get('15503894000100').p), ['d500']);

// GNV (tipo 6) e lixo não entram; venda mais recente do posto vence
postos = new Map();
assert.equal(absorverConteudo(um({ dataVenda: '2026-08-12T10:00:00Z', valorDeclarado: 4.5 }), 6, postos, opts), 0);
assert.equal(absorverConteudo(um({ dataVenda: '2026-08-12T10:00:00Z', valorDeclarado: 99 }), 5, postos, opts), 0);
absorverConteudo(um({ dataVenda: '2026-08-10T10:00:00Z', valorDeclarado: 6.10 }), 5, postos, opts);
absorverConteudo(um({ dataVenda: '2026-08-12T10:00:00Z', valorDeclarado: 6.30 }), 5, postos, opts);
absorverConteudo(um({ dataVenda: '2026-08-11T10:00:00Z', valorDeclarado: 5.90 }), 5, postos, opts);
assert.equal(postos.get('15503894000100').p.d10.v, 6.30);

// resposta real da API (Maceió, diesel S10)
const json = JSON.parse(readFileSync('fixtures/economiza-al-diesel-s10.json', 'utf-8'));
postos = new Map();
const achou = absorverConteudo(json.conteudo, 5, postos, opts);
assert.ok(achou > 30, `fixture rendeu só ${achou} preços — parser quebrou`);
for (const p of postos.values()) {
  assert.ok(p.n && p.mu && p.m, 'posto sem nome/município');
  assert.ok(p.p.d10.v > 2 && p.p.d10.v < 14, `preço fora da faixa: ${p.p.d10.v}`);
  assert.match(p.p.d10.d, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(p.lat == null || (p.lat < 0 && p.lng < 0), 'coordenada fora do Brasil');
}
console.log(`fixture: ${achou} preços · ${postos.size} postos · ` +
  `${[...postos.values()].filter(p => p.lat != null).length} com coordenada`);
console.log('ok');
