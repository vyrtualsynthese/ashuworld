import { Link } from 'react-router-dom'
import { fetchLadder, type Ladder as LadderData } from '../api'
import { LevelBadge } from '../components/LevelBadge'
import { formatNumber } from '../format'
import { providerLabel } from '../providers'
import { useResource } from '../useResource'

/**
 * One row of the board, whichever kind of account produced it.
 *
 * The api sends two lists because a Dachi and a never-attached provider account are
 * different things to the ledger. The reader has one question — who has the most XP — so
 * the two are merged here, in the browser. `name` is the row's sort key: the handle for a
 * Dachi, the provider handle for an account with no Dachi yet.
 */
type LadderRow =
  | {
      kind: 'dachi'
      key: string
      name: string
      handle: string
      level: number
      xp: number
    }
  | {
      kind: 'account'
      key: string
      name: string
      provider: string
      displayHandle: string
      xp: number
    }

/**
 * The two api lists as one ranked list.
 *
 * The sort is by XP descending, then by name ascending in French, so equal totals come out
 * in a stable, alphabetical order rather than in whatever order the two lists arrived.
 * XP, not level: the level comes from `peak_xp` and only ever rises, so ranking by it would
 * put someone who was punished above the account that is ahead now.
 */
function mergeLadder(ladder: LadderData): LadderRow[] {
  const rows: LadderRow[] = [
    ...ladder.linked.map((fan) => ({
      kind: 'dachi' as const,
      key: fan.fanId,
      name: fan.handle,
      handle: fan.handle,
      level: fan.level,
      xp: fan.balance,
    })),
    ...ladder.freeStanding.map((account) => ({
      kind: 'account' as const,
      key: account.identityId,
      name: account.displayHandle,
      provider: account.provider,
      displayHandle: account.displayHandle,
      xp: account.xp,
    })),
  ]

  return rows.sort((left, right) => {
    if (left.xp !== right.xp) return right.xp - left.xp
    return left.name.localeCompare(right.name, 'fr')
  })
}

/**
 * The board itself.
 *
 * A Dachi row carries a profile link and a level badge; an account with no Dachi yet shows
 * its platform, its handle and its XP, and deliberately has neither. The empty case is one
 * sentence instead of a table with no rows, which a screen reader would announce as an
 * empty grid and nothing else.
 */
function LadderBody({ ladder }: { ladder: LadderData }) {
  const rows = mergeLadder(ladder)

  if (rows.length === 0) {
    return (
      <p className="muted">
        Personne n’a encore gagné d’XP. Connecte-toi, gagne de l’XP et ton nom apparaîtra
        ici.
      </p>
    )
  }

  return (
    <table className="ladder-table">
      <caption>Classement par XP</caption>
      <thead>
        <tr>
          <th scope="col">Rang</th>
          <th scope="col">Dachi</th>
          <th scope="col">Niveau</th>
          <th scope="col">XP</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.key}>
            <td>{index + 1}</td>
            <td>
              {row.kind === 'dachi' ? (
                <Link to={`/f/${encodeURIComponent(row.handle)}`}>{row.handle}</Link>
              ) : (
                <>
                  <span className="provider">{providerLabel(row.provider)}</span>{' '}
                  <span className="handle">@{row.displayHandle}</span>
                </>
              )}
            </td>
            <td>{row.kind === 'dachi' ? <LevelBadge level={row.level} /> : null}</td>
            <td>{formatNumber(row.xp)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The ladder: every account that has earned XP, ranked by XP.
 *
 * Both lists come from one request, because the api answers them from one snapshot:
 * asking twice could show a Dachi in neither list or in both while an award lands between
 * the calls.
 */
export function Ladder() {
  const { resource, reload } = useResource(fetchLadder, [])

  return (
    <main className="page">
      <h1>Classement</h1>
      <p>
        Le classement réunit les Dachis et les comptes non rattachés, triés par XP. Le
        niveau est conservé même quand l’XP baisse : un Dachi garde le niveau atteint.
      </p>

      {resource.state === 'loading' && (
        <p className="muted">Chargement du classement…</p>
      )}

      {resource.state === 'error' && (
        <section className="panel panel-error" aria-labelledby="ladder-error-heading">
          <h2 id="ladder-error-heading">Le classement n’a pas pu être chargé</h2>
          <p>
            Rien n’est perdu. Le serveur n’a pas répondu, cette page n’a donc rien à
            afficher pour l’instant.
          </p>
          <button type="button" onClick={reload}>
            Réessayer
          </button>
        </section>
      )}

      {resource.state === 'ready' && <LadderBody ladder={resource.data} />}
    </main>
  )
}
