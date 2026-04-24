#!/usr/bin/env bash
#
# Cambia el track de un site_token existente sin tocar el resto del record.
#
# Uso:
#   ./scripts/update-track.sh <token> <stable|beta|all>
#
# Ejemplo:
#   ./scripts/update-track.sh 693ff5a4c99566728c7c3f6d225808bf0c6ddf97d5ca3072 stable

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "uso: $0 <token> <stable|beta|all>" >&2
  exit 1
fi

TOKEN="$1"
NEW_TRACK="$2"

case "$NEW_TRACK" in
  stable|beta|all) ;;
  *) echo "error: track debe ser stable, beta o all (got '$NEW_TRACK')" >&2; exit 1 ;;
esac

if ! command -v jq >/dev/null 2>&1; then
  echo "error: necesitás jq instalado (brew install jq)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Leer record actual
CURRENT=$(npx wrangler kv key get --binding=SITE_TOKENS --preview false "$TOKEN" 2>/dev/null || true)
if [ -z "$CURRENT" ]; then
  echo "error: token no encontrado en KV" >&2
  exit 1
fi

OLD_TRACK=$(echo "$CURRENT" | jq -r '.track')
CLIENT=$(echo "$CURRENT" | jq -r '.client')
PLUGIN=$(echo "$CURRENT" | jq -r '.plugin')

if [ "$OLD_TRACK" = "$NEW_TRACK" ]; then
  echo "nada que hacer: $CLIENT/$PLUGIN ya está en track '$NEW_TRACK'"
  exit 0
fi

# Mutar solo el campo track
UPDATED=$(echo "$CURRENT" | jq --arg t "$NEW_TRACK" '.track = $t')

# Escribir de vuelta
echo "$UPDATED" | npx wrangler kv key put --binding=SITE_TOKENS --preview false "$TOKEN" --path=/dev/stdin

echo ""
echo "✓ $CLIENT/$PLUGIN: track $OLD_TRACK → $NEW_TRACK"
