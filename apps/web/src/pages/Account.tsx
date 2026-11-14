import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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
 */
function signInHref(provider: string, purpose: 'login' | 'link'): string {
  return `/auth/${encodeURIComponent(provider)}/start?purpose=${purpose}`
}

/** The one sentence about a forfeit, so the confirmation and the result cannot disagree. */
function forfeitSentence(entries: number): string {
  if (entries === 0) return 'No XP entries were forfeited'
  if (entries === 1) return '1 XP entry was forfeited'
  return `${formatNumber(entries)} XP entries were forfeited`
}

function SignInPanel() {
  const devDoor = devLoginAvailable()

  return (
    <section className="panel" aria-labelledby="sign-in-heading">
      <h1 id="sign-in-heading">Sign in to AshuWorld</h1>
      <p>
        Your XP, your level and the accounts attached to you all live in one place. Sign in
        with a provider you already use and this page will show them.
      </p>
      {devDoor ? (
        <>
          <p className="muted">
            This deployment offers the dev sign-in only. It signs you in as a named test
            account and proves nothing, so it is not for real fans.
          </p>
          <a className="button" href={signInHref('dev', 'login')}>
            Sign in with the dev account
          </a>
        </>
      ) : (
        <p className="muted">
          Sign-in is not switched on for this deployment. Ask whoever runs AshuWorld to
          configure a provider.
        </p>
      )}
    </section>
  )
}

/** The explanation shown when a login returned an account that the fan once detached. */
function ReattachPanel({ provider }: { provider: string }) {
  const label = providerLabel(provider)

  return (
    <section className="panel panel-notice" aria-labelledby="reattach-heading">
      <h2 id="reattach-heading">Your {label} account is detached</h2>
      <p>
        You signed in with {label}, but that account is not attached to your AshuWorld
        account. You can attach it again later as a fresh, empty account; the forfeit is
        permanent.
      </p>
      <p>
        To attach it again, start a fresh {label} sign-in that asks to link the account.
      </p>
      <a className="button" href={signInHref(provider, 'link')}>
        Attach {label} again
      </a>
    </section>
  )
}

function NoticePanel({ notice }: { notice: Notice }) {
  switch (notice.kind) {
    case 'detached':
      return (
        <div className="panel panel-ok" role="status">
          <p>
            Your {providerLabel(notice.provider)} account @{notice.displayHandle} is
            detached. {forfeitSentence(notice.forfeitedEntries)}, and your XP to spend is
            now {formatNumber(notice.balance)}. Your level is still {notice.level}. You can
            attach it again later as a fresh, empty account; the forfeit is permanent.
          </p>
        </div>
      )
    case 'last_identity':
      return (
        <div className="panel panel-error" role="alert">
          <h2>This is the only way into your account</h2>
          <p>
            You cannot detach this account, because it is the only way into your AshuWorld
            account. Attach another provider account first, then detach this one if you
            still want to.
          </p>
        </div>
      )
    case 'detach_failed':
      return (
        <div className="panel panel-error" role="alert">
          <h2>That account could not be detached</h2>
          <p>Nothing was changed. Please try again in a moment.</p>
        </div>
      )
    case 'sign_out_failed':
      return (
        <div className="panel panel-error" role="alert">
          <h2>Signing out did not work</h2>
          <p>Your session is still open. Reload the page and try again.</p>
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
 * move forward. A fan deciding to disconnect must not learn either half afterwards.
 */
function DetachConfirm({ identity, busy, onConfirm, onCancel }: DetachConfirmProps) {
  const label = providerLabel(identity.provider)

  return (
    <section className="panel panel-danger" aria-labelledby="detach-heading">
      <h2 id="detach-heading">
        Detach your {label} account @{identity.displayHandle}?
      </h2>
      <p>
        This cannot be undone. The XP this account earned is forfeited for good: it leaves
        your balance, and attaching this account again later will not bring the XP back.
        Your level and your peak XP stay where they are.
      </p>
      <div className="actions">
        <button type="button" onClick={onConfirm} disabled={busy}>
          Yes, detach it
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Keep it attached
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
      <h2 id="attach-heading">Attach another account</h2>
      <p>
        Attaching an account starts that provider&apos;s sign-in, because only the provider
        can prove the account is yours. If a provider is not switched on for this
        deployment, the sign-in will say so.
      </p>
      {available.length === 0 ? (
        <p className="muted">Every provider AshuWorld knows is already attached.</p>
      ) : (
        <ul className="attach-list">
          {available.map((provider) => (
            <li key={provider}>
              {/* A full navigation: the handshake is served by the api. */}
              <a href={signInHref(provider, 'link')}>
                Attach {providerLabel(provider)} account
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
 * for a fan, and is never rendered.
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
          <h1>Your account</h1>
          <p className="muted">Checking whether you are signed in…</p>
        </>
      )}

      {resource.state === 'error' &&
        (resource.error instanceof ApiError && resource.error.status === 401 ? (
          <SignInPanel />
        ) : (
          <>
            <h1>Your account</h1>
            <section className="panel panel-error" aria-labelledby="account-error-heading">
              <h2 id="account-error-heading">Your account could not be loaded</h2>
              <p>The server did not answer, so there is nothing to show yet.</p>
              <button type="button" onClick={reload}>
                Try again
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
              Sign out
            </button>
          </header>

          {reattach !== null &&
            !resource.data.identities.some((identity) => identity.provider === reattach) && (
              <ReattachPanel provider={reattach} />
            )}

          <dl className="standing">
            <div>
              <dt>XP to spend</dt>
              <dd>{formatNumber(resource.data.balance)}</dd>
            </div>
            <div>
              <dt>Peak XP</dt>
              <dd>{formatNumber(resource.data.peakXp)}</dd>
            </div>
          </dl>

          <section aria-labelledby="identities-heading">
            <h2 id="identities-heading">Attached accounts</h2>
            <p>
              Each account below is a way into AshuWorld. Detaching one asks you to confirm
              first, because its XP is forfeited permanently.
            </p>
            {resource.data.identities.length === 0 ? (
              <p className="muted">No provider account is attached to this fan account.</p>
            ) : (
              <ul className="identity-list">
                {resource.data.identities.map((identity) => (
                  <li key={identity.id}>
                    <span className="provider">{providerLabel(identity.provider)}</span>
                    <span className="handle">@{identity.displayHandle}</span>
                    <button
                      type="button"
                      aria-label={`Detach ${providerLabel(identity.provider)} account ${identity.displayHandle}`}
                      onClick={() => {
                        setNotice(null)
                        setDetaching(identity)
                      }}
                      disabled={busy}
                    >
                      Detach
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
