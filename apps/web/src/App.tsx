import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  createBrowserRouter,
  useRouteError,
  type RouteObject,
} from 'react-router-dom'
import { Footer } from './components/Footer'
import { CGU, CONFIDENTIALITE, MENTIONS_LEGALES } from './legal/content'
import { Account } from './pages/Account'
import { Ladder } from './pages/Ladder'
import { LegalPage } from './pages/Legal'
import { NotFound } from './pages/NotFound'
import { Profile } from './pages/Profile'
import { Xp } from './pages/Xp'

/**
 * The frame around every page: the project's name, the three places a visitor can go,
 * whatever the route renders, and the legal footer.
 *
 * Each page owns its own `<main>` and its own heading, so the frame cannot nest a second
 * landmark around them. The nav is named, because a page-level list of links (the ladder's
 * handles, for one) is a navigation too, and "Navigation principale" is what tells the two
 * apart.
 *
 * The ladder is the homepage: the board is the reason to visit, and a marketing page in
 * front of it was one click between a newcomer and the thing they came to see.
 */
function Layout() {
  return (
    <div className="app">
      <header className="site-header">
        <Link className="brand" to="/">
          AshuWorld
        </Link>
        <nav aria-label="Navigation principale">
          {/* `end` keeps the ladder link inactive on /xp and /account: without it, every
              path matches `/` and the nav would always show Classement as current. */}
          <NavLink to="/" end>
            Classement
          </NavLink>
          <NavLink to="/xp">Gagner de l'XP</NavLink>
          <NavLink to="/account">Mon compte</NavLink>
        </nav>
      </header>
      <Outlet />
      <Footer />
    </div>
  )
}

/**
 * The page an unexpected rendering error lands on.
 *
 * React Router catches the error before it reaches the browser's console-free white
 * screen, but its default page is developer copy. This one says the one thing a fan needs
 * to hear — nothing they earned is lost — and offers the way back. The error itself is
 * not rendered: it may hold anything, and it belongs in the console, where the router has
 * already put it.
 *
 * It carries the footer for the same reason every other page does: a visitor who reaches an
 * error must still be able to find the publisher and the three legal documents, and the
 * error page is exactly where someone might look for them.
 */
function RouteError() {
  // Read so the router marks the error as handled and does not log it twice; the value is
  // deliberately not rendered.
  useRouteError()

  return (
    <>
      <main className="page">
        <h1>Quelque chose s’est mal passé</h1>
        <p>
          Cette page n’a pas pu s’afficher. Rien de ce que tu as gagné n’est perdu : le
          registre est tenu par le serveur, pas par cette page.
        </p>
        <Link className="button" to="/">
          Aller à l’accueil
        </Link>
      </main>
      <Footer />
    </>
  )
}

/**
 * The route table.
 *
 * Exported as data so a test can mount the real table in memory instead of asserting
 * against a copy that could drift. The root is the ladder, `/f/:handle` is the profile,
 * `/account` is the signed-in page, the three legal documents are plain routes, and
 * `/ladder` redirects so the links handed out before the move keep working.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Ladder /> },
      // `replace` keeps the redirect out of the history, so Back from the board does not
      // bounce the visitor onto /ladder and straight back here.
      { path: 'ladder', element: <Navigate to="/" replace /> },
      { path: 'xp', element: <Xp /> },
      { path: 'f/:handle', element: <Profile /> },
      { path: 'account', element: <Account /> },
      // The three legal documents are real routes, not a modal: a visitor can link to
      // them, and the footer's addresses keep working after a reload.
      { path: 'mentions-legales', element: <LegalPage document={MENTIONS_LEGALES} /> },
      { path: 'confidentialite', element: <LegalPage document={CONFIDENTIALITE} /> },
      { path: 'cgu', element: <LegalPage document={CGU} /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]

/** The browser router the app mounts with. */
export function createAppRouter() {
  return createBrowserRouter(routes)
}
