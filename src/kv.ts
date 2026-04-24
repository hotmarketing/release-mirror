/**
 * KV helpers — lookup y validación de site_tokens.
 */

import type { Env, SiteTokenRecord } from "./types";

export interface TokenValidation {
  valid: boolean;
  reason?: "not_found" | "revoked" | "expired" | "plugin_mismatch" | "domain_mismatch";
  record?: SiteTokenRecord;
}

/**
 * Busca un site_token en KV y valida contra plugin/dominio opcional.
 *
 * @param env          Worker env
 * @param token        Site token que manda el cliente (query param)
 * @param plugin       Slug del plugin que se está pidiendo ("directorio-turistico")
 * @param referer      Valor del header Referer (para domain validation)
 */
export async function validateSiteToken(
  env: Env,
  token: string | null,
  plugin: string,
  referer: string | null
): Promise<TokenValidation> {
  if (!token) return { valid: false, reason: "not_found" };

  const raw = await env.SITE_TOKENS.get(token, "json");
  if (!raw) return { valid: false, reason: "not_found" };

  const record = raw as SiteTokenRecord;

  if (!record.active) return { valid: false, reason: "revoked", record };

  if (record.expires_at) {
    const expires = new Date(record.expires_at).getTime();
    if (Date.now() > expires) return { valid: false, reason: "expired", record };
  }

  if (record.plugin !== plugin) {
    return { valid: false, reason: "plugin_mismatch", record };
  }

  if (record.allowed_domain && referer) {
    try {
      const refHost = new URL(referer).hostname;
      if (refHost !== record.allowed_domain && !refHost.endsWith(`.${record.allowed_domain}`)) {
        return { valid: false, reason: "domain_mismatch", record };
      }
    } catch {
      // Referer malformado — no bloqueamos (PUC a veces no manda referer
      // sensato), solo loggeamos en el futuro si agregamos observability.
    }
  }

  return { valid: true, record };
}
