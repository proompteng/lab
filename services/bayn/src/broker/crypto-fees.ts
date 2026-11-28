import { Schema } from 'effect'

export enum CryptoFeeTier {
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
}

export const CryptoFeeTierSchema = Schema.Enum(CryptoFeeTier)

const takerBpsByTier = {
  [CryptoFeeTier.One]: 25,
  [CryptoFeeTier.Two]: 22,
  [CryptoFeeTier.Three]: 20,
  [CryptoFeeTier.Four]: 18,
  [CryptoFeeTier.Five]: 15,
  [CryptoFeeTier.Six]: 13,
  [CryptoFeeTier.Seven]: 12,
  [CryptoFeeTier.Eight]: 10,
} as const

export type CryptoTakerFeeBps = (typeof takerBpsByTier)[CryptoFeeTier]
export const cryptoMaximumTakerFeeBps = takerBpsByTier[CryptoFeeTier.One]
export const cryptoTakerFeeBps = (tier: CryptoFeeTier | null): CryptoTakerFeeBps =>
  tier === null ? cryptoMaximumTakerFeeBps : takerBpsByTier[tier]

export const effectiveCryptoFeeTier = (
  tier: CryptoFeeTier | null,
  accountObservedAt: string,
  evaluatedAt: string,
): CryptoFeeTier | null => {
  if (tier === null) return null
  const accountAt = new Date(accountObservedAt)
  const day = Date.UTC(accountAt.getUTCFullYear(), accountAt.getUTCMonth(), accountAt.getUTCDate())
  const firstReset = day + 7 * 3_600_000
  const secondReset = day + 8 * 3_600_000
  const observed = accountAt.getTime()
  // Alpaca documents a daily 03:00 Eastern reset. Bound both EST and EDT interpretations.
  const expiresAt = observed < firstReset ? firstReset : observed < secondReset ? secondReset : firstReset + 86_400_000
  return Date.parse(evaluatedAt) < expiresAt ? tier : null
}
