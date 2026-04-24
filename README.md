# HM Release Mirror

Cloudflare Worker que proxea releases de plugins WordPress privados de Hot Marketing a clientes vía **plugin-update-checker** (PUC), con validación por `site_token` almacenado en Cloudflare KV.

## Qué resuelve

- **El PAT de GitHub vive en el Worker**, no en el `wp-config.php` del cliente.
- **Killswitch granular:** desactivar un `site_token` corta el flujo de updates de ese sitio específico sin afectar a otros.
- **Track filtering server-side:** cada token puede recibir `stable`, `beta` o `all` — la lógica ya no vive en el plugin.
- **Audit:** Cloudflare loggea cada request (Dashboard → Workers → Logs).
- **Código fuente protegido:** el cliente nunca tiene credenciales para clonar el repo.

## Arquitectura

```
WP del cliente ──PUC──▶ releases.hotmarketing.cloud ──PAT──▶ api.github.com
  HM_SITE_TOKEN          Worker + KV lookup                   releases + assets
```

## Setup inicial (Pablo, una sola vez)

```bash
cd "/home/claude/proyectos/Hot Marketing/release-mirror"

# 1. Login a Cloudflare (abre browser)
npx wrangler login

# 2. Crear el KV namespace (prod + preview)
npx wrangler kv namespace create SITE_TOKENS
npx wrangler kv namespace create SITE_TOKENS --preview

# → Copia los `id` y `preview_id` que imprime al wrangler.toml (reemplaza los PENDING_REPLACE_ME).

# 3. Subir el PAT de GitHub como secret
# Usar un fine-grained PAT con Contents:Read sobre hotmarketing/directorio-turistico
# (y cualquier otro repo de plugin que quieras servir en el futuro).
npx wrangler secret put GITHUB_PAT
# → pegás el PAT cuando pregunte

# 4. (Opcional) Admin token para gestión HTTP de tokens
npx wrangler secret put ADMIN_TOKEN

# 5. Deploy
npm run deploy
# → imprime una URL tipo https://hm-release-mirror.<tu-account>.workers.dev
```

## Crear un `site_token` para un cliente

Dos formas.

### Opción A — wrangler CLI (recomendado)

```bash
# Generar un token random (ejecutá local)
TOKEN=$(openssl rand -hex 24)

# Guardarlo en KV con metadata
npx wrangler kv key put --binding=SITE_TOKENS "$TOKEN" '{
  "client": "secturi",
  "plugin": "directorio-turistico",
  "active": true,
  "track": "all",
  "allowed_domain": "guanajuato.mx",
  "created_at": "2026-04-24T00:00:00Z",
  "notes": "Prod AWS del gob"
}'

echo "Token para wp-config: $TOKEN"
```

### Opción B — script helper (ver `scripts/create-token.sh`)

## Revocar un token (killswitch)

```bash
# Soft-revoke (recomendado — queda audit del token previamente activo)
npx wrangler kv key put --binding=SITE_TOKENS "<token>" '{
  "client": "secturi",
  "plugin": "directorio-turistico",
  "active": false,
  "track": "all",
  "created_at": "2026-04-24T00:00:00Z",
  "notes": "REVOCADO 2026-XX-XX: contrato finalizado"
}'

# Hard-delete (si preferís limpieza)
npx wrangler kv key delete --binding=SITE_TOKENS "<token>"
```

Efecto: la próxima vez que PUC pida updates (cada 12h por default) recibe 403 y el sitio se queda en la versión instalada. El plugin **sigue funcionando** — solo deja de recibir updates.

## Listar tokens

```bash
npx wrangler kv key list --binding=SITE_TOKENS
```

## Endpoints

| Método | Path                                   | Descripción                                                |
|--------|----------------------------------------|------------------------------------------------------------|
| GET    | `/`                                    | Redirect a hotmarketing.cloud                              |
| GET    | `/health`                              | `{ ok: true, version }` — para uptime monitoring           |
| GET    | `/:plugin/info.json?site_token=X`      | Metadata PUC (latest release del track del token)          |
| GET    | `/:plugin/download/:tag?site_token=X`  | Stream del asset `.zip` del release                        |

Ejemplos:

```bash
# Health
curl https://releases.hotmarketing.cloud/health

# Info (equivale a lo que pide PUC)
curl "https://releases.hotmarketing.cloud/directorio-turistico/info.json?site_token=XXX"

# Download
curl -L -o plugin.zip \
  "https://releases.hotmarketing.cloud/directorio-turistico/download/v1.6.0-rc.2?site_token=XXX"
```

## Tracks

| Track    | Qué incluye                                              |
|----------|----------------------------------------------------------|
| `stable` | Solo releases sin `prerelease: true` (tags `vX.Y.Z`)     |
| `beta`   | Todas las releases publicadas (incluye `-rc`, `-beta`)   |
| `all`    | Igual que `beta` — alias explícito                       |

Para un cliente en prod que quiera solo estables: `"track": "stable"`.
Para Pablo o staging durante desarrollo: `"track": "all"` o `"beta"`.

## Desarrollo local

```bash
npm run dev
# http://localhost:8787
```

Requiere `GITHUB_PAT` en `.dev.vars` (ignored en git):

```
GITHUB_PAT=ghp_xxxxxxxxxxxxx
```

## Observabilidad

```bash
npm run tail
# → stream de logs en tiempo real del Worker deployado
```

## Agregar un plugin nuevo al mirror

Zero-code: el Worker usa el primer path segment como repo name contra `hotmarketing/<plugin>`. Solo tenés que:

1. Crear un `site_token` en KV con `plugin: "<nuevo-slug>"`.
2. El cliente instala PUC apuntando a `https://releases.hotmarketing.cloud/<nuevo-slug>/info.json?site_token=X`.

Importante: el PAT del Worker debe tener `Contents:Read` sobre el repo del nuevo plugin también.

## Troubleshooting

- **`token_invalid / not_found`**: el token no está en KV.
- **`token_invalid / revoked`**: `active: false` en KV.
- **`token_invalid / plugin_mismatch`**: el path es `/foo/...` pero el token está emitido para `bar`.
- **`token_invalid / domain_mismatch`**: el `Referer` no coincide con `allowed_domain`. Si el cliente corre en un subdominio raro, ajustá el token o borrá `allowed_domain`.
- **`upstream_github`**: el PAT expiró o perdió permisos sobre el repo.
- **Update no aparece en WP**: PUC cachea 12h en `wp_options`. Forzar: `wp transient delete "external_updates-<plugin-slug>"` o usar el botón "Check again" dentro del Worker (no es instantáneo por el cache nuestro de 5min).
