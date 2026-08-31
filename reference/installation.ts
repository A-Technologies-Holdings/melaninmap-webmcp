/**
 * Installation identity for the agent gateway lane.
 *
 * FLATTENED FOR PUBLICATION: the deployed file imports
 * `getWebDemoInstallationId` from the site's shared identity module so the
 * agent lane and the web demo share one id (attribution continuity depends on
 * that). The shared helper is inlined below, unchanged in behavior, so this
 * directory stands alone.
 *
 * The id is an anonymous, session-scoped `mm-web-<uuid>`. It is not an
 * account, it carries no personal data, and — importantly for anyone copying
 * this pattern — it is minted by the browser, so it must never be the only key
 * a rate limit uses. See SECURITY.md.
 */

const INSTALLATION_KEY = "mm_web_demo_installation_id";

let inMemoryFallbackId: string | null = null;

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Inlined from the site's shared web-demo identity module. */
function getWebDemoInstallationId(): string {
  if (typeof window === "undefined") {
    return `mm-web-ssr-${randomId()}`;
  }
  const existing = sessionStorage.getItem(INSTALLATION_KEY);
  if (existing) return existing;
  const created = `mm-web-${randomId()}`;
  sessionStorage.setItem(INSTALLATION_KEY, created);
  return created;
}

export function getAgentInstallationId(): string {
  try {
    return getWebDemoInstallationId();
  } catch {
    // Storage access threw (private mode / storage disabled). Fall back to a
    // session-scoped in-memory id with the same shape and length guarantees.
    if (!inMemoryFallbackId) {
      inMemoryFallbackId = `mm-web-${randomId()}`;
    }
    return inMemoryFallbackId;
  }
}
