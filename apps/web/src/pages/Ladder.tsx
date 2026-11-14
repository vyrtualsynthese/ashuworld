import { Link } from 'react-router-dom'
import { fetchLadder, type Ladder as LadderData } from '../api'
import { LevelBadge } from '../components/LevelBadge'
import { formatNumber } from '../format'
import { providerLabel } from '../providers'
import { useResource } from '../useResource'

/**
 * The download is not the page: the two lists get their own sections so a screen reader
 * announces "Fan accounts" and "Free-standing accounts" before either list, and the empty
 * cases say what they mean instead of leaving a table with no rows.
 */
function LadderBody({ ladder }: { ladder: LadderData }) {
  return (
    <>
      <section aria-labelledby="linked-heading">
        <h2 id="linked-heading">Fan accounts</h2>
        {ladder.linked.length === 0 ? (
          <p className="muted">
            Nobody has joined the ladder yet. Sign in, earn some XP and this is where your
            name will show up.
          </p>
        ) : (
          <table className="ladder-table">
            <caption>Fan accounts with the most XP to spend first</caption>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Fan</th>
                <th scope="col">Level</th>
                <th scope="col">XP to spend</th>
              </tr>
            </thead>
            <tbody>
              {ladder.linked.map((fan, index) => (
                <tr key={fan.fanId}>
                  <td>{index + 1}</td>
                  <td>
                    <Link to={`/f/${encodeURIComponent(fan.handle)}`}>{fan.handle}</Link>
                  </td>
                  <td>
                    <LevelBadge level={fan.level} />
                  </td>
                  <td>{formatNumber(fan.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="free-standing-heading">
        <h2 id="free-standing-heading">Free-standing accounts</h2>
        <p>
          These provider accounts have earned XP, but nobody has attached them to a fan
          account yet.
        </p>
        {ladder.freeStanding.length === 0 ? (
          <p className="muted">No free-standing account has earned XP so far.</p>
        ) : (
          <ul className="free-list">
            {ladder.freeStanding.map((account) => (
              <li key={account.identityId}>
                <span className="provider">{providerLabel(account.provider)}</span>
                <span className="handle">@{account.displayHandle}</span>
                <span className="xp">{formatNumber(account.xp)}</span>{' '}
                <span className="unit">XP</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

/**
 * The ladder: who has the most XP to spend, and who earned XP without joining.
 *
 * Both lists come from one request, because the api answers them from one snapshot:
 * asking twice could show a fan in neither list or in both while an award lands between
 * the calls.
 */
export function Ladder() {
  const { resource, reload } = useResource(fetchLadder, [])

  return (
    <main className="page">
      <h1>Ladder</h1>
      <p>
        The ladder ranks fan accounts by the XP they can spend right now. Levels are kept
        even when XP is spent, so a fan keeps the level they reached.
      </p>

      {resource.state === 'loading' && <p className="muted">Loading the ladder…</p>}

      {resource.state === 'error' && (
        <section className="panel panel-error" aria-labelledby="ladder-error-heading">
          <h2 id="ladder-error-heading">The ladder could not be loaded</h2>
          <p>
            Nothing is lost. The server did not answer, so this page has nothing to show
            yet.
          </p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </section>
      )}

      {resource.state === 'ready' && <LadderBody ladder={resource.data} />}
    </main>
  )
}
