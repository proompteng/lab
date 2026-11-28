import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { MacroRiskConfig, macroRiskRules } from '../macro-portfolio/risk'

export class MacroEtfCoreEvidenceError extends Data.TaggedError('MacroEtfCoreEvidenceError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const evidenceFailure = (message: string, cause?: unknown) =>
  Result.fail(new MacroEtfCoreEvidenceError({ message, cause }))

export const strict = { onExcessProperty: 'error' } as const

export const universe = Object.freeze([
  'SPY',
  'QQQ',
  'IWM',
  'SMH',
  'XLK',
  'XLF',
  'XLV',
  'XLY',
  'XLC',
  'XLI',
  'XLP',
  'XLE',
  'XLU',
  'XLRE',
  'XLB',
  'TLT',
  'IEF',
  'SHY',
  'HYG',
  'LQD',
  'GLD',
  'SLV',
  'USO',
  'DBC',
  'EFA',
  'EEM',
  'VNQ',
  'DIA',
  'UUP',
] as const)

export type Etf = (typeof universe)[number]
export const EtfSchema = Schema.Literals(universe)
export const asset = Object.freeze(Object.fromEntries(universe.map((symbol, i) => [symbol, i])) as Record<Etf, number>)
export const emptyWeights = () => Array<number>(universe.length).fill(0)

export enum Profile {
  F2 = 'F2',
  F4 = 'F4',
}

const PolicySchema = Schema.Struct({
  schema: Schema.Literal('bayn.macro-etf-core-policy.v1'),
  profile: Schema.Enum(Profile),
})

export const parameters = Object.freeze({
  epoch: '2016-01-04',
  warmup: 100,
  cadence: 42,
  ema: 100,
  smoothing: 10,
  primaryVotes: 2,
  secondaryVotes: 1,
  minimumCandidateHistory: 20,
  deadbandBps: 1_000,
  annualSessions: 252,
  covarianceWindows: Object.freeze([5, 20, 60] as const),
  covarianceOffDiagonal: 0.8,
  annualVarianceFloor: 0.02 ** 2,
  riskParityPasses: 48,
  targetVolatility: 0.1,
  volatilityFloor: 0.04,
  compressionRatio: 1.25,
  compressionCut: 0.5,
  riskParitySleeves: Object.freeze([
    Object.freeze(['SPY', 'QQQ', 'EFA', 'EEM'] as const),
    Object.freeze(['IEF', 'TLT'] as const),
    Object.freeze(['GLD'] as const),
    Object.freeze(['DBC'] as const),
    Object.freeze(['UUP'] as const),
  ]),
  offense: Object.freeze([
    Object.freeze({
      budget: 0.8,
      members: Object.freeze([
        'SPY',
        'QQQ',
        'IWM',
        'DIA',
        'SMH',
        'EFA',
        'EEM',
        'VNQ',
        'XLK',
        'XLF',
        'XLV',
        'XLY',
        'XLC',
        'XLI',
        'XLP',
        'XLE',
        'XLU',
        'XLRE',
        'XLB',
      ] as const),
    }),
    Object.freeze({ budget: 0.1, members: Object.freeze(['HYG', 'LQD'] as const) }),
    Object.freeze({ budget: 0.1, members: Object.freeze(['SLV', 'USO'] as const) }),
  ]),
  havens: Object.freeze(['SHY', 'IEF', 'TLT', 'GLD', 'DBC', 'UUP'] as const),
  // XLC has a post-epoch inception; XLRE has two gaps in the registered archive.
  // Neither is a benchmark, regime input, nor risk-parity member.
  optionalCandidates: Object.freeze(['XLC', 'XLRE'] satisfies Etf[]),
  carry: 'SHY',
})

const profiles = Object.freeze({
  [Profile.F2]: Object.freeze({ trial: 'F2-42-IEF-100-10', credit: 'IEF', secondary: 'LQD' } as const),
  [Profile.F4]: Object.freeze({
    trial: 'F4-42-1-LQD-parity',
    credit: 'LQD',
    secondary: 'IEF',
    volatilityPower: 1,
    mix: Object.freeze([0.5, 0.25, 0.25] as const),
  } as const),
})

export const decodeMacroEtfCorePolicy = (input: unknown) => {
  const decoded = Schema.decodeUnknownResult(PolicySchema)(input, strict)
  if (Result.isFailure(decoded)) return evidenceFailure('Invalid macro ETF policy', decoded.failure)
  const { profile, schema } = decoded.success
  const policy = Object.freeze({ schema, profile, universe, parameters, settings: profiles[profile] })
  const hash = canonicalHashV1Result(policy)
  if (Result.isFailure(hash)) return evidenceFailure('Invalid canonical macro ETF policy', hash.failure)
  return Result.succeed(Object.freeze({ ...policy, hash: hash.success }))
}

export const corePolicyV2 = 'bayn.macro-etf-core-policy.v2'
const PolicyV2Schema = Schema.Struct({
  schema: Schema.Literal(corePolicyV2),
  profile: Schema.Enum(Profile).check(Schema.makeFilter((profile) => profile === Profile.F4)),
  risk: MacroRiskConfig,
})

export const decodeMacroEtfCorePolicyV2 = (input: unknown) => {
  const decoded = Schema.decodeUnknownResult(PolicyV2Schema, strict)(input)
  if (Result.isFailure(decoded)) return evidenceFailure('Invalid F4 v2 policy', decoded.failure)
  const policy = Object.freeze({
    ...decoded.success,
    risk: Object.freeze(decoded.success.risk),
    universe,
    parameters,
    settings: profiles[Profile.F4],
    governor: macroRiskRules,
  })
  const hash = canonicalHashV1Result(policy)
  if (Result.isFailure(hash)) return evidenceFailure('Invalid canonical F4 v2 policy', hash.failure)
  return Result.succeed(Object.freeze({ ...policy, hash: hash.success }))
}
