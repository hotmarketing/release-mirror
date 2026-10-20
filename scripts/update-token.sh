#!/usr/bin/env bash
#
# Cambia los plugins autorizados de un site_token existente, sin regenerar el
# token (el cliente conserva el mismo HM_SITE_TOKEN en su wp-config.php).
#
# Migra al vuelo records legacy (campo `plugin` singular) al modelo `plugins`.
#
# <plugins> = "*" (todos los plugins del owner) o CSV de slugs ("a,b,c").
# Por defecto reemplaza la lista completa (SET). Con --add agrega los slugs a la
# lista actual sin quitar ninguno (merge): úsalo para autorizar un plugin nuevo.
#
# Uso:
#   ./scripts/update-token.sh <token> <plugins>
#   ./scripts/update-token.sh <token> --add <plugins>
#
# Ejemplos:
#   ./scripts/update-token.sh <token> "*"
#   ./scripts/update-token.sh <token> "directorio-turistico,funciones-hot-marketing"
#   ./scripts/update-token.sh <token> --add hm-proximos-eventos

set -euo pipefail

# Cargar .env si existe (CLOUDFLARE_API_TOKEN para modo no-interactivo).
ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

MODE="set"
if [ $# -eq 3 ] && [ "$2" = "--add" ]; then
  MODE="add"
  TOKEN="$1"
  PLUGINS_ARG="$3"
elif [ $# -eq 2 ]; then
  TOKEN="$1"
  PLUGINS_ARG="$2"
else
  echo "uso: $0 <token> <plugins>" >&2
  echo "     $0 <token> --add <plugins>" >&2
  echo "  <plugins>: \"*\" (todos) o CSV de slugs (\"a,b,c\")" >&2
  exit 1
fi

case "$PLUGINS_ARG" in
  -*) echo "error: <plugins> no puede empezar con '-' (got '$PLUGINS_ARG')" >&2; exit 1 ;;
esac

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

# Setear (o agregar, con --add) plugins y eliminar el campo legacy `plugin` (migración limpia).
if [ "$MODE" = "add" ]; then
  UPDATED=$(echo "$CURRENT" | jq --argjson p "$PLUGINS_JSON" '.plugins = (if .plugins then .plugins else [.plugin] end) | .plugins += ($p - .plugins) | del(.plugin)')
else
  UPDATED=$(echo "$CURRENT" | jq --argjson p "$PLUGINS_JSON" '.plugins = $p | del(.plugin)')
fi
NEW=$(echo "$UPDATED" | jq -c '.plugins')

# Escribir de vuelta
echo "$UPDATED" | npx wrangler kv key put --binding=SITE_TOKENS --remote --preview false "$TOKEN" --path=/dev/stdin

echo ""
echo "✓ $CLIENT: plugins $OLD → $NEW"
