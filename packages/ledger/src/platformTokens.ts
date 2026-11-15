import type { Pool } from 'pg'
import type { ProviderName } from '@ashuworld/providers'

/**
 * The channel's sealed grant at rest.
 *
 * Both functions take the pool rather than a `Queryable`: the grant is written by the
 * operator command and read by the connector, neither of which runs inside an award
 * transaction, so there is nothing to compose with. The value stored is always the
 * output of `sealToken`; this module never sees the plaintext token.
 */

/** The sealed token for `provider`, or null when the channel has never authorized. */
export async function readPlatformToken(pool: Pool, provider: ProviderName): Promise<string | null> {
  const { rows } = await pool.query<{ refresh_token: string }>(
    'select refresh_token from platform_tokens where provider = $1',
    [provider],
  )
  return rows[0]?.refresh_token ?? null
}

/**
 * Stores the sealed token, replacing the provider's previous grant.
 *
 * Upsert, not insert: a re-authorization must move the row rather than fail on the
 * primary key, and the token it replaces is already unusable. `updated_at` is set
 * explicitly because the column's `default now()` only applies to the insert.
 */
export async function writePlatformToken(
  pool: Pool,
  provider: ProviderName,
  sealed: string,
): Promise<void> {
  await pool.query(
    `insert into platform_tokens (provider, refresh_token)
     values ($1, $2)
     on conflict (provider) do update
       set refresh_token = excluded.refresh_token,
           updated_at = now()`,
    [provider, sealed],
  )
}
