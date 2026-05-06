import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import type {
  AdmissionPassportConsumerClass,
  AdmissionPassportDecision,
  AdmissionPassportStatus,
  AdmissionPassportSubjectStatus,
  ExecutionTrustStatus,
  ProjectionWatermarkConsumerKey,
  ProjectionWatermarkStatus,
  RecoveryWarrantExecutionClass,
  RecoveryWarrantStatus,
  RuntimeKitComponentStatus,
  RuntimeKitDecision,
  RuntimeProofCellStatus,
  RuntimeProofKind,
  RuntimeKitStatus,
} from '~/data/agents-control-plane'
import { resolveCodexNatsHelperPathCandidatesFromConfig, resolveRuntimeAdmissionConfig } from './runtime-tooling-config'

const DEFAULT_WORKTREE = '/workspace/lab'
const PRODUCER_REVISION = '2026-03-21-runtime-admission-shadow-v1'
const WORKSPACE_CONTRACT_VERSION = '2026-03-20-runtime-kit-shadow-v1'
const RUNTIME_FRESHNESS_MS = 5 * 60 * 1000

const COLLABORATION_CONSUMERS: AdmissionPassportConsumerClass[] = ['swarm_plan', 'swarm_implement', 'swarm_verify']

export type RuntimeAdmissionSnapshot = {
  runtimeKits: RuntimeKitStatus[]
  admissionPassports: AdmissionPassportStatus[]
  servingPassportId: string | null
  recoveryWarrants: RecoveryWarrantStatus[]
  runtimeProofCells: RuntimeProofCellStatus[]
  projectionWatermarks: ProjectionWatermarkStatus[]
}

type RuntimeAdmissionInput = {
  now?: Date
  executionTrust?: ExecutionTrustStatus
  worktree?: string
  natsUrl?: string
}

const hashText = (value: string) => createHash('sha256').update(value).digest('hex')

const digestObject = (value: unknown) => hashText(JSON.stringify(value))

const shortDigest = (value: string) => value.slice(0, 16)

const addMs = (value: Date, ms: number) => new Date(value.getTime() + ms)

const unique = <T>(values: T[]) => [...new Set(values)]

const IMAGE_DIGEST_PATTERN = /sha256:[a-f0-9]{64}/i

const resolveWorktree = (value?: string) => {
  const configured = value?.trim() || resolveRuntimeAdmissionConfig(process.env).worktree
  if (configured && configured.length > 0) {
    return configured
  }
  const cwd = process.cwd().trim()
  return cwd.length > 0 ? cwd : DEFAULT_WORKTREE
}

const normalizeCandidate = (value: string | undefined | null) => value?.trim() ?? ''

const resolveNatsUrl = (configuredValue?: string) =>
  configuredValue?.trim() || resolveRuntimeAdmissionConfig(process.env).natsUrl

export const resolveCodexNatsHelperPathCandidates = ({
  worktree,
  command = 'codex-nats-publish',
  cwd,
}: {
  worktree?: string
  command?: 'codex-nats-publish' | 'codex-nats-soak'
  cwd?: string
} = {}) => {
  const resolvedCwd = normalizeCandidate(cwd) || process.cwd()
  return unique(
    resolveCodexNatsHelperPathCandidatesFromConfig(
      {
        ...resolveRuntimeAdmissionConfig(process.env),
        worktree: resolveWorktree(worktree),
      },
      command,
      resolvedCwd,
    ),
  )
}

const findExistingCandidate = (candidates: string[]) => candidates.find((candidate) => existsSync(candidate))

const isExecutablePath = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const resolveCommandCandidate = (command: string) => {
  const trimmed = command.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  if (trimmed.includes('/')) {
    return existsSync(trimmed) && isExecutablePath(trimmed) ? trimmed : undefined
  }

  const pathEntries = resolveRuntimeAdmissionConfig(process.env).pathEntries
  for (const entry of pathEntries) {
    const candidate = join(entry, trimmed)
    if (existsSync(candidate) && isExecutablePath(candidate)) {
      return candidate
    }
  }

  return undefined
}

const buildFileDigest = (path: string) => {
  const stats = statSync(path)
  return shortDigest(hashText(`${path}:${stats.size}:${stats.mtimeMs}`))
}

const buildRuntimeKitComponent = (input: {
  componentKind: RuntimeKitComponentStatus['component_kind']
  componentRef: string
  required: boolean
  path?: string
  reasonCode?: string
  evidenceRef?: string
}) => {
  const path = input.path
  const present = path !== undefined && existsSync(path) && (input.componentKind !== 'binary' || isExecutablePath(path))

  if (present) {
    return {
      component_kind: input.componentKind,
      component_ref: input.componentRef,
      required: input.required,
      present: true,
      digest: buildFileDigest(path),
      reason_code: null,
      evidence_ref: path,
    } satisfies RuntimeKitComponentStatus
  }

  return {
    component_kind: input.componentKind,
    component_ref: input.componentRef,
    required: input.required,
    present: false,
    digest: null,
    reason_code: input.reasonCode ?? null,
    evidence_ref: input.evidenceRef ?? input.path ?? null,
  } satisfies RuntimeKitComponentStatus
}

const buildConfigComponent = (input: {
  componentKind: RuntimeKitComponentStatus['component_kind']
  componentRef: string
  required: boolean
  value?: string
  reasonCode: string
}) => {
  const value = input.value?.trim() ?? ''
  if (value.length > 0) {
    return {
      component_kind: input.componentKind,
      component_ref: input.componentRef,
      required: input.required,
      present: true,
      digest: shortDigest(hashText(value)),
      reason_code: null,
      evidence_ref: input.componentRef,
    } satisfies RuntimeKitComponentStatus
  }

  return {
    component_kind: input.componentKind,
    component_ref: input.componentRef,
    required: input.required,
    present: false,
    digest: null,
    reason_code: input.reasonCode,
    evidence_ref: input.componentRef,
  } satisfies RuntimeKitComponentStatus
}

const summarizeKitDecision = (components: RuntimeKitComponentStatus[]): RuntimeKitDecision => {
  const missingRequired = components.some((component) => component.required && !component.present)
  if (missingRequired) {
    return 'blocked'
  }
  const missingOptional = components.some((component) => !component.required && !component.present)
  if (missingOptional) {
    return 'degraded'
  }
  return 'healthy'
}

const buildRuntimeKit = (input: {
  now: Date
  kitClass: RuntimeKitStatus['kit_class']
  subjectRef: string
  imageRef: string
  components: RuntimeKitComponentStatus[]
}) => {
  const componentDigest = shortDigest(
    digestObject(
      input.components.map((component) => ({
        component_kind: component.component_kind,
        component_ref: component.component_ref,
        digest: component.digest,
        present: component.present,
        reason_code: component.reason_code,
      })),
    ),
  )
  const decision = summarizeKitDecision(input.components)
  const reasonCodes = unique(
    input.components.map((component) => component.reason_code).filter((value): value is string => Boolean(value)),
  )

  return {
    runtime_kit_id: `runtime-kit:${input.kitClass}:${componentDigest}`,
    kit_class: input.kitClass,
    subject_ref: input.subjectRef,
    image_ref: input.imageRef,
    workspace_contract_version: WORKSPACE_CONTRACT_VERSION,
    component_digest: componentDigest,
    decision,
    observed_at: input.now.toISOString(),
    fresh_until: addMs(input.now, RUNTIME_FRESHNESS_MS).toISOString(),
    producer_revision: PRODUCER_REVISION,
    reason_codes: reasonCodes,
    components: input.components,
  } satisfies RuntimeKitStatus
}

const resolveAuthority = (executionTrust?: ExecutionTrustStatus) => {
  const trust =
    executionTrust ??
    ({
      status: 'healthy',
      reason: 'execution trust assumed healthy for runtime-local compilation',
      last_evaluated_at: new Date(0).toISOString(),
      blocking_windows: [],
      evidence_summary: [],
    } satisfies ExecutionTrustStatus)

  const recoveryCaseSetDigest = shortDigest(
    digestObject({
      status: trust.status,
      reason: trust.reason,
      blocking_windows: trust.blocking_windows,
      evidence_summary: trust.evidence_summary,
    }),
  )

  const reasonCodes =
    trust.status === 'healthy'
      ? []
      : [
          trust.status === 'blocked'
            ? 'execution_trust_blocked'
            : trust.status === 'unknown'
              ? 'execution_trust_unknown'
              : 'execution_trust_degraded',
        ]

  return {
    authoritySessionId: `authority-session:${recoveryCaseSetDigest}`,
    recoveryCaseSetDigest,
    reasonCodes,
    trust,
  }
}

const toRuntimeSubjectDecision = (decision: RuntimeKitDecision): AdmissionPassportDecision => {
  if (decision === 'blocked' || decision === 'unknown') {
    return 'block'
  }
  if (decision === 'degraded') {
    return 'hold'
  }
  return 'allow'
}

const buildPassport = (input: {
  now: Date
  consumerClass: AdmissionPassportConsumerClass
  authority: ReturnType<typeof resolveAuthority>
  runtimeKits: RuntimeKitStatus[]
}) => {
  const runtimeKitSetDigest = shortDigest(
    digestObject(
      input.runtimeKits.map((kit) => ({
        runtime_kit_id: kit.runtime_kit_id,
        decision: kit.decision,
        component_digest: kit.component_digest,
      })),
    ),
  )
  const runtimeReasons = input.runtimeKits.flatMap((kit) => kit.reason_codes)
  const reasonCodes = unique([...input.authority.reasonCodes, ...runtimeReasons])

  let decision: AdmissionPassportDecision = 'allow'
  if (input.authority.trust.status === 'blocked' || input.authority.trust.status === 'unknown') {
    decision = 'block'
  } else if (input.runtimeKits.some((kit) => kit.decision === 'blocked' || kit.decision === 'unknown')) {
    decision = 'block'
  } else if (input.authority.trust.status === 'degraded') {
    decision = input.consumerClass === 'serving' ? 'degrade' : 'hold'
  } else if (input.runtimeKits.some((kit) => kit.decision === 'degraded')) {
    decision = input.consumerClass === 'serving' ? 'degrade' : 'hold'
  }

  const requiredSubjects: AdmissionPassportSubjectStatus[] = [
    {
      subject_kind: 'authority',
      subject_ref: input.authority.authoritySessionId,
      required: true,
      decision:
        input.authority.trust.status === 'healthy'
          ? 'allow'
          : input.authority.trust.status === 'degraded'
            ? input.consumerClass === 'serving'
              ? 'degrade'
              : 'hold'
            : 'block',
      evidence_ref: input.authority.recoveryCaseSetDigest,
    },
    ...input.runtimeKits.map((kit) => ({
      subject_kind: 'runtime_kit' as const,
      subject_ref: kit.runtime_kit_id,
      required: true,
      decision: toRuntimeSubjectDecision(kit.decision),
      evidence_ref: kit.reason_codes[0] ?? kit.component_digest,
    })),
  ]

  const idSource = shortDigest(
    digestObject({
      authority_session_id: input.authority.authoritySessionId,
      runtime_kit_set_digest: runtimeKitSetDigest,
      decision,
      consumer_class: input.consumerClass,
      reason_codes: reasonCodes,
    }),
  )

  return {
    admission_passport_id: `passport:${input.consumerClass}:${idSource}`,
    consumer_class: input.consumerClass,
    authority_session_id: input.authority.authoritySessionId,
    recovery_case_set_digest: input.authority.recoveryCaseSetDigest,
    runtime_kit_set_digest: runtimeKitSetDigest,
    decision,
    reason_codes: reasonCodes,
    required_subjects: requiredSubjects,
    required_runtime_kits: input.runtimeKits.map((kit) => kit.runtime_kit_id),
    issued_at: input.now.toISOString(),
    fresh_until: addMs(input.now, RUNTIME_FRESHNESS_MS).toISOString(),
    producer_revision: PRODUCER_REVISION,
  } satisfies AdmissionPassportStatus
}

const proofKindForComponent = (component: RuntimeKitComponentStatus): RuntimeProofKind => {
  if (component.component_kind === 'binary' || component.component_kind === 'python_helper') {
    return 'helper_asset'
  }
  if (component.component_kind === 'config_file' || component.component_kind === 'service_url') {
    return 'config_digest'
  }
  if (component.component_kind === 'workspace_path') {
    return 'runtime_kit'
  }
  return 'runtime_kit'
}

const proofStatusForComponent = (component: RuntimeKitComponentStatus): RuntimeProofCellStatus['status'] => {
  if (component.present) {
    return 'healthy'
  }
  if (component.required) {
    return 'missing'
  }
  return 'degraded'
}

const proofStatusForRuntimeKit = (kit: RuntimeKitStatus): RuntimeProofCellStatus['status'] => {
  if (kit.decision === 'healthy') {
    return 'healthy'
  }
  if (kit.decision === 'degraded') {
    return 'degraded'
  }
  return 'missing'
}

const buildRuntimeProofCellId = (input: {
  recoveryWarrantId: string
  runtimeKitId: string
  proofKind: RuntimeProofKind
  proofSubject: string
  observedRef: string | null
  contentHash: string | null
  status: RuntimeProofCellStatus['status']
}) =>
  `runtime-proof-cell:${shortDigest(
    digestObject({
      recovery_warrant_id: input.recoveryWarrantId,
      runtime_kit_id: input.runtimeKitId,
      proof_kind: input.proofKind,
      proof_subject: input.proofSubject,
      observed_ref: input.observedRef,
      content_hash: input.contentHash,
      status: input.status,
    }),
  )}`

const buildRuntimeProofCell = (input: {
  recoveryWarrantId: string
  kit: RuntimeKitStatus
  proofKind: RuntimeProofKind
  proofSubject: string
  expectedRef: string | null
  observedRef: string | null
  artifactRef: string | null
  contentHash: string | null
  status: RuntimeProofCellStatus['status']
  required: boolean
  reasonCodes: string[]
}) =>
  ({
    runtime_proof_cell_id: buildRuntimeProofCellId({
      recoveryWarrantId: input.recoveryWarrantId,
      runtimeKitId: input.kit.runtime_kit_id,
      proofKind: input.proofKind,
      proofSubject: input.proofSubject,
      observedRef: input.observedRef,
      contentHash: input.contentHash,
      status: input.status,
    }),
    recovery_warrant_id: input.recoveryWarrantId,
    runtime_kit_id: input.kit.runtime_kit_id,
    proof_kind: input.proofKind,
    proof_subject: input.proofSubject,
    expected_ref: input.expectedRef,
    observed_ref: input.observedRef,
    artifact_ref: input.artifactRef,
    content_hash: input.contentHash,
    status: input.status,
    required: input.required,
    reason_codes: unique(input.reasonCodes),
    observed_at: input.kit.observed_at,
    expires_at: input.kit.fresh_until,
  }) satisfies RuntimeProofCellStatus

const buildRuntimeProofCellsForWarrant = ({
  recoveryWarrantId,
  runtimeKits,
}: {
  recoveryWarrantId: string
  runtimeKits: RuntimeKitStatus[]
}) =>
  runtimeKits.flatMap((kit) => {
    const imageRef = kit.image_ref.trim()
    const imageCell = buildRuntimeProofCell({
      recoveryWarrantId,
      kit,
      proofKind: 'image_digest',
      proofSubject: `${kit.kit_class}:image`,
      expectedRef: 'JANGAR_RUNTIME_IMAGE',
      observedRef: imageRef.length > 0 ? imageRef : null,
      artifactRef: imageRef.length > 0 ? imageRef : null,
      contentHash: imageRef.length > 0 ? shortDigest(hashText(imageRef)) : null,
      status: imageRef.length > 0 ? 'healthy' : 'missing',
      required: true,
      reasonCodes: imageRef.length > 0 ? [] : ['runtime_proof_missing:image_digest'],
    })
    const runtimeKitCell = buildRuntimeProofCell({
      recoveryWarrantId,
      kit,
      proofKind: 'runtime_kit',
      proofSubject: kit.runtime_kit_id,
      expectedRef: kit.component_digest,
      observedRef: kit.decision,
      artifactRef: kit.subject_ref,
      contentHash: kit.component_digest,
      status: proofStatusForRuntimeKit(kit),
      required: true,
      reasonCodes: kit.decision === 'healthy' ? [] : kit.reason_codes,
    })
    const componentCells = kit.components.map((component) => {
      const status = proofStatusForComponent(component)
      const reasonCodes =
        status === 'healthy'
          ? []
          : [component.reason_code ?? `runtime_proof_missing:${component.component_kind}:${component.component_ref}`]
      return buildRuntimeProofCell({
        recoveryWarrantId,
        kit,
        proofKind: proofKindForComponent(component),
        proofSubject: `${component.component_kind}:${component.component_ref}`,
        expectedRef: component.component_ref,
        observedRef: component.present ? (component.evidence_ref ?? component.component_ref) : null,
        artifactRef: component.evidence_ref,
        contentHash: component.digest,
        status,
        required: component.required,
        reasonCodes,
      })
    })

    return [imageCell, runtimeKitCell, ...componentCells]
  })

const warrantExecutionClassesForPassport = (passport: AdmissionPassportStatus): RecoveryWarrantExecutionClass[] => {
  if (passport.consumer_class === 'serving') {
    return ['serving']
  }
  if (passport.consumer_class === 'swarm_plan') {
    return ['discover', 'plan']
  }
  if (passport.consumer_class === 'swarm_implement') {
    return ['collaboration', 'implement']
  }
  return ['verify']
}

const projectionConsumerKeysForWarrant = (
  executionClass: RecoveryWarrantExecutionClass,
): ProjectionWatermarkConsumerKey[] => {
  if (executionClass === 'serving') {
    return ['jangar_ready', 'control_plane_status', 'deploy_verification']
  }
  if (executionClass === 'plan' || executionClass === 'implement' || executionClass === 'verify') {
    return ['control_plane_status', 'deploy_verification']
  }
  return ['control_plane_status']
}

const buildRecoveryWarrantId = ({
  passport,
  executionClass,
}: {
  passport: AdmissionPassportStatus
  executionClass: RecoveryWarrantExecutionClass
}) =>
  `recovery-warrant:${executionClass}:${shortDigest(
    digestObject({
      admission_passport_id: passport.admission_passport_id,
      execution_class: executionClass,
      runtime_kit_set_digest: passport.runtime_kit_set_digest,
      decision: passport.decision,
      fresh_until: passport.fresh_until,
    }),
  )}`

const buildProjectionWatermarkId = ({
  consumerKey,
  recoveryWarrantId,
  runtimeKitDigest,
}: {
  consumerKey: ProjectionWatermarkConsumerKey
  recoveryWarrantId: string
  runtimeKitDigest: string
}) =>
  `projection-watermark:${consumerKey}:${shortDigest(
    digestObject({
      consumer_key: consumerKey,
      recovery_warrant_id: recoveryWarrantId,
      runtime_kit_digest: runtimeKitDigest,
    }),
  )}`

const extractAdmittedImageDigest = (runtimeKits: RuntimeKitStatus[]) => {
  const digests = unique(
    runtimeKits
      .map((kit) => kit.image_ref.match(IMAGE_DIGEST_PATTERN)?.[0]?.toLowerCase() ?? null)
      .filter((value): value is string => Boolean(value)),
  )
  if (digests.length === 0) {
    return null
  }
  if (digests.length === 1) {
    return digests[0] ?? null
  }
  return `mixed:${shortDigest(digestObject(digests))}`
}

const buildRecoveryWarrantStatus = ({
  passport,
  executionClass,
  runtimeKits,
  proofCells,
  projectionWatermarkIds,
  recoveryWarrantId,
}: {
  passport: AdmissionPassportStatus
  executionClass: RecoveryWarrantExecutionClass
  runtimeKits: RuntimeKitStatus[]
  proofCells: RuntimeProofCellStatus[]
  projectionWatermarkIds: string[]
  recoveryWarrantId: string
}) => {
  const failedRequiredProofs = proofCells.filter(
    (cell) =>
      cell.required && (cell.status === 'missing' || cell.status === 'expired' || cell.status === 'quarantined'),
  )
  const degradedProofs = proofCells.filter((cell) => cell.required && cell.status === 'degraded')
  let status: RecoveryWarrantStatus['status'] = 'sealed'
  if (passport.decision === 'block' || passport.decision === 'hold' || failedRequiredProofs.length > 0) {
    status = 'broken'
  } else if (passport.decision === 'degrade' || degradedProofs.length > 0) {
    status = 'active'
  }

  const reasonCodes = unique([
    ...passport.reason_codes,
    ...proofCells.filter((cell) => cell.status !== 'healthy').flatMap((cell) => cell.reason_codes),
  ])

  return {
    recovery_warrant_id: recoveryWarrantId,
    recovery_epoch_id: `recovery-epoch:${shortDigest(
      digestObject({
        execution_class: executionClass,
        runtime_kit_digest: passport.runtime_kit_set_digest,
        opened_at: passport.issued_at,
      }),
    )}`,
    swarm_name: 'jangar-control-plane',
    execution_class: executionClass,
    admitted_revision: passport.producer_revision,
    admitted_image_digest: extractAdmittedImageDigest(runtimeKits),
    runtime_kit_digest: passport.runtime_kit_set_digest,
    admission_passport_id: passport.admission_passport_id,
    required_proof_cell_ids: proofCells.filter((cell) => cell.required).map((cell) => cell.runtime_proof_cell_id),
    active_backlog_seat_count: 0,
    projection_watermark_ids: projectionWatermarkIds,
    status,
    opened_at: passport.issued_at,
    sealed_at: status === 'sealed' ? passport.issued_at : null,
    superseded_at: null,
    reason_codes: reasonCodes,
  } satisfies RecoveryWarrantStatus
}

const buildProjectionWatermark = ({
  consumerKey,
  warrant,
  passport,
}: {
  consumerKey: ProjectionWatermarkConsumerKey
  warrant: RecoveryWarrantStatus
  passport: AdmissionPassportStatus
}) =>
  ({
    projection_watermark_id: buildProjectionWatermarkId({
      consumerKey,
      recoveryWarrantId: warrant.recovery_warrant_id,
      runtimeKitDigest: warrant.runtime_kit_digest,
    }),
    consumer_key: consumerKey,
    recovery_warrant_id: warrant.recovery_warrant_id,
    projection_digest: shortDigest(
      digestObject({
        recovery_warrant_id: warrant.recovery_warrant_id,
        status: warrant.status,
        runtime_kit_digest: warrant.runtime_kit_digest,
        required_proof_cell_ids: warrant.required_proof_cell_ids,
      }),
    ),
    source_ref: `admission-passport:${passport.admission_passport_id}`,
    observed_at: passport.issued_at,
    expires_at: passport.fresh_until,
    status: warrant.status === 'sealed' ? 'fresh' : 'degraded',
    reason_codes: warrant.reason_codes,
  }) satisfies ProjectionWatermarkStatus

const buildRuntimeProofSurface = ({
  runtimeKits,
  admissionPassports,
}: {
  runtimeKits: RuntimeKitStatus[]
  admissionPassports: AdmissionPassportStatus[]
}) => {
  const runtimeKitById = new Map(runtimeKits.map((kit) => [kit.runtime_kit_id, kit]))
  const recoveryWarrants: RecoveryWarrantStatus[] = []
  const runtimeProofCells: RuntimeProofCellStatus[] = []
  const projectionWatermarks: ProjectionWatermarkStatus[] = []

  for (const passport of admissionPassports) {
    const requiredRuntimeKits = passport.required_runtime_kits
      .map((runtimeKitId) => runtimeKitById.get(runtimeKitId))
      .filter((kit): kit is RuntimeKitStatus => Boolean(kit))

    for (const executionClass of warrantExecutionClassesForPassport(passport)) {
      const recoveryWarrantId = buildRecoveryWarrantId({ passport, executionClass })
      const proofCells = buildRuntimeProofCellsForWarrant({
        recoveryWarrantId,
        runtimeKits: requiredRuntimeKits,
      })
      const projectionWatermarkIds = projectionConsumerKeysForWarrant(executionClass).map((consumerKey) =>
        buildProjectionWatermarkId({
          consumerKey,
          recoveryWarrantId,
          runtimeKitDigest: passport.runtime_kit_set_digest,
        }),
      )
      const warrant = buildRecoveryWarrantStatus({
        passport,
        executionClass,
        runtimeKits: requiredRuntimeKits,
        proofCells,
        projectionWatermarkIds,
        recoveryWarrantId,
      })
      const watermarks = projectionConsumerKeysForWarrant(executionClass).map((consumerKey) =>
        buildProjectionWatermark({
          consumerKey,
          warrant,
          passport,
        }),
      )

      recoveryWarrants.push(warrant)
      runtimeProofCells.push(...proofCells)
      projectionWatermarks.push(...watermarks)
    }
  }

  return {
    recoveryWarrants,
    runtimeProofCells,
    projectionWatermarks,
  }
}

export const resolveAdmissionPassportConsumerClass = (
  stage: string | null | undefined,
): AdmissionPassportConsumerClass => {
  const normalized = stage?.trim().toLowerCase()
  if (normalized === 'verify') {
    return 'swarm_verify'
  }
  if (normalized === 'implement' || normalized === 'implementation' || normalized === 'review') {
    return 'swarm_implement'
  }
  return 'swarm_plan'
}

export const findAdmissionPassport = ({
  admissionPassports,
  consumerClass,
}: {
  admissionPassports: AdmissionPassportStatus[]
  consumerClass: AdmissionPassportConsumerClass
}) => admissionPassports.find((passport) => passport.consumer_class === consumerClass)

export const buildRuntimeAdmissionSnapshot = (input: RuntimeAdmissionInput = {}): RuntimeAdmissionSnapshot => {
  const now = input.now ?? new Date()
  const runtimeConfig = resolveRuntimeAdmissionConfig(process.env)
  const imageRef = runtimeConfig.runtimeImage
  const worktree = resolveWorktree(input.worktree)
  const natsUrl = resolveNatsUrl(input.natsUrl)
  const natsPublishCandidates = resolveCodexNatsHelperPathCandidates({
    worktree,
    command: 'codex-nats-publish',
  })
  const natsSoakCandidates = resolveCodexNatsHelperPathCandidates({
    worktree,
    command: 'codex-nats-soak',
  })
  const resolvedNatsPublishPath = findExistingCandidate(natsPublishCandidates)
  const resolvedNatsSoakPath = findExistingCandidate(natsSoakCandidates)
  const resolvedNatsCliPath = resolveCommandCandidate('nats')

  const servingKit = buildRuntimeKit({
    now,
    kitClass: 'serving',
    subjectRef: 'jangar:/ready',
    imageRef,
    components: [
      buildRuntimeKitComponent({
        componentKind: 'binary',
        componentRef: process.execPath,
        required: true,
        path: process.execPath,
        reasonCode: 'runtime_kit_component_missing:serving_runtime_binary',
      }),
    ],
  })

  const collaborationKit = buildRuntimeKit({
    now,
    kitClass: 'collaboration',
    subjectRef: 'jangar:codex:nats-collaboration',
    imageRef,
    components: [
      buildRuntimeKitComponent({
        componentKind: 'binary',
        componentRef: resolvedNatsPublishPath ?? natsPublishCandidates[0] ?? 'codex-nats-publish',
        required: true,
        path: resolvedNatsPublishPath,
        reasonCode: 'runtime_kit_component_missing:codex_nats_publish',
        evidenceRef: `checked_paths=[${natsPublishCandidates.join(', ')}]`,
      }),
      buildRuntimeKitComponent({
        componentKind: 'binary',
        componentRef: resolvedNatsSoakPath ?? natsSoakCandidates[0] ?? 'codex-nats-soak',
        required: true,
        path: resolvedNatsSoakPath,
        reasonCode: 'runtime_kit_component_missing:codex_nats_soak',
        evidenceRef: `checked_paths=[${natsSoakCandidates.join(', ')}]`,
      }),
      buildRuntimeKitComponent({
        componentKind: 'binary',
        componentRef: 'nats',
        required: true,
        path: resolvedNatsCliPath,
        reasonCode: 'runtime_kit_component_missing:nats_cli',
        evidenceRef: 'nats',
      }),
      buildRuntimeKitComponent({
        componentKind: 'workspace_path',
        componentRef: worktree,
        required: true,
        path: worktree,
        reasonCode: 'runtime_kit_component_missing:worktree',
        evidenceRef: worktree,
      }),
      buildConfigComponent({
        componentKind: 'service_url',
        componentRef: 'NATS_URL',
        required: true,
        value: natsUrl,
        reasonCode: 'runtime_kit_component_missing:nats_url',
      }),
    ],
  })

  const authority = resolveAuthority(input.executionTrust)
  const runtimeKits = [servingKit, collaborationKit]
  const admissionPassports = [
    buildPassport({
      now,
      consumerClass: 'serving',
      authority,
      runtimeKits: [servingKit],
    }),
    ...COLLABORATION_CONSUMERS.map((consumerClass) =>
      buildPassport({
        now,
        consumerClass,
        authority,
        runtimeKits: [collaborationKit],
      }),
    ),
  ]
  const runtimeProofSurface = buildRuntimeProofSurface({
    runtimeKits,
    admissionPassports,
  })

  return {
    runtimeKits,
    admissionPassports,
    servingPassportId:
      admissionPassports.find((passport) => passport.consumer_class === 'serving')?.admission_passport_id ?? null,
    recoveryWarrants: runtimeProofSurface.recoveryWarrants,
    runtimeProofCells: runtimeProofSurface.runtimeProofCells,
    projectionWatermarks: runtimeProofSurface.projectionWatermarks,
  }
}
