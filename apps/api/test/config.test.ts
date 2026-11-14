import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/config.js'

/**
 * The minimum a deployment must set. Every Twitch assertion below builds on the same
 * base, so a failure names the Twitch rule rather than a missing required variable.
 */
const base = {
  DATABASE_URL: 'postgres://ashu:ashu@localhost:5432/ashu',
  PUBLIC_BASE_URL: 'https://ashu.example',
}

/** Runs `loadEnv` expecting it to refuse, and hands back the error it threw. */
function refusal(raw: NodeJS.ProcessEnv): Error {
  try {
    loadEnv(raw)
  } catch (error) {
    return error as Error
  }
  throw new Error(`loadEnv should have refused ${JSON.stringify(Object.keys(raw))}`)
}

describe('loadEnv: Twitch credentials', () => {
  it('leaves Twitch off when nothing is configured', () => {
    const env = loadEnv({ ...base })
    expect(env.TWITCH_CLIENT_ID).toBeUndefined()
    expect(env.TWITCH_CLIENT_SECRET).toBeUndefined()
    expect(env.TWITCH_CHANNEL_LOGIN).toBeUndefined()
  })

  it('refuses half a Twitch pair', () => {
    expect(() => loadEnv({ ...base, TWITCH_CLIENT_ID: 'cid' })).toThrow(/TWITCH_CLIENT_SECRET/)
    expect(() => loadEnv({ ...base, TWITCH_CLIENT_SECRET: 's' })).toThrow(/TWITCH_CLIENT_ID/)
  })

  /**
   * A startup error is a log line. Half a pair is still half a credential, so the message
   * may name the variables but must never carry the value that was set, whichever half it
   * was. Sentinels, not shorthand, so the assertion cannot pass by accident.
   */
  it('names the missing half without echoing either value', () => {
    const idOnly = refusal({ ...base, TWITCH_CLIENT_ID: 'cid-value' })
    expect(idOnly.message).toContain('TWITCH_CLIENT_SECRET')
    expect(idOnly.message).not.toContain('cid-value')

    const secretOnly = refusal({ ...base, TWITCH_CLIENT_SECRET: 'secret-value' })
    expect(secretOnly.message).toContain('TWITCH_CLIENT_ID')
    expect(secretOnly.message).not.toContain('secret-value')
  })

  it('treats a blank half of the pair as absent', () => {
    expect(() => loadEnv({ ...base, TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: '  ' })).toThrow(
      /TWITCH_CLIENT_SECRET/,
    )
  })

  it('refuses a Twitch pair without the channel', () => {
    expect(() =>
      loadEnv({ ...base, TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 's' }),
    ).toThrow(/TWITCH_CHANNEL_LOGIN/)
  })

  it('reads a complete Twitch configuration, trimmed', () => {
    expect(
      loadEnv({
        ...base,
        TWITCH_CLIENT_ID: '  cid  ',
        TWITCH_CLIENT_SECRET: ' s ',
        TWITCH_CHANNEL_LOGIN: ' ashuworld ',
      }),
    ).toMatchObject({
      TWITCH_CLIENT_ID: 'cid',
      TWITCH_CLIENT_SECRET: 's',
      TWITCH_CHANNEL_LOGIN: 'ashuworld',
    })
  })

  /**
   * The channel alone is not a half pair: it is a target for a provider that is off. The
   * ruled behaviour is to stay off quietly, and the absence must be visible in the object
   * itself — a key present as `undefined` would let a later reader think it was configured.
   */
  it('stays off, with the keys absent, when only the channel is set', () => {
    const env = loadEnv({ ...base, TWITCH_CHANNEL_LOGIN: 'ashuworld' })
    expect(Object.keys(env)).not.toContain('TWITCH_CLIENT_ID')
    expect(Object.keys(env)).not.toContain('TWITCH_CLIENT_SECRET')
    expect(Object.keys(env)).not.toContain('TWITCH_CHANNEL_LOGIN')
  })
})
