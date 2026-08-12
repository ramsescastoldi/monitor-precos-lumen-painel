// Economiza Alagoas (AL) — preços por posto via NFC-e, quase tempo real.
// API pública oficial da Sefaz/AL: POST .../combustivel/pesquisa com header AppToken
// (token pedido por e-mail a api@sefaz.al.gov.br, guardado em ECONOMIZA_AL_TOKEN).
// Pegadinha: o WAF do gateway devolve 403 "signature" pra requisição sem
// User-Agent de navegador — o token nem chega a ser avaliado.
// Mesmo papel do Preço da Hora na BA: enriquece a camada de pesquisa da UF.

const URL_PESQUISA = 'http://api.sefaz.al.gov.br/sfz-economiza-alagoas-api/api/public/combustivel/pesquisa';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// tipos aceitos pela API; 6 = GNV, que o radar não exibe por posto hoje
const TIPOS = { 1: 'gc', 2: 'ga', 3: 'et', 4: 'd500', 5: 'd10' };
const POR_PAGINA = 50;          // 10 é recusado: o intervalo permitido começa acima
const MAX_PAGINAS = 6;
const DIAS = 3;

const pausa = ms => new Promise(r => setTimeout(r, ms));
const digitos = s => String(s || '').replace(/\D/g, '');

async function consultar(token, { ibge, tipo, pagina }) {
  const r = await fetch(URL_PESQUISA, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', AppToken: token },
    body: JSON.stringify({
      produto: { tipoCombustivel: tipo },
      estabelecimento: { municipio: { codigoIBGE: ibge } },
      dias: DIAS, pagina, registrosPorPagina: POR_PAGINA
    })
  });
  if (r.status === 429) return { limitado: true };
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}

// Despeja o `conteudo` de uma resposta no mapa de postos. Exportada porque é aqui
// que a coleta quebra em silêncio (tipo errado, preço rateado, posto sem geo).
export function absorverConteudo(conteudo, tipo, postos, { titulo, slug, cidade = {} }) {
  let achou = 0;
  for (const reg of conteudo || []) {
    const est = reg.estabelecimento || {};
    const end = est.endereco || {};
    const venda = reg.produto?.venda || {};
    const cnpj = digitos(est.cnpj);
    // valorVenda vem rateado por desconto da NFC-e; o preço de bomba é o declarado
    const preco = +(venda.valorDeclarado ?? venda.valorVenda);
    const quando = String(venda.dataVenda || '');
    const data = quando.slice(0, 10);
    let comb = TIPOS[tipo];
    // posto que cadastra S10 no tipo "diesel comum" é comum — a descrição decide
    if (comb === 'd500' && /S\s*-?\s*10/i.test(reg.produto?.descricao || '')) comb = 'd10';
    if (!comb || !cnpj || !data || isNaN(preco) || preco < 0.5 || preco > 30) continue;
    achou++;

    const posto = postos.get(cnpj) || {
      n: titulo(est.nomeFantasia || est.razaoSocial),
      b: '',
      mu: titulo(end.municipio || cidade.mu),
      m: end.municipio ? slug(end.municipio) : cidade.m,
      e: titulo([end.nomeLogradouro, end.numeroImovel].filter(Boolean).join(', ') +
                (end.bairro ? ' - ' + end.bairro : '')),
      p: {},
      // posto sem geocodificação vem com 0/0 (ilha no Golfo da Guiné) — descarta
      lat: end.latitude || null,
      lng: end.longitude || null
    };
    const atual = posto.p[comb];
    // NFC-e mais recente do posto = preço de bomba vigente
    if (!atual || atual._t < quando) posto.p[comb] = { v: +preco.toFixed(2), d: data, _t: quando };
    postos.set(cnpj, posto);
  }
  return achou;
}

// cidades: [{ mu, m, ibge }] — as maiores primeiro, pro parcial do deadline valer mais.
// titulo/slug: mesmos helpers do export-radar.
// Retorna Map<cnpjDigitos, { n, b, mu, m, e, p:{comb:{v,d}}, lat, lng }>
export async function coletarEconomizaAL(cidades, opts) {
  const { titulo, slug, log = console.log } = opts;
  const token = opts.token || process.env.ECONOMIZA_AL_TOKEN;
  if (!token) throw new Error('ECONOMIZA_AL_TOKEN ausente');
  const pausaMs = +(opts.pausaMs || process.env.AL_PAUSA_MS || 1200);
  const deadlineMin = +(opts.deadlineMin || process.env.AL_DEADLINE_MIN || 25);
  const fim = Date.now() + deadlineMin * 60000;

  const postos = new Map();
  let requisicoes = 0, erros = 0, cidadesOk = 0;

  for (const cidade of cidades) {
    if (Date.now() > fim) { log('  AL: deadline — devolvendo parcial'); break; }
    let achouCidade = 0;
    for (const tipo of Object.keys(TIPOS).map(Number)) {
      if (Date.now() > fim) break;
      let totalPaginas = 1;
      for (let pagina = 1; pagina <= Math.min(totalPaginas, MAX_PAGINAS); pagina++) {
        if (Date.now() > fim) break;
        await pausa(pausaMs);
        let json;
        try { json = await consultar(token, { ibge: cidade.ibge, tipo, pagina }); }
        catch (e) {
          erros++;
          log(`  AL ${cidade.mu} tipo ${tipo} p${pagina}: ${e.message}`);
          if (erros > 10) throw new Error('API instável — encerrando varredura');
          break;
        }
        if (json.limitado) {          // cota da Sefaz: espera e tenta a mesma página
          log('  AL: 429 — cooldown de 2 min');
          await pausa(120000);
          pagina--;
          continue;
        }
        requisicoes++;
        totalPaginas = json.totalPaginas || 1;
        achouCidade += absorverConteudo(json.conteudo, tipo, postos, { titulo, slug, cidade });
      }
    }
    if (achouCidade) cidadesOk++;
  }

  for (const posto of postos.values())
    for (const f of Object.values(posto.p)) delete f._t;
  log(`  Economiza AL: ${postos.size} postos · ${cidadesOk}/${cidades.length} cidades · ` +
      `${requisicoes} requisições`);
  return postos;
}
