import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/**
 * The one place a test's leftovers are removed.
 *
 * Vitest runs without globals here, so Testing Library cannot register its own automatic
 * cleanup: it looks for a global `afterEach` that does not exist. Doing it by hand is also
 * where the fetch stub and the environment stubs are undone, so one test's signed-out
 * answer cannot leak into the next one's signed-in page.
 */
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  document.body.innerHTML = ''
  window.history.replaceState({}, '', '/')
})
