import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Account } from '../src/pages/Account'
import { Ladder } from '../src/pages/Ladder'
import { Profile } from '../src/pages/Profile'
import { Xp } from '../src/pages/Xp'
import { formatNumber } from '../src/format'
import {
  FAN,
  GAME,
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
  it('renders one ranked table, with Dachis and unattached accounts side by side', async () => {
    stubFetch(() => jsonResponse(LADDER))

    renderPage(<Ladder />, '/ladder')

    // One table, not a section per kind of account: the reader compares totals, so the two
    // api lists are merged before they are shown.
    const table = await screen.findByRole('table', { name: /classement par xp/i })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(4)

    expect(within(rows[0]!).getByRole('columnheader', { name: 'Rang' })).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('columnheader', { name: 'Dachi' })).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('columnheader', { name: 'Niveau' })).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('columnheader', { name: 'XP' })).toBeInTheDocument()

    // 320, then the free-standing 45, then the negative balance. A Dachi links to a
    // profile; an account with no Dachi has neither a link nor a level.
    expect(within(rows[1]!).getByRole('link', { name: 'ashu' })).toHaveAttribute(
      'href',
      '/f/ashu',
    )
    expect(within(rows[1]!).getByText('Niveau 2')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('320')).toBeInTheDocument()

    expect(within(rows[2]!).getByText('@sofa_sam')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('Twitch')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('45')).toBeInTheDocument()
    expect(within(rows[2]!).queryByRole('link')).not.toBeInTheDocument()
    expect(within(rows[2]!).queryByText(/niveau/i)).not.toBeInTheDocument()

    expect(within(rows[3]!).getByRole('link', { name: 'dave' })).toBeInTheDocument()
    expect(within(rows[3]!).getByText('-40')).toBeInTheDocument()
  })

  it('puts a Dachi and a free-standing account in one table in XP order', async () => {
    stubFetch(() =>
      jsonResponse({
        linked: [{ fanId: 'fan-1', handle: 'ashu', level: 1, balance: 100 }],
        freeStanding: [
          { identityId: 'identity-1', provider: 'twitch', displayHandle: 'sofa_sam', xp: 250 },
        ],
      }),
    )

    renderPage(<Ladder />, '/ladder')

    const rows = (await screen.findAllByRole('row')).slice(1)
    // The free-standing account is ahead, so it is rank 1 in the same table. Asserting the
    // ordered content rather than the rank cells keeps this about ranking, not a column.
    expect(rows.map((row) => row.textContent)).toEqual([
      '1Twitch @sofa_sam250',
      '2ashuNiveau 1100',
    ])
    expect(within(rows[0]!).queryByRole('link')).not.toBeInTheDocument()
    expect(within(rows[1]!).getByRole('link', { name: 'ashu' })).toBeInTheDocument()
  })

  it('breaks an XP tie by name, using French collation', async () => {
    stubFetch(() =>
      jsonResponse({
        linked: [
          { fanId: 'fan-1', handle: 'zoe', level: 1, balance: 50 },
          // Under a code-unit sort `zoe` comes before `émile`; the page must compare names.
          { fanId: 'fan-2', handle: 'émile', level: 1, balance: 50 },
        ],
        freeStanding: [],
      }),
    )

    renderPage(<Ladder />, '/ladder')

    const rows = (await screen.findAllByRole('row')).slice(1)
    expect(rows.map((row) => row.querySelector('a')?.textContent)).toEqual(['émile', 'zoe'])
  })

  it('ranks by XP, not by a level that only moves forward', async () => {
    // `carol` has the highest level and the smallest XP: the ordering a page gets from the
    // sticky record (the level, which comes from peak XP) puts her first instead of last.
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
    // Header row first, then the rows in XP order. Asserting the ordered handles rather
    // than the rank cells keeps the check about ranking, not about a table column.
    const handles = rows.slice(1).map((row) => row.querySelector('a')?.textContent)
    expect(handles).toEqual(['ashu', 'bo', 'carol'])
    expect(within(rows[3]!).getByText('10')).toBeInTheDocument()
    expect(within(rows[3]!).getByText('Niveau 4')).toBeInTheDocument()
  })

  it('explains an empty ladder in one sentence instead of showing a blank table', async () => {
    stubFetch(() => jsonResponse({ linked: [], freeStanding: [] }))

    renderPage(<Ladder />, '/ladder')

    expect(
      await screen.findByText(/personne n’a encore gagné d’xp/i),
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

    expect(
      await screen.findByText(/le classement n’a pas pu être chargé/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/the database did not answer/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /réessayer/i }))
    expect(await screen.findByRole('link', { name: 'ashu' })).toBeInTheDocument()
  })
})

describe('Xp', () => {
  it('shows every action with its label, description, platform and amount', async () => {
    stubFetch(() => jsonResponse(GAME))

    renderPage(<Xp />, '/xp')

    const actions = await screen.findByRole('region', { name: 'Les actions' })
    const rows = within(actions).getAllByRole('row')
    // One header row plus one row per action, in the order the api sent them.
    expect(rows).toHaveLength(GAME.actions.length + 1)
    expect(within(rows[0]!).getByRole('columnheader', { name: 'Action' })).toBeInTheDocument()
    expect(
      within(rows[0]!).getByRole('columnheader', { name: 'Plateforme' }),
    ).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('columnheader', { name: 'XP' })).toBeInTheDocument()

    for (const [index, action] of GAME.actions.entries()) {
      const row = rows[index + 1]!
      // The name is the row's anchor, so it is bold; the one-per-account rule sits under it.
      expect(within(row).getByText(action.label).tagName).toBe('STRONG')
      expect(within(row).getByText(action.description)).toBeInTheDocument()
      expect(within(row).getByText(formatNumber(action.amount))).toBeInTheDocument()
    }

    // The platform is named for a reader, not echoed as the api's slug.
    expect(within(rows[1]!).getByText('YouTube')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('Discord')).toBeInTheDocument()
    expect(within(rows[3]!).getByText('Twitch')).toBeInTheDocument()
  })

  it('renders the level thresholds in order, formatted for reading', async () => {
    stubFetch(() => jsonResponse(GAME))

    renderPage(<Xp />, '/xp')

    const levels = await screen.findByRole('region', { name: 'Les niveaux' })
    const rows = within(levels).getAllByRole('row')
    expect(within(rows[0]!).getByRole('columnheader', { name: 'Niveau' })).toBeInTheDocument()
    expect(
      within(rows[0]!).getByRole('columnheader', { name: 'XP requis' }),
    ).toBeInTheDocument()

    // `1500` must come out as the French `1 500`: the raw number would fail here.
    expect(rows.slice(1).map((row) => row.textContent)).toEqual([
      `0${formatNumber(0)}`,
      `1${formatNumber(100)}`,
      `2${formatNumber(1500)}`,
    ])
    expect(within(levels).getByText(/le niveau est conservé même quand l'xp baisse/i)).toBeInTheDocument()
  })

  it('gives both tables an accessible heading', async () => {
    stubFetch(() => jsonResponse(GAME))

    renderPage(<Xp />, '/xp')

    expect(
      await screen.findByRole('heading', { name: 'Les actions', level: 2 }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Les niveaux', level: 2 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: "Gagner de l'XP", level: 1 })).toBeInTheDocument()
  })

  it('offers a retry when the rules cannot be loaded', async () => {
    let attempts = 0
    stubFetch(() => {
      attempts += 1
      if (attempts === 1) {
        return jsonResponse(
          { error: { code: 'database_unavailable', message: 'the database did not answer' } },
          503,
        )
      }
      return jsonResponse(GAME)
    })

    renderPage(<Xp />, '/xp')

    expect(
      await screen.findByRole('heading', { name: /les règles n'ont pas pu être chargées/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/the database did not answer/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /réessayer/i }))
    expect(await screen.findByRole('region', { name: 'Les actions' })).toBeInTheDocument()
    expect(screen.getByText(GAME.actions[0]!.label)).toBeInTheDocument()
  })

  it('says the rules are loading while the request is in flight', () => {
    stubFetch(() => new Promise<Response>(() => {}))

    renderPage(<Xp />, '/xp')

    expect(screen.getByText('Chargement des règles…')).toBeInTheDocument()
  })
})

describe('Profile', () => {
  it('shows the level badge, the handle, the XP, the peak and the providers', async () => {
    stubFetch(() => jsonResponse(FAN))

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(await screen.findByRole('heading', { name: 'Ashu' })).toBeInTheDocument()
    expect(screen.getByText('ashu')).toBeInTheDocument()
    expect(screen.getByText('Niveau 2')).toBeInTheDocument()
    expect(screen.getByText('XP')).toBeInTheDocument()
    expect(screen.getByText('XP maximal')).toBeInTheDocument()
    expect(screen.getByText('320')).toBeInTheDocument()
    expect(screen.getByText('540')).toBeInTheDocument()
    expect(screen.getByText('@ashu_tv')).toBeInTheDocument()
    expect(screen.getByText('@ashu_dc')).toBeInTheDocument()
  })

  it('explains that peak XP is the highest total ever reached', async () => {
    stubFetch(() => jsonResponse(FAN))

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(
      await screen.findByText(/le plus haut total jamais atteint/i),
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

    expect(
      await screen.findByRole('heading', { name: /aucun dachi à ce nom/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/nobody/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /retour au classement/i })).toHaveAttribute(
      'href',
      '/',
    )
  })

  it('treats a 4xx other than 404 as no such Dachi, not a server failure', async () => {
    stubFetch(() =>
      jsonResponse(
        { error: { code: 'forbidden', message: 'this profile is not visible' } },
        403,
      ),
    )

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(
      await screen.findByRole('heading', { name: /aucun dachi à ce nom/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/ce profil n’a pas pu être chargé/i)).not.toBeInTheDocument()
  })

  it('does not print the server error text when the profile fails to load', async () => {
    stubFetch(() => textResponse('<html>upstream said no</html>', 500))

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(
      await screen.findByText(/ce profil n’a pas pu être chargé/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/upstream said no/i)).not.toBeInTheDocument()
  })

  it('shows the retry panel when the request never reached the server', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed')
    })

    renderPageAt('/f/ashu', '/f/:handle', <Profile />)

    expect(
      await screen.findByText(/ce profil n’a pas pu être chargé/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: /aucun dachi à ce nom/i }),
    ).not.toBeInTheDocument()
  })
})

describe('Account, signed out', () => {
  it('shows the sign-in panel on a 401 rather than an error', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true')
    stubFetch(() =>
      jsonResponse({ error: { code: 'unauthenticated', message: 'sign in to continue' } }, 401),
    )

    renderPage(<Account />, '/account')

    expect(
      await screen.findByRole('heading', { name: /se connecter à ashuworld/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /se connecter avec le compte de développement/i }),
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
      await screen.findByText(/la connexion n’est pas activée sur ce déploiement/i),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /compte de développement/i })).not.toBeInTheDocument()
  })

  it('warns a signed-out Dachi from a detach and names the way back', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true')
    stubFetch(() =>
      jsonResponse({ error: { code: 'unauthenticated', message: 'sign in to continue' } }, 401),
    )

    renderPage(<Account />, '/account?reattach=twitch')

    const notice = await screen.findByRole('region', { name: /ton compte twitch est détaché/i })
    expect(within(notice).getByText(/perdue pour toujours/i)).toBeInTheDocument()
    expect(within(notice).getByText(/la perte est définitive/i)).toBeInTheDocument()
    // The way back starts from an account that still works, then a fresh attach.
    expect(
      within(notice).getByText(/un compte encore rattaché/i),
    ).toBeInTheDocument()
    expect(
      within(notice).getByText(/nouvelle connexion twitch/i),
    ).toBeInTheDocument()
    // Signing in with the detached provider loops back here, so the notice must not
    // promise that it reattaches anything.
    expect(
      within(notice).queryByText(/se reconnecter avec twitch le rattache/i),
    ).not.toBeInTheDocument()

    // The news comes before the button that acts on it: the panel must precede sign-in.
    const signIn = screen.getByRole('region', { name: /se connecter à ashuworld/i })
    expect(
      notice.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows no detached notice for a reattach value that is not a known provider', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true')
    stubFetch(() =>
      jsonResponse({ error: { code: 'unauthenticated', message: 'sign in to continue' } }, 401),
    )

    renderPage(<Account />, '/account?reattach=%3Cb%3Eevil')

    expect(
      await screen.findByRole('heading', { name: /se connecter à ashuworld/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: /compte .* est détaché/i }),
    ).not.toBeInTheDocument()
  })

  it('offers a retry when the account cannot be loaded at all', async () => {
    let attempts = 0
    stubFetch(() => {
      attempts += 1
      if (attempts === 1) return textResponse('gateway timeout', 504)
      return jsonResponse(ME)
    })

    renderPage(<Account />, '/account')

    expect(
      await screen.findByText(/ton compte n’a pas pu être chargé/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/gateway timeout/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /réessayer/i }))
    expect(await screen.findByRole('heading', { name: 'Ashu' })).toBeInTheDocument()
  })
})

describe('Account, signed in', () => {
  function signedIn(handler: FetchHandler = () => jsonResponse(ME)) {
    return stubFetch(handler)
  }

  it('shows the Dachi, the standing and one detach button per identity', async () => {
    signedIn()

    renderPage(<Account />, '/account')

    expect(await screen.findByRole('heading', { name: 'Ashu' })).toBeInTheDocument()
    expect(screen.getByText('Niveau 2')).toBeInTheDocument()
    expect(screen.getByText('XP')).toBeInTheDocument()
    expect(screen.getByText('XP maximal')).toBeInTheDocument()
    expect(screen.getByText('320')).toBeInTheDocument()
    expect(screen.getByText('540')).toBeInTheDocument()
    expect(screen.getByText('@ashu_tv')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /détacher le compte twitch ashu_tv/i }),
    ).toBeInTheDocument()
  })

  it('offers the other providers as a fresh sign-in, and not the one already attached', async () => {
    signedIn()

    renderPage(<Account />, '/account')

    expect(
      await screen.findByRole('link', { name: /rattacher un compte youtube/i }),
    ).toHaveAttribute('href', '/auth/youtube/start?purpose=link')
    expect(
      screen.queryByRole('link', { name: /rattacher un compte twitch/i }),
    ).not.toBeInTheDocument()
  })

  it('states plainly that detaching forfeits the XP for good and that the level stays', async () => {
    const fetchMock = signedIn()
    const user = userEvent.setup()

    renderPage(<Account />, '/account')
    await user.click(
      await screen.findByRole('button', { name: /détacher le compte twitch ashu_tv/i }),
    )

    const panel = screen.getByRole('region', { name: /détacher ton compte twitch/i })
    expect(within(panel).getByText(/perdue pour toujours/i)).toBeInTheDocument()
    expect(
      within(panel).getByText(/ton niveau et ton xp maximal restent inchangés/i),
    ).toBeInTheDocument()
    // Only the initial profile read has happened: nothing was sent yet.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await user.click(within(panel).getByRole('button', { name: /le garder rattaché/i }))
    expect(
      screen.queryByRole('region', { name: /détacher ton compte twitch/i }),
    ).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('names the permanence of the forfeit for a later re-attach in the confirmation', async () => {
    signedIn()
    const user = userEvent.setup()

    renderPage(<Account />, '/account')
    await user.click(
      await screen.findByRole('button', { name: /détacher le compte twitch ashu_tv/i }),
    )

    const panel = screen.getByRole('region', { name: /détacher ton compte twitch/i })
    expect(
      within(panel).getByText(/rattacher ce compte plus tard ne la rapportera pas/i),
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
      await screen.findByRole('button', { name: /détacher le compte twitch ashu_tv/i }),
    )
    await user.click(screen.getByRole('button', { name: /oui, détacher/i }))

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent(/3 entrées d’xp ont été perdues/i)
    expect(notice).toHaveTextContent(/ton niveau est toujours 2/i)
    expect(notice).toHaveTextContent(/un compte neuf et vide/i)
    expect(notice).toHaveTextContent(/la perte est définitive/i)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/me/identities/${IDENTITY_ID}/detach`,
      expect.objectContaining({ method: 'POST' }),
    )
    // The profile is read again, so the XP shown is the one after the detach.
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
      await screen.findByRole('button', { name: /détacher le compte twitch ashu_tv/i }),
    )
    await user.click(screen.getByRole('button', { name: /oui, détacher/i }))

    const refusal = await screen.findByRole('alert')
    expect(refusal).toHaveTextContent(/ta seule porte d’entrée/i)
    expect(refusal).not.toHaveTextContent(/must keep at least one identity/i)
  })

  it('shows the re-attach explanation first when the login callback sends it back', async () => {
    signedIn()

    renderPage(<Account />, '/account?reattach=youtube')

    const notice = await screen.findByRole('region', { name: /ton compte youtube est détaché/i })
    expect(within(notice).getByText(/un compte neuf et vide/i)).toBeInTheDocument()
    expect(within(notice).getByText(/la perte est définitive/i)).toBeInTheDocument()
    expect(
      within(notice).getByRole('link', { name: /rattacher youtube/i }),
    ).toHaveAttribute('href', '/auth/youtube/start?purpose=link')
    expect(
      screen.getByRole('heading', { name: 'Ashu' }),
    ).toBeInTheDocument()
    // Signed in, the shorter re-attach panel is the whole story; the signed-out notice
    // would say the same thing twice.
    expect(screen.queryByText(/perdue pour toujours/i)).not.toBeInTheDocument()
  })

  it('does not claim a provider is detached when that provider is still attached', async () => {
    signedIn()

    renderPage(<Account />, '/account?reattach=twitch')

    await screen.findByRole('heading', { name: 'Ashu' })
    expect(
      screen.queryByRole('region', { name: /ton compte twitch est détaché/i }),
    ).not.toBeInTheDocument()
  })

  it('ignores a reattach value that is not a known provider', async () => {
    signedIn()

    renderPage(<Account />, '/account?reattach=%3Cb%3Eevil')

    await screen.findByRole('heading', { name: 'Ashu' })
    expect(
      screen.queryByRole('region', { name: /compte .* est détaché/i }),
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
    await user.click(await screen.findByRole('button', { name: /se déconnecter/i }))

    expect(
      await screen.findByRole('heading', { name: /se connecter à ashuworld/i }),
    ).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })
})
