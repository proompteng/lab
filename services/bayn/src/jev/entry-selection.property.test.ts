import { expect, test } from 'bun:test'
import fc from 'fast-check'

import { selectJevEntryCandidatesFromSupported } from './decision'

interface Candidate {
  readonly symbol: string
  readonly proposalId: string
  readonly structuralSupport: number
  readonly modeledLossMicros: bigint
}

const compareWithinSymbol = (left: Candidate, right: Candidate) => {
  const supportOrder = right.structuralSupport - left.structuralSupport
  if (supportOrder !== 0) return supportOrder
  if (left.modeledLossMicros < right.modeledLossMicros) return -1
  if (left.modeledLossMicros > right.modeledLossMicros) return 1
  return left.proposalId.localeCompare(right.proposalId)
}

const previousTwoStageSelection = (candidates: readonly Candidate[], maximumPositions: number) => {
  const symbols = [...new Set(candidates.map(({ symbol }) => symbol))]
  const winners = symbols.flatMap((symbol) =>
    candidates
      .filter((candidate) => candidate.symbol === symbol)
      .toSorted(compareWithinSymbol)
      .slice(0, 1),
  )
  winners.sort((left, right) => {
    const supportOrder = right.structuralSupport - left.structuralSupport
    if (supportOrder !== 0) return supportOrder
    if (left.modeledLossMicros < right.modeledLossMicros) return -1
    if (left.modeledLossMicros > right.modeledLossMicros) return 1
    return left.symbol.localeCompare(right.symbol)
  })
  return winners.slice(0, maximumPositions)
}

test('one global selector is behaviorally equivalent to the retired per-symbol preselector', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          symbol: fc.constantFrom('AAPL', 'AMZN', 'GOOG', 'META'),
          structuralSupport: fc.constantFrom(0.7, 0.8, 0.9, 1),
          modeledLossMicros: fc.constantFrom(0n, 1_000_000n, 10_000_000n),
        }),
        { maxLength: 40 },
      ),
      fc.integer({ min: 1, max: 4 }),
      (generated, maximumPositions) => {
        const candidates = generated.map((candidate, index) => ({
          ...candidate,
          proposalId: `proposal-${String(generated.length - index).padStart(2, '0')}`,
        }))
        expect(
          selectJevEntryCandidatesFromSupported(candidates, maximumPositions).map(({ proposalId }) => proposalId),
        ).toEqual(previousTwoStageSelection(candidates, maximumPositions).map(({ proposalId }) => proposalId))
      },
    ),
    { numRuns: 2_000 },
  )
})
