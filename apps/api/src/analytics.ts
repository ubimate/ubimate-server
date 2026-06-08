/**
 * Server-side Umami analytics helper.
 *
 * Fires events to the Umami server-side API (POST /api/send).
 * All calls are fire-and-forget — errors are swallowed so analytics
 * never affect request latency or reliability.
 *
 * Required env vars:
 *   UMAMI_URL          — base URL of your Umami instance, e.g. https://analytics.ubimate.com
 *   UMAMI_WEBSITE_ID   — website ID from the Umami dashboard (e.g. the "app-ubimate-com" entry)
 *
 * If either variable is absent the module is a no-op.
 */

const UMAMI_URL        = process.env.UMAMI_URL;
const UMAMI_WEBSITE_ID = process.env.UMAMI_WEBSITE_ID;

const enabled = Boolean(UMAMI_URL && UMAMI_WEBSITE_ID);

/**
 * Send an event to Umami. Fire-and-forget — never throws.
 *
 * @param name       Event name, e.g. 'user-created'
 * @param data       Optional anonymous properties. Must not contain PII.
 */
export function trackEvent(name: string, data?: Record<string, string | number | boolean>): void {
  if (!enabled) return;

  const payload = {
    type: 'event',
    payload: {
      website: UMAMI_WEBSITE_ID,
      url: '/api',          // virtual path so events appear as a single source
      name,
      ...(data ? { data } : {}),
    },
  };

  fetch(`${UMAMI_URL}/api/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ubimate-api',
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Intentionally ignored — analytics must never affect API behaviour.
  });
}
