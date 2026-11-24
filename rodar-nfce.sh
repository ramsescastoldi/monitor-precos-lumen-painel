#!/bin/zsh
# Daily NFC-e sweep (PR + BA) → commit municipios-nfce.json → deploy. launchd: com.ramses.monitor-nfce
set -e
cd /Users/ramsescastoldi/monitor-precos-lumen-painel
set -a; source /Users/ramsescastoldi/.config/castoldi/chaves.env; set +a
export PATH=/Users/ramsescastoldi/.local/bin:/usr/local/bin:/usr/bin:/bin
date
node scrape-nfce.mjs
git add municipios-nfce.json
git diff --cached --quiet && { echo "sem mudança"; exit 0; }
git commit -q -m "data: NFC-e PR/BA — $(date -u +%Y-%m-%dT%H:%MZ)"
git pull -q --rebase --autostash
git push -q
npx wrangler deploy 2>&1 | tail -1
