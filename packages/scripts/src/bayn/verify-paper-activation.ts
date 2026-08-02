import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { parse } from 'yaml'

export type PaperAuthorityGenerationMaterial = {
  readonly schemaVersion: 'bayn.paper-authority-generation.v2'
  readonly maximum: 'PAPER'
  readonly previousGenerationHash: string
  readonly qualificationRunId: string
  readonly qualificationLockId: string
  readonly qualificationResultHash: string
  readonly protocolHash: string
  readonly qualificationExecutionPolicyHash: string
  readonly qualificationSourceRevision: string
  readonly qualificationImageRepository: string
  readonly qualificationImageDigest: string
  readonly activationSourceRevision: string
  readonly activationImageRepository: string
  readonly activationImageDigest: string
  readonly strategyName: 'risk-balanced-trend'
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly strategyParameterSchemaVersion:
    | 'bayn.risk-balanced-trend.protocol.v3'
    | 'bayn.risk-balanced-trend.protocol.v4'
  readonly accountId: string
  readonly riskPolicyHash: string
  readonly proofPlanHash: string
  readonly reconciliationId: string
  readonly reconciliationContentHash: string
}

export type PaperAuthorityGeneration = PaperAuthorityGenerationMaterial & {
  readonly generationHash: string
}

export type ObserveRollbackGeneration = {
  readonly schemaVersion: 'bayn.observe-authority-rollback.v1'
  readonly repository: string
  readonly activationId: string
  readonly sourceMainSha: string
  readonly previousObserveGenerationHash: string
  readonly paperAuthorityGenerationHash: string
  readonly generationHash: string
}

export type DeploymentAuthorityState = {
  readonly maximumAuthority: 'OBSERVE' | 'PAPER' | 'LIVE'
  readonly brokerAccess: 'read-only' | 'mutation' | null
  readonly capitalAuthority: 'none' | 'sandbox-capital' | 'live-capital-grant' | null
  readonly authorityGenerationHash: string
}

export type QualificationAuditEvidence = {
  readonly schemaVersion: 'bayn.qualification-audit.v2'
  readonly runId: string
  readonly status: 'PASS' | 'FAIL'
  readonly reference: {
    readonly economicStatus: 'PASS' | 'FAIL_CLOSED'
    readonly observations: number
    readonly rebalanceCount: number
  }
  readonly evidence: {
    readonly artifactCount: number
    readonly eventCount: number
    readonly gateCount: number
    readonly lockId: string
    readonly resultHash: string
  }
  readonly policies: {
    readonly declaredAt: string
    readonly lockId: string
    readonly policySetHash: string
    readonly documents: readonly {
      readonly name: string
      readonly schemaVersion: string
      readonly contentHash: string
      readonly content: unknown
    }[]
  }
  readonly contamination: {
    readonly lockCreatedAt: string
    readonly resultCommittedAt: string
    readonly replicas: readonly string[]
    readonly principals: { readonly candidate: string; readonly publishers: readonly string[] }
    readonly access: readonly {
      readonly replica: string
      readonly queryId: string
      readonly queryStartTime: string
      readonly user: string
      readonly kind: 'manifest' | 'sessions' | 'bars'
    }[]
  }
  readonly repository: {
    readonly sourceCommitExists: boolean
    readonly sourceCommitAncestorOfMain: boolean
    readonly preLockResultReferences: readonly string[]
    readonly sourceRevision: string
  }
  readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly evidence: string }[]
  readonly auditHash: string
}

export type QualificationTerminalEvidence = {
  readonly schemaVersion: 'bayn.qualification-collector-terminal.v1'
  readonly repository: string
  readonly currentMainSha: string
  readonly sourceSha: string
  readonly image: { readonly repository: string; readonly digest: string }
  readonly candidateOrdinal: number
  readonly githubRunId: string
  readonly githubRunAttempt: number
  readonly preregistrationHash: string
  readonly eligibilityHash: string
  readonly candidateBindingHash: string
  readonly terminal: {
    readonly schemaVersion: 'bayn.qualification-execution.v1'
    readonly runId: string
    readonly lockId: string
    readonly resultHash: string
    readonly verdict: 'QUALIFIED' | 'REJECTED'
    readonly persistence: { readonly artifactCount: number; readonly eventCount: number; readonly gateCount: number }
  }
  readonly audit: QualificationAuditEvidence
  readonly evidenceHash: string
}

export type PaperActivationEvidence = {
  readonly schemaVersion: 2
  readonly repository: string
  readonly mainSha: string
  readonly currentMainSha: string
  readonly sourceSha: string
  readonly imageRepository: string
  readonly imageDigest: string
  readonly protocolHash: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly qualificationRunId: string
  readonly qualificationDecision: 'QUALIFIED' | 'REJECTED'
  readonly qualificationObservedAt: string
  readonly qualificationExpiresAt: string
  readonly accountBindingHash: string
  readonly brokerEnvironment: 'sandbox' | 'live'
  readonly brokerBaseUrl: string
  readonly maximumAuthority: 'OBSERVE' | 'PAPER' | 'LIVE'
  readonly authorityGeneration: PaperAuthorityGeneration
  readonly authorityExpiresAt: string
  readonly unresolvedMutationCount: number
  readonly unknownMutationCount: number
  readonly openOrderCount: number
  readonly discrepancyCount: number
  readonly reconciliation: 'EXACT' | 'NON_EXACT' | 'UNKNOWN'
  readonly killSwitchActive: boolean
  readonly identityGap: boolean
  readonly activationState: 'PRECOMMITTED' | 'IN_FLIGHT' | 'CONSUMED' | 'CANCELLED'
  readonly activationId: string
  readonly qualificationTerminal: QualificationTerminalEvidence
}

export type PaperActivationReviewedPins = {
  readonly schemaVersion: 'bayn.paper-activation-reviewed-pins.v1'
  readonly sourceSha: string
  readonly imageRepository: string
  readonly imageDigest: string
  readonly protocolHash: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly strategyParameterSchemaVersion:
    | 'bayn.risk-balanced-trend.protocol.v3'
    | 'bayn.risk-balanced-trend.protocol.v4'
  readonly qualificationExecutionPolicyHash: string
  readonly previousGenerationHash: string
  readonly accountId: string
  readonly riskPolicyHash: string
  readonly proofPlanHash: string
  readonly reconciliationId: string
  readonly reconciliationContentHash: string
  readonly qualificationExpiresAt: string
  readonly accountBindingHash: string
  readonly brokerEnvironment: 'sandbox' | 'live'
  readonly brokerBaseUrl: string
  readonly maximumAuthority: 'OBSERVE' | 'PAPER' | 'LIVE'
  readonly authorityExpiresAt: string
  readonly unresolvedMutationCount: number
  readonly unknownMutationCount: number
  readonly openOrderCount: number
  readonly discrepancyCount: number
  readonly reconciliation: 'EXACT' | 'NON_EXACT' | 'UNKNOWN'
  readonly killSwitchActive: boolean
  readonly identityGap: boolean
  readonly activationState: 'PRECOMMITTED' | 'IN_FLIGHT' | 'CONSUMED' | 'CANCELLED'
}

export type PaperActivationArtifact = {
  readonly evidence: PaperActivationEvidence
  readonly pins: PaperActivationPins
}

export type PaperActivationPins = Pick<
  PaperActivationEvidence,
  | 'sourceSha'
  | 'imageRepository'
  | 'imageDigest'
  | 'protocolHash'
  | 'strategyBehaviorHash'
  | 'strategyParameterHash'
  | 'qualificationRunId'
  | 'accountBindingHash'
>

export type PaperActivationManifestPins = Pick<
  PaperActivationEvidence,
  'sourceSha' | 'strategyBehaviorHash' | 'strategyParameterHash' | 'qualificationRunId'
> & {
  readonly deploymentImageRepository: string
  readonly deploymentImageDigest: string
  readonly kustomizeImageRepository: string
  readonly kustomizeImageDigest: string
  readonly kustomizeImageTag: string
  readonly currentAuthorityGenerationHash: string
}

export type PaperActivationDecision =
  | { readonly status: 'eligible'; readonly activationId: string; readonly authorityGenerationHash: string }
  | { readonly status: 'hold'; readonly code: string; readonly message: string }

export type PaperActivationTransition = {
  readonly paperDeployment: string
  readonly observeDeployment: string
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const maximumAuthorityDurationMs = 90 * 60 * 1_000
const isSha = (value: string): boolean => /^[0-9a-f]{40}$/.test(value)
const isHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)
const isDigest = (value: string): boolean => /^sha256:[0-9a-f]{64}$/.test(value)
const hold = (code: string, message: string): PaperActivationDecision => ({ status: 'hold', code, message })
const evidenceKeys = [
  'schemaVersion',
  'repository',
  'mainSha',
  'currentMainSha',
  'sourceSha',
  'imageRepository',
  'imageDigest',
  'protocolHash',
  'strategyBehaviorHash',
  'strategyParameterHash',
  'qualificationRunId',
  'qualificationDecision',
  'qualificationObservedAt',
  'qualificationExpiresAt',
  'accountBindingHash',
  'brokerEnvironment',
  'brokerBaseUrl',
  'maximumAuthority',
  'authorityGeneration',
  'authorityExpiresAt',
  'unresolvedMutationCount',
  'unknownMutationCount',
  'openOrderCount',
  'discrepancyCount',
  'reconciliation',
  'killSwitchActive',
  'identityGap',
  'activationState',
  'activationId',
  'qualificationTerminal',
] as const satisfies readonly (keyof PaperActivationEvidence)[]
const pinKeys = [
  'sourceSha',
  'imageRepository',
  'imageDigest',
  'protocolHash',
  'strategyBehaviorHash',
  'strategyParameterHash',
  'qualificationRunId',
  'accountBindingHash',
] as const satisfies readonly (keyof PaperActivationPins)[]
const manifestPinKeys = [
  'sourceSha',
  'strategyBehaviorHash',
  'strategyParameterHash',
  'qualificationRunId',
  'deploymentImageRepository',
  'deploymentImageDigest',
  'kustomizeImageRepository',
  'kustomizeImageDigest',
  'kustomizeImageTag',
  'currentAuthorityGenerationHash',
] as const satisfies readonly (keyof PaperActivationManifestPins)[]

const paperGenerationKeys = [
  'schemaVersion',
  'maximum',
  'previousGenerationHash',
  'qualificationRunId',
  'qualificationLockId',
  'qualificationResultHash',
  'protocolHash',
  'qualificationExecutionPolicyHash',
  'qualificationSourceRevision',
  'qualificationImageRepository',
  'qualificationImageDigest',
  'activationSourceRevision',
  'activationImageRepository',
  'activationImageDigest',
  'strategyName',
  'strategyBehaviorHash',
  'strategyParameterHash',
  'strategyParameterSchemaVersion',
  'accountId',
  'riskPolicyHash',
  'proofPlanHash',
  'reconciliationId',
  'reconciliationContentHash',
  'generationHash',
] as const satisfies readonly (keyof PaperAuthorityGeneration)[]

const qualificationTerminalKeys = [
  'schemaVersion',
  'repository',
  'currentMainSha',
  'sourceSha',
  'image',
  'candidateOrdinal',
  'githubRunId',
  'githubRunAttempt',
  'preregistrationHash',
  'eligibilityHash',
  'candidateBindingHash',
  'terminal',
  'audit',
  'evidenceHash',
] as const satisfies readonly (keyof QualificationTerminalEvidence)[]
const qualificationExecutionKeys = ['schemaVersion', 'runId', 'lockId', 'resultHash', 'verdict', 'persistence'] as const
const qualificationPersistenceKeys = ['artifactCount', 'eventCount', 'gateCount'] as const
const qualificationAuditKeys = [
  'schemaVersion',
  'runId',
  'status',
  'reference',
  'evidence',
  'policies',
  'contamination',
  'repository',
  'checks',
  'auditHash',
] as const
const qualificationAuditReferenceKeys = ['economicStatus', 'observations', 'rebalanceCount'] as const
const qualificationAuditEvidenceKeys = ['artifactCount', 'eventCount', 'gateCount', 'lockId', 'resultHash'] as const
const qualificationAuditPoliciesKeys = ['declaredAt', 'lockId', 'policySetHash', 'documents'] as const
const qualificationAuditDocumentKeys = ['name', 'schemaVersion', 'contentHash', 'content'] as const
const qualificationAuditContaminationKeys = [
  'lockCreatedAt',
  'resultCommittedAt',
  'replicas',
  'principals',
  'access',
] as const
const qualificationAuditPrincipalsKeys = ['candidate', 'publishers'] as const
const qualificationAuditAccessKeys = ['replica', 'queryId', 'queryStartTime', 'user', 'kind'] as const
const qualificationAuditRepositoryKeys = [
  'sourceCommitExists',
  'sourceCommitAncestorOfMain',
  'preLockResultReferences',
  'sourceRevision',
] as const
const qualificationAuditCheckKeys = ['name', 'passed', 'evidence'] as const
const reviewedPinKeys = [
  'schemaVersion',
  'sourceSha',
  'imageRepository',
  'imageDigest',
  'protocolHash',
  'strategyBehaviorHash',
  'strategyParameterHash',
  'strategyParameterSchemaVersion',
  'qualificationExecutionPolicyHash',
  'previousGenerationHash',
  'accountId',
  'riskPolicyHash',
  'proofPlanHash',
  'reconciliationId',
  'reconciliationContentHash',
  'qualificationExpiresAt',
  'accountBindingHash',
  'brokerEnvironment',
  'brokerBaseUrl',
  'maximumAuthority',
  'authorityExpiresAt',
  'unresolvedMutationCount',
  'unknownMutationCount',
  'openOrderCount',
  'discrepancyCount',
  'reconciliation',
  'killSwitchActive',
  'identityGap',
  'activationState',
] as const satisfies readonly (keyof PaperActivationReviewedPins)[]

const requirePins = <Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, string> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length) return null
  for (const key of keys) if (typeof record[key] !== 'string' || record[key].length === 0) return null
  return record as Record<Key, string>
}

const hasExactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))

const hasInvalidUnicodeSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

const canonicalJsonV1 = (value: unknown, ancestors: readonly object[] = []): string => {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    if (hasInvalidUnicodeSurrogate(value)) throw new Error('canonical JSON contains an invalid Unicode surrogate')
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON contains a non-finite number')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object') throw new Error(`canonical JSON contains a non-JSON ${typeof value} value`)
  if (ancestors.includes(value)) throw new Error('canonical JSON contains a cycle')

  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value)
    if (
      keys.some(
        (key) =>
          key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length),
      ) ||
      Object.keys(value).some((key, index) => key !== String(index))
    )
      throw new Error('canonical JSON array is sparse or has custom properties')
    return `[${value.map((entry) => canonicalJsonV1(entry, [...ancestors, value])).join(',')}]`
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('canonical JSON contains a non-plain object')
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) throw new Error('canonical JSON contains a symbol key')
  const entries = (keys as readonly string[])
    .slice()
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => {
      if (hasInvalidUnicodeSurrogate(key)) throw new Error('canonical JSON contains an invalid Unicode key')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true || !('value' in descriptor))
        throw new Error('canonical JSON contains a non-data property')
      return `${JSON.stringify(key)}:${canonicalJsonV1(descriptor.value, [...ancestors, value])}`
    })
  return `{${entries.join(',')}}`
}

export const canonicalHashV1 = (value: unknown): string => sha256(canonicalJsonV1(value))

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const nonEmptyStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)

const exactObject = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return hasExactKeys(record, keys) ? record : null
}

const requireQualificationAudit = (value: unknown): QualificationAuditEvidence | null => {
  const record = exactObject(value, qualificationAuditKeys)
  if (record === null) return null
  if (record.schemaVersion !== 'bayn.qualification-audit.v2') return null
  if (typeof record.runId !== 'string' || !isHash(record.runId)) return null
  if (record.status !== 'PASS' && record.status !== 'FAIL') return null

  const reference = exactObject(record.reference, qualificationAuditReferenceKeys)
  if (reference === null) return null
  if (reference.economicStatus !== 'PASS' && reference.economicStatus !== 'FAIL_CLOSED') return null
  if (!isNonNegativeSafeInteger(reference.observations) || !isNonNegativeSafeInteger(reference.rebalanceCount))
    return null

  const evidence = exactObject(record.evidence, qualificationAuditEvidenceKeys)
  if (evidence === null) return null
  if (
    !isNonNegativeSafeInteger(evidence.artifactCount) ||
    !isNonNegativeSafeInteger(evidence.eventCount) ||
    !isNonNegativeSafeInteger(evidence.gateCount) ||
    typeof evidence.lockId !== 'string' ||
    !isHash(evidence.lockId) ||
    typeof evidence.resultHash !== 'string' ||
    !isHash(evidence.resultHash)
  )
    return null

  const policies = exactObject(record.policies, qualificationAuditPoliciesKeys)
  if (policies === null) return null
  if (
    typeof policies.declaredAt !== 'string' ||
    policies.declaredAt.length === 0 ||
    typeof policies.lockId !== 'string' ||
    !isHash(policies.lockId) ||
    typeof policies.policySetHash !== 'string' ||
    !isHash(policies.policySetHash) ||
    !Array.isArray(policies.documents)
  )
    return null
  for (const document of policies.documents) {
    const documentRecord = exactObject(document, qualificationAuditDocumentKeys)
    if (
      documentRecord === null ||
      typeof documentRecord.name !== 'string' ||
      documentRecord.name.length === 0 ||
      typeof documentRecord.schemaVersion !== 'string' ||
      documentRecord.schemaVersion.length === 0 ||
      typeof documentRecord.contentHash !== 'string' ||
      !isHash(documentRecord.contentHash)
    )
      return null
  }

  const contamination = exactObject(record.contamination, qualificationAuditContaminationKeys)
  if (contamination === null) return null
  if (
    typeof contamination.lockCreatedAt !== 'string' ||
    contamination.lockCreatedAt.length === 0 ||
    typeof contamination.resultCommittedAt !== 'string' ||
    contamination.resultCommittedAt.length === 0 ||
    !nonEmptyStringArray(contamination.replicas)
  )
    return null
  const principals = exactObject(contamination.principals, qualificationAuditPrincipalsKeys)
  if (
    principals === null ||
    typeof principals.candidate !== 'string' ||
    principals.candidate.length === 0 ||
    !nonEmptyStringArray(principals.publishers) ||
    !Array.isArray(contamination.access)
  )
    return null
  for (const access of contamination.access) {
    const accessRecord = exactObject(access, qualificationAuditAccessKeys)
    if (
      accessRecord === null ||
      typeof accessRecord.replica !== 'string' ||
      accessRecord.replica.length === 0 ||
      typeof accessRecord.queryId !== 'string' ||
      accessRecord.queryId.length === 0 ||
      typeof accessRecord.queryStartTime !== 'string' ||
      accessRecord.queryStartTime.length === 0 ||
      typeof accessRecord.user !== 'string' ||
      accessRecord.user.length === 0 ||
      (accessRecord.kind !== 'manifest' && accessRecord.kind !== 'sessions' && accessRecord.kind !== 'bars')
    )
      return null
  }

  const repository = exactObject(record.repository, qualificationAuditRepositoryKeys)
  if (
    repository === null ||
    repository.sourceCommitExists !== true ||
    repository.sourceCommitAncestorOfMain !== true ||
    !Array.isArray(repository.preLockResultReferences) ||
    !repository.preLockResultReferences.every((entry) => typeof entry === 'string') ||
    typeof repository.sourceRevision !== 'string' ||
    !isSha(repository.sourceRevision)
  )
    return null

  if (!Array.isArray(record.checks)) return null
  for (const check of record.checks) {
    const checkRecord = exactObject(check, qualificationAuditCheckKeys)
    if (
      checkRecord === null ||
      typeof checkRecord.name !== 'string' ||
      checkRecord.name.length === 0 ||
      typeof checkRecord.passed !== 'boolean' ||
      typeof checkRecord.evidence !== 'string' ||
      checkRecord.evidence.length === 0
    )
      return null
  }
  if (typeof record.auditHash !== 'string' || !isHash(record.auditHash)) return null

  try {
    const { auditHash: _auditHash, ...auditMaterial } = record
    if (canonicalHashV1(auditMaterial) !== record.auditHash) return null
  } catch {
    return null
  }
  return record as unknown as QualificationAuditEvidence
}

const requireQualificationTerminal = (value: unknown): QualificationTerminalEvidence | null => {
  const record = exactObject(value, qualificationTerminalKeys)
  if (record === null || record.schemaVersion !== 'bayn.qualification-collector-terminal.v1') return null
  if (
    typeof record.repository !== 'string' ||
    record.repository.length === 0 ||
    typeof record.currentMainSha !== 'string' ||
    !isSha(record.currentMainSha) ||
    typeof record.sourceSha !== 'string' ||
    !isSha(record.sourceSha) ||
    typeof record.candidateOrdinal !== 'number' ||
    !Number.isSafeInteger(record.candidateOrdinal) ||
    record.candidateOrdinal < 1 ||
    typeof record.githubRunId !== 'string' ||
    !/^\d+$/.test(record.githubRunId) ||
    typeof record.githubRunAttempt !== 'number' ||
    !Number.isSafeInteger(record.githubRunAttempt) ||
    record.githubRunAttempt < 1
  )
    return null
  const image = exactObject(record.image, ['repository', 'digest'])
  if (
    image === null ||
    typeof image.repository !== 'string' ||
    image.repository.length === 0 ||
    typeof image.digest !== 'string' ||
    !isDigest(image.digest)
  )
    return null
  for (const key of ['preregistrationHash', 'eligibilityHash', 'candidateBindingHash', 'evidenceHash'] as const) {
    if (typeof record[key] !== 'string' || !isHash(record[key])) return null
  }

  const execution = exactObject(record.terminal, qualificationExecutionKeys)
  if (execution === null || execution.schemaVersion !== 'bayn.qualification-execution.v1') return null
  if (
    typeof execution.runId !== 'string' ||
    !isHash(execution.runId) ||
    typeof execution.lockId !== 'string' ||
    !isHash(execution.lockId) ||
    typeof execution.resultHash !== 'string' ||
    !isHash(execution.resultHash) ||
    (execution.verdict !== 'QUALIFIED' && execution.verdict !== 'REJECTED')
  )
    return null
  const persistence = exactObject(execution.persistence, qualificationPersistenceKeys)
  if (
    persistence === null ||
    !isNonNegativeSafeInteger(persistence.artifactCount) ||
    !isNonNegativeSafeInteger(persistence.eventCount) ||
    !isNonNegativeSafeInteger(persistence.gateCount)
  )
    return null

  const audit = requireQualificationAudit(record.audit)
  if (audit === null || audit.status !== 'PASS') return null
  if (
    audit.runId !== execution.runId ||
    audit.evidence.lockId !== execution.lockId ||
    audit.evidence.resultHash !== execution.resultHash ||
    audit.policies.lockId !== execution.lockId ||
    audit.repository.sourceRevision !== record.sourceSha ||
    audit.evidence.artifactCount !== persistence.artifactCount ||
    audit.evidence.eventCount !== persistence.eventCount ||
    audit.evidence.gateCount !== persistence.gateCount
  )
    return null

  try {
    const { evidenceHash: _evidenceHash, ...terminalMaterial } = record
    if (canonicalHashV1(terminalMaterial) !== record.evidenceHash) return null
  } catch {
    return null
  }
  return {
    ...(record as unknown as Omit<QualificationTerminalEvidence, 'image' | 'terminal' | 'audit'>),
    image: image as QualificationTerminalEvidence['image'],
    terminal: execution as QualificationTerminalEvidence['terminal'],
    audit,
  }
}

const requireReviewedPins = (value: unknown): PaperActivationReviewedPins | null => {
  const record = exactObject(value, reviewedPinKeys)
  if (record === null || record.schemaVersion !== 'bayn.paper-activation-reviewed-pins.v1') return null
  const stringKeys = [
    'imageRepository',
    'protocolHash',
    'strategyBehaviorHash',
    'strategyParameterHash',
    'qualificationExecutionPolicyHash',
    'previousGenerationHash',
    'accountId',
    'riskPolicyHash',
    'proofPlanHash',
    'reconciliationId',
    'reconciliationContentHash',
    'qualificationExpiresAt',
    'accountBindingHash',
    'brokerBaseUrl',
    'authorityExpiresAt',
  ] as const
  if (stringKeys.some((key) => typeof record[key] !== 'string' || record[key].length === 0)) return null
  if (typeof record.sourceSha !== 'string' || !isSha(record.sourceSha)) return null
  if (typeof record.imageDigest !== 'string' || !isDigest(record.imageDigest)) return null
  for (const key of [
    'protocolHash',
    'strategyBehaviorHash',
    'strategyParameterHash',
    'qualificationExecutionPolicyHash',
    'previousGenerationHash',
    'riskPolicyHash',
    'proofPlanHash',
    'reconciliationId',
    'reconciliationContentHash',
    'accountBindingHash',
  ] as const) {
    if (typeof record[key] !== 'string' || !isHash(record[key])) return null
  }
  if (
    record.strategyParameterSchemaVersion !== 'bayn.risk-balanced-trend.protocol.v3' &&
    record.strategyParameterSchemaVersion !== 'bayn.risk-balanced-trend.protocol.v4'
  )
    return null
  if (record.brokerEnvironment !== 'sandbox' && record.brokerEnvironment !== 'live') return null
  if (
    record.maximumAuthority !== 'OBSERVE' &&
    record.maximumAuthority !== 'PAPER' &&
    record.maximumAuthority !== 'LIVE'
  )
    return null
  const countKeys = ['unresolvedMutationCount', 'unknownMutationCount', 'openOrderCount', 'discrepancyCount'] as const
  if (countKeys.some((key) => !isNonNegativeSafeInteger(record[key]))) return null
  if (record.reconciliation !== 'EXACT' && record.reconciliation !== 'NON_EXACT' && record.reconciliation !== 'UNKNOWN')
    return null
  if (
    record.activationState !== 'PRECOMMITTED' &&
    record.activationState !== 'IN_FLIGHT' &&
    record.activationState !== 'CONSUMED' &&
    record.activationState !== 'CANCELLED'
  )
    return null
  if (typeof record.killSwitchActive !== 'boolean' || typeof record.identityGap !== 'boolean') return null
  return record as unknown as PaperActivationReviewedPins
}

const requirePaperAuthorityGeneration = (value: unknown): PaperAuthorityGeneration | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!hasExactKeys(record, paperGenerationKeys)) return null
  if (record.schemaVersion !== 'bayn.paper-authority-generation.v2' || record.maximum !== 'PAPER') return null
  if (record.strategyName !== 'risk-balanced-trend') return null
  if (
    record.strategyParameterSchemaVersion !== 'bayn.risk-balanced-trend.protocol.v3' &&
    record.strategyParameterSchemaVersion !== 'bayn.risk-balanced-trend.protocol.v4'
  )
    return null
  const hashKeys = [
    'previousGenerationHash',
    'qualificationRunId',
    'qualificationLockId',
    'qualificationResultHash',
    'protocolHash',
    'qualificationExecutionPolicyHash',
    'strategyBehaviorHash',
    'strategyParameterHash',
    'riskPolicyHash',
    'proofPlanHash',
    'reconciliationId',
    'reconciliationContentHash',
    'generationHash',
  ] as const
  if (hashKeys.some((key) => typeof record[key] !== 'string' || !isHash(record[key]))) return null
  const sourceKeys = ['qualificationSourceRevision', 'activationSourceRevision'] as const
  if (sourceKeys.some((key) => typeof record[key] !== 'string' || !isSha(record[key]))) return null
  const digestKeys = ['qualificationImageDigest', 'activationImageDigest'] as const
  if (digestKeys.some((key) => typeof record[key] !== 'string' || !isDigest(record[key]))) return null
  const nonEmptyKeys = ['qualificationImageRepository', 'activationImageRepository', 'accountId'] as const
  if (nonEmptyKeys.some((key) => typeof record[key] !== 'string' || record[key].length === 0)) return null
  return record as unknown as PaperAuthorityGeneration
}

const requireEvidence = (value: unknown): PaperActivationEvidence | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!hasExactKeys(record, evidenceKeys)) return null
  const stringKeys = [
    'repository',
    'mainSha',
    'currentMainSha',
    'sourceSha',
    'imageRepository',
    'imageDigest',
    'protocolHash',
    'strategyBehaviorHash',
    'strategyParameterHash',
    'qualificationRunId',
    'qualificationObservedAt',
    'qualificationExpiresAt',
    'accountBindingHash',
    'brokerBaseUrl',
    'authorityExpiresAt',
    'activationId',
  ] as const
  if (stringKeys.some((key) => typeof record[key] !== 'string' || record[key].length === 0)) return null
  const countKeys = ['unresolvedMutationCount', 'unknownMutationCount', 'openOrderCount', 'discrepancyCount'] as const
  if (
    countKeys.some((key) => {
      const value = record[key]
      return typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    })
  )
    return null
  if (record.schemaVersion !== 2) return null
  if (record.qualificationDecision !== 'QUALIFIED' && record.qualificationDecision !== 'REJECTED') return null
  if (record.brokerEnvironment !== 'sandbox' && record.brokerEnvironment !== 'live') return null
  if (
    record.maximumAuthority !== 'OBSERVE' &&
    record.maximumAuthority !== 'PAPER' &&
    record.maximumAuthority !== 'LIVE'
  )
    return null
  if (record.reconciliation !== 'EXACT' && record.reconciliation !== 'NON_EXACT' && record.reconciliation !== 'UNKNOWN')
    return null
  if (
    record.activationState !== 'PRECOMMITTED' &&
    record.activationState !== 'IN_FLIGHT' &&
    record.activationState !== 'CONSUMED' &&
    record.activationState !== 'CANCELLED'
  )
    return null
  if (typeof record.killSwitchActive !== 'boolean' || typeof record.identityGap !== 'boolean') return null
  const authorityGeneration = requirePaperAuthorityGeneration(record.authorityGeneration)
  if (authorityGeneration === null) return null
  const qualificationTerminal = requireQualificationTerminal(record.qualificationTerminal)
  if (qualificationTerminal === null) return null
  if (
    qualificationTerminal.repository !== record.repository ||
    qualificationTerminal.currentMainSha !== record.mainSha ||
    qualificationTerminal.sourceSha !== record.sourceSha ||
    qualificationTerminal.image.repository !== record.imageRepository ||
    qualificationTerminal.image.digest !== record.imageDigest ||
    qualificationTerminal.terminal.runId !== record.qualificationRunId ||
    qualificationTerminal.terminal.verdict !== record.qualificationDecision ||
    qualificationTerminal.audit.contamination.resultCommittedAt !== record.qualificationObservedAt
  )
    return null
  return {
    ...(record as unknown as Omit<PaperActivationEvidence, 'authorityGeneration' | 'qualificationTerminal'>),
    authorityGeneration,
    qualificationTerminal,
  }
}

const expectRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

const expectArray = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

const expectString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

export const extractPaperActivationManifestPins = (
  deploymentContents: string,
  kustomizationContents: string,
): PaperActivationManifestPins => {
  const deployment = expectRecord(parse(deploymentContents), 'deployment')
  const deploymentSpec = expectRecord(deployment.spec, 'deployment.spec')
  const template = expectRecord(deploymentSpec.template, 'deployment.spec.template')
  const podSpec = expectRecord(template.spec, 'deployment.spec.template.spec')
  const containers = expectArray(podSpec.containers, 'deployment containers').map((value, index) =>
    expectRecord(value, `deployment container ${index}`),
  )
  const baynContainers = containers.filter((container) => container.name === 'bayn')
  if (baynContainers.length !== 1) throw new Error('deployment must contain exactly one Bayn container')
  const environment = expectArray(baynContainers[0]?.env, 'Bayn environment').map((value, index) =>
    expectRecord(value, `Bayn environment entry ${index}`),
  )
  const environmentValue = (name: string): string => {
    const matches = environment.filter((entry) => entry.name === name)
    if (matches.length !== 1) throw new Error(`deployment must contain exactly one ${name} value`)
    return expectString(matches[0]?.value, name)
  }

  const deploymentContainerImage = expectString(baynContainers[0]?.image, 'Bayn container image')
  const deploymentImageRepository = environmentValue('BAYN_IMAGE_REPOSITORY')
  const deploymentImageDigest = environmentValue('BAYN_IMAGE_DIGEST')
  if (deploymentContainerImage !== deploymentImageRepository)
    throw new Error('Bayn container image does not match BAYN_IMAGE_REPOSITORY')
  const kustomization = expectRecord(parse(kustomizationContents), 'kustomization')
  const images = expectArray(kustomization.images, 'kustomization images').map((value, index) =>
    expectRecord(value, `kustomization image ${index}`),
  )
  const matchingImages = images.filter((image) => image.name === deploymentContainerImage)
  if (matchingImages.length !== 1) throw new Error('kustomization must contain exactly one effective Bayn image')
  const image = matchingImages[0]
  if (image === undefined) throw new Error('effective Bayn image is missing')

  return {
    sourceSha: environmentValue('BAYN_CODE_REVISION'),
    strategyBehaviorHash: environmentValue('BAYN_STRATEGY_BEHAVIOR_HASH'),
    strategyParameterHash: environmentValue('BAYN_STRATEGY_PARAMETER_HASH'),
    qualificationRunId: environmentValue('BAYN_QUALIFICATION_RUN_ID'),
    deploymentImageRepository,
    deploymentImageDigest,
    kustomizeImageRepository: expectString(image.newName, 'kustomization Bayn newName'),
    kustomizeImageDigest: expectString(image.digest, 'kustomization Bayn digest'),
    kustomizeImageTag: expectString(image.newTag, 'kustomization Bayn tag'),
    currentAuthorityGenerationHash: environmentValue('BAYN_AUTHORITY_GENERATION_HASH'),
  }
}

export const extractDeploymentAuthorityState = (deploymentContents: string): DeploymentAuthorityState => {
  const deployment = expectRecord(parse(deploymentContents), 'deployment')
  const deploymentSpec = expectRecord(deployment.spec, 'deployment.spec')
  const template = expectRecord(deploymentSpec.template, 'deployment.spec.template')
  const podSpec = expectRecord(template.spec, 'deployment.spec.template.spec')
  const containers = expectArray(podSpec.containers, 'deployment containers').map((value, index) =>
    expectRecord(value, `deployment container ${index}`),
  )
  const baynContainers = containers.filter((container) => container.name === 'bayn')
  if (baynContainers.length !== 1) throw new Error('deployment must contain exactly one Bayn container')
  const environment = expectArray(baynContainers[0]?.env, 'Bayn environment').map((value, index) =>
    expectRecord(value, `Bayn environment entry ${index}`),
  )
  const optionalEnvironmentValue = (name: string): string | null => {
    const matches = environment.filter((entry) => entry.name === name)
    if (matches.length > 1) throw new Error(`deployment must not contain duplicate ${name} values`)
    if (matches.length === 0) return null
    return expectString(matches[0]?.value, name)
  }
  const maximumAuthority = optionalEnvironmentValue('BAYN_MAXIMUM_AUTHORITY')
  const brokerAccess = optionalEnvironmentValue('BAYN_BROKER_ACCESS')
  const capitalAuthority = optionalEnvironmentValue('BAYN_CAPITAL_AUTHORITY')
  const authorityGenerationHash = optionalEnvironmentValue('BAYN_AUTHORITY_GENERATION_HASH')
  if (maximumAuthority !== 'OBSERVE' && maximumAuthority !== 'PAPER' && maximumAuthority !== 'LIVE')
    throw new Error('deployment maximum authority is invalid')
  if (brokerAccess !== null && brokerAccess !== 'read-only' && brokerAccess !== 'mutation')
    throw new Error('deployment broker access is invalid')
  if (
    capitalAuthority !== null &&
    capitalAuthority !== 'none' &&
    capitalAuthority !== 'sandbox-capital' &&
    capitalAuthority !== 'live-capital-grant'
  )
    throw new Error('deployment capital authority is invalid')
  if (authorityGenerationHash === null || !isHash(authorityGenerationHash))
    throw new Error('deployment authority generation hash is invalid')
  if (maximumAuthority === 'PAPER' && (brokerAccess !== 'mutation' || capitalAuthority !== 'sandbox-capital'))
    throw new Error('PAPER deployment capability is incoherent')
  if (
    maximumAuthority === 'OBSERVE' &&
    ((brokerAccess !== null && brokerAccess !== 'read-only') ||
      (capitalAuthority !== null && capitalAuthority !== 'none'))
  )
    throw new Error('OBSERVE deployment capability is incoherent')
  return { maximumAuthority, brokerAccess, capitalAuthority, authorityGenerationHash }
}

const replaceExactlyOnce = (source: string, expected: string, replacement: string, label: string): string => {
  if (source.split(expected).length !== 2) throw new Error(`${label} is missing or ambiguous`)
  return source.replace(expected, replacement)
}

const capabilityBlock = (brokerAccess: 'read-only' | 'mutation', capitalAuthority: 'none' | 'sandbox-capital') =>
  `            - name: BAYN_BROKER_ACCESS\n              value: ${brokerAccess}\n            - name: BAYN_CAPITAL_AUTHORITY\n              value: ${capitalAuthority}\n`

const paperAuthorityExpiryMarker = '            - name: BAYN_PAPER_AUTHORITY_EXPIRES_AT\n              value: '
const imagePullPolicyMarker = '          imagePullPolicy: IfNotPresent\n'
const paperAuthorityGuardScript = [
  'const { spawn } = require("node:child_process");',
  'const deadline = Date.parse(process.env.BAYN_PAPER_AUTHORITY_EXPIRES_AT ?? "");',
  'if (!Number.isFinite(deadline) || deadline <= Date.now()) process.exit(78);',
  'let expired = false;',
  'const child = spawn(process.execPath, ["dist/index.js"], { stdio: "inherit" });',
  'const expiryTimer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, Math.max(0, deadline - Date.now()));',
  'const forwardedSignals = new Map();',
  'for (const signal of ["SIGTERM", "SIGINT"]) { const handler = () => child.kill(signal); forwardedSignals.set(signal, handler); process.on(signal, handler); }',
  'child.on("error", () => process.exit(70));',
  'child.on("exit", (code, signal) => { clearTimeout(expiryTimer); if (expired) process.exit(78); if (signal) { const handler = forwardedSignals.get(signal); if (handler) process.off(signal, handler); process.kill(process.pid, signal); return; } process.exit(code ?? 1); });',
].join('\n')
const paperAuthorityProcessGuard = `          command:\n            - node\n          args:\n            - -e\n            - |\n${paperAuthorityGuardScript
  .split('\n')
  .map((line) => `              ${line}`)
  .join('\n')}\n`

const paperAuthorityExpiryBlock = (authorityExpiresAt: string): string => {
  if (!Number.isFinite(Date.parse(authorityExpiresAt)) || authorityExpiresAt.includes('\n'))
    throw new Error('authority expiry is malformed')
  return `${paperAuthorityExpiryMarker}${JSON.stringify(authorityExpiresAt)}\n`
}

const removePaperAuthorityDeadline = (paperDeployment: string): string => {
  const expiryStart = paperDeployment.indexOf(paperAuthorityExpiryMarker)
  const guardStart = paperDeployment.indexOf(paperAuthorityProcessGuard)
  if (expiryStart < 0 !== guardStart < 0) throw new Error('PAPER authority deadline guard is incomplete')
  if (expiryStart < 0) return paperDeployment
  if (
    paperDeployment.indexOf(paperAuthorityExpiryMarker, expiryStart + 1) >= 0 ||
    paperDeployment.indexOf(paperAuthorityProcessGuard, guardStart + 1) >= 0
  )
    throw new Error('PAPER authority deadline guard is ambiguous')
  const expiryEnd = paperDeployment.indexOf('\n', expiryStart + paperAuthorityExpiryMarker.length)
  if (expiryEnd < 0) throw new Error('PAPER authority expiry value is unterminated')
  return paperDeployment
    .slice(0, expiryStart)
    .concat(paperDeployment.slice(expiryEnd + 1))
    .replace(paperAuthorityProcessGuard, '')
}

export const renderPaperActivationTransition = (
  sourceDeployment: string,
  authorityGenerationHash: string,
  observeRollbackGenerationHash: string,
  authorityExpiresAt: string,
): PaperActivationTransition => {
  if (!isHash(authorityGenerationHash)) throw new Error('authority generation hash is malformed')
  if (!isHash(observeRollbackGenerationHash)) throw new Error('OBSERVE rollback generation hash is malformed')
  if (observeRollbackGenerationHash === authorityGenerationHash)
    throw new Error('OBSERVE rollback generation must differ from PAPER generation')
  if (sourceDeployment.includes('            - name: BAYN_BROKER_ACCESS\n'))
    throw new Error('source deployment already contains explicit broker access')
  if (sourceDeployment.includes('            - name: BAYN_CAPITAL_AUTHORITY\n'))
    throw new Error('source deployment already contains explicit capital authority')
  if (!sourceDeployment.includes('            - name: BAYN_BROKER_ENVIRONMENT\n              value: sandbox\n'))
    throw new Error('source deployment is not bound to the sandbox broker environment')
  if (
    !sourceDeployment.includes(
      '            - name: BAYN_ALPACA_BASE_URL\n              value: https://paper-api.alpaca.markets\n',
    )
  )
    throw new Error('source deployment is not bound to the canonical Alpaca paper endpoint')

  const maximumObserve = '            - name: BAYN_MAXIMUM_AUTHORITY\n              value: OBSERVE\n'
  const maximumPaper = '            - name: BAYN_MAXIMUM_AUTHORITY\n              value: PAPER\n'
  const authorityMarker = '            - name: BAYN_AUTHORITY_GENERATION_HASH\n              value: "'
  const markerStart = sourceDeployment.indexOf(authorityMarker)
  if (markerStart < 0 || sourceDeployment.indexOf(authorityMarker, markerStart + 1) >= 0)
    throw new Error('authority generation field is missing or ambiguous')
  const valueStart = markerStart + authorityMarker.length
  const valueEnd = sourceDeployment.indexOf('"', valueStart)
  if (valueEnd < 0) throw new Error('authority generation value is unterminated')
  const previousAuthorityGenerationHash = sourceDeployment.slice(valueStart, valueEnd)
  if (!isHash(previousAuthorityGenerationHash)) throw new Error('source authority generation hash is malformed')
  if (observeRollbackGenerationHash === previousAuthorityGenerationHash)
    throw new Error('OBSERVE rollback generation must be fresh')

  let observeDeployment = replaceExactlyOnce(
    sourceDeployment,
    maximumObserve,
    maximumObserve + capabilityBlock('read-only', 'none'),
    'OBSERVE authority field',
  )
  const observeMarkerStart = observeDeployment.indexOf(authorityMarker)
  const observeValueStart = observeMarkerStart + authorityMarker.length
  const observeValueEnd = observeDeployment.indexOf('"', observeValueStart)
  observeDeployment = `${observeDeployment.slice(0, observeValueStart)}${observeRollbackGenerationHash}${observeDeployment.slice(observeValueEnd)}`
  let paperDeployment = replaceExactlyOnce(
    sourceDeployment,
    maximumObserve,
    maximumPaper + capabilityBlock('mutation', 'sandbox-capital') + paperAuthorityExpiryBlock(authorityExpiresAt),
    'OBSERVE authority field',
  )
  paperDeployment = replaceExactlyOnce(
    paperDeployment,
    imagePullPolicyMarker,
    imagePullPolicyMarker + paperAuthorityProcessGuard,
    'Bayn image pull policy field',
  )
  const paperMarkerStart = paperDeployment.indexOf(authorityMarker)
  const paperValueStart = paperMarkerStart + authorityMarker.length
  const paperValueEnd = paperDeployment.indexOf('"', paperValueStart)
  paperDeployment = `${paperDeployment.slice(0, paperValueStart)}${authorityGenerationHash}${paperDeployment.slice(paperValueEnd)}`
  return { paperDeployment, observeDeployment }
}

export const renderObserveRollback = (paperDeployment: string, observeAuthorityGenerationHash: string): string => {
  if (!isHash(observeAuthorityGenerationHash)) throw new Error('OBSERVE authority generation hash is malformed')
  let observeDeployment = replaceExactlyOnce(
    removePaperAuthorityDeadline(paperDeployment),
    '            - name: BAYN_MAXIMUM_AUTHORITY\n              value: PAPER\n',
    '            - name: BAYN_MAXIMUM_AUTHORITY\n              value: OBSERVE\n',
    'PAPER authority field',
  )
  observeDeployment = replaceExactlyOnce(
    observeDeployment,
    '            - name: BAYN_BROKER_ACCESS\n              value: mutation\n',
    '            - name: BAYN_BROKER_ACCESS\n              value: read-only\n',
    'mutation broker access field',
  )
  observeDeployment = replaceExactlyOnce(
    observeDeployment,
    '            - name: BAYN_CAPITAL_AUTHORITY\n              value: sandbox-capital\n',
    '            - name: BAYN_CAPITAL_AUTHORITY\n              value: none\n',
    'sandbox capital authority field',
  )
  const authorityMarker = '            - name: BAYN_AUTHORITY_GENERATION_HASH\n              value: "'
  const markerStart = observeDeployment.indexOf(authorityMarker)
  if (markerStart < 0 || observeDeployment.indexOf(authorityMarker, markerStart + 1) >= 0)
    throw new Error('authority generation field is missing or ambiguous')
  const valueStart = markerStart + authorityMarker.length
  const valueEnd = observeDeployment.indexOf('"', valueStart)
  if (valueEnd < 0) throw new Error('authority generation value is unterminated')
  return `${observeDeployment.slice(0, valueStart)}${observeAuthorityGenerationHash}${observeDeployment.slice(valueEnd)}`
}

const paperAuthorityGenerationIdentity = (
  generation: PaperAuthorityGenerationMaterial | PaperAuthorityGeneration,
): Omit<PaperAuthorityGenerationMaterial, 'reconciliationId' | 'reconciliationContentHash'> => {
  const {
    generationHash: _generationHash,
    reconciliationContentHash: _reconciliationContentHash,
    reconciliationId: _reconciliationId,
    ...identity
  } = generation as PaperAuthorityGeneration
  return identity
}

export const paperAuthorityGenerationHash = (
  generation: PaperAuthorityGenerationMaterial | PaperAuthorityGeneration,
): string => canonicalHashV1(paperAuthorityGenerationIdentity(generation))

export const buildPaperActivationArtifact = (input: {
  readonly terminal: unknown
  readonly reviewedPins: unknown
}): PaperActivationArtifact | null => {
  const terminal = requireQualificationTerminal(input.terminal)
  if (terminal === null) throw new Error('qualification terminal evidence is invalid or unauthenticated')
  if (terminal.terminal.verdict === 'REJECTED') return null

  const reviewed = requireReviewedPins(input.reviewedPins)
  if (reviewed === null) throw new Error('reviewed PAPER activation pins are invalid or incomplete')
  if (reviewed.sourceSha !== terminal.sourceSha)
    throw new Error('reviewed source SHA does not match qualification terminal')
  if (reviewed.imageRepository !== terminal.image.repository || reviewed.imageDigest !== terminal.image.digest)
    throw new Error('reviewed image pin does not match qualification terminal')

  const activationId = `qualification-${terminal.githubRunId}-${terminal.githubRunAttempt}`
  const generationMaterial: PaperAuthorityGenerationMaterial = {
    schemaVersion: 'bayn.paper-authority-generation.v2',
    maximum: 'PAPER',
    previousGenerationHash: reviewed.previousGenerationHash,
    qualificationRunId: terminal.terminal.runId,
    qualificationLockId: terminal.terminal.lockId,
    qualificationResultHash: terminal.terminal.resultHash,
    protocolHash: reviewed.protocolHash,
    qualificationExecutionPolicyHash: reviewed.qualificationExecutionPolicyHash,
    qualificationSourceRevision: terminal.sourceSha,
    qualificationImageRepository: terminal.image.repository,
    qualificationImageDigest: terminal.image.digest,
    activationSourceRevision: terminal.sourceSha,
    activationImageRepository: terminal.image.repository,
    activationImageDigest: terminal.image.digest,
    strategyName: 'risk-balanced-trend',
    strategyBehaviorHash: reviewed.strategyBehaviorHash,
    strategyParameterHash: reviewed.strategyParameterHash,
    strategyParameterSchemaVersion: reviewed.strategyParameterSchemaVersion,
    accountId: reviewed.accountId,
    riskPolicyHash: reviewed.riskPolicyHash,
    proofPlanHash: reviewed.proofPlanHash,
    reconciliationId: reviewed.reconciliationId,
    reconciliationContentHash: reviewed.reconciliationContentHash,
  }
  const authorityGeneration: PaperAuthorityGeneration = {
    ...generationMaterial,
    generationHash: paperAuthorityGenerationHash(generationMaterial),
  }
  const evidence: PaperActivationEvidence = {
    schemaVersion: 2,
    repository: terminal.repository,
    mainSha: terminal.currentMainSha,
    currentMainSha: terminal.currentMainSha,
    sourceSha: terminal.sourceSha,
    imageRepository: terminal.image.repository,
    imageDigest: terminal.image.digest,
    protocolHash: reviewed.protocolHash,
    strategyBehaviorHash: reviewed.strategyBehaviorHash,
    strategyParameterHash: reviewed.strategyParameterHash,
    qualificationRunId: terminal.terminal.runId,
    qualificationDecision: 'QUALIFIED',
    qualificationObservedAt: terminal.audit.contamination.resultCommittedAt,
    qualificationExpiresAt: reviewed.qualificationExpiresAt,
    accountBindingHash: reviewed.accountBindingHash,
    brokerEnvironment: reviewed.brokerEnvironment,
    brokerBaseUrl: reviewed.brokerBaseUrl,
    maximumAuthority: reviewed.maximumAuthority,
    authorityGeneration,
    authorityExpiresAt: reviewed.authorityExpiresAt,
    unresolvedMutationCount: reviewed.unresolvedMutationCount,
    unknownMutationCount: reviewed.unknownMutationCount,
    openOrderCount: reviewed.openOrderCount,
    discrepancyCount: reviewed.discrepancyCount,
    reconciliation: reviewed.reconciliation,
    killSwitchActive: reviewed.killSwitchActive,
    identityGap: reviewed.identityGap,
    activationState: reviewed.activationState,
    activationId,
    qualificationTerminal: terminal,
  }
  return {
    evidence,
    pins: {
      sourceSha: evidence.sourceSha,
      imageRepository: evidence.imageRepository,
      imageDigest: evidence.imageDigest,
      protocolHash: evidence.protocolHash,
      strategyBehaviorHash: evidence.strategyBehaviorHash,
      strategyParameterHash: evidence.strategyParameterHash,
      qualificationRunId: evidence.qualificationRunId,
      accountBindingHash: evidence.accountBindingHash,
    },
  }
}

export const deriveObserveRollbackGeneration = (input: {
  readonly repository: string
  readonly activationId: string
  readonly sourceMainSha: string
  readonly previousObserveGenerationHash: string
  readonly paperAuthorityGenerationHash: string
}): ObserveRollbackGeneration => {
  if (input.repository.length === 0 || input.activationId.length === 0)
    throw new Error('rollback generation repository and activation id are required')
  if (!isSha(input.sourceMainSha)) throw new Error('rollback generation source main SHA is malformed')
  if (!isHash(input.previousObserveGenerationHash) || !isHash(input.paperAuthorityGenerationHash))
    throw new Error('rollback generation authority hash is malformed')
  const identity = {
    schemaVersion: 'bayn.observe-authority-rollback.v1' as const,
    repository: input.repository,
    activationId: input.activationId,
    sourceMainSha: input.sourceMainSha,
    previousObserveGenerationHash: input.previousObserveGenerationHash,
    paperAuthorityGenerationHash: input.paperAuthorityGenerationHash,
  }
  const generationHash = canonicalHashV1(identity)
  if (generationHash === input.previousObserveGenerationHash || generationHash === input.paperAuthorityGenerationHash)
    throw new Error('rollback generation is not fresh')
  return { ...identity, generationHash }
}

export const evaluatePaperActivation = (input: {
  readonly evidence: unknown
  readonly pins: unknown
  readonly manifestPins: unknown
  readonly now: string
  readonly expectedRepository: string
  readonly expectedActivationId: string
  readonly trustedCurrentMainSha: string
}): PaperActivationDecision => {
  const evidence = requireEvidence(input.evidence)
  if (evidence === null) return hold('invalid-evidence', 'activation evidence must contain the complete exact schema')
  const pins = requirePins(input.pins, pinKeys)
  if (pins === null) return hold('invalid-pins', 'reviewed pins must contain the complete exact schema')
  const manifestPins = requirePins(input.manifestPins, manifestPinKeys)
  if (manifestPins === null)
    return hold('invalid-manifest-pins', 'manifest pins must contain the complete exact schema')
  if (evidence.schemaVersion !== 2) return hold('unsupported-schema', 'activation evidence schema is unsupported')
  if (evidence.repository !== input.expectedRepository)
    return hold('repository-mismatch', 'evidence belongs to another repository')
  if (evidence.activationId !== input.expectedActivationId)
    return hold('activation-id-mismatch', 'activation id does not match the precommit')
  if (
    evidence.activationId !==
    `qualification-${evidence.qualificationTerminal.githubRunId}-${evidence.qualificationTerminal.githubRunAttempt}`
  )
    return hold('activation-id-mismatch', 'activation id does not match the authenticated qualification run')
  if (
    !isSha(input.trustedCurrentMainSha) ||
    !isSha(evidence.mainSha) ||
    evidence.mainSha !== evidence.currentMainSha ||
    evidence.mainSha !== input.trustedCurrentMainSha
  )
    return hold('noncurrent-main', 'activation source is not exact current main')
  if (!isSha(evidence.sourceSha) || !isDigest(evidence.imageDigest))
    return hold('invalid-source-pin', 'source or image digest pin is malformed')
  for (const [name, value] of Object.entries({
    protocolHash: evidence.protocolHash,
    strategyBehaviorHash: evidence.strategyBehaviorHash,
    strategyParameterHash: evidence.strategyParameterHash,
    qualificationRunId: evidence.qualificationRunId,
    accountBindingHash: evidence.accountBindingHash,
  })) {
    if (!isHash(value)) return hold('invalid-hash', `${name} is malformed`)
  }
  for (const key of pinKeys) {
    if (evidence[key] !== pins[key]) return hold('pin-mismatch', `${key} does not match the reviewed manifest pin`)
  }
  for (const key of ['sourceSha', 'strategyBehaviorHash', 'strategyParameterHash', 'qualificationRunId'] as const) {
    if (evidence[key] !== manifestPins[key])
      return hold('manifest-pin-mismatch', `${key} does not match the checked-out deployment pin`)
  }
  if (
    evidence.imageRepository !== manifestPins.deploymentImageRepository ||
    evidence.imageRepository !== manifestPins.kustomizeImageRepository
  )
    return hold('manifest-pin-mismatch', 'image repository does not match deployment and Kustomize')
  if (
    evidence.imageDigest !== manifestPins.deploymentImageDigest ||
    evidence.imageDigest !== manifestPins.kustomizeImageDigest
  )
    return hold('manifest-pin-mismatch', 'image digest does not match deployment and Kustomize')
  if (manifestPins.kustomizeImageTag !== `sha-${evidence.sourceSha}`)
    return hold('manifest-pin-mismatch', 'Kustomize image tag does not match the exact source SHA')
  if (!isHash(manifestPins.currentAuthorityGenerationHash))
    return hold('manifest-pin-mismatch', 'current OBSERVE authority generation is malformed')
  if (evidence.qualificationDecision !== 'QUALIFIED')
    return hold('qualification-not-qualified', 'qualification is not QUALIFIED')
  const now = Date.parse(input.now)
  const observed = Date.parse(evidence.qualificationObservedAt)
  const qualificationExpiry = Date.parse(evidence.qualificationExpiresAt)
  const authorityExpiry = Date.parse(evidence.authorityExpiresAt)
  if (![now, observed, qualificationExpiry, authorityExpiry].every(Number.isFinite))
    return hold('invalid-time', 'activation evidence contains an invalid timestamp')
  if (observed > now || qualificationExpiry <= now)
    return hold('qualification-stale', 'qualification evidence is future-dated or expired')
  if (authorityExpiry <= now) return hold('authority-expired', 'paper authority is expired')
  if (authorityExpiry > qualificationExpiry)
    return hold('authority-outlives-qualification', 'paper authority expires after its qualification evidence')
  if (authorityExpiry - now > maximumAuthorityDurationMs)
    return hold('authority-window-too-long', 'paper authority exceeds the bounded 90-minute window')
  if (evidence.brokerEnvironment !== 'sandbox' || evidence.maximumAuthority !== 'PAPER')
    return hold('not-paper-only', 'authority is not sandbox PAPER')
  if (evidence.brokerBaseUrl !== 'https://paper-api.alpaca.markets')
    return hold('live-money-endpoint', 'broker endpoint is not the canonical Alpaca paper endpoint')
  if (evidence.activationState !== 'PRECOMMITTED')
    return hold('activation-not-precommitted', 'activation is duplicate, in flight, consumed, or cancelled')
  const generation = evidence.authorityGeneration
  if (generation.generationHash !== paperAuthorityGenerationHash(generation))
    return hold('authority-generation-mismatch', 'authority generation hash is not Bayn canonical v2 identity')
  if (
    generation.previousGenerationHash !== manifestPins.currentAuthorityGenerationHash ||
    generation.qualificationRunId !== evidence.qualificationRunId ||
    generation.protocolHash !== evidence.protocolHash ||
    generation.activationSourceRevision !== evidence.sourceSha ||
    generation.activationImageRepository !== evidence.imageRepository ||
    generation.activationImageDigest !== evidence.imageDigest ||
    generation.strategyBehaviorHash !== evidence.strategyBehaviorHash ||
    generation.strategyParameterHash !== evidence.strategyParameterHash
  )
    return hold(
      'authority-generation-binding-mismatch',
      'canonical authority generation does not match the reviewed runtime and current OBSERVE generation',
    )
  if (
    evidence.unresolvedMutationCount !== 0 ||
    evidence.unknownMutationCount !== 0 ||
    evidence.openOrderCount !== 0 ||
    evidence.discrepancyCount !== 0
  )
    return hold('unsafe-runtime-state', 'mutations, orders, or discrepancies remain unresolved')
  if (evidence.reconciliation !== 'EXACT') return hold('reconciliation-not-exact', 'broker reconciliation is not exact')
  if (evidence.killSwitchActive !== false) return hold('kill-switch-active', 'kill switch is active')
  if (evidence.identityGap !== false) return hold('identity-gap', 'broker identity evidence is incomplete')
  return {
    status: 'eligible',
    activationId: evidence.activationId,
    authorityGenerationHash: generation.generationHash,
  }
}

const parseArguments = (arguments_: readonly string[]): Record<string, string> => {
  const result: Record<string, string> = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--'))
      throw new Error('arguments must be --key value pairs')
    result[key.slice(2)] = value
  }
  return result
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2))
    if (args.mode === 'build-evidence') {
      const artifact = buildPaperActivationArtifact({
        terminal: JSON.parse(readFileSync(args.terminal ?? '', 'utf8')) as unknown,
        reviewedPins: JSON.parse(readFileSync(args['reviewed-pins'] ?? '', 'utf8')) as unknown,
      })
      if (artifact === null) {
        if (args['github-output'] !== undefined) appendFileSync(args['github-output'], 'emit=false\n')
        console.log('BAYN_PAPER_ACTIVATION_EVIDENCE_NOT_EMITTED verdict=REJECTED')
        process.exit(0)
      }
      const outputDirectory = args['output-dir'] ?? ''
      mkdirSync(outputDirectory, { recursive: true })
      writeFileSync(`${outputDirectory}/evidence.json`, `${JSON.stringify(artifact.evidence, null, 2)}\n`)
      writeFileSync(`${outputDirectory}/pins.json`, `${JSON.stringify(artifact.pins, null, 2)}\n`)
      if (args['github-output'] !== undefined) appendFileSync(args['github-output'], 'emit=true\n')
      console.log('BAYN_PAPER_ACTIVATION_EVIDENCE_EMITTED')
      process.exit(0)
    }
    if (args.mode === 'extract-manifest-pins') {
      const manifestPins = extractPaperActivationManifestPins(
        readFileSync(args.deployment ?? '', 'utf8'),
        readFileSync(args.kustomization ?? '', 'utf8'),
      )
      writeFileSync(args.output ?? '', `${JSON.stringify(manifestPins, null, 2)}\n`)
      console.log('BAYN_PAPER_ACTIVATION_MANIFEST_PINS_EXTRACTED')
      process.exit(0)
    }
    if (args.mode === 'inspect-deployment-authority') {
      const authority = extractDeploymentAuthorityState(readFileSync(args.deployment ?? '', 'utf8'))
      writeFileSync(args.output ?? '', `${JSON.stringify(authority, null, 2)}\n`)
      console.log(`BAYN_PAPER_ACTIVATION_DEPLOYMENT_AUTHORITY ${authority.maximumAuthority}`)
      process.exit(0)
    }
    if (args.mode === 'render-transition') {
      const rendered = renderPaperActivationTransition(
        readFileSync(args.deployment ?? '', 'utf8'),
        args['authority-generation-hash'] ?? '',
        args['observe-authority-generation-hash'] ?? '',
        args['authority-expires-at'] ?? '',
      )
      writeFileSync(args['paper-output'] ?? '', rendered.paperDeployment)
      writeFileSync(args['observe-output'] ?? '', rendered.observeDeployment)
      console.log('BAYN_PAPER_ACTIVATION_TRANSITION_RENDERED')
      process.exit(0)
    }
    if (args.mode === 'derive-observe-rollback') {
      const generation = deriveObserveRollbackGeneration({
        repository: args.repository ?? '',
        activationId: args['activation-id'] ?? '',
        sourceMainSha: args['source-main-sha'] ?? '',
        previousObserveGenerationHash: args['previous-observe-generation-hash'] ?? '',
        paperAuthorityGenerationHash: args['paper-authority-generation-hash'] ?? '',
      })
      writeFileSync(args.output ?? '', `${JSON.stringify(generation, null, 2)}\n`)
      console.log(`BAYN_PAPER_ACTIVATION_OBSERVE_ROLLBACK_GENERATION ${generation.generationHash}`)
      process.exit(0)
    }
    if (args.mode === 'render-rollback') {
      writeFileSync(
        args.output ?? '',
        renderObserveRollback(
          readFileSync(args.deployment ?? '', 'utf8'),
          args['observe-authority-generation-hash'] ?? '',
        ),
      )
      console.log('BAYN_PAPER_ACTIVATION_ROLLBACK_RENDERED')
      process.exit(0)
    }
    const evidence = JSON.parse(readFileSync(args.evidence ?? '', 'utf8')) as unknown
    const pins = JSON.parse(readFileSync(args.pins ?? '', 'utf8')) as unknown
    const manifestPins = JSON.parse(readFileSync(args['manifest-pins'] ?? '', 'utf8')) as unknown
    const decision = evaluatePaperActivation({
      evidence,
      pins,
      now: args.now ?? new Date().toISOString(),
      expectedRepository: args.repository ?? '',
      expectedActivationId: args['activation-id'] ?? '',
      trustedCurrentMainSha: args['current-main-sha'] ?? '',
      manifestPins,
    })
    if (decision.status === 'hold') {
      console.error(`BAYN_PAPER_ACTIVATION_HOLD ${decision.code}: ${decision.message}`)
      process.exitCode = 1
    } else {
      console.log(
        `BAYN_PAPER_ACTIVATION_ELIGIBLE activation=${decision.activationId} authority_generation_hash=${decision.authorityGenerationHash}`,
      )
    }
  } catch (error) {
    console.error(
      `BAYN_PAPER_ACTIVATION_HOLD verifier-error: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    process.exitCode = 1
  }
}
