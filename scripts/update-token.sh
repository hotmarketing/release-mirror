#!/usr/bin/env bash
#
# Cambia los plugins autorizados de un site_token existente, sin regenerar el
# token (el cliente conserva el mismo HM_SITE_TOKEN en su wp-config.php).
#
# Migra al vuelo records legacy (campo `plugin` singular) al modelo `plugins`.
#
# <plugins> = "*" (todos los plugins del owner) o CSV de slugs ("a,b,c").
# Reemplaza la lista completa (SET, no merge): para agregar uno, pasá la lista final.
#
# Uso:
#   ./scripts/update-token.sh <token> <plugins>
#
# Ejemplos:
#   ./scripts/update-token.sh <token> "*"
#   ./scripts/update-token.sh <token> "directorio-turistico,funciones-hot-marketing"

set -euo pipefail

# Cargar .env si existe (CLOUDFLARE_API_TOKEN para modo no-interactivo).
ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ $# -ne 2 ]; then
  echo "uso: $0 <token> <plugins>" >&2
  echo "  <plugins>: \"*\" (todos) o CSV de slugs (\"a,b,c\")" >&2
  exit 1
fi

TOKEN="$1"
PLUGINS_ARG="$2"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: necesitás jq instalado (brew install jq)" >&2
  exit 1
fi

# Construir array JSON de plugins desde "*" o CSV.
if [ "$PLUGINS_ARG" = "*" ]; then
  PLUGINS_JSON='["*"]'
else
  IFS=',' read -ra _plugins <<< "$PLUGINS_ARG"
  PLUGINS_JSON="["
  for i in "${!_plugins[@]}"; do
    p="$(echo "${_plugins[$i]}" | xargs)"  # trim espacios
    [ "$i" -gt 0 ] && PLUGINS_JSON+=","
    PLUGINS_JSON+="\"$p\""
  done
  PLUGINS_JSON+="]"
fi

cd "$(dirname "$0")/.."

# Leer record actual
CURRENT=$(npx wrangler kv key get --binding=SITE_TOKENS --remote --preview false "$TOKEN" 2>/dev/null || true)
if [ -z "$CURRENT" ]; then
  echo "error: token no encontrado en KV" >&2
  exit 1
fi

CLIENT=$(echo "$CURRENT" | jq -r '.client')
OLD=$(echo "$CURRENT" | jq -c 'if .plugins then .plugins else [.plugin] end')

# Setear plugins y eliminar el campo legacy `plugin` (migración limpia).
UPDATED=$(echo "$CURRENT" | jq --argjson p "$PLUGINS_JSON" '.plugins = $p | del(.plugin)')

# Escribir de vuelta
echo "$UPDATED" | npx wrangler kv key put --binding=SITE_TOKENS --remote --preview false "$TOKEN" --path=/dev/stdin

echo ""
echo "✓ $CLIENT: plugins $OLD → $PLUGINS_JSON"
