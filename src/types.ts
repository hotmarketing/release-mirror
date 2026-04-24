/**
 * Shared types para el Worker.
 */

export interface Env {
  SITE_TOKENS: KVNamespace;
  GITHUB_PAT: string;
  GITHUB_OWNER: string;
  CACHE_TTL_SECONDS: string;
  ADMIN_TOKEN?: string;
}

/**
 * Forma que guardamos en KV por cada site_token.
 *
 * key   = site_token (random ~32 chars)
 * value = JSON serializado de SiteTokenRecord
 */
export interface SiteTokenRecord {
  client: string;              // nombre humano, ej. "secturi"
  plugin: string;              // slug del repo, ej. "directorio-turistico"
  active: boolean;             // killswitch
  track: ReleaseTrack;         // qué versiones ofrecerle
  allowed_domain?: string;     // si está seteado, valida Referer
  created_at: string;          // ISO
  expires_at?: string;         // ISO opcional
  notes?: string;              // freeform para contexto humano
}

export type ReleaseTrack = "stable" | "beta" | "all";

/**
 * Schema JSON que espera plugin-update-checker cuando buildUpdateChecker()
 * recibe una URL a un metadata.json (en vez de URL de repo GitHub).
 *
 * Ref: github.com/YahnisElsts/plugin-update-checker/blob/master/README.md#how-to-release-an-update
 */
export interface PucMetadata {
  name: string;
  slug: string;
  version: string;
  download_url: string;
  homepage?: string;
  requires?: string;
  tested?: string;
  requires_php?: string;
  author?: string;
  author_homepage?: string;
  last_updated: string;        // "YYYY-MM-DD HH:MM:SS"
  sections?: {
    description?: string;
    changelog?: string;
    installation?: string;
  };
  banners?: { low?: string; high?: string };
  icons?: { "1x"?: string; "2x"?: string; svg?: string };
}

/**
 * Shape de release de GitHub API — subset que usamos.
 */
export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  assets: GitHubAsset[];
  html_url: string;
}

export interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  content_type: string;
  browser_download_url: string;
  url: string;                  // API url (necesita auth)
}
