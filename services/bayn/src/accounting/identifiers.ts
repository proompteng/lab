import { createHash } from 'node:crypto'

import { BAYN_ACCOUNTING_MODEL_V1, MAX_U128 } from './model'

const encodeIdentityPart = (value: string): string => `${Buffer.byteLength(value, 'utf8')}:${value}`

const digestIdentity = (domain: string, parts: readonly string[]): Buffer => {
  const hash = createHash('sha256')
  hash.update(BAYN_ACCOUNTING_MODEL_V1.identifierVersion, 'utf8')
  hash.update('\0', 'utf8')
  hash.update(encodeIdentityPart(domain), 'utf8')
  for (const part of parts) {
    hash.update('\0', 'utf8')
    hash.update(encodeIdentityPart(part), 'utf8')
  }
  return hash.digest()
}

const bufferToBigInt = (value: Buffer): bigint => BigInt(`0x${value.toString('hex')}`)

/** Stable, domain-separated, non-zero unsigned 128-bit identifier. */
export const stableU128 = (domain: string, parts: readonly string[]): bigint => {
  const candidate = bufferToBigInt(digestIdentity(domain, parts).subarray(0, 16)) & MAX_U128
  return candidate === 0n ? 1n : candidate
}

/** Stable metadata fingerprint for TigerBeetle's u64 user-data field. */
export const stableU64 = (domain: string, parts: readonly string[]): bigint =>
  bufferToBigInt(digestIdentity(domain, parts).subarray(0, 8))

export const evaluationFingerprint = (evaluationId: string): bigint =>
  stableU128('evaluation', [BAYN_ACCOUNTING_MODEL_V1.evaluationSchemaVersion, evaluationId])

export const accountId = (evaluationId: string, semanticAccount: string): bigint =>
  stableU128('account', [BAYN_ACCOUNTING_MODEL_V1.schemaVersion, evaluationId, semanticAccount])

export const transferId = (evaluationId: string, stableEventIdentity: string, leg: string): bigint =>
  stableU128('transfer', [BAYN_ACCOUNTING_MODEL_V1.schemaVersion, evaluationId, stableEventIdentity, leg])
