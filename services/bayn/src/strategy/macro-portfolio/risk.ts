import { Schema } from 'effect'

export enum MacroRiskMode {
  Cash = 'cash',
  Margin = 'margin',
}

export enum MacroRiskState {
  Normal = 'normal',
  Brake = 'brake',
  Halt = 'halt',
}

export const MacroRiskStateSchema = Schema.Enum(MacroRiskState)

export const MacroRiskConfig = Schema.Struct({
  mode: Schema.Enum(MacroRiskMode),
  targetVolatility: Schema.Finite.check(Schema.isBetween({ minimum: 0.08, maximum: 0.12 })),
})

export type MacroRiskConfig = typeof MacroRiskConfig.Type

export const macroRiskRules = Object.freeze({
  lookback: 63,
  decay: 0.94,
  annualSessions: 252,
  volatilityFloor: 0.03,
  cashGrossBps: 10_000,
  marginGrossBps: 15_000,
  brakeAtBps: 500,
  brakeGrossMultiplier: 0.5,
  haltAtBps: 1_000,
})

export const grossLimitBps = (mode: MacroRiskMode) =>
  mode === MacroRiskMode.Cash ? macroRiskRules.cashGrossBps : macroRiskRules.marginGrossBps

export const drawdownState = (equity: bigint, highWater: bigint) => {
  const loss = (highWater - equity) * 10_000n
  if (loss >= highWater * BigInt(macroRiskRules.haltAtBps)) return MacroRiskState.Halt
  if (loss >= highWater * BigInt(macroRiskRules.brakeAtBps)) return MacroRiskState.Brake
  return MacroRiskState.Normal
}

export type SleevePair = Readonly<{ f4: number; o1: number }>
type Covariance = SleevePair & { readonly cross: number }

/**
 * Annualized EWMA second moments, treating the short-horizon conditional mean
 * as zero. Project both current sleeve baskets onto the same historical returns
 * before calling this; the cross term includes shared ETF exposures.
 */
export const ewmaCovariance = (returns: readonly SleevePair[]): Covariance => {
  let f4 = 0
  let o1 = 0
  let cross = 0
  let mass = 0
  const { decay, annualSessions } = macroRiskRules
  for (const row of returns) {
    f4 = decay * f4 + row.f4 ** 2
    o1 = decay * o1 + row.o1 ** 2
    cross = decay * cross + row.f4 * row.o1
    mass = decay * mass + 1
  }
  return { f4: (annualSessions * f4) / mass, o1: (annualSessions * o1) / mass, cross: (annualSessions * cross) / mass }
}

export const portfolioVolatility = (covariance: Covariance, { f4, o1 }: SleevePair) =>
  Math.sqrt(Math.max(0, f4 ** 2 * covariance.f4 + o1 ** 2 * covariance.o1 + 2 * f4 * o1 * covariance.cross))
