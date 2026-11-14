import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { loadGameConfigFile, type GameConfig } from '@ashuworld/gameconfig'
import { getStanding, withTransaction, type Queryable } from '@ashuworld/ledger'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import type { DiscoveryPayload } from '@ashuworld/providers'
import { createDiscoveryProcessor, createProcessors } from '../src/processors.js'

/**
 * The real file the api and the worker read, resolved from this test module. Three levels
 * up from `apps/worker/test` is the repository root.
 */
const GAME_CONFIG_PATH = fileURLToPath(
  new URL('../../../packages/gameconfig/config/game.json', import.meta.url),
)

/** A discovery event for a first-time Twitch follower, the shape the queue stores. */
const payload: DiscoveryPayload = {
  kind: 'discovery',
  provider: 'twitch',
  externalId: 't-1',
  displayHandle: 'ashu',
  displayName: 'Ashu',
  actions: ['twitch.follow'],
}

let db: TestDb
let pool: Pool
let cfg: GameConfig

beforeAll(async () => {
  db = await createTestDb()
  pool = db.pool
  cfg = loadGameConfigFile(GAME_CONFIG_PATH)
})

beforeEach(async () => {
  await db.reset()
})

afterAll(async () => {
  await db.pool.end()
})

/**
 * The earn rows one provider account owns, oldest first.
 *
 * `xp_entries.id` is a random uuid, so ordering by it says nothing about when a row was
 * written. `created_at` is the transaction's start time and is shared by every row an
 * event pays, so the action key is the tie-break that keeps the assertion stable.
 */
async function entriesFor(
  provider: string,
  externalId: string,
): Promise<Array<{ action_key: string; amount: number }>> {
  const { rows } = await pool.query<{ action_key: string; amount: number }>(
    `select e.action_key, e.amount
       from xp_entries e
       join provider_identities p on p.id = e.identity_id
      where p.provider = $1 and p.external_id = $2
      order by e.created_at, e.action_key`,
    [provider, externalId],
  )
  return rows
}

interface IdentityRow {
  display_handle: string
  fan_id: string | null
  first_linked_at: Date | null
}

async function identityRow(provider: string, externalId: string): Promise<IdentityRow> {
  const { rows } = await pool.query<IdentityRow>(
    `select display_handle, fan_id, first_linked_at
       from provider_identities
      where provider = $1 and external_id = $2`,
    [provider, externalId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`no ${provider} identity for ${externalId}`)
  return row
}

describe('createDiscoveryProcessor', () => {
  it('awards the one-time action and the current month for a new identity', async () => {
    const processor = createDiscoveryProcessor(cfg, () => new Date('2026-11-14T12:00:00Z'))
    await withTransaction(pool, (tx) => processor(tx, payload))

    const entries = await entriesFor('twitch', 't-1')
    expect(entries.map((e) => [e.action_key, e.amount])).toEqual([
      ['twitch.follow', 50],
      ['twitch.follow@2026-11', 5],
    ])
    const identity = await identityRow('twitch', 't-1')
    expect(identity.fan_id).toBeNull()
    expect(identity.first_linked_at).toBeNull()
    expect(identity.display_handle).toBe('ashu')
  })

  it('does not pay twice when the same event is processed again', async () => {
    const processor = createDiscoveryProcessor(cfg, () => new Date('2026-11-14T12:00:00Z'))
    await withTransaction(pool, (tx) => processor(tx, payload))
    await withTransaction(pool, (tx) => processor(tx, { ...payload, displayHandle: 'renamed' }))
    expect(await entriesFor('twitch', 't-1')).toHaveLength(2)
    expect((await identityRow('twitch', 't-1')).display_handle).toBe('renamed')
  })

  it('pays nothing to a detached identity', async () => {
    await pool.query(
      `insert into provider_identities (provider, external_id, display_handle, first_linked_at)
       values ('twitch', 't-detached', 'old', now())`,
    )
    const processor = createDiscoveryProcessor(cfg, () => new Date('2026-11-14T12:00:00Z'))
    await withTransaction(pool, (tx) =>
      processor(tx, { ...payload, externalId: 't-detached', displayHandle: 'new' }),
    )

    expect(await entriesFor('twitch', 't-detached')).toHaveLength(0)
    expect((await identityRow('twitch', 't-detached')).display_handle).toBe('new')
  })

  it('fails loudly on an action the game config does not define', async () => {
    const processor = createDiscoveryProcessor(cfg)
    await expect(
      withTransaction(pool, (tx) => processor(tx, { ...payload, actions: ['twitch.nope'] })),
    ).rejects.toThrow(/twitch\.nope/)
  })

  it('pays an attached identity and recomputes the fan standing', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into fans (handle, display_name) values ('ada', 'ada') returning id`,
    )
    const fan = rows[0]
    if (fan === undefined) throw new Error('expected the fan row')
    await pool.query(
      `insert into provider_identities
         (provider, external_id, display_handle, fan_id, linked_at, first_linked_at)
       values ('twitch', 't-linked', 'ada', $1, now(), now())`,
      [fan.id],
    )

    const processor = createDiscoveryProcessor(cfg, () => new Date('2026-11-14T12:00:00Z'))
    await withTransaction(pool, (tx) =>
      processor(tx, { ...payload, externalId: 't-linked', displayHandle: 'ada' }),
    )

    const entries = await entriesFor('twitch', 't-linked')
    expect(entries.map((e) => [e.action_key, e.amount])).toEqual([
      ['twitch.follow', 50],
      ['twitch.follow@2026-11', 5],
    ])
    // `awardOnce` recomputes the attached fan's standing in the same transaction, so
    // both the live balance and the high-water mark move with the entries.
    const standing = await getStanding(pool, fan.id)
    expect(standing.balance).toBe(55)
    expect(standing.peakXp).toBe(55)
  })

  it('fails loudly when the identity row vanishes before the guard', async () => {
    const processor = createDiscoveryProcessor(cfg)
    await expect(
      withTransaction(pool, async (tx) => {
        // Delete the row after `ensureIdentity` created it, so the guard's select finds
        // nothing. Wrapping the real transaction keeps the delete inside the unit under
        // test and lets the rollback clean it up.
        const vanishing: Queryable = {
          async query<R extends object = Record<string, unknown>>(
            text: string,
            values?: unknown[],
          ) {
            if (text.trim().startsWith('select fan_id, first_linked_at from provider_identities')) {
              await tx.query('delete from provider_identities where id = $1', values)
            }
            return tx.query<R>(text, values)
          },
        }
        await processor(vanishing, payload)
      }),
    ).rejects.toThrow(/identity .* vanished/)
  })
})

describe('createProcessors', () => {
  it('routes the providers it can pay through one discovery processor', () => {
    const processors = createProcessors(cfg)

    expect([...processors.keys()].sort()).toEqual(['discord', 'twitch'])
    expect(processors.get('twitch')).toBe(processors.get('discord'))
  })
})
