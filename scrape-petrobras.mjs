// Scraper da composição oficial do preço por estado (site público de preços da Petrobras).
// Sem banco: gera custo-distribuicao.json direto no repo (mesmo padrão do data.json).
//
// Por UF e produto (gasolina/diesel), extrai da página /w/preco-<produto>-<uf>:
//   - preco_medio (bomba, média estadual da semana)
//   - parcelas: parcela_petrobras (refinaria), etanol_anidro OU biodiesel,
//     imposto_estadual, impostos_federais, dist_revenda (margem distribuição+revenda)
//   - custo_antes_dist = preco_medio - dist_revenda  → custo estimado do litro
//     "na porta" antes da margem de distribuição+revenda
//   - período de coleta (semana de referência)
//
// Proteção: se menos de MIN_OK estados parsearem, NÃO sobrescreve o JSON e sai com erro.

import fs from 'node:fs';

const BASE = 'https://precos.petrobras.com.br';
// Estados onde a Petrobras tem ponto de fornecimento (páginas publicadas no site)
const UFS = ['AL', 'AM', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MG', 'PR', 'PB', 'PA', 'PE', 'RS', 'RJ', 'SC', 'SP'];
const PRODUTOS = [
  { key: 'gasolina', urlUf: (uf) => `${BASE}/w/preco-gasolina-${uf.toLowerCase()}`, urlBr: `${BASE}/precos-gasolina` },
  { key: 'diesel', urlUf: (uf) => `${BASE}/w/preco-diesel-${uf.toLowerCase()}`, urlBr: `${BASE}/precos-diesel` }
];
const MIN_OK = 10; // mínimo de UFs com parse completo pra publicar
const OUT = 'custo-distribuicao.json';

async function fetchHtml(url) {
  for (let tent = 1; tent <= 3; tent++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LumenMonitorBot/1.0)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (tent === 3) throw e;
      await new Promise(r => setTimeout(r, 2000 * tent));
    }
  }
}

function num(s) {
  const n = parseFloat(String(s).replace(',', '.'));
  return isNaN(n) ? null : Number(n.toFixed(2));
}

// Parseia a composição a partir do texto sem tags.
// Formato no site: "R$ 1,79 Distribuição e Revenda ( 27,4 %) R$ 0,74 Custo Etanol Anidro ( 11,3 %) ..."
function parseComposicao(html, produto) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/\s+/g, ' ');

  const parcela = (labelRe) => {
    const re = new RegExp('R\\$\\s*([\\d.,]+)\\s*(?:' + labelRe + ')\\s*\\(\\s*([\\d.,]+)\\s*%\\s*\\)', 'i');
    const m = text.match(re);
    return m ? { rs: num(m[1]), pct: num(m[2]) } : null;
  };

  const mMedio = text.match(/Pre[çc]o m[ée]dio\s*>\s*(?:BR\s*)?([\d.,]+)/i);
  const preco_medio = mMedio ? num(mMedio[1]) : null;

  const dist_revenda = parcela('Distribui[cç][aã]o e Revenda');
  const imposto_estadual = parcela('Imposto Estadual');
  const impostos_federais = parcela('Impostos Federais');
  const parcela_petrobras = parcela('Parcela Petrobras');
  const mistura = produto === 'gasolina'
    ? parcela('(?:Custo )?Etanol Anidro')
    : parcela('Biodiesel');

  const mPer = text.match(/Per[íi]odo de coleta de (\d{2}\/\d{2}\/\d{4}) a (\d{2}\/\d{2}\/\d{4})/i);

  // preco_medio < 2 = página sem dado (o site às vezes publica zeros, ex: PB/diesel)
  if (preco_medio == null || preco_medio < 2 || !dist_revenda || dist_revenda.rs <= 0 || !imposto_estadual || !impostos_federais || !parcela_petrobras || !mistura) {
    return null;
  }

  // Sanidade: soma das parcelas tem que bater com o preço médio (±0,06 por arredondamento)
  const soma = dist_revenda.rs + mistura.rs + imposto_estadual.rs + impostos_federais.rs + parcela_petrobras.rs;
  if (Math.abs(soma - preco_medio) > 0.06) {
    console.warn(`  AVISO: soma das parcelas (${soma.toFixed(2)}) difere do preço médio (${preco_medio}) — descartando`);
    return null;
  }

  const toIso = (d) => { const [dd, mm, yy] = d.split('/'); return `${yy}-${mm}-${dd}`; };
  return {
    preco_medio,
    custo_antes_dist: Number((preco_medio - dist_revenda.rs).toFixed(2)),
    dist_revenda,
    [produto === 'gasolina' ? 'etanol_anidro' : 'biodiesel']: mistura,
    imposto_estadual,
    impostos_federais,
    parcela_petrobras,
    periodo: mPer ? { de: toIso(mPer[1]), ate: toIso(mPer[2]) } : null
  };
}

(async () => {
  const estados = {};
  let brasil = {};
  let okCount = 0, falhas = [];

  for (const p of PRODUTOS) {
    // Média Brasil (página principal do produto)
    try {
      const html = await fetchHtml(p.urlBr);
      const c = parseComposicao(html, p.key);
      if (c) brasil[p.key] = c;
    } catch (e) {
      console.warn(`BR/${p.key}: ${e.message}`);
    }

    for (const uf of UFS) {
      try {
        const html = await fetchHtml(p.urlUf(uf));
        const c = parseComposicao(html, p.key);
        if (c) {
          if (!estados[uf]) estados[uf] = {};
          estados[uf][p.key] = c;
          okCount++;
          console.log(`${uf}/${p.key}: média ${c.preco_medio} · dist+rev ${c.dist_revenda.rs} · custo antes ${c.custo_antes_dist}`);
        } else {
          falhas.push(`${uf}/${p.key} (parse)`);
        }
      } catch (e) {
        falhas.push(`${uf}/${p.key} (${e.message})`);
      }
      await new Promise(r => setTimeout(r, 400)); // educado com o servidor
    }
  }

  const ufsCompletas = Object.keys(estados).filter(uf => estados[uf].gasolina && estados[uf].diesel);
  console.log(`\nParse OK: ${okCount} páginas · UFs completas: ${ufsCompletas.length} (${ufsCompletas.join(', ')})`);
  if (falhas.length) console.warn(`Falhas: ${falhas.join(', ')}`);

  if (ufsCompletas.length < MIN_OK) {
    console.error(`ERRO: só ${ufsCompletas.length} UFs completas (mínimo ${MIN_OK}). NÃO sobrescrevendo ${OUT}.`);
    process.exit(1);
  }

  const out = {
    atualizado_em: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    periodo: estados.SP?.gasolina?.periodo || brasil.gasolina?.periodo || null,
    brasil,
    estados
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nOK: ${OUT} gerado (${ufsCompletas.length} UFs + Brasil).`);
})().catch(e => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
