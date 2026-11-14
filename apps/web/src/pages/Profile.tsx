import { Link, useParams } from 'react-router-dom'
import { ApiError, fetchFan, type PublicFan } from '../api'
import { LevelBadge } from '../components/LevelBadge'
import { formatNumber } from '../format'
import { providerLabel } from '../providers'
import { useResource } from '../useResource'

/** The public profile, once it is here. */
function ProfileBody({ fan }: { fan: PublicFan }) {
  return (
    <>
      <header className="profile-header">
        <h1>{fan.displayName}</h1>
        <p className="handle">
          @<span>{fan.handle}</span>
        </p>
        <LevelBadge level={fan.level} />
      </header>

      <dl className="standing">
        <div>
          <dt>XP</dt>
          <dd>{formatNumber(fan.balance)}</dd>
        </div>
        <div>
          <dt>XP maximal</dt>
          <dd>{formatNumber(fan.peakXp)}</dd>
        </div>
      </dl>
      <p className="muted">
        L’XP maximal est le plus haut total jamais atteint par ce Dachi : c’est pour cela
        que le niveau survit à une sanction ou à un détachement.
      </p>

      <section aria-labelledby="providers-heading">
        <h2 id="providers-heading">Comptes rattachés</h2>
        {fan.identities.length === 0 ? (
          <p className="muted">Aucun compte de plateforme n’est rattaché à ce Dachi.</p>
        ) : (
          <ul className="identity-list">
            {fan.identities.map((identity) => (
              <li key={`${identity.provider}:${identity.displayHandle}`}>
                <span className="provider">{providerLabel(identity.provider)}</span>
                <span className="handle">@{identity.displayHandle}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

/**
 * A public profile: the level, the XP kept now, the most it ever reached, and the
 * accounts behind the total.
 *
 * An unknown handle is a page, not an error. The api answers 404 with the same body as a
 * route that does not exist, so anything else shown here would turn a mistyped link into a
 * crash or a hint about who has an account. Any other 4xx means the same thing for this
 * page: the api refused this profile, and there is no Dachi to show. Only a 5xx or a
 * request that never reached the server is a server failure worth a retry.
 */
export function Profile() {
  const { handle = '' } = useParams<{ handle: string }>()
  const { resource, reload } = useResource(() => fetchFan(handle), [handle])

  if (resource.state === 'loading') {
    return (
      <main className="page">
        <h1>Profil</h1>
        <p className="muted">Chargement de ce Dachi…</p>
      </main>
    )
  }

  if (resource.state === 'error') {
    const status = resource.error instanceof ApiError ? resource.error.status : 0
    if (status >= 400 && status < 500) {
      return (
        <main className="page">
          <h1>Aucun Dachi à ce nom</h1>
          <p>
            Il n’y a pas de Dachi @{handle} sur AshuWorld. Le pseudo est peut-être mal
            orthographié, ou ce Dachi ne s’est pas encore inscrit.
          </p>
          <Link className="button" to="/ladder">
            Retour au classement
          </Link>
        </main>
      )
    }

    return (
      <main className="page">
        <h1>Profil</h1>
        <section className="panel panel-error" aria-labelledby="profile-error-heading">
          <h2 id="profile-error-heading">Ce profil n’a pas pu être chargé</h2>
          <p>
            Le serveur n’a pas répondu, il n’y a rien à afficher pour @{handle} pour
            l’instant.
          </p>
          <button type="button" onClick={reload}>
            Réessayer
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="page">
      <ProfileBody fan={resource.data} />
    </main>
  )
}
