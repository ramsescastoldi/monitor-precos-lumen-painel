# monitor-precos-lumen-painel

Painel público de disparidade de preços de combustíveis para o **Lumen Posto Club**.
URL: https://monitor.lumenclubpainel.com.br

## Como funciona

```
Cron horário (GitHub Actions)
       ↓
POST Netlify build hook
       ↓
Netlify build: node update.mjs
       ↓
update.mjs:
  1. conecta no Supabase via SUPABASE_DB_URL
  2. consulta revendedores ativos + última coleta de preços (7 dias)
  3. calcula agregados por estado (média, min, max)
  4. anonimiza revendedores (MT-A, MT-B, ...)
  5. injeta JSON em index.html no marcador `const DATA = {};  // END_DATA`
       ↓
Netlify serve / (index.html, data.json)
```

## Configuração inicial (uma vez)

1. **Netlify Site Settings → Environment variables:** adicionar
   `SUPABASE_DB_URL = postgresql://postgres.xxovxgefmopoiammqrod:...@aws-1-sa-east-1.pooler.supabase.com:6543/postgres`

2. **Netlify Site Settings → Build & deploy → Build hooks:** criar build hook chamado "refresh-cron". Copiar URL.

3. **GitHub repo settings → Secrets and variables → Actions:** adicionar secret
   `NETLIFY_BUILD_HOOK = <URL do build hook do passo 2>`

4. **Netlify Domain management:** adicionar custom domain `monitor.lumenclubpainel.com.br`. Pegar valor do CNAME target (ex: `<site>.netlify.app`).

5. **Hostinger DNS** (via MCP ou manual): adicionar CNAME `monitor` → `<site>.netlify.app`.

## Rodar local
```bash
SUPABASE_DB_URL='postgresql://...' npm run build
# abrir index.html no browser
```

## Estrutura
- `update.mjs` — script de build (consulta DB + gera HTML)
- `index.html` — template HTML com marcador `const DATA = {};  // END_DATA`
- `netlify.toml` — config de build
- `.github/workflows/refresh.yml` — cron que dispara build hook
- `data.json` — JSON bruto (gerado pelo build)
