/**
 * GitHub API helpers — consulta releases y stream de assets con el PAT del Worker.
 */

import type { GitHubRelease, ReleaseTrack } from "./types";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "hm-release-mirror/0.1";

interface FetchReleasesOptions {
  owner: string;
  repo: string;
  pat: string;
}

/**
 * Obtiene hasta 30 releases del repo (suficiente para encontrar la última
 * del track deseado). Ordenadas más nuevas primero.
 */
export async function fetchReleases({
  owner,
  repo,
  pat,
}: FetchReleasesOptions): Promise<GitHubRelease[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=30`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }

  return (await res.json()) as GitHubRelease[];
}

/**
 * Elige la release más reciente que encaja en el track.
 *
 * - stable → primera no-prerelease, no-draft
 * - beta   → primera no-draft (prefiere stable si hay empate de orden)
 * - all    → primera no-draft
 *
 * Asume que GitHub las devuelve ordenadas por published_at DESC.
 */
export function pickLatestForTrack(
  releases: GitHubRelease[],
  track: ReleaseTrack
): GitHubRelease | null {
  const published = releases.filter((r) => !r.draft);
  if (published.length === 0) return null;

  if (track === "stable") {
    return published.find((r) => !r.prerelease) ?? null;
  }
  // "beta" y "all" se comportan igual: ofrecen todo lo publicado, más nueva primero.
  return published[0] ?? null;
}

/**
 * Devuelve el primer asset con nombre .zip.
 * El workflow de release del plugin sube ONE .zip con vendor/ bundleado.
 */
export function pickZipAsset(release: GitHubRelease) {
  return release.assets.find((a) => a.name.toLowerCase().endsWith(".zip")) ?? null;
}

/**
 * Stream del asset ZIP. GitHub devuelve 302 al S3 presigned — fetch lo sigue
 * solo si pedimos Accept: octet-stream. No bufferamos en el Worker; pasamos el
 * body directo al cliente.
 */
export async function streamAsset({
  assetApiUrl,
  pat,
}: {
  assetApiUrl: string;
  pat: string;
}): Promise<Response> {
  const upstream = await fetch(assetApiUrl, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/octet-stream",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream error: ${upstream.status}`, { status: 502 });
  }

  // Pasamos content-length / content-type si vienen, omitimos el resto por privacidad.
  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "application/zip",
    "Cache-Control": "public, max-age=60",
  });
  const cl = upstream.headers.get("content-length");
  if (cl) headers.set("Content-Length", cl);

  return new Response(upstream.body, { status: 200, headers });
}
