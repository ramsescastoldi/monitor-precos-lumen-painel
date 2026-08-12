# monitor-precos-lumen-painel

Painel de preços de combustíveis para membros do **Lumen Posto Club** (auth OTP WhatsApp).
URL: https://monitor.lumenclubpainel.com.br

## Arquitetura (desde 2026-05-18)

```
GitHub Actions (crons)                       VPS (IP fixo)
  scrape-anp.yml         seg+qui 03h BRT       container monitor-deployer:
  scrape-distribuidoras  diário 11h17 BRT        a cada 1h: git fetch;
  scrape-volumes         dia 2 e 21, 12h BRT     se main mudou → wrangler deploy
  scrape-petrobras       seg+qui 09h23 BRT       (Cloudflare Workers Assets)
       ↓
  scraper → Supabase → node update.mjs → data.json
  scrape-petrobras → custo-distribuicao.json (sem banco)
       ↓
  git commit + push (diff real)
```

O `index.html` é estático: faz `fetch('data.json')` + `fetch('custo-distribuicao.json')` em runtime.
O token Cloudflare é filtrado por IP — deploy SÓ roda da VPS, nunca do GitHub Actions.

## Scrapers

- `scrape-anp.mjs` — preços de revenda por posto (ANP SHPC, 15 UFs em `ESTADOS`) → Supabase
- `scrape-distribuidoras.mjs` — planilha Google Sheets de cotações B2B → Supabase
- `scrape-volumes.mjs` — entregas por distribuidor (ANP líquidos, mensal) → Supabase
- `scrape-petrobras.mjs` — composição oficial de preço por UF (site Petrobras) → `custo-distribuicao.json` direto (sem banco)
- `update.mjs` — Supabase → agregados/margens/volumes → `data.json`
- `check-freshness.mjs` — alerta Telegram se volumes defasarem ≥3 meses
- `export-radar.mjs` — postos ANP → KV do Radar de Preços (backup; rodada completa roda no Mac)
- `scrape-precodahora.mjs` — BA quase tempo real (NFC-e, Preço da Hora); merge por CNPJ
- `scrape-buscapreco-am.mjs` — AM quase tempo real (NFC-e, Busca Preço Amazonas); merge por endereço (não tem CNPJ). `node test_buscapreco_am.mjs` = auto-teste do parser
- `scrape-economiza-al.mjs` — AL quase tempo real (NFC-e, API oficial Economiza Alagoas); merge por CNPJ. Precisa de `ECONOMIZA_AL_TOKEN` (cofre `~/.config/castoldi/chaves.env`; sem ele o bloco só avisa e a UF segue com a ANP). `node test_economiza_al.mjs` = auto-teste do parser

## Secrets (GitHub Actions)

- `SUPABASE_DB_URL` — Postgres direto (transaction pooler)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — healthcheck de frescor

## Rodar local

```bash
npm install
SUPABASE_DB_URL='postgresql://...' node update.mjs   # gera data.json
node scrape-petrobras.mjs                            # gera custo-distribuicao.json (sem env)
python3 -m http.server 8000                          # abrir http://localhost:8000
```
