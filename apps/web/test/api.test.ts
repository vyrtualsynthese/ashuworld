import { describe, expect, it } from 'vitest'
import { ApiError, getJson, postJson } from '../src/api'
import { jsonResponse, stubFetch, textResponse } from './helpers'

describe('getJson', () => {
  it('reads a same-origin path and parses the body', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ hello: 'world' }))

    await expect(getJson<{ hello: string }>('/api/public/ladder')).resolves.toEqual({
      hello: 'world',
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/public/ladder', {
      credentials: 'same-origin',
    })
  })

  it('throws an ApiError carrying the status and the server code', async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: 'not_found', message: 'the requested resource does not exist' } },
        404,
      ),
    )

    const error = await getJson('/api/public/fans/nobody').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 404, code: 'not_found' })
    expect((error as ApiError).message).toMatch(/requested resource does not exist/)
  })

  it('keeps a non-JSON error body instead of swallowing it', async () => {
    stubFetch(() => textResponse('<html>bad gateway</html>', 502))

    const error = (await getJson('/api/me').catch((caught: unknown) => caught)) as ApiError

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(502)
    expect(error.code).toBe('unreadable_response')
    expect(error.raw).toBe('<html>bad gateway</html>')
    // The raw body is data for a developer, not a sentence to show a fan.
    expect(error.message).not.toMatch(/bad gateway/)
  })

  it('names an empty error body rather than reporting a JSON parse failure', async () => {
    stubFetch(() => new Response(null, { status: 500 }))

    const error = (await getJson('/api/me').catch((caught: unknown) => caught)) as ApiError

    expect(error.status).toBe(500)
    expect(error.code).toBe('http_error')
    expect(error.raw).toBe('')
  })

  it('falls back to a generic code when the error body has no code', async () => {
    stubFetch(() => jsonResponse({ message: 'something went wrong' }, 418))

    const error = (await getJson('/api/me').catch((caught: unknown) => caught)) as ApiError

    expect(error.status).toBe(418)
    expect(error.code).toBe('http_error')
  })

  it('reports an unreachable server as a network error with status 0', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')))

    const error = (await getJson('/api/me').catch((caught: unknown) => caught)) as ApiError

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(0)
    expect(error.code).toBe('network')
    expect(error.message).not.toMatch(/fetch failed/)
  })

  it('reports a success body that is not JSON without pretending it parsed', async () => {
    stubFetch(() => textResponse('<html>not json</html>', 200))

    const error = (await getJson('/api/me').catch((caught: unknown) => caught)) as ApiError

    expect(error.status).toBe(200)
    expect(error.code).toBe('unreadable_response')
    expect(error.raw).toBe('<html>not json</html>')
  })
})

describe('postJson', () => {
  it('sends a JSON body when it has one', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }))

    await postJson('/api/thing', { handle: 'ashu' })

    expect(fetchMock).toHaveBeenCalledWith('/api/thing', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'ashu' }),
    })
  })

  it('sends no body and no content type when called without one', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }))

    await expect(postJson('/auth/logout')).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    })
  })

  it('throws the same typed error on a refusal', async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: 'last_identity', message: 'keep at least one identity' } },
        409,
      ),
    )

    const error = (await postJson('/api/me/identities/x/detach').catch((caught: unknown) => caught)) as ApiError

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(409)
    expect(error.code).toBe('last_identity')
  })
})

describe('ApiError', () => {
  it('is a real Error with a name and a stable shape', () => {
    const error = new ApiError(503, 'database_unavailable', 'the database did not answer')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ApiError')
    expect(error.status).toBe(503)
    expect(error.code).toBe('database_unavailable')
    expect(error.raw).toBeNull()
  })
})
