import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { parse } from 'yaml'

import {
  buildPaperActivationArtifact,
  canonicalHashV1,
  deriveObserveRollbackGeneration,
  evaluatePaperActivation,
  extractDeploymentAuthorityState,
  extractPaperActivationManifestPins,
  paperAuthorityGenerationHash,
  renderObserveRollback,
  renderPaperActivationTransition,
  type PaperActivationEvidence,
  type PaperActivationReviewedPins,
  type PaperAuthorityGenerationMaterial,
  type QualificationTerminalEvidence,
} from './verify-paper-activation'

const hash = 'a'.repeat(64)
const sourceSha = 'b'.repeat(40)
const now = '2026-07-31T08:00:00Z'
const deploymentPath = new URL('../../../../argocd/applications/bayn/deployment.yaml', import.meta.url)
const kustomizationPath = new URL('../../../../argocd/applications/bayn/kustomization.yaml', import.meta.url)
const generationMaterial = (
  overrides: Partial<PaperAuthorityGenerationMaterial> = {},
): PaperAuthorityGenerationMaterial => ({
  schemaVersion: 'bayn.paper-authority-generation.v2',
  maximum: 'PAPER',
  previousGenerationHash: '0'.repeat(64),
  qualificationRunId: hash,
  qualificationLockId: '1'.repeat(64),
  qualificationResultHash: '2'.repeat(64),
  protocolHash: hash,
  qualificationExecutionPolicyHash: '3'.repeat(64),
  qualificationSourceRevision: sourceSha,
  qualificationImageRepository: 'registry.ide-newton.ts.net/lab/bayn',
  qualificationImageDigest: `sha256:${'c'.repeat(64)}`,
  activationSourceRevision: sourceSha,
  activationImageRepository: 'registry.ide-newton.ts.net/lab/bayn',
  activationImageDigest: `sha256:${'c'.repeat(64)}`,
  strategyName: 'risk-balanced-trend',
  strategyBehaviorHash: hash,
  strategyParameterHash: hash,
  strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
  accountId: 'paper-account-1',
  riskPolicyHash: '4'.repeat(64),
  proofPlanHash: '5'.repeat(64),
  reconciliationId: '6'.repeat(64),
  reconciliationContentHash: '7'.repeat(64),
  ...overrides,
})
const authorityGeneration = (overrides: Partial<PaperAuthorityGenerationMaterial> = {}) => {
  const material = generationMaterial(overrides)
  return { ...material, generationHash: paperAuthorityGenerationHash(material) }
}
const qualificationAuditMaterial = {
  schemaVersion: 'bayn.qualification-audit.v2' as const,
  runId: hash,
  status: 'PASS' as const,
  reference: { economicStatus: 'PASS' as const, observations: 1, rebalanceCount: 0 },
  evidence: { artifactCount: 1, eventCount: 2, gateCount: 3, lockId: '1'.repeat(64), resultHash: '2'.repeat(64) },
  policies: {
    declaredAt: '2026-07-31T06:00:00Z',
    lockId: '1'.repeat(64),
    policySetHash: '3'.repeat(64),
    documents: [
      {
        name: 'execution',
        schemaVersion: 'bayn.policy.v1',
        contentHash: '4'.repeat(64),
        content: { maximum: 'PAPER' },
      },
    ],
  },
  contamination: {
    lockCreatedAt: '2026-07-31T06:00:00Z',
    resultCommittedAt: '2026-07-31T07:00:00Z',
    replicas: ['signal-1'],
    principals: { candidate: 'candidate', publishers: ['publisher'] },
    access: [
      {
        replica: 'signal-1',
        queryId: 'query-1',
        queryStartTime: '2026-07-31T06:30:00Z',
        user: 'candidate',
        kind: 'bars' as const,
      },
    ],
  },
  repository: {
    sourceCommitExists: true,
    sourceCommitAncestorOfMain: true,
    preLockResultReferences: [],
    sourceRevision: sourceSha,
  },
  checks: [{ name: 'terminal-result-binding', passed: true, evidence: 'verdict=QUALIFIED' }],
}
const qualificationAudit = {
  ...qualificationAuditMaterial,
  auditHash: canonicalHashV1(qualificationAuditMaterial),
}
const qualificationTerminalMaterial = {
  schemaVersion: 'bayn.qualification-collector-terminal.v1' as const,
  repository: 'proompteng/lab',
  currentMainSha: sourceSha,
  sourceSha,
  image: { repository: 'registry.ide-newton.ts.net/lab/bayn', digest: `sha256:${'c'.repeat(64)}` },
  candidateOrdinal: 1,
  githubRunId: '77',
  githubRunAttempt: 1,
  preregistrationHash: '8'.repeat(64),
  eligibilityHash: '9'.repeat(64),
  candidateBindingHash: 'a'.repeat(64),
  terminal: {
    schemaVersion: 'bayn.qualification-execution.v1' as const,
    runId: hash,
    lockId: '1'.repeat(64),
    resultHash: '2'.repeat(64),
    verdict: 'QUALIFIED' as const,
    persistence: { artifactCount: 1, eventCount: 2, gateCount: 3 },
  },
  audit: qualificationAudit,
}
const qualificationTerminal: QualificationTerminalEvidence = {
  ...qualificationTerminalMaterial,
  evidenceHash: canonicalHashV1(qualificationTerminalMaterial),
}
const reviewedPins = (): PaperActivationReviewedPins => ({
  schemaVersion: 'bayn.paper-activation-reviewed-pins.v1',
  sourceSha,
  imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
  imageDigest: `sha256:${'c'.repeat(64)}`,
  protocolHash: hash,
  strategyBehaviorHash: hash,
  strategyParameterHash: hash,
  strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
  qualificationExecutionPolicyHash: '3'.repeat(64),
  previousGenerationHash: '0'.repeat(64),
  accountId: 'paper-account-1',
  riskPolicyHash: '4'.repeat(64),
  proofPlanHash: '5'.repeat(64),
  reconciliationId: '6'.repeat(64),
  reconciliationContentHash: '7'.repeat(64),
  qualificationExpiresAt: '2026-08-01T07:00:00Z',
  accountBindingHash: hash,
  brokerEnvironment: 'sandbox',
  brokerBaseUrl: 'https://paper-api.alpaca.markets',
  maximumAuthority: 'PAPER',
  authorityExpiresAt: '2026-07-31T09:00:00Z',
  unresolvedMutationCount: 0,
  unknownMutationCount: 0,
  openOrderCount: 0,
  discrepancyCount: 0,
  reconciliation: 'EXACT',
  killSwitchActive: false,
  identityGap: false,
  activationState: 'PRECOMMITTED',
})
const evidence = (overrides: Partial<PaperActivationEvidence> = {}): PaperActivationEvidence => {
  const base: PaperActivationEvidence = {
    schemaVersion: 2,
    repository: 'proompteng/lab',
    mainSha: sourceSha,
    currentMainSha: sourceSha,
    sourceSha,
    imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
    imageDigest: `sha256:${'c'.repeat(64)}`,
    protocolHash: hash,
    strategyBehaviorHash: hash,
    strategyParameterHash: hash,
    qualificationRunId: hash,
    qualificationDecision: 'QUALIFIED',
    qualificationObservedAt: '2026-07-31T07:00:00Z',
    qualificationExpiresAt: '2026-08-01T07:00:00Z',
    accountBindingHash: hash,
    brokerEnvironment: 'sandbox',
    brokerBaseUrl: 'https://paper-api.alpaca.markets',
    maximumAuthority: 'PAPER',
    authorityGeneration: authorityGeneration(),
    authorityExpiresAt: '2026-07-31T09:00:00Z',
    unresolvedMutationCount: 0,
    unknownMutationCount: 0,
    openOrderCount: 0,
    discrepancyCount: 0,
    reconciliation: 'EXACT',
    killSwitchActive: false,
    identityGap: false,
    activationState: 'PRECOMMITTED',
    activationId: 'qualification-77-1',
    qualificationTerminal,
  }
  const value = { ...base, ...overrides }
  const auditMaterial = {
    ...qualificationAuditMaterial,
    runId: value.qualificationRunId,
    evidence: { ...qualificationAuditMaterial.evidence, lockId: value.qualificationTerminal.terminal.lockId },
    policies: { ...qualificationAuditMaterial.policies, lockId: value.qualificationTerminal.terminal.lockId },
    repository: { ...qualificationAuditMaterial.repository, sourceRevision: value.sourceSha },
  }
  const audit = { ...auditMaterial, auditHash: canonicalHashV1(auditMaterial) }
  const terminalMaterial = {
    ...qualificationTerminalMaterial,
    currentMainSha: value.mainSha,
    sourceSha: value.sourceSha,
    image: { repository: value.imageRepository, digest: value.imageDigest },
    terminal: {
      ...qualificationTerminalMaterial.terminal,
      runId: value.qualificationRunId,
      verdict: value.qualificationDecision,
    },
    audit,
  }
  return {
    ...value,
    qualificationTerminal: { ...terminalMaterial, evidenceHash: canonicalHashV1(terminalMaterial) },
  }
}
const manifestPins = (value: PaperActivationEvidence) => ({
  sourceSha: value.sourceSha,
  strategyBehaviorHash: value.strategyBehaviorHash,
  strategyParameterHash: value.strategyParameterHash,
  qualificationRunId: value.qualificationRunId,
  deploymentImageRepository: value.imageRepository,
  deploymentImageDigest: value.imageDigest,
  kustomizeImageRepository: value.imageRepository,
  kustomizeImageDigest: value.imageDigest,
  kustomizeImageTag: `sha-${value.sourceSha}`,
  currentAuthorityGenerationHash: value.authorityGeneration.previousGenerationHash,
})
const evaluate = (value = evidence()) =>
  evaluatePaperActivation({
    evidence: value,
    pins: {
      sourceSha: value.sourceSha,
      imageRepository: value.imageRepository,
      imageDigest: value.imageDigest,
      protocolHash: value.protocolHash,
      strategyBehaviorHash: value.strategyBehaviorHash,
      strategyParameterHash: value.strategyParameterHash,
      qualificationRunId: value.qualificationRunId,
      accountBindingHash: value.accountBindingHash,
    },
    manifestPins: manifestPins(value),
    now,
    expectedRepository: 'proompteng/lab',
    expectedActivationId: 'qualification-77-1',
    trustedCurrentMainSha: sourceSha,
  })

describe('Bayn PAPER activation verifier', () => {
  test('builds one authenticated activation artifact from a qualified terminal and reviewed pins', () => {
    const artifact = buildPaperActivationArtifact({ terminal: qualificationTerminal, reviewedPins: reviewedPins() })
    expect(artifact).not.toBeNull()
    if (artifact === null) return
    expect(artifact.evidence.qualificationDecision).toBe('QUALIFIED')
    expect(artifact.evidence.qualificationTerminal).toEqual(qualificationTerminal)
    expect(artifact.evidence.activationId).toBe('qualification-77-1')
    expect(
      evaluatePaperActivation({
        evidence: artifact.evidence,
        pins: artifact.pins,
        manifestPins: manifestPins(artifact.evidence),
        now,
        expectedRepository: artifact.evidence.repository,
        expectedActivationId: artifact.evidence.activationId,
        trustedCurrentMainSha: sourceSha,
      }),
    ).toMatchObject({ status: 'eligible' })
  })

  test('does not build an activation artifact for a rejected terminal verdict', () => {
    const rejectedMaterial = {
      ...qualificationTerminalMaterial,
      terminal: { ...qualificationTerminalMaterial.terminal, verdict: 'REJECTED' as const },
    }
    const rejected: QualificationTerminalEvidence = {
      ...rejectedMaterial,
      evidenceHash: canonicalHashV1(rejectedMaterial),
    }
    expect(buildPaperActivationArtifact({ terminal: rejected, reviewedPins: reviewedPins() })).toBeNull()
  })

  test('CLI materializes exactly evidence.json and pins.json for a qualified terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'bayn-paper-evidence-cli-'))
    const terminalPath = join(root, 'terminal.json')
    const reviewedPinsPath = join(root, 'reviewed-pins.json')
    const outputDirectory = join(root, 'artifact')
    const githubOutput = join(root, 'github-output')
    writeFileSync(terminalPath, `${JSON.stringify(qualificationTerminal)}\n`)
    writeFileSync(reviewedPinsPath, `${JSON.stringify(reviewedPins())}\n`)
    try {
      execFileSync(
        process.execPath,
        [
          join(process.cwd(), 'packages/scripts/src/bayn/verify-paper-activation.ts'),
          '--mode',
          'build-evidence',
          '--terminal',
          terminalPath,
          '--reviewed-pins',
          reviewedPinsPath,
          '--output-dir',
          outputDirectory,
          '--github-output',
          githubOutput,
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      )
      expect(JSON.parse(readFileSync(join(outputDirectory, 'evidence.json'), 'utf8'))).toMatchObject({
        schemaVersion: 2,
        qualificationDecision: 'QUALIFIED',
      })
      expect(JSON.parse(readFileSync(join(outputDirectory, 'pins.json'), 'utf8'))).toEqual(
        buildPaperActivationArtifact({ terminal: qualificationTerminal, reviewedPins: reviewedPins() })?.pins,
      )
      expect(readFileSync(githubOutput, 'utf8')).toBe('emit=true\n')
      expect(readdirSync(outputDirectory).sort()).toEqual(['evidence.json', 'pins.json'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a terminal artifact whose authenticated evidence hash was changed', () => {
    expect(() =>
      buildPaperActivationArtifact({
        terminal: { ...qualificationTerminal, sourceSha: 'd'.repeat(40) },
        reviewedPins: reviewedPins(),
      }),
    ).toThrow('invalid or unauthenticated')
  })

  test('accepts one exact current-main precommitted sandbox PAPER tuple', () =>
    expect(evaluate()).toMatchObject({ status: 'eligible' }))
  const holds: Array<[string, Partial<PaperActivationEvidence>, string]> = [
    ['rejected', { qualificationDecision: 'REJECTED' }, 'qualification-not-qualified'],
    ['stale', { qualificationExpiresAt: now }, 'qualification-stale'],
    ['noncurrent', { currentMainSha: 'd'.repeat(40) }, 'noncurrent-main'],
    ['duplicate', { activationState: 'CONSUMED' }, 'activation-not-precommitted'],
    ['in-flight', { activationState: 'IN_FLIGHT' }, 'activation-not-precommitted'],
    ['mutation', { unresolvedMutationCount: 1 }, 'unsafe-runtime-state'],
    ['unknown mutation', { unknownMutationCount: 1 }, 'unsafe-runtime-state'],
    ['open order', { openOrderCount: 1 }, 'unsafe-runtime-state'],
    ['discrepancy', { discrepancyCount: 1 }, 'unsafe-runtime-state'],
    ['non-exact', { reconciliation: 'NON_EXACT' }, 'reconciliation-not-exact'],
    ['kill', { killSwitchActive: true }, 'kill-switch-active'],
    ['identity gap', { identityGap: true }, 'identity-gap'],
    ['expired authority', { authorityExpiresAt: now }, 'authority-expired'],
    [
      'authority beyond qualification',
      { qualificationExpiresAt: '2026-07-31T08:30:00Z', authorityExpiresAt: '2026-07-31T08:45:00Z' },
      'authority-outlives-qualification',
    ],
    ['unbounded authority', { authorityExpiresAt: '2026-07-31T10:00:01Z' }, 'authority-window-too-long'],
    ['live endpoint', { brokerBaseUrl: 'https://api.alpaca.markets' }, 'live-money-endpoint'],
    ['live environment', { brokerEnvironment: 'live' }, 'not-paper-only'],
    ['live authority', { maximumAuthority: 'LIVE' }, 'not-paper-only'],
  ]
  test.each(holds)('rejects %s', (_name, override, code) =>
    expect(evaluate(evidence(override))).toMatchObject({ status: 'hold', code }),
  )
  test('rejects changed pins', () => {
    const value = evidence()
    expect(
      evaluatePaperActivation({
        evidence: value,
        pins: {
          sourceSha: 'e'.repeat(40),
          imageRepository: value.imageRepository,
          imageDigest: value.imageDigest,
          protocolHash: value.protocolHash,
          strategyBehaviorHash: value.strategyBehaviorHash,
          strategyParameterHash: value.strategyParameterHash,
          qualificationRunId: value.qualificationRunId,
          accountBindingHash: value.accountBindingHash,
        },
        manifestPins: manifestPins(value),
        now,
        expectedRepository: 'proompteng/lab',
        expectedActivationId: value.activationId,
        trustedCurrentMainSha: sourceSha,
      }),
    ).toMatchObject({ status: 'hold', code: 'pin-mismatch' })
  })
  test('rejects an unbound authority generation', () =>
    expect(
      evaluate(
        evidence({
          authorityGeneration: { ...authorityGeneration(), generationHash: hash },
        }),
      ),
    ).toMatchObject({
      status: 'hold',
      code: 'authority-generation-mismatch',
    }))
  test('uses Bayn canonical v2 generation identity and ignores reconciliation-only drift', () => {
    const golden: PaperAuthorityGenerationMaterial = {
      schemaVersion: 'bayn.paper-authority-generation.v2',
      maximum: 'PAPER',
      previousGenerationHash: '0'.repeat(64),
      qualificationRunId: '1'.repeat(64),
      qualificationLockId: '2'.repeat(64),
      qualificationResultHash: '3'.repeat(64),
      protocolHash: '4'.repeat(64),
      qualificationExecutionPolicyHash: '5'.repeat(64),
      qualificationSourceRevision: '6'.repeat(40),
      qualificationImageRepository: 'registry.ide-newton.ts.net/lab/bayn',
      qualificationImageDigest: `sha256:${'7'.repeat(64)}`,
      activationSourceRevision: '8'.repeat(40),
      activationImageRepository: 'registry.ide-newton.ts.net/lab/bayn',
      activationImageDigest: `sha256:${'9'.repeat(64)}`,
      strategyName: 'risk-balanced-trend',
      strategyBehaviorHash: 'a'.repeat(64),
      strategyParameterHash: 'b'.repeat(64),
      strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
      accountId: 'paper-account-1',
      riskPolicyHash: 'c'.repeat(64),
      proofPlanHash: 'd'.repeat(64),
      reconciliationId: 'e'.repeat(64),
      reconciliationContentHash: 'f'.repeat(64),
    }
    expect(paperAuthorityGenerationHash(golden)).toBe(
      '2ca5928d4b5330c61686cf691891529a8dbe71c49a3f92b8857c1ef3965ecb56',
    )
    expect(
      paperAuthorityGenerationHash({
        ...golden,
        reconciliationId: '0'.repeat(64),
        reconciliationContentHash: '1'.repeat(64),
      }),
    ).toBe(paperAuthorityGenerationHash(golden))
    expect(paperAuthorityGenerationHash({ ...golden, proofPlanHash: '0'.repeat(64) })).not.toBe(
      paperAuthorityGenerationHash(golden),
    )
  })
  test('rejects canonical generation drift from the reviewed runtime and prior OBSERVE generation', () => {
    const value = evidence()
    const changedPrevious = authorityGeneration({ previousGenerationHash: '8'.repeat(64) })
    expect(
      evaluatePaperActivation({
        evidence: { ...value, authorityGeneration: changedPrevious },
        pins: {
          sourceSha: value.sourceSha,
          imageRepository: value.imageRepository,
          imageDigest: value.imageDigest,
          protocolHash: value.protocolHash,
          strategyBehaviorHash: value.strategyBehaviorHash,
          strategyParameterHash: value.strategyParameterHash,
          qualificationRunId: value.qualificationRunId,
          accountBindingHash: value.accountBindingHash,
        },
        manifestPins: manifestPins(value),
        now,
        expectedRepository: value.repository,
        expectedActivationId: value.activationId,
        trustedCurrentMainSha: sourceSha,
      }),
    ).toMatchObject({ status: 'hold', code: 'authority-generation-binding-mismatch' })
    const changedActivation = authorityGeneration({ activationSourceRevision: '9'.repeat(40) })
    expect(evaluate({ ...value, authorityGeneration: changedActivation })).toMatchObject({
      status: 'hold',
      code: 'authority-generation-binding-mismatch',
    })
  })
  test('rejects incomplete reviewed pins', () => {
    const value = evidence()
    expect(
      evaluatePaperActivation({
        evidence: value,
        pins: {},
        manifestPins: {},
        now,
        expectedRepository: value.repository,
        expectedActivationId: value.activationId,
        trustedCurrentMainSha: sourceSha,
      }),
    ).toMatchObject({ status: 'hold', code: 'invalid-pins' })
  })
  test.each(['killSwitchActive', 'identityGap'] as const)('rejects omitted %s evidence', (field) => {
    const complete = evidence()
    const incomplete = { ...complete } as Record<string, unknown>
    delete incomplete[field]
    expect(
      evaluatePaperActivation({
        evidence: incomplete,
        pins: {
          sourceSha: complete.sourceSha,
          imageRepository: complete.imageRepository,
          imageDigest: complete.imageDigest,
          protocolHash: complete.protocolHash,
          strategyBehaviorHash: complete.strategyBehaviorHash,
          strategyParameterHash: complete.strategyParameterHash,
          qualificationRunId: complete.qualificationRunId,
          accountBindingHash: complete.accountBindingHash,
        },
        manifestPins: manifestPins(complete),
        now,
        expectedRepository: complete.repository,
        expectedActivationId: complete.activationId,
        trustedCurrentMainSha: sourceSha,
      }),
    ).toMatchObject({ status: 'hold', code: 'invalid-evidence' })
  })
  test.each(['killSwitchActive', 'identityGap'] as const)('rejects non-boolean %s evidence', (field) => {
    const complete = evidence()
    const malformed = { ...complete, [field]: 0 }
    expect(
      evaluatePaperActivation({
        evidence: malformed,
        pins: {
          sourceSha: complete.sourceSha,
          imageRepository: complete.imageRepository,
          imageDigest: complete.imageDigest,
          protocolHash: complete.protocolHash,
          strategyBehaviorHash: complete.strategyBehaviorHash,
          strategyParameterHash: complete.strategyParameterHash,
          qualificationRunId: complete.qualificationRunId,
          accountBindingHash: complete.accountBindingHash,
        },
        manifestPins: manifestPins(complete),
        now,
        expectedRepository: complete.repository,
        expectedActivationId: complete.activationId,
        trustedCurrentMainSha: sourceSha,
      }),
    ).toMatchObject({ status: 'hold', code: 'invalid-evidence' })
  })
  test('rejects a self-asserted stale main and deployment drift', () => {
    const value = evidence()
    expect(
      evaluatePaperActivation({
        evidence: value,
        pins: {
          sourceSha: value.sourceSha,
          imageRepository: value.imageRepository,
          imageDigest: value.imageDigest,
          protocolHash: value.protocolHash,
          strategyBehaviorHash: value.strategyBehaviorHash,
          strategyParameterHash: value.strategyParameterHash,
          qualificationRunId: value.qualificationRunId,
          accountBindingHash: value.accountBindingHash,
        },
        manifestPins: { ...manifestPins(value), kustomizeImageDigest: `sha256:${'d'.repeat(64)}` },
        now,
        expectedRepository: value.repository,
        expectedActivationId: value.activationId,
        trustedCurrentMainSha: 'e'.repeat(40),
      }),
    ).toMatchObject({ status: 'hold', code: 'noncurrent-main' })
    expect(
      evaluatePaperActivation({
        evidence: value,
        pins: {
          sourceSha: value.sourceSha,
          imageRepository: value.imageRepository,
          imageDigest: value.imageDigest,
          protocolHash: value.protocolHash,
          strategyBehaviorHash: value.strategyBehaviorHash,
          strategyParameterHash: value.strategyParameterHash,
          qualificationRunId: value.qualificationRunId,
          accountBindingHash: value.accountBindingHash,
        },
        manifestPins: { ...manifestPins(value), kustomizeImageDigest: `sha256:${'d'.repeat(64)}` },
        now,
        expectedRepository: value.repository,
        expectedActivationId: value.activationId,
        trustedCurrentMainSha: sourceSha,
      }),
    ).toMatchObject({ status: 'hold', code: 'manifest-pin-mismatch' })
  })

  test('binds evidence to the effective Kustomize image', () => {
    const deployment = readFileSync(deploymentPath, 'utf8')
    const kustomization = readFileSync(kustomizationPath, 'utf8')
    const extracted = extractPaperActivationManifestPins(deployment, kustomization)
    expect(extracted.deploymentImageRepository).toBe(extracted.kustomizeImageRepository)
    expect(extracted.deploymentImageDigest).toBe(extracted.kustomizeImageDigest)
    expect(extracted.kustomizeImageTag).toBe(`sha-${extracted.sourceSha}`)

    const value = evidence({
      sourceSha: extracted.sourceSha,
      imageRepository: extracted.kustomizeImageRepository,
      imageDigest: extracted.kustomizeImageDigest,
      strategyBehaviorHash: extracted.strategyBehaviorHash,
      strategyParameterHash: extracted.strategyParameterHash,
      qualificationRunId: extracted.qualificationRunId,
    })
    const drifted = extractPaperActivationManifestPins(
      deployment,
      kustomization.replace(extracted.kustomizeImageDigest, `sha256:${'d'.repeat(64)}`),
    )
    expect(
      evaluatePaperActivation({
        evidence: value,
        pins: {
          sourceSha: value.sourceSha,
          imageRepository: value.imageRepository,
          imageDigest: value.imageDigest,
          protocolHash: value.protocolHash,
          strategyBehaviorHash: value.strategyBehaviorHash,
          strategyParameterHash: value.strategyParameterHash,
          qualificationRunId: value.qualificationRunId,
          accountBindingHash: value.accountBindingHash,
        },
        manifestPins: drifted,
        now,
        expectedRepository: value.repository,
        expectedActivationId: value.activationId,
        trustedCurrentMainSha: sourceSha,
      }),
    ).toMatchObject({ status: 'hold', code: 'manifest-pin-mismatch' })

    expect(() =>
      extractPaperActivationManifestPins(
        deployment.replace(
          '          image: registry.ide-newton.ts.net/lab/bayn\n',
          '          image: registry.example.invalid/unreviewed/bayn\n',
        ),
        kustomization,
      ),
    ).toThrow('Bayn container image does not match BAYN_IMAGE_REPOSITORY')
  })

  test('renders one runtime-valid PAPER capability transition and explicit OBSERVE rollback', () => {
    const nextAuthorityHash = 'f'.repeat(64)
    const authorityExpiresAt = '2026-07-31T09:00:00Z'
    const rollbackGeneration = deriveObserveRollbackGeneration({
      repository: 'proompteng/lab',
      activationId: 'proompt-405-paper-proof-1',
      sourceMainSha: sourceSha,
      previousObserveGenerationHash: '0'.repeat(64),
      paperAuthorityGenerationHash: nextAuthorityHash,
    })
    const rendered = renderPaperActivationTransition(
      readFileSync(deploymentPath, 'utf8'),
      nextAuthorityHash,
      rollbackGeneration.generationHash,
      authorityExpiresAt,
    )
    const envValues = (document: string): ReadonlyMap<string, string> => {
      const deployment = parse(document) as {
        spec: { template: { spec: { containers: readonly [{ env: readonly { name: string; value?: string }[] }] } } }
      }
      return new Map(
        deployment.spec.template.spec.containers[0].env.flatMap((entry) =>
          entry.value === undefined ? [] : [[entry.name, entry.value] as const],
        ),
      )
    }
    const paper = envValues(rendered.paperDeployment)
    const observe = envValues(rendered.observeDeployment)
    expect(paper.get('BAYN_MAXIMUM_AUTHORITY')).toBe('PAPER')
    expect(paper.get('BAYN_BROKER_ACCESS')).toBe('mutation')
    expect(paper.get('BAYN_CAPITAL_AUTHORITY')).toBe('sandbox-capital')
    expect(paper.get('BAYN_AUTHORITY_GENERATION_HASH')).toBe(nextAuthorityHash)
    expect(paper.get('BAYN_PAPER_AUTHORITY_EXPIRES_AT')).toBe(authorityExpiresAt)
    expect(observe.get('BAYN_MAXIMUM_AUTHORITY')).toBe('OBSERVE')
    expect(observe.get('BAYN_BROKER_ACCESS')).toBe('read-only')
    expect(observe.get('BAYN_CAPITAL_AUTHORITY')).toBe('none')
    expect(observe.get('BAYN_AUTHORITY_GENERATION_HASH')).toBe(rollbackGeneration.generationHash)
    expect(observe.has('BAYN_PAPER_AUTHORITY_EXPIRES_AT')).toBe(false)
    expect(observe.get('BAYN_AUTHORITY_GENERATION_HASH')).not.toBe('0'.repeat(64))
    expect(renderObserveRollback(rendered.paperDeployment, observe.get('BAYN_AUTHORITY_GENERATION_HASH') ?? '')).toBe(
      rendered.observeDeployment,
    )
    expect(extractDeploymentAuthorityState(rendered.paperDeployment)).toEqual({
      maximumAuthority: 'PAPER',
      brokerAccess: 'mutation',
      capitalAuthority: 'sandbox-capital',
      authorityGenerationHash: nextAuthorityHash,
    })
    expect(extractDeploymentAuthorityState(rendered.observeDeployment)).toEqual({
      maximumAuthority: 'OBSERVE',
      brokerAccess: 'read-only',
      capitalAuthority: 'none',
      authorityGenerationHash: rollbackGeneration.generationHash,
    })

    const paperDeployment = parse(rendered.paperDeployment) as {
      spec: {
        template: {
          spec: {
            containers: readonly [{ command?: readonly string[]; args?: readonly string[] }]
          }
        }
      }
    }
    const observeDeployment = parse(rendered.observeDeployment) as {
      spec: {
        template: {
          spec: {
            containers: readonly [{ command?: readonly string[]; args?: readonly string[] }]
          }
        }
      }
    }
    const paperContainer = paperDeployment.spec.template.spec.containers[0]
    const observeContainer = observeDeployment.spec.template.spec.containers[0]
    expect(paperContainer.command).toEqual(['node'])
    expect(paperContainer.args?.[0]).toBe('-e')
    expect(paperContainer.args?.[1]).toContain('BAYN_PAPER_AUTHORITY_EXPIRES_AT')
    expect(observeContainer.command).toBeUndefined()
    expect(observeContainer.args).toBeUndefined()
  })

  test('hard-stops at expiry, refuses expired restart, and preserves graceful termination signals', async () => {
    const nextAuthorityHash = 'f'.repeat(64)
    const rollbackGeneration = deriveObserveRollbackGeneration({
      repository: 'proompteng/lab',
      activationId: 'proompt-405-paper-proof-1',
      sourceMainSha: sourceSha,
      previousObserveGenerationHash: '0'.repeat(64),
      paperAuthorityGenerationHash: nextAuthorityHash,
    })
    const rendered = renderPaperActivationTransition(
      readFileSync(deploymentPath, 'utf8'),
      nextAuthorityHash,
      rollbackGeneration.generationHash,
      '2026-07-31T09:00:00Z',
    )
    const deployment = parse(rendered.paperDeployment) as {
      spec: { template: { spec: { containers: readonly [{ args: readonly string[] }] } } }
    }
    const guard = deployment.spec.template.spec.containers[0].args[1] ?? ''
    const root = mkdtempSync(join(tmpdir(), 'bayn-paper-expiry-'))
    const marker = join(root, 'started')
    mkdirSync(join(root, 'dist'))
    writeFileSync(
      join(root, 'dist/index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);\n`,
    )
    try {
      const deadline = new Date(Date.now() + 200).toISOString()
      const startedAt = Date.now()
      const running = Bun.spawnSync({
        cmd: ['node', '-e', guard],
        cwd: root,
        env: { ...process.env, BAYN_PAPER_AUTHORITY_EXPIRES_AT: deadline },
      })
      expect(running.exitCode).toBe(78)
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(existsSync(marker)).toBe(true)

      const expired = Bun.spawnSync({
        cmd: ['node', '-e', guard],
        cwd: root,
        env: { ...process.env, BAYN_PAPER_AUTHORITY_EXPIRES_AT: new Date(Date.now() - 1_000).toISOString() },
      })
      expect(expired.exitCode).toBe(78)

      const signalMarker = join(root, 'signal-started')
      writeFileSync(
        join(root, 'dist/index.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(signalMarker)}, 'started'); setInterval(() => {}, 1000);\n`,
      )
      const supervisor = Bun.spawn(['node', '-e', guard], {
        cwd: root,
        env: { ...process.env, BAYN_PAPER_AUTHORITY_EXPIRES_AT: new Date(Date.now() + 10_000).toISOString() },
        stdout: 'ignore',
        stderr: 'ignore',
      })
      for (let attempt = 0; attempt < 100 && !existsSync(signalMarker); attempt++) await Bun.sleep(10)
      expect(existsSync(signalMarker)).toBe(true)
      const signaledAt = Date.now()
      supervisor.kill('SIGTERM')
      const signalExit = await Promise.race([supervisor.exited, Bun.sleep(2_000).then(() => -1)])
      expect(signalExit).toBe(143)
      expect(supervisor.signalCode).toBe('SIGTERM')
      expect(Date.now() - signaledAt).toBeLessThan(2_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('precommits a deterministic fresh OBSERVE rollback generation', () => {
    const input = {
      repository: 'proompteng/lab',
      activationId: 'proompt-405-paper-proof-1',
      sourceMainSha: sourceSha,
      previousObserveGenerationHash: '0'.repeat(64),
      paperAuthorityGenerationHash: 'f'.repeat(64),
    }
    const generation = deriveObserveRollbackGeneration(input)
    expect(deriveObserveRollbackGeneration(input)).toEqual(generation)
    expect(generation.generationHash).not.toBe(input.previousObserveGenerationHash)
    expect(generation.generationHash).not.toBe(input.paperAuthorityGenerationHash)
    expect(deriveObserveRollbackGeneration({ ...input, activationId: 'another-activation' }).generationHash).not.toBe(
      generation.generationHash,
    )
    expect(() =>
      renderPaperActivationTransition(
        readFileSync(deploymentPath, 'utf8'),
        input.paperAuthorityGenerationHash,
        extractPaperActivationManifestPins(
          readFileSync(deploymentPath, 'utf8'),
          readFileSync(kustomizationPath, 'utf8'),
        ).currentAuthorityGenerationHash,
        '2026-07-31T09:00:00Z',
      ),
    ).toThrow('OBSERVE rollback generation must be fresh')
  })
})
