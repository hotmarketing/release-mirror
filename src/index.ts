/**
 * Hot Marketing Release Mirror — entrypoint.
 *
 * Routes:
 *   GET  /                                      → redirect a hotmarketing.com
 *   GET  /health                                → { ok, version }
 *   GET  /:plugin/info.json?site_token=X        → metadata PUC
 *   GET  /:plugin/download/:tag?site_token=X    → stream del ZIP
 *
 * Todos los endpoints de plugin requieren site_token válido en KV.
 */

import type { Env } from "./types";
import { validateSiteToken } from "./kv";
import {
  fetchPluginHeader,
  fetchReleases,
  findRepoIcon,
  pickLatestForTrack,
  pickZipAsset,
  streamAsset,
  streamRepoIcon,
} from "./github";
import { buildMetadata } from "./puc";

const WORKER_VERSION = "0.3.1";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // CORS preflight — PUC no lo necesita pero abre la puerta para herramientas de debug.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Aceptamos HEAD igual que GET (HTTP estándar: HEAD = GET sin cuerpo). Útil
    // para que CDNs/proxies validen el ícono sin descargarlo; el runtime de
    // Workers descarta el body en respuestas a HEAD automáticamente.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed" }, 405);
    }

    // GET /
    if (parts.length === 0) {
      return Response.redirect("https://www.hotmarketing.cloud/", 302);
    }

    // GET /health
    if (parts.length === 1 && parts[0] === "health") {
      return json({ ok: true, version: WORKER_VERSION });
    }

    // GET /:plugin/info.json
    if (parts.length === 2 && parts[1] === "info.json") {
      return handleInfo(request, env, ctx, parts[0]!, url);
    }

    // GET /:plugin/icon — público (un logo no es sensible), sin site_token,
    // porque el <img> del wp-admin no lo manda. El Worker lo proxea con su PAT.
    if (parts.length === 2 && parts[1] === "icon") {
      return handleIcon(env, parts[0]!);
    }

    // GET /:plugin/download/:tag
    if (parts.length === 3 && parts[1] === "download") {
      return handleDownload(request, env, parts[0]!, parts[2]!, url);
    }

    return json({ error: "not_found" }, 404);
  },
};

async function handleInfo(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  plugin: string,
  url: URL
): Promise<Response> {
  const token = url.searchParams.get("site_token");
  const referer = request.headers.get("referer");

  const validation = await validateSiteToken(env, token, plugin, referer);
  if (!validation.valid) {
    return json({ error: "token_invalid", reason: validation.reason }, 403);
  }

  const record = validation.record!;

  // Cache key distingue por plugin+track. Independiente del site_token —
  // dos clientes con mismo track comparten cache → menos hits a GitHub.
  const cacheKey = new Request(
    `https://cache.internal/${plugin}/${record.track}.json`,
    { method: "GET" }
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);

  let metadata;
  if (cached) {
    metadata = (await cached.json()) as Record<string, unknown>;
  } else {
    let releases;
    try {
      releases = await fetchReleases({
        owner: env.GITHUB_OWNER,
        repo: plugin,
        pat: env.GITHUB_PAT,
      });
    } catch (err) {
      return json({ error: "upstream_github", detail: String(err) }, 502);
    }

    const release = pickLatestForTrack(releases, record.track);
    if (!release) return json({ error: "no_release_for_track" }, 404);

    const asset = pickZipAsset(release);
    if (!asset) return json({ error: "release_has_no_zip" }, 404);

    // Enriquecemos con el header del plugin (tested, author...) y el ícono del
    // repo. Ambos degradan a vacío ante cualquier fallo: nunca rompen el info.json.
    const [header, iconName] = await Promise.all([
      fetchPluginHeader({ owner: env.GITHUB_OWNER, repo: plugin, pat: env.GITHUB_PAT }),
      findRepoIcon({ owner: env.GITHUB_OWNER, repo: plugin, pat: env.GITHUB_PAT }),
    ]);

    // El download_url y el icons quedan con plantilla __TEMPLATE__ → al servir la
    // reemplazamos por el origin real. Cacheamos SIN token; el ZIP sí lo re-anexa.
    metadata = buildMetadata({
      release,
      pluginSlug: plugin,
      pluginName: plugin,
      downloadUrl: `__TEMPLATE__/${plugin}/download/${release.tag_name}`,
      header,
      iconUrl: iconName ? `__TEMPLATE__/${plugin}/icon` : undefined,
      iconIsSvg: iconName?.toLowerCase().endsWith(".svg"),
    }) as unknown as Record<string, unknown>;

    const ttl = Number(env.CACHE_TTL_SECONDS) || 300;
    const cacheResp = new Response(JSON.stringify(metadata), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` },
    });
    ctx.waitUntil(cache.put(cacheKey, cacheResp));
  }

  // Reemplazamos la plantilla con la URL absoluta + site_token de este caller.
  const downloadUrl = (metadata.download_url as string).replace(
    "__TEMPLATE__",
    `${url.origin}`
  );
  metadata.download_url = `${downloadUrl}?site_token=${encodeURIComponent(token!)}`;

  // El ícono NO lleva token (lo carga el <img> del wp-admin). Solo resolvemos origin.
  if (metadata.icons && typeof metadata.icons === "object") {
    const icons = metadata.icons as Record<string, string>;
    for (const k of Object.keys(icons)) {
      icons[k] = icons[k]!.replace("__TEMPLATE__", `${url.origin}`);
    }
  }

  return json(metadata);
}

async function handleIcon(env: Env, plugin: string): Promise<Response> {
  const name = await findRepoIcon({
    owner: env.GITHUB_OWNER,
    repo: plugin,
    pat: env.GITHUB_PAT,
  });
  if (!name) return json({ error: "no_icon" }, 404);
  return streamRepoIcon({ owner: env.GITHUB_OWNER, repo: plugin, name, pat: env.GITHUB_PAT });
}

async function handleDownload(
  request: Request,
  env: Env,
  plugin: string,
  tag: string,
  url: URL
): Promise<Response> {
  const token = url.searchParams.get("site_token");
  const referer = request.headers.get("referer");

  const validation = await validateSiteToken(env, token, plugin, referer);
  if (!validation.valid) {
    return json({ error: "token_invalid", reason: validation.reason }, 403);
  }

  // Obtenemos la release específica por tag — NO la última — para que el
  // sitio reciba lo que pidió PUC tras leer el info.json. Evita race en el
  // medio de una redeployada.
  let releases;
  try {
    releases = await fetchReleases({
      owner: env.GITHUB_OWNER,
      repo: plugin,
      pat: env.GITHUB_PAT,
    });
  } catch (err) {
    return json({ error: "upstream_github", detail: String(err) }, 502);
  }

  const release = releases.find((r) => r.tag_name === tag);
  if (!release) return json({ error: "tag_not_found", tag }, 404);

  const asset = pickZipAsset(release);
  if (!asset) return json({ error: "release_has_no_zip" }, 404);

  return streamAsset({ assetApiUrl: asset.url, pat: env.GITHUB_PAT });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
