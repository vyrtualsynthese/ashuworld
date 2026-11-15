import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Sealing of a provider refresh token for storage.
 *
 * The token never leaves as plaintext once it is sealed: the api and the worker hold the
 * key, the database holds only ciphertext, so a backup, a `pg_dump` or a reader of the
 * `platform_tokens` table learns nothing.
 *
 * AES-256-GCM is authenticated encryption: a wrong key, an altered ciphertext or a
 * truncated tag all fail at `decipher.final()` instead of returning a plausible-looking
 * token. Nothing here catches that failure — the caller decides whether a bad key is a
 * configuration error (throw, keep the row) or a token to be re-authorized.
 *
 * A fresh random 12-byte IV per call is what keeps two seals of the same token different.
 * GCM with a repeated IV under the same key leaks the XOR of the plaintexts and destroys
 * the authentication guarantee, so the IV is never reused and never derived from the
 * plaintext. It travels in the sealed string, which is what lets `openToken` read a row
 * back without a second column.
 */

const VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * The key as raw bytes, or an error naming the requirement.
 *
 * `Buffer.from(..., 'base64')` silently drops characters it cannot decode, so a
 * mistyped key would otherwise become a different, shorter key that still "works" or,
 * worse, a same-length key that decrypts nothing. The length check is the only thing
 * that turns a silent corruption into a startup failure.
 */
function keyFromBase64(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `token key must be base64 of exactly ${KEY_BYTES} bytes for aes-256-gcm; got ${key.length} bytes`,
    )
  }
  return key
}

function fromBase64Url(part: string): Buffer {
  return Buffer.from(part, 'base64url')
}

/**
 * The four fields of a sealed value, or an error naming the expected shape.
 *
 * The `as` is what removes the four `undefined` branches a destructured `string[]` would
 * otherwise carry under `noUncheckedIndexedAccess`: the length check one line above is
 * the only fact it rests on, so the two stay adjacent.
 */
function sealedFields(sealed: string): [string, string, string, string] {
  const parts = sealed.split(':')
  if (parts.length !== 4) {
    throw new Error('sealed token: expected v1:<iv>:<tag>:<ciphertext>')
  }
  return parts as [string, string, string, string]
}

/** Seals `plaintext` under `keyBase64`; the result is `v1:<iv>:<tag>:<ciphertext>`. */
export function sealToken(plaintext: string, keyBase64: string): string {
  const key = keyFromBase64(keyBase64)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':')
}

/**
 * Opens a sealed value. Throws on an unknown version, a malformed value, a wrong key or a
 * tampered ciphertext; never includes the sealed value or the plaintext in the message,
 * because either could be the token itself.
 */
export function openToken(sealed: string, keyBase64: string): string {
  const key = keyFromBase64(keyBase64)
  const [version, ivPart, tagPart, cipherPart] = sealedFields(sealed)
  if (version !== VERSION) {
    // A fixed message: the header field of a value that is not one of ours may be the
    // head of a plaintext token, and an error message ends up in a log.
    throw new Error('sealed token: unknown version')
  }
  const iv = fromBase64Url(ivPart)
  const tag = fromBase64Url(tagPart)
  const ciphertext = fromBase64Url(cipherPart)
  if (iv.length !== IV_BYTES) {
    throw new Error(`sealed token: the iv must be ${IV_BYTES} bytes, got ${iv.length}`)
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`sealed token: the tag must be ${TAG_BYTES} bytes, got ${tag.length}`)
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
