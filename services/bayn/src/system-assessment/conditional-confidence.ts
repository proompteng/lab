import { JevResearchPolicy, conditionalStatisticalModel } from '../jev/acceptance'
import { Result, Schema } from 'effect'

import { Sha256Schema, SignedMicrosSchema, StrictNonEmptyStringSchema } from '../schemas'
import { SystemAssessmentError } from './economics'

export const ConditionalStatisticalPlanSchema = Schema.Struct({
  method: Schema.Literal(conditionalStatisticalModel.method),
  meanModel: Schema.Literal(conditionalStatisticalModel.meanModel),
  supports: Schema.Array(
    Schema.Struct({
      policy: Schema.Enum(JevResearchPolicy),
      lowerMicros: SignedMicrosSchema,
      upperMicros: SignedMicrosSchema,
      sourceHash: Sha256Schema,
      assumption: StrictNonEmptyStringSchema,
    }),
  ),
})
export type ConditionalStatisticalPlan = typeof ConditionalStatisticalPlanSchema.Type

export const conditionalStatisticalAssumptions = [
  'For every registered session and policy, fully costed net profit lies almost surely within its prospectively registered support, conditional on all prior information and attempted policies. Observed minima and maxima cannot establish this assumption.',
  'The causal filtration includes prior attempts, market information, failures, execution and operating costs. Centered session profit has the conditional Hoeffding MGF bound with parameter one quarter of the registered squared range.',
  'For each policy and session, conditional expected net profit given all prior information equals that session’s deterministic expected net profit given registration information. This mean model is assumed, not inferred from observed returns; higher moments may remain dependent.',
  'The bound estimates average registered expected session net profit under that mean model. It does not establish future profitability or the truth of the registered market assumptions.',
  'Support bounds are statistical model assumptions, not new capital or risk limits. A stop price or daily loss limit alone does not guarantee bounded realized losses. No observation is clipped or excluded to satisfy support.',
] as const

export const validateConditionalStatisticalPlan = (
  plan: ConditionalStatisticalPlan,
  definitions: readonly JevResearchPolicy[],
) => {
  const identities = new Set(plan.supports.map((support) => support.policy))
  return plan.supports.length === definitions.length &&
    new Set(definitions).size === definitions.length &&
    identities.size === definitions.length &&
    definitions.every((hash) => identities.has(hash)) &&
    plan.supports.every((support) => BigInt(support.lowerMicros) <= BigInt(support.upperMicros))
    ? Result.succeed(plan)
    : Result.fail(
        new SystemAssessmentError({
          message:
            'Statistical support must bind each distinct complete registered policy exactly once and have ordered bounds',
        }),
      )
}

export const ceilSquareRoot = (value: bigint): bigint => {
  if (value < 2n) return value
  let root = value
  let next = (root + 1n) / 2n
  while (next < root) {
    root = next
    next = (root + value / root) / 2n
  }
  return root * root === value ? root : root + 1n
}

/** exp(-bits) <= 2^-bits <= 1/denominator; no floating log or quantile decides a gate. */
export const conditionalBound = (values: readonly bigint[], lower: bigint, upper: bigint, denominator: bigint) => {
  let bits = 0n,
    power = 1n
  while (power < denominator) {
    power *= 2n
    bits += 1n
  }
  const count = BigInt(values.length)
  const width = upper - lower
  const squaredRanges = count * width * width
  const radius = ceilSquareRoot((squaredRanges * bits + 1n) / 2n)
  const sum = values.reduce((total, value) => total + value, 0n)
  return {
    count: count.toString(),
    sumMicros: sum.toString(),
    squaredRangesMicros2: squaredRanges.toString(),
    logUpperBound: bits.toString(),
    radiusMicros: radius.toString(),
    lowerSumMicros: (sum - radius).toString(),
    meanLowerBoundMicros: { numerator: (sum - radius).toString(), denominator: count.toString() },
  }
}

export interface StatisticalSeries {
  readonly policy: JevResearchPolicy
  readonly netProfitMicros: readonly string[]
}

export const conditionalConfidence = (
  plan: ConditionalStatisticalPlan,
  candidate: StatisticalSeries,
  controls: readonly StatisticalSeries[],
  attemptIndex: number,
) =>
  Result.gen(function* () {
    const series = [candidate, ...controls]
    yield* validateConditionalStatisticalPlan(
      plan,
      series.map((row) => row.policy),
    )
    const count = candidate.netProfitMicros.length
    if (
      count === 0 ||
      controls.length === 0 ||
      series.some((row) => row.netProfitMicros.length !== count) ||
      !Number.isSafeInteger(attemptIndex) ||
      attemptIndex < 1
    )
      return yield* Result.fail(
        new SystemAssessmentError({
          message: 'Conditional confidence requires the complete matched calendar and original positive attempt index',
        }),
      )
    const rows = []
    for (const row of series) {
      const support = plan.supports.find((support) => support.policy === row.policy)
      if (support === undefined)
        return yield* Result.fail(new SystemAssessmentError({ message: 'Missing registered statistical support' }))
      const values = row.netProfitMicros.map(BigInt)
      const lower = BigInt(support.lowerMicros),
        upper = BigInt(support.upperMicros)
      if (values.some((value) => value < lower || value > upper))
        return yield* Result.fail(new SystemAssessmentError({ message: `STATISTICAL_SUPPORT_VIOLATED:${row.policy}` }))
      rows.push({ row, values, lower, upper })
    }
    const first = rows[0]
    if (first === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Missing candidate statistical series' }))
    const k = BigInt(attemptIndex)
    const denominator = 20n * k * (k + 1n) * BigInt(series.length)
    const profit = conditionalBound(first.values, first.lower, first.upper, denominator)
    const paired = []
    for (const control of rows.slice(1)) {
      const differences: bigint[] = []
      for (const [index, value] of first.values.entries()) {
        const matched = control.values[index]
        if (matched === undefined)
          return yield* Result.fail(new SystemAssessmentError({ message: 'Matched control session is missing' }))
        differences.push(value - matched)
      }
      paired.push({
        control: control.row.policy,
        ...conditionalBound(differences, first.lower - control.upper, first.upper - control.lower, denominator),
      })
    }
    return {
      ...conditionalStatisticalModel,
      alpha: { numerator: '1', denominator: denominator.toString() },
      attemptIndex,
      supports: plan.supports,
      assumptions: conditionalStatisticalAssumptions,
      profit,
      paired,
    }
  })
