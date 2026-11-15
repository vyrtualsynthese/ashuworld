import { describe, expect, it } from 'vitest'
import { DEFAULT_RETRY_AFTER_MS, realSleep, retryAfterMs } from '../src/connectors/httpRetry.js'

/**
 * The header's only useful form is whole seconds, and every other shape has to become the
 * default rather than a zero-length wait: retrying at once is what the 429 just refused.
 */
describe('retryAfterMs', () => {
  it('reads whole seconds as milliseconds', () => {
    expect(retryAfterMs('2')).toBe(2000)
    expect(retryAfterMs('0')).toBe(0)
    expect(retryAfterMs(' 30 ')).toBe(30_000)
  })

  it('falls back to the default when the header is absent or unusable', () => {
    // Twitch might omit it, or a proxy might blank it, send a date, or send a negative.
    for (const header of [null, '', '   ', 'soon', 'Wed, 21 Oct 2015 07:28:00 GMT', '-1', 'Infinity']) {
      expect(retryAfterMs(header)).toBe(DEFAULT_RETRY_AFTER_MS)
    }
  })
})

/** The default is a real timer, so it is proven once here instead of on every connector test. */
describe('realSleep', () => {
  it('resolves after the delay it was given', async () => {
    const started = Date.now()
    await realSleep(0)
    expect(Date.now()).toBeGreaterThanOrEqual(started)
  })
})
