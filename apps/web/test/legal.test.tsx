import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render } from '@testing-library/react'
import { CGU, CONFIDENTIALITE, MENTIONS_LEGALES } from '../src/legal/content'
import { LegalPage } from '../src/pages/Legal'
import { Footer } from '../src/components/Footer'

function renderLegal(document: typeof CGU) {
  return render(
    <MemoryRouter>
      <LegalPage document={document} />
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
})
