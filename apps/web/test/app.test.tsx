import { describe, expect, it, vi } from 'vitest'
import { RouterProvider, createMemoryRouter, type RouteObject } from 'react-router-dom'
import { render, screen, within } from '@testing-library/react'
import { routes } from '../src/App'
import { FAN, GAME, LADDER, ME, jsonResponse, stubFetch } from './helpers'

function renderAt(path: string): void {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
}

describe('the route table', () => {
  it('serves the home page at the root, with the three places to go', async () => {
    renderAt('/')

    expect(await screen.findByRole('heading', { name: 'AshuWorld' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /voir le classement/i })).toHaveAttribute(
      'href',
      '/ladder',
    )
    const nav = screen.getByRole('navigation', { name: /navigation principale/i })
    // The three links are in a fixed order, so the nav reads the same on every page.
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Classement',
      "Gagner de l'XP",
      'Mon compte',
    ])
    expect(within(nav).getByRole('link', { name: /classement/i })).toHaveAttribute(
      'href',
      '/ladder',
    )
    expect(within(nav).getByRole('link', { name: /gagner de l'xp/i })).toHaveAttribute(
      'href',
      '/xp',
    )
    expect(within(nav).getByRole('link', { name: /mon compte/i })).toHaveAttribute(
      'href',
      '/account',
    )
  })

  it('serves the xp page at /xp', async () => {
    stubFetch(() => jsonResponse(GAME))

    renderAt('/xp')

    expect(
      await screen.findByRole('heading', { name: "Gagner de l'XP", level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Les actions' })).toBeInTheDocument()
    expect(screen.getByText(GAME.actions[0]!.label)).toBeInTheDocument()
  })

  it('serves the ladder at /ladder', async () => {
    stubFetch(() => jsonResponse(LADDER))

    renderAt('/ladder')

    expect(
      await screen.findByRole('heading', { name: 'Classement', level: 1 }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'ashu' })).toBeInTheDocument()
  })

  it('serves a profile at /f/:handle', async () => {
    stubFetch(() => jsonResponse(FAN))

    renderAt('/f/ashu')

    expect(await screen.findByRole('heading', { name: 'Ashu' })).toBeInTheDocument()
  })

  it('serves the account page at /account', async () => {
    stubFetch(() => jsonResponse(ME))

    renderAt('/account')

    expect(await screen.findByRole('heading', { name: 'Ashu' })).toBeInTheDocument()
  })

  it('has a friendly page for a path that matches no route', async () => {
    renderAt('/no-such-page')

    expect(
      await screen.findByRole('heading', { name: /page introuvable/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /retour au classement/i })).toBeInTheDocument()
  })

  it('shows a friendly page when a route throws, never the error text', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Boom(): never {
      throw new Error('route exploded')
    }
    const broken: RouteObject = {
      path: '/',
      element: routes[0]!.element,
      errorElement: routes[0]!.errorElement,
      children: [...(routes[0]!.children ?? []), { path: 'boom', element: <Boom /> }],
    }

    try {
      const router = createMemoryRouter([broken], { initialEntries: ['/boom'] })
      render(<RouterProvider router={router} />)

      expect(
        await screen.findByRole('heading', { name: /quelque chose s’est mal passé/i }),
      ).toBeInTheDocument()
      expect(screen.queryByText(/route exploded/)).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: /aller à l’accueil/i })).toHaveAttribute(
        'href',
        '/',
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
