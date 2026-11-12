/**
 * Politique de collecte : un seul point de passage pour toutes les requêtes vers les sites de la
 * place, qui applique ce que leurs robots.txt et conditions demandent :
 *  - brvm.org : délai de 10 secondes entre deux requêtes (Crawl-delay) ;
 *  - sikafinance.com : les documents « /docs/ » ne sont pas téléchargés (Disallow) ; délai de 2 s ;
 *  - richbourse.com : extraction automatique refusée par le site (réponse 403 explicite) ; aucune
 *    requête n'est envoyée, les exports CSV du site s'importent à la main.
 * Les délais s'appliquent par hôte, toutes collectes confondues (file d'attente).
 */

export interface HostPolicy { delayMs: number; disallow: RegExp[]; blocked?: string }

export const HOST_POLICIES: Record<string, HostPolicy> = {
  "www.brvm.org": { delayMs: 10_000, disallow: [] },
  "brvm.org": { delayMs: 10_000, disallow: [] },
  "www.sikafinance.com": { delayMs: 2_000, disallow: [/^\/docs\//, /^\/listes\/displaylist/, /^\/portif\/displayp/] },
  "sikafinance.com": { delayMs: 2_000, disallow: [/^\/docs\//] },
  "www.richbourse.com": { delayMs: 0, disallow: [/.*/], blocked: "RichBourse refuse l'extraction automatique (ses exports CSV s'importent à la main)" },
  "richbourse.com": { delayMs: 0, disallow: [/.*/], blocked: "RichBourse refuse l'extraction automatique" },
};

export const USER_AGENT = "CrackenMarket/0.1 (+collecte publique BRVM ; contact via le dépôt)";

const lastRequestAt = new Map<string, number>();
const queues = new Map<string, Promise<void>>();

/** Vrai si la politique du site interdit cette adresse à un robot. */
export function isDisallowed(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "adresse invalide"; }
  const policy = HOST_POLICIES[u.hostname];
  if (!policy) return null;
  if (policy.blocked) return policy.blocked;
  return policy.disallow.some((re) => re.test(u.pathname)) ? `chemin interdit par le robots.txt de ${u.hostname}` : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Requête polie : refuse les adresses interdites, respecte le délai par hôte (file d'attente par
 * hôte), envoie un user-agent identifiable, abandonne après `timeoutMs`.
 */
export async function politeFetch(url: string, init: { timeoutMs?: number; fetchImpl?: typeof fetch; headers?: Record<string, string> } = {}): Promise<Response> {
  const reason = isDisallowed(url);
  if (reason) throw new Error(`${reason} : ${url}`);
  const host = new URL(url).hostname;
  const policy = HOST_POLICIES[host];
  const delay = Math.round((policy?.delayMs ?? 1_000) * delayScale);
  const prev = queues.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  queues.set(host, prev.then(() => mine));
  try {
    await prev;
    const wait = lastRequestAt.get(host) != null ? Math.max(0, delay - (Date.now() - lastRequestAt.get(host)!)) : 0;
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(host, Date.now());
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
    try {
      return await (init.fetchImpl ?? fetch)(url, { signal: ctrl.signal, headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) } });
    } finally {
      clearTimeout(t);
    }
  } finally {
    release();
  }
}

/** Texte d'une réponse, ou erreur HTTP explicite. */
export async function politeText(url: string, init?: Parameters<typeof politeFetch>[1]): Promise<string> {
  const res = await politeFetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.text();
}

/** Octets d'une réponse (PDF), ou erreur HTTP explicite. */
export async function politeBytes(url: string, init?: Parameters<typeof politeFetch>[1]): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await politeFetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "" };
}

/** Facteur appliqué aux délais (1 en production ; les tests le mettent à 0 avec un fetch factice). */
let delayScale = 1;

/** Pour les tests : remet les horloges à zéro et règle le facteur des délais. */
export function resetFetchPolicy(scale = 1): void {
  lastRequestAt.clear();
  queues.clear();
  delayScale = scale;
}
