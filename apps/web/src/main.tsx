import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { createAppRouter } from './App'
import './styles.css'

/**
 * The browser entry point.
 *
 * It does exactly one thing: find the mount point declared in `index.html` and hand the
 * router to React. Everything else lives in `App.tsx` and the pages, so this module is the
 * only part that cannot be exercised without a document. Failing loudly on a missing
 * mount point is deliberate: rendering nowhere is a blank page that looks like a network
 * problem, while a thrown error names the actual mistake.
 */
const container = document.getElementById('root')
if (container === null) {
  throw new Error('index.html has no #root element for the app to mount into')
}

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={createAppRouter()} />
  </StrictMode>,
)
