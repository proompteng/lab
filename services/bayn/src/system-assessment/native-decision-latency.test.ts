import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { testHash } from './fixtures.test-support'
import { prepareSystemLatencyReplay } from './latency-replay'
import { measureAlphaDecisionLatency, measureRegisteredDecisionLatency } from './native-decision-latency'
import { ResearchStrategyEngine } from './strategy-binding'

import { alphaLatencyFixture } from './native-alpha-latency.test-support'

describe('native alpha command-to-durable-decision latency', () => {
  test.each(['missing', 'source', 'image'] as const)(
    '%s physical worker build cannot calibrate the registered alpha engine',
    (changed) => {
      const f = alphaLatencyFixture()
      const cut = {
        ...f.cut,
        controllerPasses: f.cut.controllerPasses.map((pass) => {
          if (pass.receiptHash !== f.pass.receiptHash) return pass
          const { executionBuild: _build, ...observation } = pass.observation
          return {
            ...pass,
            observation: {
              ...observation,
              ...(changed === 'missing'
                ? {}
                : {
                    executionBuild: {
                      ...f.executionBuild,
                      ...(changed === 'source' ? { sourceRevision: '9'.repeat(40) } : {}),
                      ...(changed === 'image' ? { imageDigest: `sha256:${'9'.repeat(64)}` } : {}),
                    },
                  }),
            },
          }
        }),
      }
      const result = Result.getOrThrow(measureAlphaDecisionLatency(f.registration, cut, f.identity))
      expect(result.status).not.toBe('MEASURED')
      expect(result.p95FullBatchMs).toBeNull()
      expect(
        [...result.missing, ...result.violations].some((reason) => reason.includes('ALPHA_CONTROLLER_BUILD')),
      ).toBe(true)
    },
  )

  test('registered preparation binds the explicit engine and complete alpha calibration', () => {
    const f = alphaLatencyFixture()
    const prepared = Result.getOrThrow(
      prepareSystemLatencyReplay({
        registration: f.registration,
        sourceCut: f.cut,
        brokerIdentity: f.identity,
      }),
    )
    expect(prepared.protocol.schemaVersion).toBe('bayn.system-latency-stress-protocol.v4')
    expect(prepared.calibration.status).toBe('MEASURED')
    expect(prepared.p95FullBatchMs).toBe(120)
  })

  test('measures a reproduced alpha abstention without fabricating a Jev batch', () => {
    const f = alphaLatencyFixture()
    const result = Result.getOrThrow(measureRegisteredDecisionLatency(f.registration, f.cut, f.identity))
    expect(result).toMatchObject({
      schemaVersion: 'bayn.native-alpha-decision-latency.v1',
      engine: ResearchStrategyEngine.IntradayAlpha,
      status: 'MEASURED',
      p95FullBatchMs: 120,
      admittedObservationCount: 1,
      measuredObservationCount: 1,
      missing: [],
      violations: [],
    })
    expect(result.samples[0]).toMatchObject({ observationHash: f.owned.contentHash, failed: false, abstained: true })
    expect(f.cut.batches).toEqual([])
  })

  test.each([
    'observation witness',
    'command reference',
    'command witness',
    'unresolved decision',
    'source payload',
  ] as const)('%s absence withholds the complete percentile', (missing) => {
    const f = alphaLatencyFixture()
    const cut = {
      ...f.cut,
      alphaObservations: missing === 'source payload' ? [] : f.cut.alphaObservations,
      durableObservations: f.cut.durableObservations.filter((w) =>
        missing === 'observation witness'
          ? w.kind !== 'ALPHA_OBSERVATION'
          : missing === 'command witness'
            ? w.sourceHash !== f.pass.receiptHash
            : true,
      ),
      controllerPasses: f.cut.controllerPasses.map((pass) => {
        if (pass.receiptHash !== f.pass.receiptHash) return pass
        if (missing === 'command reference')
          return {
            ...pass,
            observation: { ...pass.observation, alphaObservationReferences: { hashes: [], complete: false } },
          }
        if (missing === 'unresolved decision')
          return {
            ...pass,
            observation: {
              result: 'SUCCESS' as const,
              outcome: 'ACQUIRED' as const,
              executionBuild: f.executionBuild,
              observedAt: f.at(10),
              executionIssuedAt: f.at(-10),
              alphaObservationReferences: { hashes: [f.owned.contentHash], complete: true },
            },
          }
        return pass
      }),
    }
    const result = Result.getOrThrow(measureAlphaDecisionLatency(f.registration, cut, f.identity))
    expect(result.status).not.toBe('MEASURED')
    expect(result.p95FullBatchMs).toBeNull()
    expect(result.missing.length).toBeGreaterThan(0)
  })

  test('failed native work remains in the timing sample and a delayed durable witness increases its bound', () => {
    const f = alphaLatencyFixture()
    const cut = {
      ...f.cut,
      controllerPasses: f.cut.controllerPasses.map((pass) =>
        pass.receiptHash !== f.pass.receiptHash
          ? pass
          : {
              ...pass,
              observation: {
                result: 'FAILURE' as const,
                executionBuild: f.executionBuild,
                executionIssuedAt: f.at(-10),
                observedAt: f.at(10),
                operation: 'build-decision' as const,
                failure: 'database' as const,
                message: 'Synthetic retained decision write failure',
                alphaObservationReferences: { hashes: [f.owned.contentHash], complete: true },
              },
            },
      ),
      durableObservations: f.cut.durableObservations.map((w) =>
        w.kind === 'ALPHA_OBSERVATION' ? { ...w, witnessedAt: f.at(5000) } : w,
      ),
    }
    const result = Result.getOrThrow(measureAlphaDecisionLatency(f.registration, cut, f.identity))
    expect(result.status).toBe('MEASURED')
    expect(result.p95FullBatchMs).toBe(5010)
    expect(result.samples[0]).toMatchObject({ failed: true, abstained: false })
  })

  test('a candidate cannot borrow an incumbent or different-policy observation', () => {
    const f = alphaLatencyFixture()
    const payload = { ...f.owned.payload, authorityGenerationHash: testHash('different generation') }
    const cut = { ...f.cut, alphaObservations: [{ payload, contentHash: testHash(payload) }] }
    const result = Result.getOrThrow(measureAlphaDecisionLatency(f.registration, cut, f.identity))
    expect(result.status).toBe('VIOLATED')
    expect(result.p95FullBatchMs).toBeNull()
    expect(result.violations.some((v) => v.startsWith('ALPHA_OBSERVATION_SCOPE_OR_CONTENT_MISMATCH:'))).toBe(true)
  })
})
