import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  admitCandidate6Trial,
  candidate6PriorTerminalLineage,
  makeCandidate6PreregistrationMaterial,
  makeSealedCandidate6Preregistration,
  sealCandidate6Preregistration,
  type Candidate6PreregistrationFailure,
  type Candidate6PreregistrationMaterial,
} from './preregistration'

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'fixture must succeed')
  return result.success
}

const failure = <A>(result: Result.Result<A, Candidate6PreregistrationFailure>): Candidate6PreregistrationFailure => {
  assert(Result.isFailure(result), 'fixture must fail')
  return result.failure
}

const mutate = (
  material: Candidate6PreregistrationMaterial,
  update: (copy: Candidate6PreregistrationMaterial) => void,
): Candidate6PreregistrationMaterial => {
  const copy = structuredClone(material)
  update(copy)
  return copy
}

describe('candidate 6 sealed preregistration', () => {
  test('is deterministic and binds the complete decision identity', () => {
    const first = success(makeSealedCandidate6Preregistration())
    const second = success(makeSealedCandidate6Preregistration())

    expect(second).toEqual(first)
    expect(first.preregistrationHash).toMatch(/^[0-9a-f]{64}$/)
    expect(first).toMatchObject({
      candidateOrdinal: 6,
      identity: {
        strategyName: 'month-end-liquidity-reversal',
        strategyVersion: '1.0.0',
      },
      data: {
        developmentEnd: '2022-12-30',
        qualificationStart: '2023-01-03',
        qualificationEnd: '2025-12-31',
      },
      trialSemantics: {
        officialTrialsPerIdentity: 1,
        liveCapitalEnabled: false,
        brokerMutationEnabled: false,
      },
    })
  })

  test('changes hash for every decision-relevant preregistration section', () => {
    const material = success(makeCandidate6PreregistrationMaterial())
    const sealed = success(sealCandidate6Preregistration(material))
    const variants = [
      mutate(material, (copy) => {
        ;(copy.identity as { strategyVersion: string }).strategyVersion = '1.0.1'
      }),
      mutate(material, (copy) => {
        ;(copy.data as { qualificationEnd: string }).qualificationEnd = '2025-12-30'
      }),
      mutate(material, (copy) => {
        ;(copy.data as { developmentSessionsExportSha256: string }).developmentSessionsExportSha256 = '0'.repeat(64)
      }),
      mutate(material, (copy) => {
        ;(copy.data as { developmentManifestExportSha256: string }).developmentManifestExportSha256 = '0'.repeat(64)
      }),
      mutate(material, (copy) => {
        ;(copy.features as { pressureReturn: string }).pressureReturn = 'different-feature'
      }),
      mutate(material, (copy) => {
        ;(copy.decisions as { targetWeight: number }).targetWeight = 0.34
      }),
      mutate(material, (copy) => {
        ;(copy.decisions as { terminalEvaluationPolicy: string }).terminalEvaluationPolicy = 'changed-terminal-policy'
      }),
      mutate(material, (copy) => {
        ;(copy.benchmark as { comparison: string }).comparison = 'changed-benchmark-comparison'
      }),
      mutate(material, (copy) => {
        ;(copy.execution as { slippageBps: number }).slippageBps = 2.6
      }),
      mutate(material, (copy) => {
        ;(copy.limits as { maximumGrossExposure: number }).maximumGrossExposure = 0.34
      }),
      mutate(material, (copy) => {
        ;(copy.statisticalGates as { maximumDrawdownInclusive: number }).maximumDrawdownInclusive = 0.34
      }),
      mutate(material, (copy) => {
        ;(copy.walkForward as { minimumPositiveNetFolds: number }).minimumPositiveNetFolds = 3
      }),
      mutate(material, (copy) => {
        ;(copy.exclusions as unknown as string[])[0] = 'changed-exclusion'
      }),
      mutate(material, (copy) => {
        ;(copy.trialSemantics as { officialTrialsPerIdentity: number }).officialTrialsPerIdentity = 2
      }),
    ]

    for (const variant of variants) {
      expect(success(sealCandidate6Preregistration(variant)).preregistrationHash).not.toBe(sealed.preregistrationHash)
    }
  })

  test('does not permit candidate 5 selection or lineage rewriting', () => {
    const sealed = success(makeSealedCandidate6Preregistration())
    expect(
      failure(
        admitCandidate6Trial({
          candidateOrdinal: 5,
          preregistrationHash: sealed.preregistrationHash,
          priorTerminalCandidates: candidate6PriorTerminalLineage,
          existingTrialIdentities: [],
        }),
      ),
    ).toEqual({ _tag: 'CandidateOrdinalMismatch', observed: 5 })

    const rewritten = structuredClone(candidate6PriorTerminalLineage) as unknown as Array<{
      candidateOrdinal: number
      runId: string
      resultHash: string
      verdict: 'QUALIFIED' | 'REJECTED'
    }>
    rewritten[4] = { ...rewritten[4]!, verdict: 'QUALIFIED' }
    expect(
      failure(
        admitCandidate6Trial({
          candidateOrdinal: 6,
          preregistrationHash: sealed.preregistrationHash,
          priorTerminalCandidates: rewritten,
          existingTrialIdentities: [],
        }),
      )._tag,
    ).toBe('Candidate5MutationAttempt')
  })

  test('admits the immutable identity once and rejects a second official trial', () => {
    const sealed = success(makeSealedCandidate6Preregistration())
    const admitted = success(
      admitCandidate6Trial({
        candidateOrdinal: 6,
        preregistrationHash: sealed.preregistrationHash,
        priorTerminalCandidates: candidate6PriorTerminalLineage,
        existingTrialIdentities: [],
      }),
    )
    expect(admitted.trialIdentity).toMatch(/^[0-9a-f]{64}$/)
    expect(admitted.maximumOfficialTrials).toBe(1)

    expect(
      failure(
        admitCandidate6Trial({
          candidateOrdinal: 6,
          preregistrationHash: sealed.preregistrationHash,
          priorTerminalCandidates: candidate6PriorTerminalLineage,
          existingTrialIdentities: [admitted.trialIdentity],
        }),
      ),
    ).toEqual({ _tag: 'Candidate6AlreadyTrialed', trialIdentity: admitted.trialIdentity })
  })
})
