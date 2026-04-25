#!/usr/bin/env bash
#
# Crea un site_token random y lo guarda en KV.
#
# Uso:
#   ./scripts/create-token.sh <client> <plugin> [track] [allowed_domain] [notes]
#
# Ejemplo:
#   ./scripts/create-token.sh secturi directorio-turistico all guanajuato.mx "Prod AWS gob"

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
  echo "uso: $0 <client> <plugin> [track=all] [allowed_domain] [notes]" >&2
  exit 1
fi

CLIENT="$1"
PLUGIN="$2"
TRACK="${3:-all}"
DOMAIN="${4:-}"
NOTES="${5:-}"

TOKEN="$(openssl rand -hex 24)"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

RECORD=$(cat <<EOF
{
  "client": "$CLIENT",
  "plugin": "$PLUGIN",
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
npx wrangler kv key put --binding=SITE_TOKENS --remote "$TOKEN" "$RECORD"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "Token creado para $CLIENT / $PLUGIN (track: $TRACK)"
echo ""
echo "Pegar en wp-config.php del sitio:"
echo ""
echo "  define( 'HM_SITE_TOKEN', '$TOKEN' );"
echo ""
echo "════════════════════════════════════════════════════════════"
