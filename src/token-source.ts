/**
 * OpenCode v1 token access. v1 lets no plugin read another provider's credentials,
 * so opencode-keycloak-auth publishes a versioned token source in the symbol
 * registry (patches/opencode-keycloak-auth-token-source.diff). `token()` returns
 * the live, refreshed access token or `undefined`, never throws, never logs in.
 * v2 uses the host API instead (src/v2/index.ts).
 */
export const TOKEN_SOURCE_KEY = Symbol.for("opencode-keycloak-auth/token-source@1");

export interface KeycloakTokenSource {
  readonly version: 1;
  token(providerId: string): Promise<string | undefined>;
}

/** The token source published by opencode-keycloak-auth, if it is loaded and recent enough. */
export function keycloakTokenSource(
  scope: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>,
): KeycloakTokenSource | undefined {
  const source = scope[TOKEN_SOURCE_KEY] as Partial<KeycloakTokenSource> | undefined;
  if (!source || source.version !== 1 || typeof source.token !== "function") return undefined;
  return source as KeycloakTokenSource;
}

/** The current token of `providerId`, or `undefined` (no source, no token, any error). */
export async function tokenFor(
  providerId: string,
  scope?: Record<PropertyKey, unknown>,
): Promise<string | undefined> {
  const source = keycloakTokenSource(scope);
  if (!source) return undefined;
  try {
    const token = await source.token(providerId);
    return typeof token === "string" && token ? token : undefined;
  } catch {
    return undefined;
  }
}
