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
import { fetchReleases, pickLatestForTrack, pickZipAsset, streamAsset } from "./github";
import { buildMetadata } from "./puc";

const WORKER_VERSION = "0.1.0";

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

    if (request.method !== "GET") {
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

    // El download_url queda plantilla — abajo le embebemos el site_token del caller.
    // Guardamos en cache la versión SIN token, y al servir la construimos.
    metadata = buildMetadata({
      release,
      pluginSlug: plugin,
      pluginName: plugin,
      downloadUrl: `__TEMPLATE__/${plugin}/download/${release.tag_name}`,
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

  return json(metadata);
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
