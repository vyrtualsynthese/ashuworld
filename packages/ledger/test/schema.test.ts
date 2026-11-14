import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import { migrate, migrationFiles } from '../src/migrate.js'

function first<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('expected at least one row')
  return row
}

async function seedIdentity(db: TestDb, externalId = '1'): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into provider_identities (provider, external_id, display_handle)
     values ('twitch', $1, $2) returning id`,
    [externalId, `twitch_${externalId}`],
  )
  return first(rows).id
}

async function seedFan(db: TestDb, handle = 'ashu'): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into fans (handle, display_name) values ($1, $2) returning id`,
    [handle, handle],
  )
  return first(rows).id
}

async function seedEarn(db: TestDb, identityId: string, actionKey: string, idempotencyKey: string) {
  await db.pool.query(
    `insert into xp_entries (identity_id, provider, action_key, amount, kind, idempotency_key)
     values ($1, 'twitch', $2, 50, 'earn', $3)`,
    [identityId, actionKey, idempotencyKey],
  )
}

describe('schema', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })

  beforeEach(async () => {
    await db.reset()
  })

  afterAll(async () => {
    await db.pool.end()
  })

  it('creates the tables', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = current_schema() order by 1`,
    )
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        'fans',
        'provider_identities',
        'xp_entries',
        'inbound_events',
        'sessions',
        'audit_log',
        'oauth_handshakes',
      ]),
    )
  })

  it('is idempotent', async () => {
    await expect(migrate(db.pool)).resolves.toBeUndefined()
    const { rows } = await db.pool.query<{ n: string }>('select count(*)::text as n from _migrations')
    expect(rows[0]?.n).toBe('5')
  })

  it('records the applied files by name', async () => {
    const { rows } = await db.pool.query<{ name: string }>('select name from _migrations order by 1')
    expect(rows.map((r) => r.name)).toEqual([
      '0001_init.sql',
      '0002_oauth_handshakes.sql',
      '0003_ladder_indexes.sql',
      '0004_inbound_claim_index.sql',
      '0005_consent_retention_erasure.sql',
    ])
  })

  // The ladder groups balances by owner. `identity_id` was already indexed; without this
  // one the planner has no way into the fan side and rescans the ledger per fan.
  it('indexes live xp_entries by fan, partially', async () => {
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = current_schema() and indexname = 'xp_entries_fan_live'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.indexdef).toContain('(fan_id)')
    // A full index would carry every forfeited entry forever: a detach forfeits instead
    // of deleting, and the balance never reads a forfeited row.
    expect(rows[0]?.indexdef).toMatch(/where \(forfeited_at is null\)/i)
  })

  // The worker's claim takes the oldest unprocessed row per provider, and the unrouted
  // report groups the same predicate by provider. A full index would carry every processed
  // event forever, which no query here reads.
  it('indexes unprocessed inbound events by provider, partially', async () => {
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = current_schema() and indexname = 'inbound_events_unprocessed'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.indexdef).toContain('(provider, id)')
    expect(rows[0]?.indexdef).toMatch(/where \(processed_at is null\)/i)
  })

  it('refuses a handshake purpose that is neither login nor link', async () => {
    await expect(
      db.pool.query(
        `insert into oauth_handshakes (state, provider, purpose, expires_at)
         values ('state-1', 'dev', 'admin', now() + interval '10 minutes')`,
      ),
    ).rejects.toThrow(/oauth_handshakes_purpose_check/)
  })

  it('refuses a link handshake that names no fan', async () => {
    await expect(
      db.pool.query(
        `insert into oauth_handshakes (state, provider, purpose, expires_at)
         values ('state-1', 'dev', 'link', now() + interval '10 minutes')`,
      ),
    ).rejects.toThrow(/link_handshake_has_fan/)
  })

  it('accepts a link handshake once it names a fan', async () => {
    const fanId = await seedFan(db)
    await db.pool.query(
      `insert into oauth_handshakes (state, provider, purpose, fan_id, expires_at)
       values ('state-1', 'dev', 'link', $1, now() + interval '10 minutes')`,
      [fanId],
    )
    const { rows } = await db.pool.query<{ n: string }>('select count(*)::text as n from oauth_handshakes')
    expect(rows[0]?.n).toBe('1')
  })

  it('refuses an entry owned by both an identity and a fan', async () => {
    // Real ids, so only the owner CHECK can fire; a made-up uuid would let the foreign
    // key throw the same way and the test would survive the CHECK being dropped.
    const identityId = await seedIdentity(db)
    const fanId = await seedFan(db)
    await expect(
      db.pool.query(
        `insert into xp_entries (identity_id, fan_id, provider, action_key, amount, kind, idempotency_key)
         values ($1, $2, 'twitch', 'twitch.follow', 50, 'earn', 'k1')`,
        [identityId, fanId],
      ),
    ).rejects.toThrow(/xp_entries_one_owner/)
  })

  it('refuses an entry owned by neither', async () => {
    await expect(
      db.pool.query(
        `insert into xp_entries (provider, action_key, amount, kind, idempotency_key)
         values ('twitch', 'twitch.follow', 50, 'earn', 'k2')`,
      ),
    ).rejects.toThrow(/xp_entries_one_owner/)
  })

  it('accepts an identity-only earn', async () => {
    const identityId = await seedIdentity(db)
    await seedEarn(db, identityId, 'twitch.follow', 'earn_only')
    const { rows } = await db.pool.query<{ n: string }>('select count(*)::text as n from xp_entries')
    expect(rows[0]?.n).toBe('1')
  })

  it('accepts a fan-only penalty with a reason', async () => {
    const fanId = await seedFan(db)
    await db.pool.query(
      `insert into xp_entries (fan_id, provider, action_key, amount, kind, reason, idempotency_key)
       values ($1, 'twitch', 'operator.penalty', -25, 'penalty', 'insulting chat', 'penalty_only')`,
      [fanId],
    )
    const { rows } = await db.pool.query<{ amount: number }>('select amount from xp_entries')
    expect(rows[0]?.amount).toBe(-25)
  })

  // The partial unique index is the mechanism the whole game rests on: a one-time action
  // pays once per identity, forever, and the check has to live in the database because
  // two webhook deliveries can arrive at the same instant.
  it('rejects a second earn of the same one-time action for one identity', async () => {
    const identityId = await seedIdentity(db)
    await seedEarn(db, identityId, 'twitch.follow', 'earn_1')
    await expect(seedEarn(db, identityId, 'twitch.follow', 'earn_2')).rejects.toThrow(/xp_entries_one_time/)
  })

  it('allows the same one-time action on a different identity', async () => {
    const ashu = await seedIdentity(db, '1')
    const other = await seedIdentity(db, '2')
    await seedEarn(db, ashu, 'twitch.follow', 'earn_a')
    await seedEarn(db, other, 'twitch.follow', 'earn_b')
    const { rows } = await db.pool.query<{ n: string }>('select count(*)::text as n from xp_entries')
    expect(rows[0]?.n).toBe('2')
  })

  it('keeps a forfeited earn spent, so a detach cannot pay the same action twice', async () => {
    const identityId = await seedIdentity(db)
    await seedEarn(db, identityId, 'twitch.follow', 'earn_1')
    await db.pool.query('update xp_entries set forfeited_at = now() where identity_id = $1', [identityId])
    await expect(seedEarn(db, identityId, 'twitch.follow', 'earn_2')).rejects.toThrow(/xp_entries_one_time/)
  })

  it('refuses a penalty without a reason', async () => {
    const fanId = await seedFan(db)
    await expect(
      db.pool.query(
        `insert into xp_entries (fan_id, provider, action_key, amount, kind, idempotency_key)
         values ($1, 'twitch', 'operator.penalty', -25, 'penalty', 'penalty_1')`,
        [fanId],
      ),
    ).rejects.toThrow(/xp_entries_penalty_has_reason/)
  })

  it('refuses a handle that is not lowercase letters, digits and underscores', async () => {
    await expect(seedFan(db, 'Bad Handle')).rejects.toThrow(/fans_handle_check/)
  })
})

describe('migration runner', () => {
  it('does not apply a file twice when two runners start together', async () => {
    const fresh = await createTestDb({ migrate: false })
    try {
      // Two runners racing on one schema: the advisory lock makes one wait, and the
      // re-check inside the lock makes it skip instead of replaying the file.
      await Promise.all([migrate(fresh.pool), migrate(fresh.pool)])
      const { rows } = await fresh.pool.query<{ n: string }>('select count(*)::text as n from _migrations')
      expect(rows[0]?.n).toBe('5')
      const { rows: fans } = await fresh.pool.query<{ n: string }>("select count(*)::text as n from pg_tables where schemaname = current_schema() and tablename = 'fans'")
      expect(fans[0]?.n).toBe('1')
    } finally {
      await fresh.pool.end()
    }
  })

  it('finds its files from any working directory', async () => {
    const origin = process.cwd()
    const elsewhere = await mkdtemp(join(tmpdir(), 'ashuworld-cwd-'))
    // A decoy that a cwd-relative runner would apply instead of the real one.
    await mkdir(join(elsewhere, 'migrations'))
    await writeFile(join(elsewhere, 'migrations', '9999_decoy.sql'), 'create table decoy (id integer);\n', 'utf8')

    const fresh = await createTestDb({ migrate: false })
    try {
      process.chdir(elsewhere)
      expect(migrationFiles()).toEqual([
        '0001_init.sql',
        '0002_oauth_handshakes.sql',
        '0003_ladder_indexes.sql',
        '0004_inbound_claim_index.sql',
        '0005_consent_retention_erasure.sql',
      ])
      await migrate(fresh.pool)
      const { rows } = await fresh.pool.query<{ name: string }>('select name from _migrations order by 1')
      expect(rows.map((r) => r.name)).toEqual([
        '0001_init.sql',
        '0002_oauth_handshakes.sql',
        '0003_ladder_indexes.sql',
        '0004_inbound_claim_index.sql',
        '0005_consent_retention_erasure.sql',
      ])
      const { rows: tables } = await fresh.pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = current_schema() order by 1`,
      )
      expect(tables.map((t) => t.tablename)).toContain('fans')
      expect(tables.map((t) => t.tablename)).not.toContain('decoy')
    } finally {
      process.chdir(origin)
      await fresh.pool.end()
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})
