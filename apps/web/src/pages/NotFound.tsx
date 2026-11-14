import { Link } from 'react-router-dom'

/**
 * The page for an address that matches no route.
 *
 * It exists so a mistyped URL ends with a sentence and a way back, instead of the router's
 * bare default. It is a client-side 404 only: the api's not-found body is handled by the
 * api client, not here.
 */
export function NotFound() {
  return (
    <main className="page">
      <h1>Page not found</h1>
      <p>The address you followed does not lead to a page on AshuWorld.</p>
      <Link className="button" to="/ladder">
        Back to the ladder
      </Link>
    </main>
  )
}
