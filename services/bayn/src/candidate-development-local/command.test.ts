import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Exit, Result } from 'effect'

import { makeStrategyProtocolHash } from '../contracts'
import { fixtureSnapshot, fixtureRuntime } from '../app-test-support'
import { fixtureProtocol, makeTestDefinition } from '../test-fixtures'
import type { CandidateDevelopmentNextPreregistration } from '../candidate-development-calendar'
import {
  candidateDevelopmentTerminalStatus,
  evaluateCandidateDevelopmentDefinition,
  makeCandidateDevelopmentLocalAttempt,
  reserveCandidateDevelopmentLocalReceipt,
  runCandidateDevelopmentLocally,
  verifyCandidateDevelopmentSourceManifestBinding,
  verifyCandidateDevelopmentLocalSourceTree,
  verifyCandidateDevelopmentSourceManifest,
  type CandidateDevelopmentLocalAttemptPort,
  type CandidateDevelopmentLocalDependencies,
  type PreparedCandidateDevelopmentLocalAttempt,
} from './command'
import {
  bindCandidateDevelopmentLocalSource,
  CandidateDevelopmentLocalError,
  decodeCandidateDevelopmentRuntimeMarketDataWitness,
  makeCandidateDevelopmentLocalReceipt,
  parseCandidateDevelopmentLocalArguments,
  serializeCandidateDevelopmentLocalReceipt,
  witnessContentHash,
  type CandidateDevelopmentLocalAttemptReceipt,
  type CandidateDevelopmentRuntimeMarketDataWitness,
  type CandidateDevelopmentSourceManifest,
} from './domain'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error('fixture construction failed')
  return result.success
}

const sourceModulePath = 'services/bayn/src/strategy/candidate-21.ts'
const sourceManifestPath = 'services/bayn/candidates/ordinal-21-source-manifest.json'
const sourceRevision = 'a'.repeat(40)
const moduleBlobOid = 'b'.repeat(40)
const sourceManifestBlobOid = 'c'.repeat(40)
const moduleSha256 = 'd'.repeat(64)

const witnessContent = {
  schemaVersion: 'bayn.strategy-development-market-data-witness.v1' as const,
  snapshotId: fixtureSnapshot.manifest.finalizedSnapshot.snapshotId,
  inputManifest: fixtureSnapshot.manifest,
  bars: fixtureSnapshot.bars,
}

const witness: CandidateDevelopmentRuntimeMarketDataWitness = {
  ...witnessContent,
  contentHash: successOf(witnessContentHash(witnessContent)),
}

const sourceManifest: CandidateDevelopmentSourceManifest = {
  schemaVersion: 'bayn.candidate-development-source-manifest.v2',
  candidateOrdinal: 21,
  priorTrialCount: 20,
  trialHistoryHash: 'f'.repeat(64),
  strategyName: 'risk-balanced-trend',
  strategyProtocolHash: makeStrategyProtocolHash(fixtureRuntime.provenance.strategy),
  modulePath: sourceModulePath,
  moduleSha256,
  moduleFormat: 'typescript-strategy-definition-v1',
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-source.v2',
    snapshotId: witness.snapshotId,
    inputManifestHash: witness.inputManifest.hash,
    boundedContentHash: witness.contentHash,
  },
}

const source = successOf(
  bindCandidateDevelopmentLocalSource({
    sourceRevision,
    modulePath: sourceModulePath,
    moduleBlobOid,
    moduleSha256,
    sourceManifestPath,
    sourceManifestBlobOid,
    sourceManifestSha256: 'e'.repeat(64),
    sourceManifest,
  }),
)

const expectedPreregistration: CandidateDevelopmentNextPreregistration = {
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: sourceManifest.candidateOrdinal,
  priorTrialCount: sourceManifest.priorTrialCount,
  strategyProtocolHash: sourceManifest.strategyProtocolHash,
  priorTrialsHash: sourceManifest.trialHistoryHash,
  modulePath: sourceManifest.modulePath,
  moduleSha256: sourceManifest.moduleSha256,
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-source.v1',
    snapshotId: sourceManifest.marketData.snapshotId,
    finalizedSnapshotContentHash: 'a'.repeat(64),
    inputManifestHash: sourceManifest.marketData.inputManifestHash,
    boundedContentHash: sourceManifest.marketData.boundedContentHash,
  },
  preregistration: {
    sourceRevision,
    path: sourceManifestPath,
    blobOid: sourceManifestBlobOid,
  },
}

const prepared: PreparedCandidateDevelopmentLocalAttempt = {
  repositoryRoot: '/repo',
  args: {
    modulePath: '/repo/services/bayn/src/strategy/candidate-21.ts',
    sourceManifestPath: '/repo/services/bayn/candidates/ordinal-21-source-manifest.json',
    runtimeMarketDataPath: '/sealed/witness.json',
  },
  receiptPath: '/repo/.git/bayn/candidate-development-attempts/ordinal-21.json',
  source,
  sourceManifest,
  application: fixtureRuntime.application,
  definition: fixtureRuntime.definition,
  provenance: fixtureRuntime.provenance,
}

describe('candidate-development-local domain boundary', () => {
  test('binds local source manifest identity to the exact frozen successor', () => {
    expect(Result.isSuccess(verifyCandidateDevelopmentSourceManifest(sourceManifest, expectedPreregistration))).toBe(
      true,
    )
    for (const stale of [
      { candidateOrdinal: 1 },
      { priorTrialCount: 0 },
      { trialHistoryHash: '0'.repeat(64) },
      { modulePath: 'services/bayn/src/strategy/old-candidate.ts' },
      { moduleSha256: '0'.repeat(64) },
    ]) {
      expect(
        Result.isFailure(
          verifyCandidateDevelopmentSourceManifest({ ...sourceManifest, ...stale }, expectedPreregistration),
        ),
      ).toBe(true)
    }
  })

  test('requires the exact reviewed source-manifest path, blob, and bytes', () => {
    const expected = { path: sourceManifestPath, blobOid: sourceManifestBlobOid, sha256: 'e'.repeat(64) }
    expect(Result.isSuccess(verifyCandidateDevelopmentSourceManifestBinding(expected, expected))).toBe(true)
    for (const stale of [
      { path: 'services/bayn/candidates/other-source-manifest.json' },
      { blobOid: 'f'.repeat(40) },
      { sha256: '0'.repeat(64) },
    ]) {
      expect(
        Result.isFailure(verifyCandidateDevelopmentSourceManifestBinding({ ...expected, ...stale }, expected)),
      ).toBe(true)
    }
  })

  test('requires statistical PASS alongside economic PASS before reporting PASS', () => {
    expect(candidateDevelopmentTerminalStatus('PASS', 'PASS')).toBe('PASS')
    expect(candidateDevelopmentTerminalStatus('PASS', 'REJECTED')).toBe('HOLD_REJECT')
    expect(candidateDevelopmentTerminalStatus('PASS', 'INSUFFICIENT')).toBe('HOLD_REJECT')
    expect(candidateDevelopmentTerminalStatus('FAIL_CLOSED', 'PASS')).toBe('HOLD_REJECT')
  })

  test('accepts exactly three path arguments and excludes witness paths from receipts', () => {
    expect(
      Result.isSuccess(parseCandidateDevelopmentLocalArguments(['module.ts', 'manifest.json', 'witness.json'])),
    ).toBe(true)
    expect(Result.isFailure(parseCandidateDevelopmentLocalArguments(['module.ts', 'manifest.json']))).toBe(true)
    expect(Result.isFailure(decodeCandidateDevelopmentRuntimeMarketDataWitness({}))).toBe(true)

    const receipt = makeCandidateDevelopmentLocalReceipt(source, 'PASS', 'f'.repeat(64))
    expect(serializeCandidateDevelopmentLocalReceipt(receipt)).not.toContain('witness.json')
    expect(receipt.schemaVersion).toBe('bayn.candidate-development-local-attempt.v4')
  })

  test('rejects a mixed snapshot during the shared evaluation', () => {
    const mixedWitness = {
      ...witness,
      bars: [{ ...witness.bars[0]!, symbol: 'NOT_IN_THE_UNIVERSE' }, ...witness.bars.slice(1)],
    }
    const result = evaluateCandidateDevelopmentDefinition(
      fixtureRuntime.definition,
      mixedWitness,
      source,
      sourceManifest,
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.code).toBe('DECISION_FAILED')
  })

  test('rejects candidate-vs-plan substitution through the bound protocol hash', () => {
    const result = evaluateCandidateDevelopmentDefinition(
      makeTestDefinition(fixtureProtocol, fixtureRuntime.definition.decide),
      witness,
      source,
      { ...sourceManifest, strategyProtocolHash: '0'.repeat(64) },
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.code).toBe('SOURCE_BINDING_INVALID')
  })

  test('binds qualification analysis to the preregistered candidate ordinal and history', () => {
    const bound = evaluateCandidateDevelopmentDefinition(fixtureRuntime.definition, witness, source, sourceManifest)
    const firstCandidate = evaluateCandidateDevelopmentDefinition(fixtureRuntime.definition, witness, source, {
      ...sourceManifest,
      candidateOrdinal: 1,
      priorTrialCount: 0,
    })
    expect(Result.isSuccess(bound)).toBe(true)
    expect(Result.isSuccess(firstCandidate)).toBe(true)
    if (Result.isSuccess(bound) && Result.isSuccess(firstCandidate)) {
      expect(bound.success.terminalReportHash).not.toBe(firstCandidate.success.terminalReportHash)
    }

    const inconsistent = evaluateCandidateDevelopmentDefinition(fixtureRuntime.definition, witness, source, {
      ...sourceManifest,
      priorTrialCount: 19,
    })
    expect(inconsistent).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'DECISION_FAILED' },
    })
  })

  test('maps a pure decision failure to a failed terminal outcome', () => {
    const failingDefinition = makeTestDefinition(fixtureProtocol, () =>
      Result.fail({
        _tag: 'RiskBalancedTrendUniverseMismatch',
        expected: fixtureProtocol.universe,
        observed: [],
      }),
    )
    const result = evaluateCandidateDevelopmentDefinition(failingDefinition, witness, source, sourceManifest)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.code).toBe('DECISION_FAILED')
  })
})

describe('candidate-development-local source and attempt lifecycle', () => {
  test('fails closed when reviewed source state changes', async () => {
    const sourceGit = {
      text: async (_root: string, args: readonly string[]) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'f'.repeat(40)
        if (args[0] === 'ls-files') return 'H services/bayn/src/strategy/candidate-21.ts'
        if (args[0] === 'diff') return 'services/bayn/src/strategy/candidate-21.ts'
        return ''
      },
      bytes: async () => Buffer.alloc(0),
    }
    const exit = await Effect.runPromiseExit(
      verifyCandidateDevelopmentLocalSourceTree('/repo', [sourceModulePath], sourceGit, sourceRevision),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test('reserves an attempt once and rejects replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-candidate-local-'))
    const path = join(directory, 'ordinal-21.json')
    const receipt = makeCandidateDevelopmentLocalReceipt(source, 'RESERVED')
    try {
      await Effect.runPromise(reserveCandidateDevelopmentLocalReceipt(path, receipt))
      const replay = await Effect.runPromiseExit(reserveCandidateDevelopmentLocalReceipt(path, receipt))
      expect(Exit.isFailure(replay)).toBe(true)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ status: 'RESERVED', attempt: 1 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('finalizes a failed decision exactly once', async () => {
    const events: string[] = []
    const finalized: CandidateDevelopmentLocalAttemptReceipt[] = []
    const port: CandidateDevelopmentLocalAttemptPort = {
      reserve: () => Effect.sync(() => events.push('reserve')),
      execute: () => Effect.fail(new CandidateDevelopmentLocalError({ code: 'DECISION_FAILED', message: 'failed' })),
      finalize: (_path, receipt) =>
        Effect.sync(() => {
          events.push('finalize')
          finalized.push(receipt)
        }),
    }
    const result = await Effect.runPromiseExit(
      runCandidateDevelopmentLocally(['module.ts', 'manifest.json', 'witness.json'], {
        prepare: () => Effect.succeed(prepared),
        attempt: makeCandidateDevelopmentLocalAttempt(port),
      } satisfies CandidateDevelopmentLocalDependencies),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(events).toEqual(['reserve', 'finalize'])
    expect(finalized).toHaveLength(1)
    expect(finalized[0]?.status).toBe('FAILED')
  })
})
