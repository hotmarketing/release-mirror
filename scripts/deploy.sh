#!/usr/bin/env bash
#
# Despliega el Worker a producción y confirma que /health responde la versión nueva.
#
# Uso:
#   ./scripts/deploy.sh
#
# Se niega a desplegar si hay cambios sin commitear o si main no está al día con
# origin: lo que corre en producción siempre es un commit que existe en GitHub.

set -euo pipefail

cd "$(dirname "$0")/.."

# Cargar .env si existe (CLOUDFLARE_API_TOKEN para modo no-interactivo).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✘ Hay cambios sin commitear. Commitea o descarta antes de desplegar." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

git pull --ff-only -q
if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{u}')" ]; then
  echo "✘ main no coincide con origin (¿commits sin push?). Haz push antes de desplegar." >&2
  exit 1
fi

npx tsc --noEmit

EXPECTED="$(sed -n 's/^const WORKER_VERSION = "\(.*\)";/\1/p' src/index.ts)"
echo "→ Desplegando $(git log --oneline -1) — versión esperada $EXPECTED"

npx wrangler deploy

# La propagación en el edge tarda unos segundos.
for i in 1 2 3 4 5 6; do
  HEALTH="$(curl -s --max-time 10 https://releases.hotmarketing.cloud/health || true)"
  if echo "$HEALTH" | grep -q "\"version\":\"$EXPECTED\""; then
    echo "✔ /health: $HEALTH"
    exit 0
  fi
  sleep 5
done

echo "✘ /health no reporta $EXPECTED tras 30 s. Última respuesta: $HEALTH" >&2
exit 1
