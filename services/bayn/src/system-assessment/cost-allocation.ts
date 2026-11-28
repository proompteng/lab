import { Result, Schema } from 'effect'

import { OperatingCostCategory, OperatingCostError, type OperatingCostEvidence } from '../operating-costs'
import { IsoDateSchema, Sha256Schema, StrictNonEmptyStringSchema, UnsignedMicrosSchema } from '../schemas'

export const CostAllocationPlanSchema = Schema.Struct({
  provider: StrictNonEmptyStringSchema,
  category: Schema.Enum(OperatingCostCategory),
  serviceStartDate: IsoDateSchema,
  serviceEndDateExclusive: IsoDateSchema,
  basisSourceHash: Sha256Schema,
  weights: Schema.Array(
    Schema.Struct({
      accountBindingHash: Sha256Schema,
      sessionDate: IsoDateSchema,
      weight: UnsignedMicrosSchema,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(10000)),
})

type CostAllocationPlan = typeof CostAllocationPlanSchema.Type
const scopeKey = (scope: { readonly accountBindingHash: string; readonly sessionDate: string }) =>
  `${scope.accountBindingHash}:${scope.sessionDate}`
const planKey = (
  plan: Pick<CostAllocationPlan, 'provider' | 'category' | 'serviceStartDate' | 'serviceEndDateExclusive'>,
) => JSON.stringify([plan.provider, plan.category, plan.serviceStartDate, plan.serviceEndDateExclusive])
const failure = (message: string) => Result.fail(new OperatingCostError({ message }))

export const allocateCostByWeights = (amount: bigint, weights: readonly bigint[]): readonly bigint[] | null => {
  if (amount < 0n || weights.length === 0 || weights.some((weight) => weight <= 0n)) return null
  const total = weights.reduce((sum, weight) => sum + weight, 0n)
  let cumulativeWeight = 0n
  let previousAmount = 0n
  return weights.map((weight) => {
    cumulativeWeight += weight
    const cumulativeAmount = (amount * cumulativeWeight) / total
    const allocated = cumulativeAmount - previousAmount
    previousAmount = cumulativeAmount
    return allocated
  })
}

export const validateCostAllocationPlans = (
  plans: readonly CostAllocationPlan[],
  accounts: ReadonlySet<string>,
  sessionDates: ReadonlySet<string>,
) =>
  Result.gen(function* () {
    const identities = new Set<string>()
    for (const plan of plans) {
      const identity = planKey(plan)
      if (identities.has(identity))
        return yield* failure('A billing identity, category and service period require one frozen allocation basis')
      identities.add(identity)
      if (plan.serviceStartDate >= plan.serviceEndDateExclusive)
        return yield* failure('Registered cost service period must be nonempty')
      let previous = ''
      let evaluated = false
      for (const weight of plan.weights) {
        const key = scopeKey(weight)
        if (
          key <= previous ||
          BigInt(weight.weight) <= 0n ||
          weight.sessionDate < plan.serviceStartDate ||
          weight.sessionDate >= plan.serviceEndDateExclusive
        )
          return yield* failure(
            'Cost allocation weights must be positive, unique, canonically ordered and within their service period',
          )
        previous = key
        evaluated ||= accounts.has(weight.accountBindingHash) && sessionDates.has(weight.sessionDate)
      }
      if (!evaluated) return yield* failure('A registered cost basis must cover an evaluated account and session')
    }
  })

export const validateFrozenCostAllocations = (plans: readonly CostAllocationPlan[], evidence: OperatingCostEvidence) =>
  Result.gen(function* () {
    const sources = new Set<string>()
    for (const line of evidence.consumption) {
      const matching = plans.filter((plan) => planKey(plan) === planKey(line))
      const plan = matching[0]
      if (matching.length !== 1 || plan === undefined)
        return yield* failure('Invoice has no unique prospectively registered cost allocation basis')
      const net =
        BigInt(line.grossAmountMicros) - line.credits.reduce((sum, credit) => sum + BigInt(credit.amountMicros), 0n)
      const amounts = allocateCostByWeights(
        net,
        plan.weights.map((weight) => BigInt(weight.weight)),
      )
      if (amounts === null)
        return yield* failure('Invoice credits or registered weights have an invalid allocation domain')
      const expected = new Map<string, bigint>()
      for (const [index, weight] of plan.weights.entries()) {
        const amount = amounts[index]
        if (amount === undefined) return yield* failure('Allocation output omits a registered weight')
        expected.set(scopeKey(weight), amount)
      }
      const observed = new Set<string>()
      for (const allocation of line.allocations) {
        const scope = scopeKey(allocation)
        if (observed.has(scope) || expected.get(scope) !== BigInt(allocation.amountMicros))
          return yield* failure('Invoice allocation differs from its prospectively registered weights')
        observed.add(scope)
      }
      const missing = [...expected].reduce((sum, [scope, amount]) => sum + (observed.has(scope) ? 0n : amount), 0n)
      if (missing !== BigInt(line.unallocatedMicros))
        return yield* failure('Unallocated invoice expense does not match the missing frozen allocations')
      sources.add(plan.basisSourceHash)
    }
    return [...sources]
  })
