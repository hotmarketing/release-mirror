/**
 * Construye el metadata.json que espera plugin-update-checker.
 */

import type { GitHubRelease, PucMetadata } from "./types";

interface BuildMetadataOptions {
  release: GitHubRelease;
  pluginSlug: string;
  pluginName: string;
  downloadUrl: string;
}

/**
 * GitHub devuelve published_at ISO. PUC quiere "YYYY-MM-DD HH:MM:SS".
 */
function formatDate(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * Quita el prefijo "v" de tag_name porque PUC compara con version_compare().
 * "v1.6.0-rc.2" → "1.6.0-rc.2"
 */
function normalizeVersion(tag: string): string {
  return tag.replace(/^v/, "");
}

export function buildMetadata({
  release,
  pluginSlug,
  pluginName,
  downloadUrl,
}: BuildMetadataOptions): PucMetadata {
  return {
    name: pluginName,
    slug: pluginSlug,
    version: normalizeVersion(release.tag_name),
    download_url: downloadUrl,
    last_updated: formatDate(release.published_at),
    sections: {
      description: pluginName,
      changelog: release.body ?? "",
    },
  };
}
