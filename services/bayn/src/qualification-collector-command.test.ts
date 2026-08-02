import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Effect, Option } from 'effect'

import type { QualificationAuditReport } from './audit/audit'
import type { QualificationDossier } from './audit/dossier'
import {
  completeQualificationAuditCommand,
  QualificationAuditCommandError,
  renderQualificationAuditCommandOutput,
  requireQualificationAuditReport,
} from './qualification-audit-command'
import {
  blockingQualificationWorkflowRunIds,
  executeQualificationAttempt,
  freezeQualificationPrelockDependencies,
  isQualificationSourceAffectingPath,
  loadQualificationCollectorInvocation,
  missingQualificationWiring,
  parseQualificationImageReference,
  qualificationAttemptState,
  QualificationCollectorError,
  runQualificationCollector,
  verifyQualificationCandidateImmutableSource,
  type QualificationCollectorExecutionReceipt,
  type QualificationCollectorPrelockEvidence,
} from './qualification-collector-command'
import type { CandidateDevelopmentNextPreregistration } from './candidate-development-calendar'
import type { QualificationCandidateBindingReceipt } from './qualification-candidate-command'
import {
  config,
  fixtureEvaluation,
  fixtureQualification,
  fixtureLock,
  fixtureSnapshot,
  fixtureStrategy,
  marketDataService,
  provenance,
  readyState,
  successfulEvidenceStore,
  successfulJournal,
} from './app-test-support'
import type { LoadedRuntimeConfig } from './config'
import { BrokerAccess, noCapitalAuthority } from './execution/authority'
import { canonicalHashV1 } from './hash'
import { fixtureProtocol } from './test-fixtures'

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
  candidateOrdinal: 17,
  priorTrialCount: 16,
  preregistrationHash: 'e'.repeat(64),
  moduleBlobOid: '7'.repeat(40),
  candidateDefinitionHash: '8'.repeat(64),
  compiledBoundedContentHash: '3'.repeat(64),
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
  imageRepository: input.imageRepository,
  imageDigest: input.imageDigest,
  snapshotId: 'f'.repeat(64),
  inputManifestHash: '1'.repeat(64),
  finalizedSnapshotContentHash: '2'.repeat(64),
  committedBoundedContentHash: input.compiledBoundedContentHash,
  compiledBoundedContentHash: input.compiledBoundedContentHash,
  candidateRunId: '4'.repeat(64),
  lockId: '5'.repeat(64),
  bindingHash: '6'.repeat(64),
  lock: fixtureLock,
})

const execution = (binding = candidate()): QualificationCollectorExecutionReceipt => ({
  schemaVersion: 'bayn.qualification-execution.v1',
  runId: binding.candidateRunId,
  lockId: binding.lockId,
  resultHash: '7'.repeat(64),
  verdict: 'REJECTED',
  persistence: { artifactCount: 17, eventCount: 230, gateCount: 7 },
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

const loadedConfig: LoadedRuntimeConfig = {
  ...config,
  runtimeMode: 'BrokerlessService',
  cyclePollIntervalMs: 30_000,
  alpaca: undefined,
  execution: {
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
}

const plan = {
  _tag: 'BrokerlessService' as const,
  config: loadedConfig,
  protocol: fixtureProtocol,
  parameterHash: provenance.strategy.parameterHash,
  strategy: fixtureStrategy,
  strategyProtocolHash: fixtureLock.protocolHash,
}

const collectorCommandPath = new URL('./qualification-collector-command.ts', import.meta.url).pathname
const typedConfigurationSecret = 'typed-configuration-secret-marker'

const runCollectorEntrypoint = async (environment: Record<string, string>) => {
  const child = Bun.spawn({
    cmd: [process.execPath, collectorCommandPath],
    cwd: import.meta.dir,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

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

const immutableSourceFixture = async (
  options: { readonly malformed?: boolean; readonly preexisting?: boolean } = {},
) => {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'bayn-qualification-source-'))
  const modulePath = 'services/bayn/src/strategy/candidate-17.mjs'
  const preregistrationPath = 'services/bayn/candidates/candidate-17-preregistration.json'
  const compiledBoundedContentHash = 'a'.repeat(64)
  const strategyProtocol = {
    schemaVersion: 'bayn.candidate-development-strategy-protocol.v2',
    marketData: {
      schemaVersion: 'bayn.candidate-development-market-data-contract.v1',
      snapshotId: 'b'.repeat(64),
      contentHash: compiledBoundedContentHash,
    },
  }
  const strategyProtocolHash = canonicalHashV1(strategyProtocol)
  const moduleSource = `
    export const candidateDevelopmentArtifact = {
      schemaVersion: 'bayn.candidate-development-artifact.v1',
      input: {
        candidateOrdinal: 17,
        priorTrialCount: 16,
        expectedStrategyProtocolHash: '${strategyProtocolHash}',
        officialSessions: [],
        signalSessionDates: [],
        featureLookbackSessions: 252,
      },
      strategyProtocol: ${JSON.stringify(strategyProtocol)},
      buildEvaluation: function () { throw new Error('qualification source verification must not evaluate holdout data') },
    }
  `
  const moduleBytes = Buffer.from(moduleSource)
  const moduleSha256 = createHash('sha256').update(moduleBytes).digest('hex')
  const marketData = {
    schemaVersion: 'bayn.candidate-development-market-data-source.v1' as const,
    snapshotId: strategyProtocol.marketData.snapshotId,
    finalizedSnapshotContentHash: 'c'.repeat(64),
    inputManifestHash: 'd'.repeat(64),
    boundedContentHash: compiledBoundedContentHash,
  }
  const document = {
    schemaVersion: 'bayn.candidate-development-next-preregistration.v1' as const,
    candidateOrdinal: 17,
    priorTrialCount: 16,
    strategyProtocolHash,
    modulePath,
    moduleSha256,
    marketData,
  }
  const preregistrationBytes = Buffer.from(options.malformed === true ? '{' : `${JSON.stringify(document)}\n`)

  await gitText(repositoryPath, ['init', '-b', 'main'])
  await gitText(repositoryPath, ['config', 'user.email', 'qualification-test@example.invalid'])
  await gitText(repositoryPath, ['config', 'user.name', 'Qualification Test'])
  await mkdir(join(repositoryPath, dirname(preregistrationPath)), { recursive: true })
  await writeFile(join(repositoryPath, preregistrationPath), preregistrationBytes)
  if (options.preexisting === true) {
    const preexistingPath = join(repositoryPath, 'history', 'preexisting-candidate.mjs')
    await mkdir(dirname(preexistingPath), { recursive: true })
    await writeFile(preexistingPath, moduleBytes)
  }
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
  const preregistration: CandidateDevelopmentNextPreregistration = {
    ...document,
    preregistration: {
      sourceRevision: preregistrationRevision,
      path: preregistrationPath,
      blobOid: preregistrationBlobOid,
    },
  }
  return {
    repositoryPath,
    compiledBoundedContentHash,
    input: {
      repositoryPath,
      sourceRevision,
      preregistration,
      preregistrationBytes,
      moduleBlobOid,
      moduleBytes,
    },
    cleanup: () => rm(repositoryPath, { recursive: true, force: true }),
  }
}

describe('qualification collector orchestration', () => {
  test.each([
    ['GITHUB_EVENT_NAME', { GITHUB_SHA: 'a'.repeat(40) }, 'GITHUB_EVENT_NAME is required'],
    ['GITHUB_SHA', { GITHUB_EVENT_NAME: 'schedule' }, 'GITHUB_SHA is required'],
  ] as const)(
    'returns missing %s as a typed failure and lets NodeRuntime own nonzero termination',
    async (_name, overrides, message) => {
      const environment = {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        BAYN_POSTGRES_URL: `postgresql://${typedConfigurationSecret}@invalid/bayn`,
        ...overrides,
      }
      const failure = await Effect.runPromise(Effect.flip(loadQualificationCollectorInvocation(environment)))
      const result = await runCollectorEntrypoint(environment)
      const output = `${result.stdout}\n${result.stderr}`

      expect(failure).toBeInstanceOf(QualificationCollectorError)
      expect(failure).toMatchObject({
        phase: 'configuration',
        code: 'environment-missing',
        message,
      })
      expect(result.exitCode).toBe(1)
      expect(output).toContain(`qualification collector failed [configuration/environment-missing]: ${message}`)
      expect(output).toContain(`QualificationCollectorError: ${message}`)
      expect(output).not.toContain('BAYN_QUALIFICATION_TERMINAL=')
      expect(output).not.toContain(typedConfigurationSecret)
    },
  )

  test('accepts a reviewed preregistration document and a module blob created only after preregistration', async () => {
    const fixture = await immutableSourceFixture()
    try {
      const receipt = await Effect.runPromise(verifyQualificationCandidateImmutableSource(fixture.input))

      expect(receipt).toMatchObject({
        schemaVersion: 'bayn.qualification-candidate-source.v1',
        moduleBlobOid: fixture.input.moduleBlobOid,
        compiledBoundedContentHash: fixture.compiledBoundedContentHash,
      })
      expect(receipt.definitionHash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await fixture.cleanup()
    }
  })

  test('rejects a malformed reviewed preregistration document before module or privileged access', async () => {
    const fixture = await immutableSourceFixture({ malformed: true })
    try {
      const failure = await Effect.runPromise(Effect.flip(verifyQualificationCandidateImmutableSource(fixture.input)))

      expect(failure).toBeInstanceOf(QualificationCollectorError)
      expect(failure).toMatchObject({
        phase: 'candidate',
        code: 'preregistration-document-malformed',
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test('rejects reviewed preregistration bytes whose module or data binding differs from the compiled calendar entry', async () => {
    const fixture = await immutableSourceFixture()
    try {
      const mismatched = {
        ...fixture.input,
        preregistration: {
          ...fixture.input.preregistration,
          marketData: {
            ...fixture.input.preregistration.marketData,
            boundedContentHash: 'f'.repeat(64),
          },
        },
      }
      const failure = await Effect.runPromise(Effect.flip(verifyQualificationCandidateImmutableSource(mismatched)))

      expect(failure).toBeInstanceOf(QualificationCollectorError)
      expect(failure).toMatchObject({
        phase: 'candidate',
        code: 'preregistration-document-invalid',
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test('rejects a candidate module blob that was already reachable at preregistration', async () => {
    const fixture = await immutableSourceFixture({ preexisting: true })
    try {
      const failure = await Effect.runPromise(Effect.flip(verifyQualificationCandidateImmutableSource(fixture.input)))

      expect(failure).toBeInstanceOf(QualificationCollectorError)
      expect(failure).toMatchObject({
        phase: 'candidate',
        code: 'candidate-module-not-novel',
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test('standalone dossier mode renders the deliberate dossier output without report-only rejection', async () => {
    const dossier = {
      schemaVersion: 'bayn.qualification-dossier.v2',
      dossierHash: 'a'.repeat(64),
    } as unknown as QualificationDossier

    const output = await Effect.runPromise(renderQualificationAuditCommandOutput(dossier))

    expect(output.endsWith('\n')).toBe(true)
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 'bayn.qualification-dossier.v2',
      dossierHash: 'a'.repeat(64),
    })
  })

  test('collector report-only boundary rejects a dossier before terminal evidence can be emitted', async () => {
    const dossier = {
      schemaVersion: 'bayn.qualification-dossier.v2',
      dossierHash: 'b'.repeat(64),
    } as unknown as QualificationDossier

    const failure = await Effect.runPromise(Effect.flip(requireQualificationAuditReport(dossier)))

    expect(failure).toBeInstanceOf(QualificationAuditCommandError)
    expect(failure.message).toBe('qualification audit command produced a dossier')
  })

  test('standalone failed audits render their JSON evidence before nonzero completion', async () => {
    const failed = { ...audit(), status: 'FAIL' as const }

    const output = await Effect.runPromise(renderQualificationAuditCommandOutput(failed))
    const failure = await Effect.runPromise(Effect.flip(completeQualificationAuditCommand({ output: 'audit' }, failed)))

    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: 'bayn.qualification-audit.v2',
      status: 'FAIL',
      runId: failed.runId,
      auditHash: failed.auditHash,
    })
    expect(failure.message).toBe('qualification audit failed')
  })

  test('distinguishes fresh, terminal-recoverable, and incomplete durable attempt states', async () => {
    expect(await Effect.runPromise(qualificationAttemptState(Option.none()))).toBe('FRESH')
    expect(
      await Effect.runPromise(
        qualificationAttemptState(Option.some({ state: 'TERMINAL', lock: fixtureLock, result: fixtureQualification })),
      ),
    ).toBe('RECOVER_TERMINAL')
    const failure = await Effect.runPromise(
      Effect.flip(qualificationAttemptState(Option.some({ state: 'OPENED_INCOMPLETE', lock: fixtureLock }))),
    )
    expect(failure.code).toBe('qualification-opened-incomplete')
  })

  test('recovers and re-audits a terminal retry without loading holdout bars again', async () => {
    let loadCalls = 0
    const inspection = await Effect.runPromise(marketDataService(Effect.succeed(fixtureSnapshot)).inspect)
    const recovered = readyState().evidence
    if (recovered === null) throw new Error('fixture recovered evidence is missing')
    const terminalStore = {
      ...successfulEvidenceStore,
      readQualification: () =>
        Effect.succeed(Option.some({ state: 'TERMINAL' as const, lock: fixtureLock, result: fixtureQualification })),
      openQualification: () =>
        Effect.succeed({ state: 'TERMINAL' as const, lock: fixtureLock, result: fixtureQualification }),
      recover: () =>
        Effect.succeed(
          Option.some({
            evaluation: recovered.evaluation,
            reconciliation: recovered.reconciliation,
            persistence: recovered.persistence,
          }),
        ),
    }
    const receipt = await Effect.runPromise(
      executeQualificationAttempt(
        {
          plan,
          inspection,
          priorTrialRunIds: [],
          dependencies: {
            marketData: {
              ...marketDataService(
                Effect.sync(() => {
                  loadCalls += 1
                  return fixtureSnapshot
                }),
              ),
              inspect: Effect.succeed(inspection),
            },
            journal: successfulJournal,
            evidenceStore: terminalStore,
          },
        },
        {
          ...candidate(prelock({ priorTrialCount: 0, candidateOrdinal: 1 })),
          candidateOrdinal: 1,
          priorTrialCount: 0,
          candidateRunId: fixtureLock.candidateRunId,
          lockId: fixtureLock.lockId,
          lock: fixtureLock,
        },
      ),
    )

    expect(loadCalls).toBe(0)
    expect(receipt).toMatchObject({
      runId: fixtureEvaluation.runId,
      lockId: fixtureQualification.lockId,
      resultHash: fixtureQualification.resultHash,
      verdict: fixtureQualification.verdict,
    })
  })

  test('collects, verifies, executes, and independently audits exactly once in causal order', async () => {
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
    expect(result).toMatchObject({
      schemaVersion: 'bayn.qualification-collector-terminal.v1',
      sourceSha: input.sourceSha,
      candidateOrdinal: input.candidateOrdinal,
      terminal,
      audit: { status: 'PASS', runId: terminal.runId },
    })
    expect(result.eligibilityHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('rejects an in-flight workflow before candidate verification or qualification execution', async () => {
    const calls: string[] = []
    const failure = await Effect.runPromise(
      Effect.flip(
        runQualificationCollector({
          collectPrelock: Effect.succeed(prelock({ activeAttemptRunIds: ['other-run'] })),
          verifyCandidate: () =>
            Effect.sync(() => {
              calls.push('candidate')
              return candidate()
            }),
          executeQualification: () =>
            Effect.sync(() => {
              calls.push('execute')
              return execution()
            }),
          auditQualification: () => Effect.succeed(audit()),
        }),
      ),
    )

    expect(calls).toEqual([])
    expect(failure).toMatchObject({
      _tag: 'QualificationCollectorError',
      phase: 'eligibility',
      code: 'qualification-attempt-in-flight',
    })
  })

  test.each([
    [
      'candidate binding',
      { candidateOrdinal: 18 } as Partial<QualificationCandidateBindingReceipt>,
      {} as Partial<QualificationCollectorExecutionReceipt>,
      {} as Partial<QualificationAuditReport>,
      'candidate-binding-mismatch',
    ],
    [
      'terminal lock',
      {} as Partial<QualificationCandidateBindingReceipt>,
      { lockId: 'a'.repeat(64) } as Partial<QualificationCollectorExecutionReceipt>,
      {} as Partial<QualificationAuditReport>,
      'terminal-binding-mismatch',
    ],
    [
      'audit result',
      {} as Partial<QualificationCandidateBindingReceipt>,
      {} as Partial<QualificationCollectorExecutionReceipt>,
      { evidence: { ...audit().evidence, resultHash: 'b'.repeat(64) } } as Partial<QualificationAuditReport>,
      'terminal-audit-mismatch',
    ],
  ])('fails closed on changed %s', async (_name, candidatePatch, executionPatch, auditPatch, code) => {
    const input = prelock()
    const binding = { ...candidate(input), ...candidatePatch }
    const terminal = { ...execution(binding), ...executionPatch }
    const report = { ...audit(terminal), ...auditPatch } as QualificationAuditReport
    const failure = await Effect.runPromise(
      Effect.flip(
        runQualificationCollector({
          collectPrelock: Effect.succeed(input),
          verifyCandidate: () => Effect.succeed(binding),
          executeQualification: () => Effect.succeed(terminal),
          auditQualification: () => Effect.succeed(report),
        }),
      ),
    )

    expect(failure).toBeInstanceOf(QualificationCollectorError)
    expect(failure.code).toBe(code)
  })

  test('names the exact separately authorized secret wiring and accepts no implicit aliases', () => {
    expect(missingQualificationWiring({})).toEqual([
      'GITHUB_TOKEN',
      'BAYN_CLICKHOUSE_USERNAME',
      'BAYN_CLICKHOUSE_PASSWORD',
      'BAYN_POSTGRES_URL',
      'BAYN_QUALIFICATION_POSTGRES_CA_PEM',
      'BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME',
      'BAYN_AUDIT_CLICKHOUSE_USERNAME',
      'BAYN_AUDIT_CLICKHOUSE_PASSWORD',
    ])
    const configured = Object.fromEntries(
      missingQualificationWiring({}).map((name) => [name, `${name.toLowerCase()}-configured`]),
    )
    expect(missingQualificationWiring(configured)).toEqual([])
  })

  test('freezes the exact prelock inspection and trial lineage while delegating the post-lock load', async () => {
    let underlyingInspections = 0
    let underlyingLineageReads = 0
    const underlyingMarketData = {
      ...marketDataService(Effect.succeed(fixtureSnapshot)),
      inspect: Effect.sync(() => {
        underlyingInspections += 1
        throw new Error('frozen prelock inspection must be reused')
      }),
    }
    const underlyingEvidenceStore = {
      ...successfulEvidenceStore,
      listPriorTrials: Effect.sync(() => {
        underlyingLineageReads += 1
        throw new Error('frozen trial lineage must be reused')
      }),
    }
    const capturedInspection = await Effect.runPromise(marketDataService(Effect.succeed(fixtureSnapshot)).inspect)
    const frozen = freezeQualificationPrelockDependencies(
      { marketData: underlyingMarketData, journal: successfulJournal, evidenceStore: underlyingEvidenceStore },
      capturedInspection,
      ['a'.repeat(64)],
    )

    expect(await Effect.runPromise(frozen.marketData.inspect)).toBe(capturedInspection)
    expect(await Effect.runPromise(frozen.evidenceStore.listPriorTrials)).toEqual(['a'.repeat(64)])
    expect(await Effect.runPromise(frozen.marketData.load)).toBe(fixtureSnapshot)
    expect(underlyingInspections).toBe(0)
    expect(underlyingLineageReads).toBe(0)
  })

  test('matches the release gate Bayn image-input freshness boundary', () => {
    for (const path of [
      'services/bayn/src/index.ts',
      'nix/images/bayn.nix',
      '.github/workflows/bayn-qualification.yml',
      'packages/scripts/package.json',
      'patches/effect.patch',
    ]) {
      expect(isQualificationSourceAffectingPath(path)).toBe(true)
    }
    for (const path of [
      'argocd/applications/bayn/deployment.yaml',
      'argocd/applications/bayn/kustomization.yaml',
      'argocd/applicationsets/product.yaml',
      'docs/bayn.md',
    ]) {
      expect(isQualificationSourceAffectingPath(path)).toBe(false)
    }
  })

  test('canonicalizes the locally loaded image reference without a registry release binding', () => {
    expect(parseQualificationImageReference('registry.example/lab/bayn:nix@sha256:' + 'a'.repeat(64))).toEqual({
      repository: 'registry.example/lab/bayn',
      digest: 'sha256:' + 'a'.repeat(64),
    })
    expect(parseQualificationImageReference('registry.example/lab/bayn@sha256:' + 'a'.repeat(63))).toBeUndefined()
  })

  test('does not let a later serialized queue starve the currently executing run', () => {
    expect(
      blockingQualificationWorkflowRunIds(200, [
        { id: 200, status: 'in_progress' },
        { id: 201, status: 'queued' },
        { id: 199, status: 'queued' },
        { id: 198, status: 'in_progress' },
      ]),
    ).toEqual(['198', '199'])
  })
})
