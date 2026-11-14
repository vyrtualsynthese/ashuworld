import { describe, expect, it, vi } from 'vitest'
import { createTwitchProvider } from '../../src/auth/providers/twitch.js'
import { ProviderExchangeError } from '../../src/auth/providers.js'

/**
 * Node's fetch types come from `undici-types`, which exports `RequestInfo` from its module
 * but does not declare it globally. Declaring it here keeps the fake `fetch` signatures
 * readable and identical in meaning: `string | URL | Request`.
 */
type RequestInfo = string | URL | Request

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function provider(fetchImpl: typeof fetch) {
  return createTwitchProvider({
    clientId: 'cid', clientSecret: 'secret', channelLogin: 'ashuworld', fetchImpl,
  })
}

describe('twitch provider', () => {
  it('builds an authorize URL with the follow scope and the state', () => {
    const url = new URL(provider(vi.fn()).authorizeUrl({
      state: 's1', redirectUri: 'https://example.test/auth/twitch/callback',
    }))
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('scope')).toBe('user:read:follows')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/auth/twitch/callback')
  })

  it('exchanges the code, reads the identity and proves the follow', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://id.twitch.tv/oauth2/token') {
        return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      }
      if (url.startsWith('https://api.twitch.tv/helix/users')) {
        return json({ data: [{ id: '42', login: 'ashu', display_name: 'Ashu' }] })
      }
      if (url.startsWith('https://api.twitch.tv/helix/channels/followed')) {
        return json({ data: [{ broadcaster_id: '9', broadcaster_login: 'ashuworld' }], pagination: {} })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const result = await provider(fetchImpl).exchange({
      code: 'c1', redirectUri: 'https://example.test/auth/twitch/callback',
    })
    expect(result.profile).toEqual({ provider: 'twitch', externalId: '42', displayHandle: 'ashu', displayName: 'Ashu' })
    expect(result.verifiedActions).toEqual(['twitch.follow'])
    expect(result.refreshToken).toBeUndefined()
  })

  it('signs in with no verified action when the channel is not followed', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'at' })
      if (url.includes('/helix/users')) return json({ data: [{ id: '42', login: 'ashu', display_name: 'Ashu' }] })
      return json({ data: [], pagination: {} })
    }) as unknown as typeof fetch

    const result = await provider(fetchImpl).exchange({ code: 'c1', redirectUri: 'https://example.test/cb' })
    expect(result.verifiedActions).toEqual([])
  })

  it('still signs in when Twitch refuses to show the follow list', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'at' })
      if (url.includes('/helix/users')) return json({ data: [{ id: '42', login: 'ashu', display_name: 'Ashu' }] })
      if (url.includes('/helix/channels/followed')) return json({ message: 'unauthorized' }, 403)
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const result = await provider(fetchImpl).exchange({ code: 'c1', redirectUri: 'https://example.test/cb' })
    expect(result.profile).toEqual({ provider: 'twitch', externalId: '42', displayHandle: 'ashu', displayName: 'Ashu' })
    expect(result.verifiedActions).toEqual([])
  })

  it('rejects with 502 when Twitch returns no account', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'at' })
      return json({ data: [] })
    }) as unknown as typeof fetch

    // One promise, asserted twice: the identity read is a deployment problem, so it must
    // not answer 400 the way a refused code does.
    const exchange = provider(fetchImpl).exchange({ code: 'c1', redirectUri: 'https://example.test/cb' })
    await expect(exchange).rejects.toBeInstanceOf(ProviderExchangeError)
    await expect(exchange).rejects.toMatchObject({ httpStatus: 502 })
  })

  it('pages until it finds the channel', async () => {
    const followed: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'at' })
      if (url.includes('/helix/users')) return json({ data: [{ id: '42', login: 'ashu', display_name: 'Ashu' }] })
      if (!url.includes('/helix/channels/followed')) throw new Error(`unexpected ${url}`)

      followed.push(url)
      if (followed.length === 1) {
        return json({ data: [{ broadcaster_id: '1', broadcaster_login: 'other' }], pagination: { cursor: 'next' } })
      }
      return json({ data: [{ broadcaster_id: '9', broadcaster_login: 'AshuWorld' }], pagination: {} })
    }) as unknown as typeof fetch

    const result = await provider(fetchImpl).exchange({ code: 'c1', redirectUri: 'https://example.test/cb' })
    expect(followed).toHaveLength(2)
    // A cursor that is read but never sent back would still pass every other assertion here.
    expect(followed.map((url) => new URL(url).searchParams.get('after'))).toEqual([null, 'next'])
    expect(result.verifiedActions).toEqual(['twitch.follow'])
  })

  it('fails as a 4xx when Twitch refuses the code', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'Invalid authorization code' }, 400)) as unknown as typeof fetch
    await expect(provider(fetchImpl).exchange({ code: 'bad', redirectUri: 'https://example.test/cb' }))
      .rejects.toBeInstanceOf(ProviderExchangeError)
  })
})
