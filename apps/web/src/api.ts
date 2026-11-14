/** The shape every failure in the api uses. Mirrors `apps/api/src/errors.ts`. */
export interface ErrorEnvelope {
  error: {
    code: string
    message: string
  }
}

/** One fan account on the public ladder. */
export interface LadderFan {
  fanId: string
  handle: string
  level: number
  balance: number
}

/** One provider account that has never been attached to a fan. */
export interface FreeStandingAccount {
  identityId: string
  provider: string
  displayHandle: string
  xp: number
}

/** What `GET /api/public/ladder` answers. */
export interface Ladder {
  linked: LadderFan[]
  freeStanding: FreeStandingAccount[]
}

/** A provider account currently attached to a fan. */
export interface FanIdentity {
  id: string
  provider: string
  displayHandle: string
  linked: boolean
}

/** What the public profile answers: the fan, the standing and the attached accounts. */
export interface PublicFan {
  handle: string
  displayName: string
  level: number
  balance: number
  peakXp: number
  identities: Array<{ provider: string; displayHandle: string }>
}

/** What `GET /api/me` answers. */
export interface Me {
  id: string
  handle: string
  displayName: string
  balance: number
  peakXp: number
  level: number
  identities: FanIdentity[]
}

/** What a successful detach answers: the standing that is left afterwards. */
export interface DetachResult {
  forfeitedEntries: number
  balance: number
  peakXp: number
  level: number
}

/** One action on the public rules page: what it pays and how to explain it. */
export interface PublicAction {
  key: string
  provider: string
  amount: number
  /** What returns every month while the condition holds; 0 when the action has none. */
  monthly: number
  label: string
  description: string
}

/** One level threshold on the public rules page. */
export interface PublicLevel {
  level: number
  minXp: number
}

/**
 * What `GET /api/public/game` answers.
 *
 * The values come from `config/game.json` through the api, not from this bundle: the page
 * and the ledger cannot disagree about what an action pays, because there is one copy.
 */
export interface PublicGame {
  actions: PublicAction[]
  levels: PublicLevel[]
}

/**
 * A failed call, carrying what the caller needs to branch on.
 *
 * `status` is the HTTP status, or `0` when the request never reached the server. `code` is
 * the server's own error code when it sent one, and a named fallback otherwise, so a page
 * can decide between "sign in", "no such fan" and "try again" without parsing a sentence.
 *
 * `raw` keeps a body that was not the expected JSON envelope. It is deliberately not part
 * of `message`: a proxy's HTML error page is evidence for whoever debugs the call, and
 * must never end up on screen as if it were written for a fan.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly raw: string | null

  constructor(status: number, code: string, message: string, raw: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.raw = raw
  }
}

const NETWORK_MESSAGE = 'your browser could not reach the server'
const UNREADABLE_MESSAGE = 'the server answered with something this page could not read'
const REFUSED_MESSAGE = 'the server refused the request'

/** Reads the body as text, even when the response is an error with no body at all. */
async function readText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** The `{ error: { code, message } }` envelope, if that is what the body holds. */
function readEnvelope(body: string): { code: string; message: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const envelope = (parsed as { error?: unknown }).error
  if (typeof envelope !== 'object' || envelope === null) return null
  const { code, message } = envelope as { code?: unknown; message?: unknown }
  if (typeof code !== 'string' || code === '') return null
  return {
    code,
    message: typeof message === 'string' && message !== '' ? message : REFUSED_MESSAGE,
  }
}

/**
 * Turns a non-2xx response into the typed error.
 *
 * A body that is not JSON keeps its bytes in `raw` and gets a named code, so a broken
 * proxy is still diagnosable instead of being flattened into "something went wrong".
 * A JSON body without the envelope gets `http_error`: the status is the only fact the
 * server actually gave.
 */
function errorFromResponse(status: number, body: string): ApiError {
  if (body.trim() === '') return new ApiError(status, 'http_error', REFUSED_MESSAGE, '')
  const envelope = readEnvelope(body)
  if (envelope === null) {
    return body.trimStart().startsWith('{')
      ? new ApiError(status, 'http_error', REFUSED_MESSAGE, body)
      : new ApiError(status, 'unreadable_response', UNREADABLE_MESSAGE, body)
  }
  return new ApiError(status, envelope.code, envelope.message, null)
}

/**
 * One request, with the session treated the way the browser must treat it.
 *
 * `credentials: 'same-origin'` is what makes the `HttpOnly` session cookie travel with the
 * call. The app never reads that cookie — it cannot — and never stores a copy of it: every
 * page asks the server who the caller is.
 */
async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init })
  } catch {
    throw new ApiError(0, 'network', NETWORK_MESSAGE)
  }

  const body = await readText(response)
  if (!response.ok) throw errorFromResponse(response.status, body)
  if (body === '') return undefined as T

  try {
    return JSON.parse(body) as T
  } catch {
    throw new ApiError(response.status, 'unreadable_response', UNREADABLE_MESSAGE, body)
  }
}

/** A same-origin GET, with the body parsed as `T`. */
export function getJson<T>(path: string): Promise<T> {
  return request<T>(path, {})
}

/**
 * A same-origin POST. The body is JSON when there is one, and the request has neither a
 * body nor a content type when there is not: `/auth/logout` and a detach take no payload.
 */
export function postJson<T = void>(path: string, body?: unknown): Promise<T> {
  if (body === undefined) return request<T>(path, { method: 'POST' })
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The public ladder. */
export function fetchLadder(): Promise<Ladder> {
  return getJson<Ladder>('/api/public/ladder')
}

/** One public profile. The handle comes from the URL, so it is escaped before it is a path. */
export function fetchFan(handle: string): Promise<PublicFan> {
  return getJson<PublicFan>(`/api/public/fans/${encodeURIComponent(handle)}`)
}

/** The public game rules: every action's value and the level thresholds. */
export function fetchPublicGame(): Promise<PublicGame> {
  return getJson<PublicGame>('/api/public/game')
}

/** The signed-in fan, or a 401 `ApiError` when there is none. */
export function fetchMe(): Promise<Me> {
  return getJson<Me>('/api/me')
}

/** Detaches one identity. A `last_identity` refusal arrives as a 409 `ApiError`. */
export function detachIdentity(identityId: string): Promise<DetachResult> {
  return postJson<DetachResult>(`/api/me/identities/${encodeURIComponent(identityId)}/detach`)
}

/** Ends the session server-side. The server clears the cookie; the app never sees it. */
export function signOut(): Promise<void> {
  return postJson<void>('/auth/logout')
}
