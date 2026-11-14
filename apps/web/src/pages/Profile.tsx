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
          <dt>XP to spend</dt>
          <dd>{formatNumber(fan.balance)}</dd>
        </div>
        <div>
          <dt>Peak XP</dt>
          <dd>{formatNumber(fan.peakXp)}</dd>
        </div>
      </dl>
      <p className="muted">
        Peak XP is the highest balance this fan has ever reached, which is why the level
        survives a punishment or a detach.
      </p>

      <section aria-labelledby="providers-heading">
        <h2 id="providers-heading">Attached accounts</h2>
        {fan.identities.length === 0 ? (
          <p className="muted">No provider account is attached to this fan account.</p>
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
 * A public profile: the level, what the fan can spend, what they reached, and the accounts
 * behind the total.
 *
 * An unknown handle is a page, not an error. The api answers 404 with the same body as a
 * route that does not exist, so anything else shown here would turn a mistyped link into a
 * crash or a hint about who has an account. Any other 4xx means the same thing for this
 * page: the api refused this profile, and there is no fan to show. Only a 5xx or a request
 * that never reached the server is a server failure worth a retry.
 */
export function Profile() {
  const { handle = '' } = useParams<{ handle: string }>()
  const { resource, reload } = useResource(() => fetchFan(handle), [handle])

  if (resource.state === 'loading') {
    return (
      <main className="page">
        <h1>Profile</h1>
        <p className="muted">Loading this fan…</p>
      </main>
    )
  }

  if (resource.state === 'error') {
    const status = resource.error instanceof ApiError ? resource.error.status : 0
    if (status >= 400 && status < 500) {
      return (
        <main className="page">
          <h1>No such fan</h1>
          <p>
            There is no fan called @{handle} on AshuWorld. The handle may be misspelled, or
            this fan may not have joined yet.
          </p>
          <Link className="button" to="/ladder">
            Back to the ladder
          </Link>
        </main>
      )
    }

    return (
      <main className="page">
        <h1>Profile</h1>
        <section className="panel panel-error" aria-labelledby="profile-error-heading">
          <h2 id="profile-error-heading">This profile could not be loaded</h2>
          <p>The server did not answer, so there is nothing to show for @{handle} yet.</p>
          <button type="button" onClick={reload}>
            Try again
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
