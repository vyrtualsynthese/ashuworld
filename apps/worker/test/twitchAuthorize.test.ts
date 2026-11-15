import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyCallback,
  exchangeTwitchCode,
  main,
  twitchAuthorizeUrl,
} from '../src/twitchAuthorize.js'

const env = { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'secret' }

const REDIRECT = 'http://localhost:17563/twitch/callback'

/** The first element of a list the test knows is non-empty, without a non-null assertion. */
function first<T>(items: readonly T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error('expected at least one element')
  return item
}

/**
 * A fake `fetch` that records what it was called with and answers one canned response.
 * Nothing here reaches the network, which is the point: the command's two network edges
 * are values the test hands in.
 */
type FetchInput = Parameters<typeof fetch>[0]

function fakeFetch(body: unknown, status = 200): {
  impl: typeof fetch
  calls: Array<[FetchInput, RequestInit | undefined]>
} {
  const calls: Array<[FetchInput, RequestInit | undefined]> = []
  const impl: typeof fetch = async (input, init) => {
    calls.push([input, init])
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('twitchAuthorizeUrl', () => {
  it('asks for the channel follower scope on the fixed loopback redirect', () => {
    const url = new URL(twitchAuthorizeUrl(env))
    expect(`${url.origin}${url.pathname}`).toBe('https://id.twitch.tv/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('moderator:read:followers')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
  })

  it('carries a fresh 32-byte state on every run', () => {
    const stateOf = (): string => {
      const state = new URL(twitchAuthorizeUrl(env)).searchParams.get('state')
      if (state === null) throw new Error('expected a state')
      return state
    }
    const a = stateOf()
    const b = stateOf()
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
  })

  it('names the missing client id', () => {
    expect(() => twitchAuthorizeUrl({})).toThrow(/TWITCH_CLIENT_ID/)
  })
})

describe('exchangeTwitchCode', () => {
  it('posts the code and returns the refresh token', async () => {
    const { impl, calls } = fakeFetch({ access_token: 'at', refresh_token: 'rt' })

    await expect(exchangeTwitchCode(env, 'the-code', impl)).resolves.toEqual({
      refreshToken: 'rt',
    })

    const [input, init] = first(calls)
    expect(String(input)).toBe('https://id.twitch.tv/oauth2/token')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' })

    const body = new URLSearchParams(String(init?.body))
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBe('secret')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe(REDIRECT)
  })

  it('tells the operator to disconnect the app and run it again when no refresh token came back', async () => {
    const { impl } = fakeFetch({ access_token: 'at', expires_in: 3600 })

    await expect(exchangeTwitchCode(env, 'the-code', impl)).rejects.toThrow(
      /disconnect the app at https:\/\/www\.twitch\.tv\/settings\/connections[\s\S]*again/i,
    )
  })

  it('refuses a non-2xx answer and names the status', async () => {
    const { impl } = fakeFetch({ status: 400, message: 'Invalid authorization code' }, 400)

    await expect(exchangeTwitchCode(env, 'spent-code', impl)).rejects.toThrow(/HTTP 400/)
  })

  it('names the missing client secret and never calls Twitch', async () => {
    const { impl, calls } = fakeFetch({ refresh_token: 'rt' })

    await expect(
      exchangeTwitchCode({ TWITCH_CLIENT_ID: 'cid' }, 'the-code', impl),
    ).rejects.toThrow(/TWITCH_CLIENT_SECRET/)
    expect(calls).toHaveLength(0)
  })
})

describe('classifyCallback', () => {
  const state = 'state-of-this-run'

  it('refuses an error whose state is not this run, so stray traffic cannot end the run', () => {
    const verdict = classifyCallback(
      new URLSearchParams({ error: 'access_denied', state: 'not-this-run' }),
      state,
    )

    expect(verdict).toEqual({
      kind: 'refused',
      page: 'The callback did not come from this run; nothing was exchanged.',
      reason:
        'the callback state did not match this run, so nothing was exchanged; ' +
        'start the command again and use the URL it prints',
    })
    expect(verdict.kind === 'refused' ? verdict.reason : '').not.toMatch(/access_denied/)
  })

  it('refuses a code whose state is not this run, so the code path keeps the check', () => {
    const verdict = classifyCallback(
      new URLSearchParams({ code: 'the-code', state: 'not-this-run' }),
      state,
    )

    expect(verdict.kind).toBe('refused')
    expect(verdict.kind === 'refused' ? verdict.reason : '').toMatch(/state did not match/)
  })

  it('refuses a callback with no state at all', () => {
    expect(classifyCallback(new URLSearchParams({ code: 'the-code' }), state).kind).toBe(
      'refused',
    )
  })

  it('honours an error and a code only when the state matches this run', () => {
    expect(
      classifyCallback(
        new URLSearchParams({
          error: 'access_denied',
          error_description: 'The user denied you access to your account',
          state,
        }),
        state,
      ),
    ).toEqual({
      kind: 'refused',
      page: 'Twitch refused the authorization; the terminal says why.',
      reason:
        'Twitch refused the authorization: access_denied (The user denied you access to your account)',
    })

    expect(
      classifyCallback(new URLSearchParams({ code: 'the-code', state }), state),
    ).toEqual({ kind: 'code', code: 'the-code' })
  })

  it('refuses a matching callback that carries neither an error nor a code', () => {
    expect(classifyCallback(new URLSearchParams({ state }), state)).toEqual({
      kind: 'refused',
      page: 'Twitch redirected back without a code; run the command again.',
      reason: 'Twitch redirected back without a code',
    })
  })
})

describe('main', () => {
  it('exits non-zero naming the missing variable, before opening a port', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(main({})).resolves.toBe(1)

    expect(errors.mock.calls.flat().join('\n')).toMatch(/TWITCH_CLIENT_ID/)
  })
})
