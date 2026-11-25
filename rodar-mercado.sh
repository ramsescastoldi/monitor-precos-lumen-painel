#!/bin/zsh
# Import parity (ABICOM daily + ANP weekly), producer/importer prices and CEPEA etanol → mercado.json → deploy.
# Runs on the Mac (gov.br refuses GitHub runners; ABICOM table is an image read by macOS OCR). launchd: com.ramses.monitor-mercado
set -e
cd /Users/ramsescastoldi/monitor-precos-lumen-painel
set -a; source /Users/ramsescastoldi/.config/castoldi/chaves.env; set +a
export PATH=/Users/ramsescastoldi/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
date
node scrape-mercado.mjs
git add mercado.json
git diff --cached --quiet && { echo "sem mudança"; exit 0; }
git commit -q -m "data: mercado (ABICOM/ANP/CEPEA) — $(date -u +%Y-%m-%dT%H:%MZ)"
git pull -q --rebase --autostash
git push -q
npx wrangler deploy 2>&1 | tail -1
