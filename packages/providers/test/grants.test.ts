import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openToken, sealToken } from '../src/grants.js'

function key(): string {
  return randomBytes(32).toString('base64')
}

/** The message of the error the call throws, so a test can inspect what would be logged. */
function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to throw')
}

describe('sealToken / openToken', () => {
  it('round-trips a token and produces different ciphertext each time', () => {
    const k = key()
    const a = sealToken('secret', k)
    const b = sealToken('secret', k)
    expect(a).not.toBe(b)
    expect(openToken(a, k)).toBe('secret')
    expect(a).not.toContain('secret')
  })

  // The version prefix is the only thing that makes a later key rotation or algorithm
  // change readable: without it an old row would be decrypted with the new routine and
  // fail as an authentication error, which reads like a wrong key.
  it('writes the version first and four colon-separated fields', () => {
    const sealed = sealToken('secret', key())
    const parts = sealed.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    // 12-byte IV and 16-byte GCM tag, base64url without padding.
    expect(Buffer.from(parts[1] ?? '', 'base64url')).toHaveLength(12)
    expect(Buffer.from(parts[2] ?? '', 'base64url')).toHaveLength(16)
    expect(sealed).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
  })

  it('round-trips an empty string and a long unicode token', () => {
    const k = key()
    expect(openToken(sealToken('', k), k)).toBe('')
    const long = 'é'.repeat(4096)
    expect(openToken(sealToken(long, k), k)).toBe(long)
  })

  it('refuses a key that is not 32 bytes', () => {
    expect(() => sealToken('x', Buffer.from('short').toString('base64'))).toThrow(/32 bytes/)
    expect(() => openToken('v1:a:b:c', Buffer.from('short').toString('base64'))).toThrow(/32 bytes/)
  })

  it('fails closed when the key changed', () => {
    const sealed = sealToken('secret', key())
    expect(() => openToken(sealed, key())).toThrow()
  })

  // A tampered ciphertext must fail the same way a wrong key does: GCM authenticates the
  // whole message, so nothing decrypts into a half-trusted token.
  it('fails closed when the ciphertext was altered', () => {
    const k = key()
    const [version, iv, tag, body] = sealToken('secret', k).split(':')
    const flipped = Buffer.from(body ?? '', 'base64url')
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(() => openToken(`${version}:${iv}:${tag}:${flipped.toString('base64url')}`, k)).toThrow()
  })

  it('rejects an unknown version prefix', () => {
    const k = key()
    const [version, iv, tag, body] = sealToken('secret', k).split(':')
    expect(version).toBe('v1')
    expect(() => openToken(`v2:${iv}:${tag}:${body}`, k)).toThrow(/unknown version/)
  })

  // A value that was never sealed by us may be a plaintext token that happens to contain
  // colons, and then the header field is the token's head. The message ends up in a log,
  // so it must not carry that field.
  it('does not echo the header of a value that is not ours', () => {
    const k = key()
    expect(() => openToken('v0:secret:tag:body', k)).toThrow('sealed token: unknown version')
    expect(messageOf(() => openToken('v0:secret:tag:body', k))).toBe('sealed token: unknown version')
    expect(messageOf(() => openToken('v0:secret:tag:body', k))).not.toContain('secret')
    // The same for a token whose head is not a version at all.
    expect(messageOf(() => openToken('twitch-refresh-secret:a:b:c', k))).not.toContain('secret')
  })

  it('rejects a malformed sealed value without echoing it', () => {
    const k = key()
    expect(() => openToken('secret', k)).toThrow(/sealed token/)
    expect(() => openToken('v1:only-two', k)).toThrow(/sealed token/)
    expect(() => openToken('v1:aaaa:bbbb:c2VjcmV0', k)).toThrow(/iv must be 12 bytes/)
    // The refused value itself never reaches the message: a broken row could hold a token.
    expect(messageOf(() => openToken('v1:aaaa:bbbb:c2VjcmV0', k))).not.toContain('secret')

    const [version, iv, , body] = sealToken('secret', k).split(':')
    expect(() => openToken(`${version}:${iv}:AAAA:${body}`, k)).toThrow(/tag must be 16 bytes/)
  })
})
