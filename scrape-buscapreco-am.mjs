// Busca Preço Amazonas (AM) — preços por posto via NFC-e, estado inteiro, quase
// tempo real (notas de minutos atrás). Achado na caça mensal de 12/08/2026.
//
// É um web app JSF, não uma API: GET /home entrega JSESSIONID + o <select> com os
// municípios; POST /item/grupo/page/N devolve HTML com os cards de resultado.
// O reCAPTCHA v2 está no HTML mas NÃO é validado no servidor — POST sem token
// responde 200 normalmente. Se um dia passar a validar, o POST volta a página de
// busca sem cards e a varredura devolve vazio (o export segue só com a ANP).
//
// Diferença crítica pra BA: aqui NÃO vem CNPJ. A chave de merge é o endereço
// (logradouro sem o tipo + número + município), que casou com a ANP nos testes.
// ponytail: posto cujo logradouro a ANP grafa diferente entra como posto novo
// (ex.: COTAM, "Av. Buriti" na ANP vs "Waldomiro Lustosa" na NFC-e) — duplica em
// vez de atualizar. Se incomodar, casar também por CEP+número.

const BASE = 'https://buscapreco.sefaz.am.gov.br';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TERMOS = ['GASOLINA', 'ETANOL', 'DIESEL'];
const MAX_PAGINAS = 6;
const FAIXA = { gc: [4, 12], ga: [4, 13], et: [2.5, 10], d10: [4, 13], d500: [4, 13] };
const TIPO_LOGRADOURO = /^(avenida|av|rua|r|travessa|tv|estrada|est|rodovia|rod|alameda|al|praca|pca|boulevard|blvd|bl|conjunto|cj|beco|passagem|psg|largo|via|distrito)-/;

const pausa = ms => new Promise(r => setTimeout(r, ms));

const desescapar = s => String(s || '')
  .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
  .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&acirc;/g, 'â')
  .replace(/&ecirc;/g, 'ê').replace(/&ocirc;/g, 'ô').replace(/&atilde;/g, 'ã')
  .replace(/&otilde;/g, 'õ').replace(/&ccedil;/g, 'ç').replace(/&ntilde;/g, 'ñ')
  .replace(/&agrave;/g, 'à').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();

const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const chaveRua = s => semAcento(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  .replace(TIPO_LOGRADOURO, '').replace(TIPO_LOGRADOURO, '');

// endereço da NFC-e: "MACEIO, NRO 132, ADRIANOPOLIS, MANAUS-AM, CEP 69057-010"
export function partesEndereco(bruto) {
  const e = desescapar(bruto);
  const m = e.match(/^(.*?),\s*NRO\s*([^,]*),\s*(.*),\s*([^,]+)-AM,\s*CEP\s*([\d-]+)\s*$/i);
  if (!m) return null;
  const numero = String(m[2]).replace(/\D/g, '');
  const rua = chaveRua(m[1]);
  const municipio = m[4].trim();
  if (!rua || !municipio) return null;
  return {
    rua, numero, municipio, cep: m[5],
    bairro: m[3].split(',')[0].trim(),
    chave: `${rua}|${numero}|${chaveRua(municipio)}`,
    endereco: `${m[1].trim()}, ${numero || 'S/N'}${m[3] ? ' - ' + m[3].split(',')[0].trim() : ''}`
  };
}

// mesma chave, mas montada a partir das colunas da ANP (é assim que o export
// acha o posto já existente pra atualizar em vez de duplicar)
export function chaveANP(rua, numero, municipio) {
  return `${chaveRua(rua)}|${String(numero || '').replace(/\D/g, '')}|${chaveRua(municipio)}`;
}

// descrição livre digitada pelo posto na NFC-e → combustível do radar.
// Estrito de propósito: a busca por "DIESEL" traz remédio ("DIASEC 2 MG"), e
// "ETANOL" não pode pegar álcool de limpeza.
export function combDaDescricao(descricao) {
  const d = semAcento(descricao).toUpperCase();
  if (/MARITIM|AVIACAO|QUEROSENE|ADITIVO|ARLA|GNV|GAS NATURAL|LUBRIF|GRAXA/.test(d)) return null;
  if (/GASOLINA/.test(d)) return /ADITIVAD|PODIUM|SUPREM|GRID|V-?POWER|FORMULA|PREMIUM/.test(d) ? 'ga' : 'gc';
  if (/ETANOL/.test(d)) return /GEL|ANTISS|LIMPEZA|70/.test(d) ? null : 'et';
  if (/DIESEL/.test(d)) return /S-?\s?10/.test(d) ? 'd10' : 'd500';
  return null;
}

function precoValido(comb, v) {
  const faixa = FAIXA[comb];
  return faixa && v >= faixa[0] && v <= faixa[1];
}

// "Há 1 dia(s) 13 hora(s) 45 minuto(s) 28 segundo(s)" a partir do carimbo da
// consulta ("12/08/2026 09:33:46") — usa o relógio do servidor, sem fuso nosso.
function instanteDaIdade(idade, consulta) {
  if (!consulta) return null;
  const n = re => +(idade.match(re)?.[1] || 0);
  const atrasoMs = (n(/(\d+)\s*dia/) * 86400 + n(/(\d+)\s*hora/) * 3600 +
                    n(/(\d+)\s*minuto/) * 60 + n(/(\d+)\s*segundo/)) * 1000;
  return new Date(consulta.getTime() - atrasoMs);
}

function parseConsulta(html) {
  const m = html.match(/Consulta realizada em:\s*<b>(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})<\/b>/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
}

const parsePreco = s => {
  const v = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  return isNaN(v) ? null : +v.toFixed(2);
};

// Um "chunk" = card do produto + o modal que lista as outras notas do mesmo item.
// Card e modal têm markup diferente, então são duas varreduras por chunk.
const RE_CARD = /<b>R\$ ([\d.,]+)<\/b>[\s\S]{0,200}?tb-valor-10">Há ([^<]*)<\/p>[\s\S]{0,400}?data-tooltip="([^"]*)">\s*<b>[^<]*<\/b>[\s\S]{0,500}?data-tooltip="([^"]*CEP [\d-]+)"[\s\S]{0,1200}?refreshMap\(\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/;
const RE_MODAL = /location_city<\/i><b>([^<]*)<\/b>[\s\S]{0,400}?location_on<\/i>([^<]*)<\/p>[\s\S]{0,600}?R\$ ([\d.,]+)<\/b>[\s\S]{0,200}?tb-valor-10">Há ([^<]*)</g;

// Retorna Map<chaveEndereco, { n, b, mu, m, e, p:{comb:{v,d}}, lat, lng }>
export function absorverPagina(html, postos, { titulo, slug }) {
  const consulta = parseConsulta(html);
  let achou = 0;

  const guardar = (nome, endereco, precoBruto, idade, comb, lat, lng) => {
    const preco = parsePreco(precoBruto);
    const end = partesEndereco(endereco);
    const quando = instanteDaIdade(idade, consulta);
    if (!comb || !preco || !end || !quando || !precoValido(comb, preco)) return;
    achou++;

    const posto = postos.get(end.chave) || {
      n: titulo(nome), b: '', mu: titulo(end.municipio), m: slug(end.municipio),
      e: titulo(end.endereco), p: {}, lat: null, lng: null
    };
    if (lat != null && posto.lat == null) { posto.lat = lat; posto.lng = lng; }
    const atual = posto.p[comb];
    // NFC-e mais recente do posto = preço de bomba vigente
    const carimbo = quando.getTime();
    if (!atual || atual._t < carimbo) {
      posto.p[comb] = { v: preco, d: quando.toISOString().slice(0, 10), _t: carimbo };
    }
    postos.set(end.chave, posto);
  };

  for (const chunk of html.split('class="card small p hoverable"').slice(1)) {
    // card e modal só trazem o nome do posto; o produto é o título do grupo
    const produto = chunk.match(/<h4 class="">([^<]*)<\/h4>/)?.[1] ||
                    chunk.match(/class="card-title[^"]*"[\s\S]{0,300}?data-tooltip="([^"]*)"/)?.[1] || '';
    const comb = combDaDescricao(desescapar(produto));
    const card = chunk.match(RE_CARD);
    if (card) {
      guardar(desescapar(card[3]), card[4], card[1], card[2], comb, +card[6], +card[5]);
    }
    for (const linha of chunk.matchAll(RE_MODAL)) {
      guardar(desescapar(linha[1]), linha[2], linha[3], linha[4], comb, null, null);
    }
  }
  return achou;
}

async function abrirSessao() {
  const r = await fetch(BASE + '/home', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('handshake HTTP ' + r.status);
  const html = await r.text();
  const cookies = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  if (!cookies) throw new Error('sessão sem cookies');
  return { cookies, html };
}

async function consultar(sessao, { termo, municipio, pagina }) {
  const body = new URLSearchParams({
    descricaoProd: termo, municipio, termoCdGtin: '', cdGtin: '',
    tipoConsulta: '', consultaExata: '', _consultaExata: 'on',
    latitude: '', longitude: '', distancia: '', precoMinimo: '', precoMaximo: ''
  });
  const r = await fetch(`${BASE}/item/grupo/page/${pagina}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Cookie': sessao.cookies, 'Referer': BASE + '/home',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  // páginas são ISO-8859-1 e o header não diz o charset: decodificar errado
  // estraga o "Há ..." da idade da nota e a varredura devolve zero em silêncio
  return new TextDecoder('iso-8859-1').decode(await r.arrayBuffer());
}

// municípios direto do <select> da própria busca (não fixar lista no código)
export function municipiosDaPagina(html) {
  return [...html.matchAll(/<option value="([^"]+)">/g)]
    .map(m => desescapar(m[1])).filter(v => v && v !== '0' && v.toLowerCase() !== 'todos');
}

// opts: { titulo, slug, log, pausaMs, deadlineMin }
export async function coletarBuscaPrecoAM(opts) {
  const { titulo, slug, log = console.log } = opts;
  const pausaMs = +(opts.pausaMs || process.env.BPAM_PAUSA_MS || 1500);
  const deadlineMin = +(opts.deadlineMin || process.env.BPAM_DEADLINE_MIN || 40);
  const fim = Date.now() + deadlineMin * 60000;

  let sessao = await abrirSessao();
  // o <select> de municípios só existe na PÁGINA DE RESULTADO, não na home
  const municipios = municipiosDaPagina(
    await consultar(sessao, { termo: TERMOS[0], municipio: '', pagina: 1 }));
  if (!municipios.length) throw new Error('nenhum município no select da busca');
  // Manaus primeiro: se o deadline cortar, o parcial já cobre o mercado que importa
  municipios.sort((a, b) => (b === 'Manaus') - (a === 'Manaus'));

  const postos = new Map();
  let requisicoes = 0, errosRede = 0, municipiosOk = 0, mudas = 0;
  let sessoesRefeitas = 0, falhasSeguidas = 0;

  for (const municipio of municipios) {
    if (Date.now() > fim) { log('  BPAM: deadline — devolvendo parcial'); break; }
    let achou = 0;
    for (const termo of TERMOS) {
      let paginas = 1;
      for (let pagina = 1; pagina <= Math.min(paginas, MAX_PAGINAS); pagina++) {
        if (Date.now() > fim) break;
        await pausa(pausaMs);
        let html;
        try { html = await consultar(sessao, { termo, municipio, pagina }); }
        catch (e) {
          errosRede++;
          log(`  BPAM ${municipio}/${termo} p${pagina}: ${e.message}`);
          if (errosRede > 8) throw new Error('rede instável — encerrando varredura');
          break;
        }
        requisicoes++;
        if (pagina === 1) {
          // sem o marcador não é página de resultado: a sessão caiu no meio da
          // rajada e o site devolve a busca vazia. Sem isso a varredura inteira
          // termina com 0 postos sem reclamar (aconteceu no 1º teste ao vivo).
          const marcador = html.match(/Encontrados (\d+) itens/);
          if (!marcador) {
            sessao = await abrirSessao();
            sessoesRefeitas++;
            pagina--;                 // repete a mesma página com a sessão nova
            if (++falhasSeguidas > 5) throw new Error('sessão não se sustenta — encerrando');
            continue;
          }
          falhasSeguidas = 0;
          const itens = +marcador[1];
          if (!itens) break;
          paginas = Math.max(...[...html.matchAll(/\/item\/grupo\/page\/(\d+)/g)]
            .map(m => +m[1]).concat(1));
        }
        const nesta = absorverPagina(html, postos, { titulo, slug });
        if (!nesta) mudas++;         // página com itens que não virou preço nenhum
        achou += nesta;
      }
    }
    if (achou) municipiosOk++;
  }

  for (const posto of postos.values())
    for (const f of Object.values(posto.p)) delete f._t;
  log(`  Busca Preço AM: ${postos.size} postos · ${municipiosOk}/${municipios.length} municípios · ` +
      `${requisicoes} requisições${sessoesRefeitas ? ` · ${sessoesRefeitas} sessões refeitas` : ''}`);
  if (mudas > 5 && !postos.size)
    log(`  BPAM ATENÇÃO: ${mudas} páginas com itens não renderam preço — layout do site mudou?`);
  return postos;
}
