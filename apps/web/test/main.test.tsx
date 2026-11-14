import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

/**
 * The entry point is deliberately imported, not copied, so the test proves the real
 * `index.html` contract: the app mounts into `#root`. The missing-root test comes first
 * because the module is cached after the first successful import; resetting the module
 * registry between the two is what lets the throw happen.
 *
 * The thrown value is read explicitly rather than through `rejects.toThrow`: on Vitest 5,
 * a dynamically imported module that throws rejects with an `Error` whose message is
 * dropped by that matcher, so the assertion passed only on the type and proved nothing
 * about the sentence.
 */
describe('the entry point', () => {
  it('fails loudly when the page has no mount point', async () => {
    vi.resetModules()
    document.body.innerHTML = ''

    let thrown: unknown
    try {
      await import('../src/main')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/root/)
  })

  it('mounts the app into #root', async () => {
    vi.resetModules()
    document.body.innerHTML = '<div id="root"></div>'

    await import('../src/main')

    expect(await screen.findByRole('heading', { name: 'AshuWorld' })).toBeInTheDocument()
  })
})
