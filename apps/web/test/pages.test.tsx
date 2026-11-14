import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Account } from '../src/pages/Account'
import { Ladder } from '../src/pages/Ladder'
import { Profile } from '../src/pages/Profile'
import {
  FAN,
  LADDER,
  ME,
  jsonResponse,
  renderPage,
  renderPageAt,
  stubFetch,
  textResponse,
  type FetchHandler,
} from './helpers'

const IDENTITY_ID = ME.identities[0]!.id

describe('Ladder', () => {
  it('renders ladder rows from the api and splits linked from free-standing', async () => {
    stubFetch(() => jsonResponse(LADDER))

    renderPage(<Ladder />, '/ladder')

    expect(await screen.findByRole('link', { name: 'ashu' })).toHaveAttribute(
      'href',
      '/f/ashu',
    )
    expect(screen.getByText('320')).toBeInTheDocument()
    expect(screen.getByText('-40')).toBeInTheDocument()
    expect(screen.getByText('Level 2')).toBeInTheDocument()

    const free = screen.getByRole('region', { name: /free-standing accounts/i })
    expect(within(free).getByText('@sofa_sam')).toBeInTheDocument()
    expect(within(free).getByText('45')).toBeInTheDocument()
  })

  it('ranks the linked rows by spendable XP, not by a level that only moves forward', async () => {
    // `carol` has the highest level and the smallest balance: the ordering a page gets
    // from the server is by balance, and anything that re-sorts by the sticky record
    // (the level, which comes from peak XP) puts her first instead of last.
    stubFetch(() =>
      jsonResponse({
        linked: [
          { fanId: 'fan-1', handle: 'ashu', level: 2, balance: 320 },
          { fanId: 'fan-2', handle: 'bo', level: 1, balance: 120 },
          { fanId: 'fan-3', handle: 'carol', level: 4, balance: 10 },
        ],
        freeStanding: [],
      }),
    )

    renderPage(<Ladder />, '/ladder')

    const rows = await screen.findAllByRole('row')
    // Header row first, then the fans in the server's order. Asserting the ordered handles
    // rather than the rank cells keeps the check about ranking, not about a table column.
    const handles = rows.slice(1).map((row) => row.querySelector('a')?.textContent)
    expect(handles).toEqual(['ashu', 'bo', 'carol'])
    expect(within(rows[3]!).getByText('10')).toBeInTheDocument()
    expect(within(rows[3]!).getByText('Level 4')).toBeInTheDocument()
  })

  it('explains an empty ladder in plain words instead of showing a blank table', async () => {
    stubFetch(() => jsonResponse({ linked: [], freeStanding: [] }))

    renderPage(<Ladder />, '/ladder')

    expect(
      await screen.findByText(/nobody has joined the ladder yet/i),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('offers a retry when the ladder cannot be loaded, never the server text', async () => {
    let attempts = 0
    stubFetch(() => {
      attempts += 1
      if (attempts === 1) {
        return jsonResponse(
          { error: { code: 'database_unavailable', message: 'the database did not answer' } },
          503,
        )
      }
      return jsonResponse(LADDER)
    })

    renderPage(<Ladder />, '/ladder')

    expect(await screen.findByText(/the ladder could not be loaded/i)).toBeInTheDocument()
    expect(screen.queryByText(/the database did not answer/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('link', { name: 'ashu' })).toBeInTheDocument()
  })
})

describe('Profile', () => {
  it('shows the level badge, the handle, the balance, the peak and the providers', async () => {
    stubFetch(() => jsonResponse(FAN))

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(await screen.findByRole('heading', { name: 'Ashu' })).toBeInTheDocument()
    expect(screen.getByText('ashu')).toBeInTheDocument()
    expect(screen.getByText('Level 2')).toBeInTheDocument()
    expect(screen.getByText('320')).toBeInTheDocument()
    expect(screen.getByText('540')).toBeInTheDocument()
    expect(screen.getByText('@ashu_tv')).toBeInTheDocument()
    expect(screen.getByText('@ashu_dc')).toBeInTheDocument()
  })

  it('explains that peak xp is the highest balance ever reached', async () => {
    stubFetch(() => jsonResponse(FAN))

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(
      await screen.findByText(/peak xp is the highest balance .* ever reached/i),
    ).toBeInTheDocument()
  })

  it('asks the api for the handle in the url, escaped', async () => {
    const fetchMock = stubFetch(() => jsonResponse(FAN))

    renderPageAt('/f/ashu%20tv', '/f/:handle', <Profile />)

    await screen.findByRole('heading', { name: 'Ashu' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/public/fans/ashu%20tv',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('renders a 404 profile as not found instead of crashing', async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: 'not_found', message: 'the requested resource does not exist' } },
        404,
      ),
    )

    renderPageAt('/f/nobody', '/f/:handle', <Profile />)

    expect(await screen.findByRole('heading', { name: /no such fan/i })).toBeInTheDocument()
    expect(screen.getByText(/nobody/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back to the ladder/i })).toHaveAttribute(
      'href',
      '/ladder',
    )
  })

  it('treats a 4xx other than 404 as no such fan, not a server failure', async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: 'forbidden', message: 'this profile is not visible' } },
        403,
      ),
    )

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(await screen.findByRole('heading', { name: /no such fan/i })).toBeInTheDocument()
    expect(screen.queryByText(/this profile could not be loaded/i)).not.toBeInTheDocument()
  })

  it('does not print the server error text when the profile fails to load', async () => {
    stubFetch(() => textResponse('<html>upstream said no</html>', 500))

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(await screen.findByText(/this profile could not be loaded/i)).toBeInTheDocument()
    expect(screen.queryByText(/upstream said no/i)).not.toBeInTheDocument()
  })

  it('shows the retry panel when the request never reached the server', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed')
    })

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(await screen.findByText(/this profile could not be loaded/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /no such fan/i })).not.toBeInTheDocument()
  })
})

describe('Account, signed out', () => {
  it('shows the sign-in panel on a 401 rather than an error', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true')
    stubFetch(() =>
      jsonResponse({ error: { code: 'unauthenticated', message: 'sign in to continue' } }, 401),
    )

    renderPage(<Account />, '/account')

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /sign in with the dev account/i }),
    ).toHaveAttribute('href', '/auth/dev/start?purpose=login')
    expect(screen.queryByText(/sign in to continue/i)).not.toBeInTheDocument()
  })

  it('says sign-in is not switched on, and offers no link, when the dev door is off', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'false')
    stubFetch(() =>
      jsonResponse({ error: { code: 'unauthenticated', message: 'sign in to continue' } }, 401),
    )

    renderPage(<Account />, '/account')

    expect(
      await screen.findByText(/sign-in is not switched on for this deployment/i),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /dev account/i })).not.toBeInTheDocument()
  })

  it('offers a retry when the account cannot be loaded at all', async () => {
    let attempts = 0
    stubFetch(() => {
      attempts += 1
      if (attempts === 1) return textResponse('gateway timeout', 504)
      return jsonResponse(ME)
    })

    renderPage(<Account />, '/account')

    expect(await screen.findByText(/your account could not be loaded/i)).toBeInTheDocument()
    expect(screen.queryByText(/gateway timeout/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('heading', { name: 'Ashu' })).toBeInTheDocument()
  })
})

describe('Account, signed in', () => {
  function signedIn(handler: FetchHandler = () => jsonResponse(ME)) {
    return stubFetch(handler)
  }

  it('shows the fan, the standing and one detach button per identity', async () => {
    signedIn()

    renderPage(<Account />, '/account')

    expect(await screen.findByRole('heading', { name: 'Ashu' })).toBeInTheDocument()
    expect(screen.getByText('Level 2')).toBeInTheDocument()
    expect(screen.getByText('320')).toBeInTheDocument()
    expect(screen.getByText('540')).toBeInTheDocument()
    expect(screen.getByText('@ashu_tv')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /detach twitch account ashu_tv/i }),
    ).toBeInTheDocument()
  })

  it('offers the other providers as a fresh sign-in, and not the one already attached', async () => {
    signedIn()

    renderPage(<Account />, '/account')

    expect(
      await screen.findByRole('link', { name: /attach youtube account/i }),
    ).toHaveAttribute('href', '/auth/youtube/start?purpose=link')
    expect(
      screen.queryByRole('link', { name: /attach twitch account/i }),
    ).not.toBeInTheDocument()
  })

  it('states plainly that detaching forfeits the xp for good and that the level stays', async () => {
    const fetchMock = signedIn()
    const user = userEvent.setup()

    renderPage(<Account />, '/account')
    await user.click(
      await screen.findByRole('button', { name: /detach twitch account ashu_tv/i }),
    )

    const panel = screen.getByRole('region', { name: /detach your twitch account/i })
    expect(within(panel).getByText(/for good/i)).toBeInTheDocument()
    expect(within(panel).getByText(/your level and your peak xp stay/i)).toBeInTheDocument()
    // Only the initial profile read has happened: nothing was sent yet.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await user.click(within(panel).getByRole('button', { name: /keep it attached/i }))
    expect(
      screen.queryByRole('region', { name: /detach your twitch account/i }),
    ).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('names the permanence of the forfeit for a later re-attach in the confirmation', async () => {
    signedIn()
    const user = userEvent.setup()

    renderPage(<Account />, '/account')
    await user.click(
      await screen.findByRole('button', { name: /detach twitch account ashu_tv/i }),
    )

    const panel = screen.getByRole('region', { name: /detach your twitch account/i })
    expect(
      within(panel).getByText(/attaching this account again later will not bring the xp back/i),
    ).toBeInTheDocument()
  })

  it('detaches after confirmation and reports what was forfeited', async () => {
    let detached = false
    const fetchMock = signedIn((url, init) => {
      if (url.endsWith('/detach')) {
        detached = true
        expect(init?.method).toBe('POST')
        return jsonResponse(
          { forfeitedEntries: 3, balance: 120, peakXp: 540, level: 2 },
          200,
        )
      }
      return jsonResponse(
        detached ? { ...ME, balance: 120, identities: [] } : ME,
      )
    })
    const user = userEvent.setup()

    renderPage(<Account />, '/account')
    await user.click(
      await screen.findByRole('button', { name: /detach twitch account ashu_tv/i }),
    )
    await user.click(screen.getByRole('button', { name: /yes, detach it/i }))

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent(/3 xp entries were forfeited/i)
    expect(notice).toHaveTextContent(/your level is still 2/i)
    expect(notice).toHaveTextContent(/attach it again later as a fresh, empty account/i)
    expect(notice).toHaveTextContent(/the forfeit is permanent/i)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/me/identities/${IDENTITY_ID}/detach`,
      expect.objectContaining({ method: 'POST' }),
    )
    // The profile is read again, so the balance shown is the one after the detach.
    expect(await screen.findByText('120')).toBeInTheDocument()
  })

  it('explains a last_identity refusal as the only way into the account', async () => {
    signedIn((url) => {
      if (url.endsWith('/detach')) {
        return jsonResponse(
          {
            error: {
              code: 'last_identity',
              message: 'an account must keep at least one identity; add another before detaching this one',
            },
          },
          409,
        )
      }
      return jsonResponse(ME)
    })
    const user = userEvent.setup()

    renderPage(<Account />, '/account')
    await user.click(
      await screen.findByRole('button', { name: /detach twitch account ashu_tv/i }),
    )
    await user.click(screen.getByRole('button', { name: /yes, detach it/i }))

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent(/the only way into your account/i)
    expect(refusal).not.toHaveTextContent(/must keep at least one identity/i)
  })

  it('shows the re-attach explanation first when the login callback sends it back', async () => {
    signedIn()

    renderPage(<Account />, '/account?reattach=youtube')

    const notice = await screen.findByRole('region', { name: /youtube account is detached/i })
    expect(within(notice).getByText(/fresh, empty account/i)).toBeInTheDocument()
    expect(within(notice).getByText(/the forfeit is permanent/i)).toBeInTheDocument()
    expect(
      within(notice).getByRole('link', { name: /attach youtube again/i }),
    ).toHaveAttribute('href', '/auth/youtube/start?purpose=link')
    expect(
      screen.getByRole('heading', { name: 'Ashu' }),
    ).toBeInTheDocument()
  })

  it('does not claim a provider is detached when that provider is still attached', async () => {
    signedIn()

    renderPage(<Account />, '/account?reattach=twitch')

    await screen.findByRole('heading', { name: 'Ashu' })
    expect(
      screen.queryByRole('region', { name: /twitch account is detached/i }),
    ).not.toBeInTheDocument()
  })

  it('ignores a reattach value that is not a known provider', async () => {
    signedIn()

    renderPage(<Account />, '/account?reattach=%3Cb%3Eevil')

    await screen.findByRole('heading', { name: 'Ashu' })
    expect(
      screen.queryByRole('region', { name: /account is detached/i }),
    ).not.toBeInTheDocument()
  })

  it('signs out through the logout endpoint and returns to the signed-out panel', async () => {
    let signedOut = false
    const fetchMock = signedIn((url, init) => {
      if (url === '/auth/logout') {
        expect(init?.method).toBe('POST')
        signedOut = true
        return new Response(null, { status: 204 })
      }
      if (signedOut) {
        return jsonResponse({ error: { code: 'unauthenticated', message: 'sign in' } }, 401)
      }
      return jsonResponse(ME)
    })
    const user = userEvent.setup()

    renderPage(<Account />, '/account')
    await user.click(await screen.findByRole('button', { name: /sign out/i }))

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })
})
