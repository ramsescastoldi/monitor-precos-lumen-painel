// Auto-teste do parser do Busca Preço AM: node test_buscapreco_am.mjs
// Roda offline num HTML de resultado real salvo em fixtures/ (se existir) e nas
// regras de classificação/endereço, que é onde a coisa quebra em silêncio.
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { combDaDescricao, partesEndereco, absorverPagina, municipiosDaPagina } from './scrape-buscapreco-am.mjs';

const slug = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const titulo = s => String(s || '').toLowerCase()
  .replace(/(^|\s|\.)([a-zà-ú])/g, m => m.toUpperCase());

// classificação: descrição é texto livre do posto, e a busca traz lixo junto
assert.equal(combDaDescricao('GASOLINA COMUM'), 'gc');
assert.equal(combDaDescricao('GASOLINA ADITIVADA'), 'ga');
assert.equal(combDaDescricao('GASOLINA PODIUM'), 'ga');
assert.equal(combDaDescricao('ETANOL HIDRATADO'), 'et');
assert.equal(combDaDescricao('OLEO DIESEL B S10'), 'd10');
assert.equal(combDaDescricao('DIESEL S-10'), 'd10');
assert.equal(combDaDescricao('OLEO DIESEL B S-500 COMUM'), 'd500');
assert.equal(combDaDescricao('DIASEC 2 MG C/ 12 CP'), null);   // remédio na busca por DIESEL
assert.equal(combDaDescricao('DIESEL MARITIMO'), null);
assert.equal(combDaDescricao('ALCOOL EM GEL 70'), null);
assert.equal(combDaDescricao('ETANOL GEL LIMPEZA'), null);
assert.equal(combDaDescricao('GNV'), null);

// endereço: a chave de merge com a ANP sai daqui (tipo de logradouro fora)
const e = partesEndereco('MACEIO, NRO 132, ADRIANOPOLIS, MANAUS-AM, CEP 69057-010');
assert.equal(e.chave, 'maceio|132|manaus');
assert.equal(e.cep, '69057-010');
assert.equal(e.endereco, 'MACEIO, 132 - ADRIANOPOLIS');
assert.equal(partesEndereco('AVENIDA BRASIL, NRO 726, COMPENSA, MANAUS-AM, CEP 69030-020').chave,
  'brasil|726|manaus');   // casa com "AVENIDA BRASIL 726" da ANP
assert.equal(partesEndereco('IGARAPE DO TARUMA, PONTA NEGRA, MANAUS-AM, CEP 69037-010'), null);

// fixture opcional: HTML de resultado real gravado do site
const fix = 'fixtures/buscapreco-am-resultado.html';
if (existsSync(fix)) {
  const html = readFileSync(fix, 'latin1');
  const postos = new Map();
  const achou = absorverPagina(html, postos, { titulo, slug });
  assert.ok(achou > 0, 'fixture não rendeu nenhum preço — regex do card/modal quebrou');
  assert.ok(postos.size > 0, 'fixture não rendeu nenhum posto');
  for (const p of postos.values()) {
    assert.ok(p.n && p.mu && p.m, 'posto sem nome/município');
    for (const [comb, f] of Object.entries(p.p)) {
      assert.ok(f.v > 2 && f.v < 14, `preço fora da faixa: ${comb} ${f.v}`);
      assert.match(f.d, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  const comCoord = [...postos.values()].filter(p => p.lat != null).length;
  console.log(`fixture: ${achou} preços · ${postos.size} postos · ${comCoord} com coordenada`);
  assert.ok(municipiosDaPagina(html).length > 10, 'select de municípios não parseou');
} else {
  console.log(`(sem ${fix} — só as regras foram testadas)`);
}

console.log('ok');
