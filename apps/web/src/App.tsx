import {
  Link,
  NavLink,
  Outlet,
  createBrowserRouter,
  useRouteError,
  type RouteObject,
} from 'react-router-dom'
import { Account } from './pages/Account'
import { Home } from './pages/Home'
import { Ladder } from './pages/Ladder'
import { NotFound } from './pages/NotFound'
import { Profile } from './pages/Profile'
import { Xp } from './pages/Xp'

/**
 * The frame around every page: the project's name, the four places a visitor can go, and
 * whatever the route renders.
 *
 * Each page owns its own `<main>` and its own heading, so the frame cannot nest a second
 * landmark around them. The nav is named, because a page-level list of links (the ladder's
 * handles, for one) is a navigation too, and "Navigation principale" is what tells the two
 * apart.
 */
function Layout() {
  return (
    <div className="app">
      <header className="site-header">
        <Link className="brand" to="/">
          AshuWorld
        </Link>
        <nav aria-label="Navigation principale">
          <NavLink to="/ladder">Classement</NavLink>
          <NavLink to="/xp">Gagner de l'XP</NavLink>
          <NavLink to="/account">Mon compte</NavLink>
        </nav>
      </header>
      <Outlet />
    </div>
  )
}

/**
 * What a page shows when rendering it threw.
 *
 * React Router catches the error before it reaches the browser's console-free white
 * screen, but its default page is developer copy. This one says the one thing a fan needs
 * to hear — nothing they earned is lost — and offers the way back. The error itself is
 * not rendered: it may hold anything, and it belongs in the console, where the router has
 * already put it.
 */
function RouteError() {
  // Read so the router marks the error as handled and does not log it twice; the value is
  // deliberately not rendered.
  useRouteError()

  return (
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
  )
}

/**
 * The route table.
 *
 * Exported as data so a test can mount the real table in memory instead of asserting
 * against a copy that could drift. `/f/:handle` is the profile; `/account` is the
 * signed-in page.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Home /> },
      { path: 'ladder', element: <Ladder /> },
      { path: 'xp', element: <Xp /> },
      { path: 'f/:handle', element: <Profile /> },
      { path: 'account', element: <Account /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]

/** The browser router the app mounts with. */
export function createAppRouter() {
  return createBrowserRouter(routes)
}
