#!/usr/bin/env bash
#
# Crea un site_token random y lo guarda en KV.
#
# El token es la "API key" del cliente: autoriza una lista de plugins.
# <plugins> = "*" (todos los plugins del owner) o CSV de slugs ("a,b,c").
#
# Uso:
#   ./scripts/create-token.sh <client> <plugins> [track] [allowed_domain] [notes]
#
# Ejemplos:
#   ./scripts/create-token.sh secturi directorio-turistico all guanajuato.mx "Prod AWS gob"
#   ./scripts/create-token.sh guanajuato "*" stable guanajuato.mx "Cliente integral"

set -euo pipefail

# Cargar .env si existe (CLOUDFLARE_API_TOKEN para modo no-interactivo).
ENV_FILE="$(dirname "$0")/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ $# -lt 2 ]; then
  echo "uso: $0 <client> <plugins> [track=all] [allowed_domain] [notes]" >&2
  echo "  <plugins>: \"*\" (todos) o CSV de slugs (\"a,b,c\")" >&2
  exit 1
fi

CLIENT="$1"
PLUGINS_ARG="$2"
TRACK="${3:-all}"
DOMAIN="${4:-}"
NOTES="${5:-}"

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

TOKEN="$(openssl rand -hex 24)"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

RECORD=$(cat <<EOF
{
  "client": "$CLIENT",
  "plugins": $PLUGINS_JSON,
  "active": true,
  "track": "$TRACK",
  "allowed_domain": "$DOMAIN",
  "created_at": "$CREATED_AT",
  "notes": "$NOTES"
}
EOF
)

# Si allowed_domain vacío, quitamos la key entera (más claro en KV)
if [ -z "$DOMAIN" ]; then
  RECORD=$(echo "$RECORD" | grep -v '"allowed_domain"')
fi

cd "$(dirname "$0")/.."
npx wrangler kv key put --binding=SITE_TOKENS --remote --preview false "$TOKEN" "$RECORD"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "Token creado para $CLIENT — plugins: $PLUGINS_JSON (track: $TRACK)"
echo ""
echo "Pegar en wp-config.php del sitio:"
echo ""
echo "  define( 'HM_SITE_TOKEN', '$TOKEN' );"
echo ""
echo "════════════════════════════════════════════════════════════"
