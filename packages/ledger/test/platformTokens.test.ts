import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readPlatformToken, writePlatformToken } from '../src/index.js'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'

function first<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('expected at least one row')
  return row
}

describe('platform tokens', () => {
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

  it('reads back what was written', async () => {
    await writePlatformToken(db.pool, 'twitch', 'v1:iv:tag:body')
    expect(await readPlatformToken(db.pool, 'twitch')).toBe('v1:iv:tag:body')
  })

  it('returns null for a provider that never authorized', async () => {
    expect(await readPlatformToken(db.pool, 'twitch')).toBeNull()
  })

  // One channel authorization per provider: the row is the grant, so a re-authorization
  // replaces it instead of accumulating tokens that are no longer valid.
  it('replaces the token on a second write and moves updated_at', async () => {
    await writePlatformToken(db.pool, 'twitch', 'v1:first')
    const { rows } = await db.pool.query<{ updated_at: Date }>(
      'select updated_at from platform_tokens where provider = $1',
      ['twitch'],
    )
    const before = first(rows).updated_at

    // `now()` is the transaction timestamp; two autocommit statements could in principle
    // share one. A short wait makes "moves" the property under test rather than the clock.
    await db.pool.query('select pg_sleep(0.01)')
    await writePlatformToken(db.pool, 'twitch', 'v1:second')

    expect(await readPlatformToken(db.pool, 'twitch')).toBe('v1:second')
    const after = await db.pool.query<{ updated_at: Date; n: string }>(
      'select updated_at, (select count(*)::text from platform_tokens) as n from platform_tokens where provider = $1',
      ['twitch'],
    )
    expect(first(after.rows).n).toBe('1')
    expect(first(after.rows).updated_at.getTime()).toBeGreaterThan(before.getTime())
  })

  it('keeps one row per provider', async () => {
    await writePlatformToken(db.pool, 'twitch', 'v1:twitch')
    await writePlatformToken(db.pool, 'youtube', 'v1:youtube')
    expect(await readPlatformToken(db.pool, 'twitch')).toBe('v1:twitch')
    expect(await readPlatformToken(db.pool, 'youtube')).toBe('v1:youtube')
  })
})
