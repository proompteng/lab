import { createHash } from 'node:crypto'

import type {
  AdmissionPassportStatus,
  ProjectionWatermarkConsumerKey,
  ProjectionWatermarkStatus,
  RecoveryWarrantExecutionClass,
  RecoveryWarrantStatus,
  RuntimeKitComponentStatus,
  RuntimeKitStatus,
  RuntimeProofCellStatus,
  RuntimeProofKind,
} from '~/server/control-plane-status-types'

const IMAGE_DIGEST_PATTERN = /sha256:[a-f0-9]{64}/i

const hashText = (value: string) => createHash('sha256').update(value).digest('hex')

const digestObject = (value: unknown) => hashText(JSON.stringify(value))

const shortDigest = (value: string) => value.slice(0, 16)

const unique = <T>(values: T[]) => [...new Set(values)]

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
        admission_passport_id: passport.admission_passport_id,
        execution_class: executionClass,
        runtime_kit_digest: passport.runtime_kit_set_digest,
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

export const buildRuntimeProofSurface = ({
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
