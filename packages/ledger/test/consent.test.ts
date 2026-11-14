import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createFan,
  recordTermsAcceptance,
  touchLastSeen,
  withTransaction,
} from '../src/index.js'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'

interface ConsentRow {
  terms_version: string | null
  terms_accepted_at: Date | null
  last_seen_at: Date | null
}

async function consentRow(db: TestDb, fanId: string): Promise<ConsentRow> {
  const { rows } = await db.pool.query<ConsentRow>(
    'select terms_version, terms_accepted_at, last_seen_at from fans where id = $1',
    [fanId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`no fan row for ${fanId}`)
  return row
}

describe('consent', () => {
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

  // Consent is evidence of what the fan agreed to at one moment. A later sign-in that
  // carries a newer version must not replace it, or the stored record would describe an
  // acceptance that never happened at that date.
  it('records the acceptance once and never overwrites it', async () => {
    const { id } = await withTransaction(db.pool, (tx) =>
      createFan(tx, { handle: 'ada', displayName: 'Ada' }),
    )

    await withTransaction(db.pool, (tx) => recordTermsAcceptance(tx, id, '2026-11-14'))
    const first = await consentRow(db, id)

    await withTransaction(db.pool, (tx) => recordTermsAcceptance(tx, id, '2027-01-01'))
    const second = await consentRow(db, id)

    expect(first.terms_version).toBe('2026-11-14')
    expect(first.terms_accepted_at).toBeInstanceOf(Date)
    expect(second.terms_version).toBe('2026-11-14')
    expect(second.terms_accepted_at?.toISOString()).toBe(first.terms_accepted_at?.toISOString())
  })

  // An id the caller believes exists but does not (deleted account, stale session) is not
  // an error: the update simply matches nothing. Throwing would turn a harmless race into
  // a failed sign-in.
  it('writes nothing for an unknown fan id and does not throw', async () => {
    const unknown = randomUUID()

    await expect(
      withTransaction(db.pool, (tx) => recordTermsAcceptance(tx, unknown, '2026-11-14')),
    ).resolves.toBeUndefined()
    await expect(
      withTransaction(db.pool, (tx) => touchLastSeen(tx, unknown)),
    ).resolves.toBeUndefined()

    const { rows } = await db.pool.query<{ n: string }>(
      'select count(*)::text as n from fans where id = $1',
      [unknown],
    )
    expect(rows[0]?.n).toBe('0')
  })

  // Retention reads this column as "the fan was here recently", so every sign-in has to move
  // it forward, not merely fill it when it is empty.
  it('moves last_seen_at forward on every touch', async () => {
    const { id } = await withTransaction(db.pool, (tx) =>
      createFan(tx, { handle: 'grace', displayName: 'Grace' }),
    )
    const past = new Date('2020-01-01T00:00:00.000Z')
    await db.pool.query('update fans set last_seen_at = $2 where id = $1', [id, past])

    await withTransaction(db.pool, (tx) => touchLastSeen(tx, id))
    const row = await consentRow(db, id)

    expect(row.last_seen_at).toBeInstanceOf(Date)
    expect(row.last_seen_at?.getTime() ?? 0).toBeGreaterThan(past.getTime())
  })
})
