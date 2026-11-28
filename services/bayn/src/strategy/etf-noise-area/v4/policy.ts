import { Schema } from 'effect'

export enum Enhancement {
  Volatility = 'volatility',
  Regime = 'regime',
  Trailing = 'trailing',
}

export const EnhancementSchema = Schema.Enum(Enhancement)

/** Fixed offline experiment rules. No strategy registration, account, or deployment binding. */
export const v4Rules = Object.freeze({
  barMinutes: 5,
  volatilityLookbackSessions: 14,
  openingRangeMinutes: 15,
  efficiencyLookbackMinutes: 60,
  middayStartMinutes: 120,
  middayEndMinutes: 240,
  middayMinEfficiency: 0.35,
  minimumPeerVotes: 3,
  atrBars: 14,
  chandelierMultiple: 4,
  activationR: 1.2,
})
