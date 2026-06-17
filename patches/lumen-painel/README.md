# Patch: notícias rotacionais — repo `lumen-painel`

> ⚠️ **Atenção: este patch NÃO se aplica a este repositório.**
> Ele corrige o repo **`ramsescastoldi/lumen-painel`** (que gera `painel.lumenclubpainel.com.br`).
> Foi versionado aqui porque esta sessão do Claude Code só tinha escopo de escrita em
> `monitor-precos-lumen-painel`. Use-o no clone do `lumen-painel`.

## O que corrige

O quadro **"Notícias que podem impactar no posto"** (`noticias_impacto`) estava repetindo as
notícias do dia anterior — o painel de 17/jun ainda exibia matérias de 29-30/mai. Causa: a lógica
de *carry-forward* em `scripts/gerar-painel.mjs` recolocava as notícias de ontem quando o modelo
trazia menos de 2 itens válidos.

A correção torna o quadro **rotacional**, conforme pedido:

1. **Nunca repete a notícia do dia anterior** — histórico rolling `_noticias_recentes`
   (últimas 16, url + título) + dedup por **URL igual** ou **título muito parecido** (Jaccard ≥ 0,6).
2. **Sempre fresca** — descarta matéria com data de fonte > 4 dias.
3. **Não recicla mais** — se faltar notícia, faz uma **busca nova via `web_search`** dedicada.
4. **Sempre do setor de combustíveis com impacto pro dono de posto** — o prompt passa a exigir
   o recorte, nesta prioridade: **(a) alterações de preços → (b) impostos (ICMS/PIS-Cofins/Confaz)
   → (c) bloqueios / medidas provisórias → (d) mudanças políticas (CNPE/ANP/lei)**, e lista as
   notícias recentes como proibidas.
5. **Limpeza** — `update.mjs` passa a remover campos internos `_*` do HTML público (corrige o
   vazamento pré-existente de `_manchetes_recentes`; relevante porque o Netlify roda `update.mjs`
   no build).
6. **`data.json`** — zera `noticias_impacto` e move as 2 matérias de maio para `_noticias_recentes`
   (já entram como proibidas), pra próxima execução começar limpa.

> O `index.html` **não** é tocado de propósito: o Netlify regenera ele a cada deploy via `update.mjs`.

## Arquivos alterados (no `lumen-painel`)

- `scripts/gerar-painel.mjs`
- `update.mjs`
- `data.json`

## Como aplicar

```bash
git clone https://github.com/ramsescastoldi/lumen-painel.git
cd lumen-painel
git checkout -b fix/noticias-rotacionais
git apply /caminho/para/noticias-rotacionais.patch
node --check scripts/gerar-painel.mjs && node --check update.mjs   # sanity
git add -A
git commit -m "fix: notícias de impacto rotacionais (anti-repetição + recorte do setor)"
git push -u origin fix/noticias-rotacionais
# abrir PR no lumen-painel
```

Validado localmente: sintaxe OK nos dois scripts; testes de dedup/frescor passam (notícias de
maio são descartadas; URLs/títulos repetidos detectados; notícia nova e distinta passa).
