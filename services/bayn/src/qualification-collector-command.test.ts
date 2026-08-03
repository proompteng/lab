import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Effect, Fiber, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import type { CandidateDevelopmentNextPreregistration } from './candidate-development-calendar'
import {
  blockingQualificationWorkflowRunIds,
  loadQualificationCollectorInvocation,
  makeQualificationCandidateRuntime,
  missingQualificationWiring,
  qualificationOperationWithinDeadline,
  qualificationAttemptState,
  QualificationCollectorError,
  runQualificationCollector,
  verifyQualificationCandidateSource,
  type QualificationCollectorExecutionReceipt,
  type QualificationCollectorPrelockEvidence,
  type DeploymentRuntime,
} from './qualification-collector-command'
import { candidate18Preregistration } from './candidate-development-calendar'
import type { QualificationAuditReport } from './audit/audit'
import type { QualificationCandidateBindingReceipt } from './qualification-binding'
import { fixtureLock, fixtureRuntime } from './app-test-support'
import { activeStrategyBehaviorHash, bindReviewedStrategySource } from './strategy'

const prelock = (
  overrides: Partial<QualificationCollectorPrelockEvidence> = {},
): QualificationCollectorPrelockEvidence => ({
  schemaVersion: 'bayn.qualification-collector-prelock.v1',
  repository: 'proompteng/lab',
  currentMainSha: '0'.repeat(40),
  sourceSha: 'a'.repeat(40),
  imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  strategyBehaviorHash: 'c'.repeat(64),
  strategyParameterHash: 'd'.repeat(64),
  strategyProtocolHash: 'e'.repeat(64),
  candidateOrdinal: 17,
  priorTrialCount: 16,
  preregistrationHash: 'e'.repeat(64),
  moduleBlobOid: '7'.repeat(40),
  moduleSha256: '8'.repeat(64),
  trialHistoryHash: '9'.repeat(64),
  candidateSourceHash: 'a'.repeat(64),
  boundedContentHash: 'b'.repeat(64),
  activeAttemptRunIds: [],
  githubRunId: '123456',
  githubRunAttempt: 1,
  ...overrides,
})

const candidate = (input = prelock()): QualificationCandidateBindingReceipt => ({
  schemaVersion: 'bayn.qualification-candidate-binding.v1',
  candidateOrdinal: input.candidateOrdinal,
  priorTrialCount: input.priorTrialCount,
  sourceRevision: input.sourceSha,
  reviewedSourceRevision: 'a'.repeat(40),
  imageRepository: input.imageRepository,
  imageDigest: input.imageDigest,
  snapshotId: 'f'.repeat(64),
  inputManifestHash: '1'.repeat(64),
  finalizedSnapshotContentHash: '2'.repeat(64),
  boundedContentHash: input.boundedContentHash,
  moduleSha256: input.moduleSha256,
  trialHistoryHash: input.trialHistoryHash,
  strategyProtocolHash: input.strategyProtocolHash,
  candidateRunId: '4'.repeat(64),
  lockId: '5'.repeat(64),
  bindingHash: '6'.repeat(64),
  lock: fixtureLock,
})

const deployment = (overrides: Partial<DeploymentRuntime> = {}): DeploymentRuntime => ({
  sourceSha: 'a'.repeat(40),
  imageRepository: 'registry.example.test/lab/bayn',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  strategyBehaviorHash: activeStrategyBehaviorHash,
  strategyParameterHash: fixtureRuntime.provenance.strategy.parameterHash,
  maximumAuthority: 'OBSERVE',
  clickhouseUrl: 'http://clickhouse.example.test',
  signalSnapshotId: 'c'.repeat(64),
  signalPublicationAsOf: '2026-01-30T00:00:00.000Z',
  signalCalendarVersion: 'fixture-calendar-v2',
  signalDataStart: '2016-01-04',
  signalDataEnd: '2026-01-30',
  signalLookbackStart: '2016-01-04',
  signalEvaluationStart: '2017-01-03',
  signalEvaluationEnd: '2026-01-30',
  tigerBeetleClusterId: '1',
  tigerBeetleAddresses: '127.0.0.1:3000',
  tigerBeetleLedger: '1',
  ...overrides,
})

const execution = (binding = candidate()): QualificationCollectorExecutionReceipt => ({
  schemaVersion: 'bayn.qualification-execution.v1',
  runId: binding.candidateRunId,
  lockId: binding.lockId,
  resultHash: '7'.repeat(64),
  verdict: 'REJECTED',
  persistence: { artifactCount: 0, eventCount: 230, gateCount: 7 },
})

const audit = (receipt = execution()): QualificationAuditReport => ({
  schemaVersion: 'bayn.qualification-audit.v2',
  runId: receipt.runId,
  status: 'PASS',
  reference: { economicStatus: 'FAIL_CLOSED', observations: 1_000, rebalanceCount: 100 },
  evidence: {
    artifactCount: receipt.persistence.artifactCount,
    eventCount: receipt.persistence.eventCount,
    gateCount: receipt.persistence.gateCount,
    lockId: receipt.lockId,
    resultHash: receipt.resultHash,
  },
  policies: {
    declaredAt: '2026-07-31T00:00:00.000Z',
    lockId: receipt.lockId,
    policySetHash: '8'.repeat(64),
    documents: [],
  },
  contamination: {
    lockCreatedAt: '2026-07-31T00:00:00.000000Z',
    resultCommittedAt: '2026-07-31T00:01:00.000000Z',
    replicas: ['replica-0', 'replica-1'],
    principals: { candidate: 'signal-publisher', publishers: ['signal-publisher'] },
    access: [],
  },
  repository: {
    sourceRevision: prelock().sourceSha,
    sourceCommitExists: true,
    sourceCommitAncestorOfMain: true,
    preLockResultReferences: [],
  },
  checks: [],
  auditHash: '9'.repeat(64),
})

const gitText = async (cwd: string, args: readonly string[]): Promise<string> => {
  const child = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  return stdout.trim()
}

const sourceFixture = async (malformed = false, historicalModule = false) => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'bayn-qualification-source-'))
  const modulePath = 'services/bayn/src/strategy/candidate-21.ts'
  const historicalModulePath = 'services/bayn/src/strategy/old-candidate.ts'
  const preregistrationPath = 'services/bayn/candidates/ordinal-21-preregistration.json'
  const ledgerPath = 'services/bayn/src/candidate-development-trials/ledger.ts'
  const moduleBytes = Buffer.from("export const strategyDefinition = { name: 'candidate-21' }\n")
  const moduleSha256 = createHash('sha256').update(moduleBytes).digest('hex')
  await gitText(repositoryPath, ['init', '-b', 'main'])
  await gitText(repositoryPath, ['config', 'user.email', 'qualification-test@example.invalid'])
  await gitText(repositoryPath, ['config', 'user.name', 'Qualification Test'])
  await gitText(repositoryPath, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(repositoryPath, 'README.md'), 'qualification source fixture\n')
  await gitText(repositoryPath, ['add', 'README.md'])
  await gitText(repositoryPath, ['commit', '-m', 'create source fixture'])
  const preregistration: CandidateDevelopmentNextPreregistration = {
    schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
    candidateOrdinal: 21,
    priorTrialCount: 20,
    strategyProtocolHash: 'a'.repeat(64),
    priorTrialsHash: 'b'.repeat(64),
    modulePath,
    moduleSha256,
    marketData: {
      schemaVersion: 'bayn.candidate-development-market-data-source.v1',
      snapshotId: 'c'.repeat(64),
      finalizedSnapshotContentHash: 'd'.repeat(64),
      inputManifestHash: 'e'.repeat(64),
      boundedContentHash: 'f'.repeat(64),
    },
    preregistration: {
      sourceRevision: '',
      path: preregistrationPath,
      blobOid: '',
    },
  }
  if (historicalModule) {
    await mkdir(join(repositoryPath, dirname(historicalModulePath)), { recursive: true })
    await writeFile(join(repositoryPath, historicalModulePath), moduleBytes)
    await gitText(repositoryPath, ['add', historicalModulePath])
    await gitText(repositoryPath, ['commit', '-m', 'add historical module blob'])
  }
  await mkdir(join(repositoryPath, dirname(preregistrationPath)), { recursive: true })
  await mkdir(join(repositoryPath, dirname(ledgerPath)), { recursive: true })
  await writeFile(
    join(repositoryPath, ledgerPath),
    'const historicalLedger = [\n  { value: 1 },\n] as const\n\n/** One append-only source-controlled ledger. */\nexport const registration = null\n',
  )
  const { preregistration: _registrationMetadata, ...document } = preregistration
  await writeFile(join(repositoryPath, preregistrationPath), malformed ? '{' : JSON.stringify(document))
  await gitText(repositoryPath, ['add', '.'])
  await gitText(repositoryPath, ['commit', '-m', 'preregister candidate'])
  const preregistrationRevision = await gitText(repositoryPath, ['rev-parse', 'HEAD'])
  const preregistrationBlobOid = await gitText(repositoryPath, ['rev-parse', `HEAD:${preregistrationPath}`])
  await mkdir(join(repositoryPath, dirname(modulePath)), { recursive: true })
  await writeFile(join(repositoryPath, modulePath), moduleBytes)
  await gitText(repositoryPath, ['add', modulePath])
  await gitText(repositoryPath, ['commit', '-m', 'add candidate module'])
  const sourceRevision = await gitText(repositoryPath, ['rev-parse', 'HEAD'])
  const moduleBlobOid = await gitText(repositoryPath, ['rev-parse', `HEAD:${modulePath}`])
  const bound = {
    ...preregistration,
    preregistration: {
      sourceRevision: preregistrationRevision,
      path: preregistrationPath,
      blobOid: preregistrationBlobOid,
    },
  }
  const { preregistration: _boundMetadata, ...boundDocument } = bound
  const preregistrationBytes = Buffer.from(malformed ? '{' : JSON.stringify(boundDocument))
  return {
    repositoryPath,
    ledgerPath,
    input: {
      repositoryPath,
      sourceRevision,
      allowedDescendantPaths: [modulePath, preregistrationPath, ledgerPath],
      preregistration: bound,
      preregistrationBytes,
      moduleBlobOid,
      moduleBytes,
    },
    cleanup: () => rm(repositoryPath, { recursive: true, force: true }),
  }
}

describe('qualification collector boundaries', () => {
  test('interrupts a post-lock operation at the configured deadline', async () => {
    let interrupted = false
    const timeout = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* qualificationOperationWithinDeadline(
            Effect.never.pipe(Effect.ensuring(Effect.sync(() => void (interrupted = true)))),
            10,
            'qualification-data-load',
            () =>
              new QualificationCollectorError({
                phase: 'execution',
                code: 'underlying-failure',
                message: 'underlying operation failed',
              }),
          ).pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }))
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          return yield* Fiber.join(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(timeout).toMatchObject({ code: 'qualification-data-load-timeout' })
    expect(interrupted).toBe(true)
  })

  test('separates candidate module provenance from deployed behavior and parameter identity', () => {
    const source = {
      sourceRevision: deployment().sourceSha,
      modulePath: candidate18Preregistration.modulePath,
      moduleSha256: candidate18Preregistration.moduleSha256,
    }
    const application = bindReviewedStrategySource(fixtureRuntime.application, source)
    const matching = makeQualificationCandidateRuntime(application, deployment(), source, candidate18Preregistration)
    expect(Result.isSuccess(matching)).toBe(true)
    if (Result.isSuccess(matching)) {
      expect(matching.success.moduleSha256).toBe(source.moduleSha256)
      expect(matching.success.strategyBehaviorHash).toBe(source.moduleSha256)
    }
    const reviewedSource = {
      ...source,
      sourceRevision: candidate18Preregistration.preregistration.sourceRevision,
    }
    const descendant = makeQualificationCandidateRuntime(
      bindReviewedStrategySource(fixtureRuntime.application, reviewedSource),
      deployment(),
      { ...source, reviewedSourceRevision: reviewedSource.sourceRevision },
      candidate18Preregistration,
    )
    expect(Result.isSuccess(descendant)).toBe(true)

    const behaviorMismatch = makeQualificationCandidateRuntime(
      application,
      deployment({ strategyBehaviorHash: '0'.repeat(64) }),
      source,
      candidate18Preregistration,
    )
    expect(behaviorMismatch).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'deployment-strategy-behavior-mismatch' },
    })

    const parameterMismatch = makeQualificationCandidateRuntime(
      application,
      deployment({ strategyParameterHash: '1'.repeat(64) }),
      source,
      candidate18Preregistration,
    )
    expect(parameterMismatch).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'deployment-strategy-parameter-mismatch' },
    })

    const substitutedApplication = bindReviewedStrategySource(fixtureRuntime.application, {
      ...source,
      moduleSha256: '0'.repeat(64),
    })
    expect(
      makeQualificationCandidateRuntime(substitutedApplication, deployment(), source, candidate18Preregistration),
    ).toMatchObject({
      _tag: 'Failure',
      failure: { code: 'candidate-application-source-mismatch' },
    })
  })

  test('rejects non-scheduled and manual invocations', async () => {
    const manual = await Effect.runPromise(
      Effect.flip(loadQualificationCollectorInvocation({ GITHUB_EVENT_NAME: 'workflow_dispatch' })),
    )
    expect(manual).toMatchObject({ code: 'manual-dispatch-rejected' })
    const push = await Effect.runPromise(
      Effect.flip(loadQualificationCollectorInvocation({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40) })),
    )
    expect(push).toMatchObject({ code: 'event-not-trusted' })
  })

  test('reports missing wiring without exposing secret values', () => {
    expect(missingQualificationWiring({})).toContain('GITHUB_TOKEN')
    expect(missingQualificationWiring({ GITHUB_TOKEN: 'secret' })).not.toContain('GITHUB_TOKEN')
  })

  test('rejects malformed or source-mismatched preregistration bytes before any evaluation', async () => {
    const malformed = await sourceFixture(true)
    try {
      const failure = await Effect.runPromise(Effect.flip(verifyQualificationCandidateSource(malformed.input)))
      expect(failure).toBeInstanceOf(QualificationCollectorError)
      expect(failure).toMatchObject({ code: 'preregistration-document-malformed' })
    } finally {
      await malformed.cleanup()
    }

    const valid = await sourceFixture()
    try {
      const failure = await Effect.runPromise(
        Effect.flip(
          verifyQualificationCandidateSource({
            ...valid.input,
            moduleBytes: Buffer.from('different source\n'),
          }),
        ),
      )
      expect(failure).toMatchObject({ code: 'candidate-source-mismatch' })
    } finally {
      await valid.cleanup()
    }
  })

  test('rejects a candidate module blob reachable from preregistration parent ancestry', async () => {
    const reused = await sourceFixture(false, true)
    try {
      const failure = await Effect.runPromise(Effect.flip(verifyQualificationCandidateSource(reused.input)))
      expect(failure).toMatchObject({ code: 'candidate-module-not-novel' })
    } finally {
      await reused.cleanup()
    }
  })

  test('accepts registration bookkeeping descendants but rejects executable helper drift', async () => {
    const valid = await sourceFixture()
    try {
      const sourceBeforeApproval = await gitText(valid.repositoryPath, ['rev-parse', 'HEAD'])
      await writeFile(join(valid.repositoryPath, valid.input.preregistration.preregistration.path), '{}')
      await gitText(valid.repositoryPath, ['add', valid.input.preregistration.preregistration.path])
      await gitText(valid.repositoryPath, ['commit', '-m', 'record development approval'])
      const descendant = await gitText(valid.repositoryPath, ['rev-parse', 'HEAD'])
      const accepted = await Effect.runPromise(
        verifyQualificationCandidateSource({
          ...valid.input,
          sourceRevision: descendant,
          preregistrationBytes: valid.input.preregistrationBytes,
          allowedDescendantPaths: valid.input.allowedDescendantPaths,
        }),
      )
      expect(accepted.reviewedSourceRevision).toBe(valid.input.preregistration.preregistration.sourceRevision)
      expect(descendant).not.toBe(sourceBeforeApproval)

      await writeFile(
        join(valid.repositoryPath, valid.ledgerPath),
        'const historicalLedger = [\n  { value: 1 },\n  { value: 2 },\n] as const\n\n/** One append-only source-controlled ledger. */\nexport const registration = null\n',
      )
      await gitText(valid.repositoryPath, ['add', valid.ledgerPath])
      await gitText(valid.repositoryPath, ['commit', '-m', 'append terminal ledger evidence'])
      const ledgerDescendant = await gitText(valid.repositoryPath, ['rev-parse', 'HEAD'])
      const acceptedLedger = await Effect.runPromise(
        verifyQualificationCandidateSource({
          ...valid.input,
          sourceRevision: ledgerDescendant,
          allowedDescendantPaths: valid.input.allowedDescendantPaths,
        }),
      )
      expect(acceptedLedger.reviewedSourceRevision).toBe(valid.input.preregistration.preregistration.sourceRevision)

      await writeFile(
        join(valid.repositoryPath, valid.ledgerPath),
        'const historicalLedger = [\n  { value: 1 },\n  { value: 2 },\n] as const\n\n/** One append-only source-controlled ledger. */\nexport const registration = true\n',
      )
      await gitText(valid.repositoryPath, ['add', valid.ledgerPath])
      await gitText(valid.repositoryPath, ['commit', '-m', 'change ledger executable'])
      const unsafeLedgerDescendant = await gitText(valid.repositoryPath, ['rev-parse', 'HEAD'])
      const ledgerFailure = await Effect.runPromise(
        Effect.flip(
          verifyQualificationCandidateSource({
            ...valid.input,
            sourceRevision: unsafeLedgerDescendant,
            allowedDescendantPaths: valid.input.allowedDescendantPaths,
          }),
        ),
      )
      expect(ledgerFailure).toMatchObject({ code: 'candidate-source-descendant-invalid' })

      await writeFile(
        join(valid.repositoryPath, 'services/bayn/src/strategy/helper.ts'),
        'export const changed = true\n',
      )
      await gitText(valid.repositoryPath, ['add', 'services/bayn/src/strategy/helper.ts'])
      await gitText(valid.repositoryPath, ['commit', '-m', 'change executable helper'])
      const unsafeDescendant = await gitText(valid.repositoryPath, ['rev-parse', 'HEAD'])
      const failure = await Effect.runPromise(
        Effect.flip(
          verifyQualificationCandidateSource({
            ...valid.input,
            sourceRevision: unsafeDescendant,
            preregistrationBytes: valid.input.preregistrationBytes,
          }),
        ),
      )
      expect(failure).toMatchObject({ code: 'candidate-source-descendant-invalid' })
    } finally {
      await valid.cleanup()
    }
  })

  test('preserves exactly-once workflow ordering and rejects pre-existing attempts', async () => {
    const calls: string[] = []
    const input = prelock()
    const binding = candidate(input)
    const terminal = execution(binding)
    const result = await Effect.runPromise(
      runQualificationCollector({
        collectPrelock: Effect.sync(() => {
          calls.push('collect')
          return input
        }),
        verifyCandidate: () =>
          Effect.sync(() => {
            calls.push('candidate')
            return binding
          }),
        executeQualification: () =>
          Effect.sync(() => {
            calls.push('execute')
            return terminal
          }),
        auditQualification: () =>
          Effect.sync(() => {
            calls.push('audit')
            return audit(terminal)
          }),
      }),
    )
    expect(calls).toEqual(['collect', 'candidate', 'execute', 'audit'])
    expect(result.terminal).toEqual(terminal)

    const replay = await Effect.runPromise(
      Effect.flip(qualificationAttemptState(Option.some({ state: 'OPENED_INCOMPLETE' as const, lock: fixtureLock }))),
    )
    expect(replay).toMatchObject({ code: 'qualification-opened-incomplete' })
  })

  test('fails closed when candidate binding is substituted after prelock', async () => {
    const input = prelock()
    const result = await Effect.runPromiseExit(
      runQualificationCollector({
        collectPrelock: Effect.succeed(input),
        verifyCandidate: () => Effect.succeed(candidate({ ...input, moduleSha256: '0'.repeat(64) })),
        executeQualification: () => Effect.succeed(execution()),
        auditQualification: () => Effect.succeed(audit()),
      }),
    )
    expect(result._tag).toBe('Failure')
  })

  test('keeps workflow exclusion deterministic', () => {
    expect(
      blockingQualificationWorkflowRunIds(20, [
        { id: 19, status: 'queued' },
        { id: 20, status: 'in_progress' },
        { id: 18, status: 'in_progress' },
      ]),
    ).toEqual(['18', '19'])
  })
})
