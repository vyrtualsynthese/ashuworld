import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { routes } from '../src/App'
import { Footer } from '../src/components/Footer'
import {
  CGU,
  CONFIDENTIALITE,
  MENTIONS_LEGALES,
  type LegalDocument,
} from '../src/legal/content'
import { LegalPage } from '../src/pages/Legal'

function renderLegal(legal: LegalDocument) {
  return render(
    <MemoryRouter>
      <LegalPage document={legal} />
    </MemoryRouter>,
  )
}

describe('legal pages', () => {
  it('names the publisher and the host on the mentions légales', () => {
    renderLegal(MENTIONS_LEGALES)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Mentions légales')
    expect(screen.getAllByText(/ASHU DEV/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/898 442 538/).length).toBeGreaterThan(0)
    expect(screen.getByText(/14 rue Bausset/)).toBeInTheDocument()
    expect(screen.getAllByText(/info@ashudev\.com/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/auto-hébergement/i).length).toBeGreaterThan(0)
  })

  it('states both cookies, their purpose and that there is no tracker', () => {
    renderLegal(CONFIDENTIALITE)
    expect(screen.getByText(/ashuworld_session/)).toBeInTheDocument()
    expect(screen.getByText(/ashu_oauth_state/)).toBeInTheDocument()
    expect(screen.getByText(/aucun traceur/i)).toBeInTheDocument()
  })

  it('keeps the ledger after erasure, under a pseudonym, to prevent a second payment', () => {
    renderLegal(CONFIDENTIALITE)
    expect(screen.getByText(/entrées du registre d’XP/)).toHaveTextContent(/pseudonyme/i)
    expect(screen.getByText(/entrées du registre d’XP/)).toHaveTextContent(
      /second paiement/i,
    )
  })

  it('says a level is never lost and a detach forfeits XP', () => {
    renderLegal(CGU)
    expect(screen.getByText(/niveau n’est jamais perdu|niveau n'est jamais perdu/i)).toBeInTheDocument()
    expect(screen.getByText(/détachement/i)).toBeInTheDocument()
  })

  it('links the three documents from the footer, on every page', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Mentions légales' })).toHaveAttribute('href', '/mentions-legales')
    expect(screen.getByRole('link', { name: 'Politique de confidentialité' })).toHaveAttribute('href', '/confidentialite')
    expect(screen.getByRole('link', { name: 'CGU' })).toHaveAttribute('href', '/cgu')
  })

  it.each([
    { path: '/mentions-legales', legal: MENTIONS_LEGALES },
    { path: '/confidentialite', legal: CONFIDENTIALITE },
    { path: '/cgu', legal: CGU },
  ])('serves $path with its own title and the footer', ({ path, legal }) => {
    const router = createMemoryRouter(routes, { initialEntries: [path] })
    render(<RouterProvider router={router} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(legal.title)
    expect(document.title).toBe(legal.title)

    // The footer is rendered by `Layout`, so the legal navigation must be there on every
    // page, including the three legal pages themselves.
    const legalNav = screen.getByRole('navigation', { name: 'Liens légaux' })
    expect(within(legalNav).getAllByRole('link')).toHaveLength(3)
  })
})
