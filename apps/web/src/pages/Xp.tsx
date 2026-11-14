import {
  fetchPublicGame,
  type PublicAction,
  type PublicGame as PublicGameData,
  type PublicLevel,
} from '../api'
import { formatNumber } from '../format'
import { providerLabel } from '../providers'
import { useResource } from '../useResource'

/**
 * What every action pays, as the api serves it.
 *
 * The label is the action's name in the interface and the description says how often it
 * counts; both come from `game.json`, beside the amount they describe. That is the whole
 * point of the page: changing an amount in the config changes this table, with no code
 * change and no chance of the page promising a number the ledger will not pay.
 */
function ActionsTable({ actions }: { actions: PublicAction[] }) {
  return (
    <table className="ladder-table xp-actions">
      <thead>
        <tr>
          <th scope="col">Action</th>
          <th scope="col">Plateforme</th>
          <th scope="col">XP</th>
        </tr>
      </thead>
      <tbody>
        {actions.map((action) => (
          <tr key={action.key}>
            <td>
              <strong>{action.label}</strong>
              <span className="action-description muted">{action.description}</span>
            </td>
            <td>{providerLabel(action.provider)}</td>
            <td>{formatNumber(action.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The level ladder: the level number and the XP needed to reach it. */
function LevelsTable({ levels }: { levels: PublicLevel[] }) {
  return (
    <table className="ladder-table xp-levels">
      <thead>
        <tr>
          <th scope="col">Niveau</th>
          <th scope="col">XP requis</th>
        </tr>
      </thead>
      <tbody>
        {levels.map((level) => (
          <tr key={level.level}>
            <td>{level.level}</td>
            <td>{formatNumber(level.minXp)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The rules page.
 *
 * It reads the same config the api used to award XP, so it cannot drift: the request is
 * public like the ladder, and an outage shows the retry panel rather than an empty table
 * that would read as "nothing pays".
 */
export function Xp() {
  const { resource, reload } = useResource(fetchPublicGame, [])

  return (
    <main className="page">
      <h1>Gagner de l'XP</h1>
      <p>
        Voici tout ce qui rapporte de l'XP, et combien. Chaque action ne compte qu'une fois
        par compte de plateforme.
      </p>
      <p className="muted">
        Les connexions aux plateformes arrivent progressivement pendant l'alpha : une
        action listée ici peut ne pas encore être détectée automatiquement.
      </p>

      {resource.state === 'loading' && <p className="muted">Chargement des règles…</p>}

      {resource.state === 'error' && (
        <section className="panel panel-error" aria-labelledby="xp-error-heading">
          <h2 id="xp-error-heading">Les règles n'ont pas pu être chargées</h2>
          <p>
            Rien n'est perdu. Le serveur n'a pas répondu, cette page n'a donc rien à
            afficher pour l'instant.
          </p>
          <button type="button" onClick={reload}>
            Réessayer
          </button>
        </section>
      )}

      {resource.state === 'ready' && <Rules game={resource.data} />}
    </main>
  )
}

/**
 * The two tables, each under its own heading.
 *
 * The sections are labelled by their heading rather than by an `aria-label` copy, so a
 * screen reader announces "Les actions, region" and then the table inside it: two tables
 * on one page need that context, or a reader lands in a grid with no idea which one.
 */
function Rules({ game }: { game: PublicGameData }) {
  return (
    <>
      <section aria-labelledby="xp-actions-heading">
        <h2 id="xp-actions-heading">Les actions</h2>
        <ActionsTable actions={game.actions} />
      </section>

      <section aria-labelledby="xp-levels-heading">
        <h2 id="xp-levels-heading">Les niveaux</h2>
        <LevelsTable levels={game.levels} />
        <p className="muted">
          Le niveau est conservé même quand l'XP baisse : un Dachi garde le niveau atteint.
        </p>
      </section>
    </>
  )
}
