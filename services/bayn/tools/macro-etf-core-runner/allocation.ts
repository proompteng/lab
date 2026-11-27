import { Result } from 'effect'

import { withShyCarry } from '../../src/strategy/macro-etf-core/planner'
import {
  asset,
  decodeMacroEtfCorePolicy,
  emptyWeights,
  parameters,
  Profile,
  universe,
  type Etf,
} from '../../src/strategy/macro-etf-core/policy'
import { computeMacroEtfCoreSignal } from '../../src/strategy/macro-etf-core/signals'
import { failure, RunnerProfile } from './contract'
import type { Market } from './market'

export const coexistenceWeights = (
  baselineWeights: readonly number[],
  excluded: ReadonlySet<string>,
  eligible: ReadonlySet<Etf>,
) => {
  const weights = universe.map((symbol, i) => (excluded.has(symbol) ? 0 : baselineWeights[i]))
  for (const group of parameters.offense) {
    const removed = group.members.reduce(
      (sum, symbol) => (excluded.has(symbol) ? sum + baselineWeights[asset[symbol]] : sum),
      0,
    )
    if (removed === 0) continue
    const recipients = group.members.filter((symbol) => !excluded.has(symbol) && eligible.has(symbol))
    const denominator = recipients.reduce((sum, symbol) => sum + weights[asset[symbol]], 0)
    for (const symbol of recipients) {
      const i = asset[symbol]
      weights[i] += removed * (denominator > 0 ? weights[i] / denominator : 1 / recipients.length)
    }
  }
  return excluded.has('SHY') ? weights : withShyCarry(weights)
}

export const computeAllocation = (profile: RunnerProfile, market: Market, excludedSymbols: readonly string[]) =>
  Result.gen(function* () {
    const profiles =
      profile === RunnerProfile.Equal
        ? [Profile.F2, Profile.F4]
        : [profile === RunnerProfile.F2 ? Profile.F2 : Profile.F4]
    const components = []
    for (const profile of profiles) {
      const input = { schema: 'bayn.macro-etf-core-policy.v1', profile }
      const policy = yield* decodeMacroEtfCorePolicy(input)
      const signal = yield* computeMacroEtfCoreSignal(input, market.evidence)
      components.push({ profile, policyHash: policy.hash, signal: signal ?? null })
    }
    const excluded = new Set([...excludedSymbols, ...market.missingCandidates])
    if (components.every(({ signal }) => signal === null))
      return { components, excludedSymbols: [...excluded].sort(), targets: null }
    const baselineWeights = emptyWeights()
    for (const { signal } of components) {
      if (signal === null) return yield* Result.fail(failure('signal', 'Macro profile review cadences diverged'))
      for (const [i, weight] of signal.weights.entries()) baselineWeights[i] += weight / components.length
    }
    const recent = market.evidence.snapshot.bars.slice(-parameters.minimumCandidateHistory)
    const ineligible = parameters.optionalCandidates.filter(
      (symbol) => !recent.every((rows) => rows.some((row) => row.symbol === symbol)),
    )
    const eligible = new Set(universe.filter((symbol) => !ineligible.some((optional) => symbol === optional)))
    const weights = coexistenceWeights(baselineWeights, excluded, eligible)
    if (
      weights.some((weight) => !Number.isFinite(weight) || weight < 0) ||
      weights.reduce((a, b) => a + b, 0) > 1 + 1e-12
    )
      return yield* Result.fail(failure('signal', 'Invalid coexistence allocation'))

    return {
      components,
      excludedSymbols: [...excluded].sort(),
      targets: universe.map((symbol, i) => ({ symbol, weight: weights[i] })),
    }
  })

export type Allocation = Result.Result.Success<ReturnType<typeof computeAllocation>>
