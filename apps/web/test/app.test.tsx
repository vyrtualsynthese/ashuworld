import { describe, expect, it, vi } from 'vitest'
import { RouterProvider, createMemoryRouter, type RouteObject } from 'react-router-dom'
import { render, screen, within } from '@testing-library/react'
import { routes } from '../src/App'
import { FAN, LADDER, ME, jsonResponse, stubFetch } from './helpers'

function renderAt(path: string): void {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
}

describe('the route table', () => {
  it('serves the home page at the root, with a way to the ladder', async () => {
    renderAt('/')

    expect(await screen.findByRole('heading', { name: 'AshuWorld' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /voir le classement/i })).toHaveAttribute(
      'href',
      '/ladder',
    )
    const nav = screen.getByRole('navigation', { name: /navigation principale/i })
    expect(within(nav).getByRole('link', { name: /classement/i })).toHaveAttribute(
      'href',
      '/ladder',
    )
    expect(within(nav).getByRole('link', { name: /mon compte/i })).toHaveAttribute(
      'href',
      '/account',
    )
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
