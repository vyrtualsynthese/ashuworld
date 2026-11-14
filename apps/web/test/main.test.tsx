import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

/**
 * The entry point is deliberately imported, not copied, so the test proves the real
 * `index.html` contract: the app mounts into `#root`. The missing-root test comes first
 * because the module is cached after the first successful import; resetting the module
 * registry between the two is what lets the throw happen.
 */
describe('the entry point', () => {
  it('fails loudly when the page has no mount point', async () => {
    vi.resetModules()
    document.body.innerHTML = ''

    await expect(import('../src/main')).rejects.toThrow(/root/)
  })

  it('mounts the app into #root', async () => {
    vi.resetModules()
    document.body.innerHTML = '<div id="root"></div>'

    await import('../src/main')

    expect(await screen.findByRole('heading', { name: 'AshuWorld' })).toBeInTheDocument()
  })
})
