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
 * Compara dos tags semver (con o sin prefijo "v") según semver 2.0.0 §11.
 * Devuelve <0 si a<b, 0 si iguales, >0 si a>b.
 *
 * Clave del fix: un release estable (sin prerelease) tiene MAYOR precedencia
 * que su propio prerelease — `1.9.0 > 1.9.0-rc.2`. No podemos confiar en el
 * orden del array de GitHub (va por created_at, no por semver), así que
 * comparamos explícitamente. Tags no-semver comparan como menores (pierden).
 */
export function compareSemver(tagA: string, tagB: string): number {
  const a = parseSemver(tagA);
  const b = parseSemver(tagB);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[]; // [] = release estable (mayor precedencia)
}

function parseSemver(tag: string): ParsedSemver | null {
  // Quita prefijo "v" y build metadata (+...), que no cuenta para precedencia.
  const core = tag.replace(/^v/, "").trim().split("+")[0] ?? "";
  const dash = core.indexOf("-");
  const mainPart = dash === -1 ? core : core.slice(0, dash);
  const prePart = dash === -1 ? "" : core.slice(dash + 1);
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(mainPart);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: prePart === "" ? [] : prePart.split("."),
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  // Estable (sin identificadores) gana a cualquier prerelease.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1; // identificador numérico < alfanumérico
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1; // comparación ASCII
    }
  }
  // Iguales hasta donde alcanza el más corto → el que tiene más identificadores gana.
  return a.length - b.length;
}

/**
 * Elige la release de MAYOR versión semver que encaja en el track.
 *
 * - stable → mayor semver entre las no-prerelease, no-draft
 * - beta / all → mayor semver entre todas las no-draft (incluye prereleases)
 *
 * NO confiamos en el orden del array de GitHub (created_at DESC): un prerelease
 * creado después que su estable aparecería primero pero es de MENOR precedencia.
 * Reducimos por `compareSemver` para que `1.9.0` le gane a `1.9.0-rc.2`, pero un
 * futuro `1.10.0-rc.1` sí le gane a `1.9.0` en track all/beta. Empates y tags
 * no-semver caen al primero del array (el más reciente por created_at).
 */
export function pickLatestForTrack(
  releases: GitHubRelease[],
  track: ReleaseTrack
): GitHubRelease | null {
  let candidates = releases.filter((r) => !r.draft);
  if (track === "stable") {
    candidates = candidates.filter((r) => !r.prerelease);
  }
  if (candidates.length === 0) return null;

  return candidates.reduce((best, cur) =>
    compareSemver(cur.tag_name, best.tag_name) > 0 ? cur : best
  );
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
