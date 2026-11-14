import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * The browser app's Vite and Vitest configuration.
 *
 * The dev server proxies `/api` and `/auth` to the api process instead of using a
 * cross-origin base URL: the session is an `HttpOnly` cookie scoped to this origin, so the
 * browser must see one origin for both the pages and the calls they make. A proxy also
 * keeps `fetch` paths identical between `vite dev` and production, where one server serves
 * both. The cookie itself is never read by this app, only sent by the browser.
 *
 * The test block lives here rather than in a second file so there is a single definition
 * of how the app is built and how it is tested.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
  test: {
    name: '@ashuworld/web',
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
