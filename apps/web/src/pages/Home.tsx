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
        AshuWorld transforme ce que tu fais déjà avec Ashu — regarder, s’abonner, suivre —
        en XP, et l’XP en niveau qui t’appartient pour toujours.
      </p>
      <p>
        Chaque compte Dachi figure sur le même classement, trié par XP. Chaque compte de
        plateforme que tu rattaches ajoute son XP au même total.
      </p>
      <Link className="button" to="/ladder">
        Voir le classement
      </Link>
    </main>
  )
}
