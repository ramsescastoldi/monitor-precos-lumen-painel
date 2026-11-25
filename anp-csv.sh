#!/bin/bash
# ANP resets GitHub runner IPs (since 19/11/2026). This Mac downloads the two weekly CSVs,
# uploads them as assets of the "anp-csv" release, and triggers the scrape workflow,
# which falls back to those assets. launchd com.ramses.monitor-anp-csv, daily 06:10.
set -euo pipefail
cd "$(dirname "$0")"
D=$(mktemp -d)
B=https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus
for f in ultimas-4-semanas-gasolina-etanol.csv ultimas-4-semanas-diesel-gnv.csv; do
  curl -sf -m 300 --retry 3 -o "$D/$f" "$B/$f"
  [ "$(wc -c < "$D/$f")" -gt 1000000 ] || { echo "$f pequeno demais"; exit 1; }
done
gh release upload anp-csv "$D"/*.csv --clobber
gh workflow run scrape-anp.yml
rm -rf "$D"
echo "$(date '+%F %T') CSVs enviados, workflow disparado"
