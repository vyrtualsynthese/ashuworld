import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ApiError,
  detachIdentity,
  fetchMe,
  signOut,
  type DetachResult,
  type FanIdentity,
  type Me,
} from '../api'
import { LevelBadge } from '../components/LevelBadge'
import { devLoginAvailable } from '../devLogin'
import { formatNumber } from '../format'
import { TERMS_VERSION } from '../legal/content'
import { LINKABLE_PROVIDERS, isProviderName, providerLabel } from '../providers'
import { useResource } from '../useResource'

/** What the last action said. One notice at a time, cleared when a new action starts. */
type Notice =
  | {
      kind: 'detached'
      provider: string
      displayHandle: string
      forfeitedEntries: number
      balance: number
      level: number
    }
  | { kind: 'last_identity' }
  | { kind: 'detach_failed' }
  | { kind: 'sign_out_failed' }

/**
 * An href into the api's sign-in handshake.
 *
 * This is a plain `<a>`, not a router `Link`: `/auth/...` is served by the api, and React
 * Router would intercept the click and look for a client route that does not exist. A full
 * navigation is also what the handshake needs — the provider's redirect must reach the
 * browser, not the history stack.
 *
 * The provider is escaped even though every caller passes a known name: an href is a
 * destination, and the escaping belongs at the point the string becomes one.
 *
 * `accept` is the terms version the Dachi ticked. The api refuses a `login` start without
 * it (`400 consent_required`), while a `link` starts from a session that already accepted,
 * so only the `login` callers pass it.
 */
function signInHref(provider: string, purpose: 'login' | 'link', accept?: string): string {
  const base = `/auth/${encodeURIComponent(provider)}/start?purpose=${purpose}`
  return accept === undefined ? base : `${base}&accept=${encodeURIComponent(accept)}`
}

/** The one sentence about a forfeit, so the confirmation and the result cannot disagree. */
function forfeitSentence(entries: number): string {
  if (entries === 0) return 'Aucune entrée d’XP n’a été perdue'
  if (entries === 1) return '1 entrée d’XP a été perdue'
  return `${formatNumber(entries)} entrées d’XP ont été perdues`
}

function SignInPanel() {
  const devDoor = devLoginAvailable()
  // The api refuses a login start that does not name the accepted version, so the tick is
  // what unlocks the control, not a decoration next to it.
  const [accepted, setAccepted] = useState(false)
  const devText = 'Se connecter avec le compte de développement'

  return (
    <section className="panel" aria-labelledby="sign-in-heading">
      <h1 id="sign-in-heading">Se connecter à AshuWorld</h1>
      <p>
        Ton XP, ton niveau et les comptes rattachés vivent au même endroit. Connecte-toi
        avec une plateforme que tu utilises déjà et cette page les affichera.
      </p>
      {devDoor ? (
        <>
          <p className="muted">
            Ce déploiement ne propose que la connexion de développement. Elle te connecte à
            un compte de test nommé et ne prouve rien : elle n’est pas destinée aux vrais
            Dachis.
          </p>
          <p>
            <label>
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />{' '}
              J’ai 15 ans ou plus et j’accepte les <Link to="/cgu">CGU</Link> et la{' '}
              <Link to="/confidentialite">politique de confidentialité</Link>
            </label>
          </p>
          {accepted ? (
            <a className="button" href={signInHref('dev', 'login', TERMS_VERSION)}>
              {devText}
            </a>
          ) : (
            <button type="button" className="button" disabled>
              {devText}
            </button>
          )}
        </>
      ) : (
        <p className="muted">
          La connexion n’est pas activée sur ce déploiement. Demande à la personne qui gère
          AshuWorld de configurer une plateforme.
        </p>
      )}
    </section>
  )
}

/** The explanation shown when a login returned an account that the Dachi once detached. */
function ReattachPanel({ provider }: { provider: string }) {
  const label = providerLabel(provider)

  return (
    <section className="panel panel-notice" aria-labelledby="reattach-heading">
      <h2 id="reattach-heading">Ton compte {label} est détaché</h2>
      <p>
        Tu t’es connecté avec {label}, mais ce compte n’est pas rattaché à ton compte
        AshuWorld. Tu pourras le rattacher plus tard comme un compte neuf et vide ; la perte
        est définitive.
      </p>
      <p>
        Pour le rattacher, lance une nouvelle connexion {label} qui demande à lier le
        compte.
      </p>
      <a className="button" href={signInHref(provider, 'link')}>
        Rattacher {label}
      </a>
    </section>
  )
}

/**
 * The same news, for a visitor with no session.
 *
 * The detach that sent them here ended the session with it, so the signed-in panel cannot
 * be shown. Saying nothing would leave the most consequential fact unsaid: signing in
 * with this provider does not restore what it earned, and sending the Dachi down that route
 * again only returns them to this page. So the notice names the path that works: sign in
 * with an account that is still attached, then attach this one. It comes before the
 * sign-in panel so it is read before the button that acts on it.
 */
function SignedOutDetachedNotice({ provider }: { provider: string }) {
  const label = providerLabel(provider)

  return (
    <section className="panel panel-notice" aria-labelledby="signed-out-detached-heading">
      <h2 id="signed-out-detached-heading">Ton compte {label} est détaché</h2>
      <p>
        {label} a été détaché de son compte AshuWorld, et l’XP qu’il a gagnée est perdue
        pour toujours.
      </p>
      <p>
        Se reconnecter avec {label} ne la rapportera pas : cette route se termine sans
        session et revient sur cette page. Pour le rattacher, connecte-toi d’abord avec un
        compte encore rattaché, puis lance une nouvelle connexion {label} et choisis de
        rattacher le compte. Il revient comme un compte neuf et vide. La perte est
        définitive.
      </p>
    </section>
  )
}

function NoticePanel({ notice }: { notice: Notice }) {
  switch (notice.kind) {
    case 'detached':
      return (
        <div className="panel panel-ok" role="status">
          <p>
            Ton compte {providerLabel(notice.provider)} @{notice.displayHandle} est détaché.
            {' '}
            {forfeitSentence(notice.forfeitedEntries)}, et ton XP est maintenant{' '}
            {formatNumber(notice.balance)}. Ton niveau est toujours {notice.level}. Tu
            pourras le rattacher plus tard comme un compte neuf et vide ; la perte est
            définitive.
          </p>
        </div>
      )
    case 'last_identity':
      return (
        <div className="panel panel-error" role="alert">
          <h2>C’est ta seule porte d’entrée</h2>
          <p>
            Tu ne peux pas détacher ce compte : c’est la seule façon d’accéder à ton compte
            AshuWorld. Rattache d’abord une autre plateforme, puis détache celui-ci si tu le
            souhaites.
          </p>
        </div>
      )
    case 'detach_failed':
      return (
        <div className="panel panel-error" role="alert">
          <h2>Ce compte n’a pas pu être détaché</h2>
          <p>Rien n’a été modifié. Réessaie dans un instant.</p>
        </div>
      )
    case 'sign_out_failed':
      return (
        <div className="panel panel-error" role="alert">
          <h2>La déconnexion n’a pas fonctionné</h2>
          <p>Ta session est toujours ouverte. Recharge la page et réessaie.</p>
        </div>
      )
  }
}

interface DetachConfirmProps {
  identity: FanIdentity
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The confirmation a detach must pass through.
 *
 * The promise is stated in full because the action cannot be undone: the XP that account
 * earned is forfeited permanently, while the level and the peak are records that only ever
 * move forward. A Dachi deciding to disconnect must not learn either half afterwards.
 */
function DetachConfirm({ identity, busy, onConfirm, onCancel }: DetachConfirmProps) {
  const label = providerLabel(identity.provider)

  return (
    <section className="panel panel-danger" aria-labelledby="detach-heading">
      <h2 id="detach-heading">
        Détacher ton compte {label} @{identity.displayHandle} ?
      </h2>
      <p>
        Cette action est définitive. L’XP gagnée par ce compte est perdue pour toujours :
        elle quitte ton total, et rattacher ce compte plus tard ne la rapportera pas. Ton
        niveau et ton XP maximal restent inchangés.
      </p>
      <div className="actions">
        <button type="button" onClick={onConfirm} disabled={busy}>
          Oui, détacher
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Le garder rattaché
        </button>
      </div>
    </section>
  )
}

/** The providers this account does not hold yet, offered as a fresh link sign-in. */
function AttachPanel({ me }: { me: Me }) {
  const attached = new Set(me.identities.map((identity) => identity.provider))
  const available = LINKABLE_PROVIDERS.filter((provider) => !attached.has(provider))

  return (
    <section aria-labelledby="attach-heading">
      <h2 id="attach-heading">Rattacher un autre compte</h2>
      <p>
        Rattacher un compte lance la connexion de cette plateforme, car elle seule peut
        prouver que le compte est le tien. Si une plateforme n’est pas activée sur ce
        déploiement, la connexion le dira.
      </p>
      {available.length === 0 ? (
        <p className="muted">
          Toutes les plateformes connues d’AshuWorld sont déjà rattachées.
        </p>
      ) : (
        <ul className="attach-list">
          {available.map((provider) => (
            <li key={provider}>
              {/* A full navigation: the handshake is served by the api. */}
              <a href={signInHref(provider, 'link')}>
                Rattacher un compte {providerLabel(provider)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The account page: who you are, what you hold, and the two ways out.
 *
 * `GET /api/me` is the whole state. A 401 is not an error here — it is the ordinary
 * answer for a visitor with no session, and the page shows the way in. Any other failure
 * is the page's own sentence plus a retry: the api's message is written for a caller, not
 * for a Dachi, and is never rendered.
 *
 * Detaching asks first, then reports what the server actually forfeited. The numbers come
 * back in the response rather than being guessed from the pre-detach profile, so the
 * sentence after the action cannot drift from the ledger.
 */
export function Account() {
  const [searchParams] = useSearchParams()
  const requested = searchParams.get('reattach')
  const reattach = requested !== null && isProviderName(requested) ? requested : null

  const { resource, reload } = useResource(fetchMe, [])
  const [detaching, setDetaching] = useState<FanIdentity | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  async function confirmDetach(identity: FanIdentity): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const result: DetachResult = await detachIdentity(identity.id)
      setNotice({
        kind: 'detached',
        provider: identity.provider,
        displayHandle: identity.displayHandle,
        forfeitedEntries: result.forfeitedEntries,
        balance: result.balance,
        level: result.level,
      })
      setDetaching(null)
      reload()
    } catch (error) {
      setDetaching(null)
      if (error instanceof ApiError && error.code === 'last_identity') {
        setNotice({ kind: 'last_identity' })
      } else {
        setNotice({ kind: 'detach_failed' })
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleSignOut(): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await signOut()
      reload()
    } catch {
      setNotice({ kind: 'sign_out_failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page">
      {notice !== null && <NoticePanel notice={notice} />}

      {resource.state === 'loading' && (
        <>
          <h1>Ton compte</h1>
          <p className="muted">Vérification de ta session…</p>
        </>
      )}

      {resource.state === 'error' &&
        (resource.error instanceof ApiError && resource.error.status === 401 ? (
          <>
            {reattach !== null && <SignedOutDetachedNotice provider={reattach} />}
            <SignInPanel />
          </>
        ) : (
          <>
            <h1>Ton compte</h1>
            <section className="panel panel-error" aria-labelledby="account-error-heading">
              <h2 id="account-error-heading">Ton compte n’a pas pu être chargé</h2>
              <p>Le serveur n’a pas répondu, il n’y a donc rien à afficher pour l’instant.</p>
              <button type="button" onClick={reload}>
                Réessayer
              </button>
            </section>
          </>
        ))}

      {resource.state === 'ready' && (
        <>
          <header className="profile-header">
            <h1>{resource.data.displayName}</h1>
            <p className="handle">
              @<span>{resource.data.handle}</span>
            </p>
            <LevelBadge level={resource.data.level} />
            <button type="button" onClick={() => void handleSignOut()} disabled={busy}>
              Se déconnecter
            </button>
          </header>

          {reattach !== null &&
            !resource.data.identities.some((identity) => identity.provider === reattach) && (
              <ReattachPanel provider={reattach} />
            )}

          <dl className="standing">
            <div>
              <dt>XP</dt>
              <dd>{formatNumber(resource.data.balance)}</dd>
            </div>
            <div>
              <dt>XP maximal</dt>
              <dd>{formatNumber(resource.data.peakXp)}</dd>
            </div>
          </dl>

          <section aria-labelledby="identities-heading">
            <h2 id="identities-heading">Comptes rattachés</h2>
            <p>
              Chaque compte ci-dessous est une porte d’entrée dans AshuWorld. En détacher un
              demande confirmation, car son XP est perdu définitivement.
            </p>
            {resource.data.identities.length === 0 ? (
              <p className="muted">
                Aucun compte de plateforme n’est rattaché à ce compte Dachi.
              </p>
            ) : (
              <ul className="identity-list">
                {resource.data.identities.map((identity) => (
                  <li key={identity.id}>
                    <span className="provider">{providerLabel(identity.provider)}</span>
                    <span className="handle">@{identity.displayHandle}</span>
                    <button
                      type="button"
                      aria-label={`Détacher le compte ${providerLabel(identity.provider)} ${identity.displayHandle}`}
                      onClick={() => {
                        setNotice(null)
                        setDetaching(identity)
                      }}
                      disabled={busy}
                    >
                      Détacher
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {detaching !== null && (
              <DetachConfirm
                identity={detaching}
                busy={busy}
                onConfirm={() => void confirmDetach(detaching)}
                onCancel={() => setDetaching(null)}
              />
            )}
          </section>

          <AttachPanel me={resource.data} />
        </>
      )}
    </main>
  )
}
