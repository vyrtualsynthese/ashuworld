import { Link } from 'react-router-dom'

/**
 * The home page: what AshuWorld is, in two sentences, and the way in.
 *
 * The link is the point of the page. A visitor who has never heard of the project should
 * be able to read two lines and see the ladder, without a sign-in wall in front of it.
 */
export function Home() {
  return (
    <main className="page">
      <h1>AshuWorld</h1>
      <p>
        AshuWorld turns what you already do with Ashu — watching, subscribing and
        following — into XP, and XP into a level that is yours to keep.
      </p>
      <p>
        Every fan account sits on one ladder, ranked by the XP it can spend right now, and
        each provider account you attach adds its XP to the same total.
      </p>
      <Link className="button" to="/ladder">
        See the ladder
      </Link>
    </main>
  )
}
