/**
 * Waiting out a rate limit, in the one place both Twitch calls share it.
 *
 * Twitch answers a call it will not serve yet with HTTP 429 and a `Retry-After` header in
 * whole seconds. Retrying at once keeps being refused, so the caller waits what the header
 * says and asks for the same thing again. Both the follower pages and the token refresh go
 * through this module: a rate-limited refresh that aborted the round would fail discovery
 * just as a rate-limited page would.
 */

/** A pause of `ms` milliseconds. Injected so a test records the wait instead of taking it. */
export type Sleep = (ms: number) => Promise<void>

/** The default pause when Twitch sends no usable `Retry-After`. */
export const DEFAULT_RETRY_AFTER_MS = 1_000

/** How many times one request is asked again after a 429, so at most four attempts. */
const MAX_RETRIES = 3

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How long a 429 asks the caller to wait, in milliseconds.
 *
 * Twitch sends whole seconds. Anything else (absent, blank, a date, a negative number) is
 * not a wait this code can honour, so it falls back to the one-second default rather than
 * retrying immediately into the same refusal.
 */
export function retryAfterMs(header: string | null): number {
  if (header === null) return DEFAULT_RETRY_AFTER_MS
  const text = header.trim()
  if (text === '') return DEFAULT_RETRY_AFTER_MS
  const seconds = Number(text)
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS
  return seconds * 1_000
}

/**
 * Sends one request, waiting through up to three rate-limit refusals.
 *
 * Only a 429 is retried. Every other status is handed back on the first answer so the call
 * site keeps its own message: a 401 is an expired grant and a 5xx is an outage, and neither
 * is fixed by asking again.
 *
 * After the third wait the last 429 is returned rather than thrown, so the caller reports a
 * rate limit through the same error it builds for every refusal and the wording of that
 * failure lives in one place.
 *
 * The body of a response that is about to be discarded is cancelled: an unread body holds
 * its connection open until the process gets round to it.
 */
export async function sendWithRateLimitRetry(
  send: () => Promise<Response>,
  sleep: Sleep,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await send()
    if (response.status !== 429 || attempt >= MAX_RETRIES) return response
    await response.body?.cancel()
    await sleep(retryAfterMs(response.headers.get('retry-after')))
  }
}
