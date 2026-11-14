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
      <h1>Page introuvable</h1>
      <p>L’adresse que tu as suivie ne mène à aucune page d’AshuWorld.</p>
      <Link className="button" to="/">
        Retour au classement
      </Link>
    </main>
  )
}
