#!/bin/zsh
# Rodada diária COMPLETA do Radar (ANP 27 UFs + Preço da Hora BA + Busca Preço AM) — launchd
# com.ramses.radar-export, 05:30. O GitHub Actions (seg+qui) é backup só-ANP.
export PATH="/Users/ramsescastoldi/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
cd /Users/ramsescastoldi/monitor-precos-lumen-painel || exit 1

echo "===== radar-export $(date '+%Y-%m-%d %H:%M:%S') ====="
git pull --ff-only --quiet 2>&1 | head -2
npm install --no-audit --no-fund --silent 2>&1 | tail -1

# ritmo lento pra caber na cota do PRODEB; deadline devolve parcial
# BPAM não tem cota conhecida: ritmo normal e deadline próprio
PDH_PAUSA_MS=90000 PDH_DEADLINE_MIN=240 BPAM_PAUSA_MS=1500 BPAM_DEADLINE_MIN=40 node export-radar.mjs
echo "===== fim $(date '+%H:%M:%S') (exit $?) ====="
