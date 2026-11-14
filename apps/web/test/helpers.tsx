import { render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'

/** A real `Response`, so the api client is tested against the interface the browser gives it. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A response that is not JSON at all, e.g. a proxy's error page. */
export function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

/** Renders a page with a router around it, because every page links somewhere. */
export function renderPage(ui: ReactElement, path = '/'): RenderResult {
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>)
}

/** Renders a page that reads `useParams`, under the route pattern that defines them. */
export function renderPageAt(
  path: string,
  pattern: string,
  ui: ReactElement,
): RenderResult {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={ui} />
      </Routes>
    </MemoryRouter>,
  )
}

export type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>

/**
 * Replaces `fetch` with a handler that answers by URL.
 *
 * Returning the mock lets a test assert how many calls were made and what the detach call
 * carried, without reaching into the page's internals.
 */
export function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

/** The signed-in fan most account tests start from. */
export const ME = {
  id: 'fan-1',
  handle: 'ashu',
  displayName: 'Ashu',
  balance: 320,
  peakXp: 540,
  level: 2,
  identities: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      provider: 'twitch',
      displayHandle: 'ashu_tv',
      linked: true,
    },
  ],
}

/** The public ladder with one linked fan and one never-linked account. */
export const LADDER = {
  linked: [
    { fanId: 'fan-1', handle: 'ashu', level: 2, balance: 320 },
    // A negative balance is legal in the ledger and must still render as a number.
    { fanId: 'fan-2', handle: 'dave', level: 1, balance: -40 },
  ],
  freeStanding: [
    { identityId: 'identity-1', provider: 'twitch', displayHandle: 'sofa_sam', xp: 45 },
  ],
}

/** A public profile with two attached providers. */
export const FAN = {
  id: 'fan-1',
  handle: 'ashu',
  displayName: 'Ashu',
  level: 2,
  balance: 320,
  peakXp: 540,
  identities: [
    { provider: 'twitch', displayHandle: 'ashu_tv' },
    { provider: 'discord', displayHandle: 'ashu_dc' },
  ],
}

/**
 * The public game rules, shaped like the api's answer.
 *
 * The last level uses a four-digit threshold on purpose: it is the one row where
 * `formatNumber` changes the text, so a page that printed the raw number fails.
 */
export const GAME = {
  actions: [
    {
      key: 'youtube.subscribe',
      provider: 'youtube',
      amount: 100,
      label: "S'abonner à la chaîne sur YouTube",
      description: 'Une seule fois, par compte YouTube rattaché.',
    },
    {
      key: 'discord.member',
      provider: 'discord',
      amount: 75,
      label: 'Rejoindre le serveur Discord',
      description: 'Une seule fois, par compte Discord rattaché.',
    },
    {
      key: 'twitch.follow',
      provider: 'twitch',
      amount: 50,
      label: 'Suivre la chaîne sur Twitch',
      description: 'Une seule fois, par compte Twitch rattaché.',
    },
  ],
  levels: [
    { level: 0, minXp: 0 },
    { level: 1, minXp: 100 },
    { level: 2, minXp: 1500 },
  ],
}
