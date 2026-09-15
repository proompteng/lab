import { createHash } from 'node:crypto'

export type RuntimeKitClass = 'serving' | 'collaboration'

export type RuntimeKitDecision = 'healthy' | 'degraded' | 'blocked' | 'unknown'

export type RuntimeKitComponentKind = 'python_helper' | 'binary' | 'workspace_path' | 'config_file' | 'service_url'

export type RuntimeKitComponentStatus = {
  component_kind: RuntimeKitComponentKind
  component_ref: string
  required: boolean
  present: boolean
  digest: string | null
  reason_code: string | null
  evidence_ref: string | null
}

export type RuntimeKitStatus = {
  runtime_kit_id: string
  kit_class: RuntimeKitClass
  subject_ref: string
  image_ref: string
  workspace_contract_version: string
  component_digest: string
  decision: RuntimeKitDecision
  observed_at: string
  fresh_until: string
  producer_revision: string
  reason_codes: string[]
  components: RuntimeKitComponentStatus[]
}

export type AdmissionPassportConsumerClass = 'serving' | 'swarm_plan' | 'swarm_implement' | 'swarm_verify'

export type AdmissionPassportDecision = 'allow' | 'degrade' | 'hold' | 'block'

export type AdmissionPassportSubjectStatus = {
  subject_kind: 'authority' | 'runtime_kit'
  subject_ref: string
  required: boolean
  decision: AdmissionPassportDecision
  evidence_ref: string | null
}

export type AdmissionPassportStatus = {
  admission_passport_id: string
  consumer_class: AdmissionPassportConsumerClass
  authority_session_id: string
  recovery_case_set_digest: string
  runtime_kit_set_digest: string
  decision: AdmissionPassportDecision
  reason_codes: string[]
  required_subjects: AdmissionPassportSubjectStatus[]
  required_runtime_kits: string[]
  issued_at: string
  fresh_until: string
  producer_revision: string
}

export const findAdmissionPassport = ({
  admissionPassports,
  consumerClass,
}: {
  admissionPassports: AdmissionPassportStatus[]
  consumerClass: AdmissionPassportConsumerClass
}) => admissionPassports.find((passport) => passport.consumer_class === consumerClass)

export type RecoveryWarrantExecutionClass = 'serving' | 'collaboration' | 'discover' | 'plan' | 'implement' | 'verify'

export type RecoveryWarrantStatusValue = 'draft' | 'active' | 'sealed' | 'superseded' | 'broken' | 'quarantined'

export type RuntimeProofKind =
  | 'image_digest'
  | 'runtime_kit'
  | 'helper_asset'
  | 'config_digest'
  | 'secret_binding'
  | 'network_identity'

export type RuntimeProofCellStatusValue = 'healthy' | 'degraded' | 'missing' | 'expired' | 'quarantined'

export type RuntimeProofCellStatus = {
  runtime_proof_cell_id: string
  recovery_warrant_id: string | null
  runtime_kit_id: string
  proof_kind: RuntimeProofKind
  proof_subject: string
  expected_ref: string | null
  observed_ref: string | null
  artifact_ref: string | null
  content_hash: string | null
  status: RuntimeProofCellStatusValue
  required: boolean
  reason_codes: string[]
  observed_at: string
  expires_at: string
}

export type ProjectionWatermarkStatusValue = 'fresh' | 'degraded' | 'expired' | 'quarantined'

export type ProjectionWatermarkConsumerKey = 'service_ready' | 'control_plane_status' | 'deploy_verification'

export type ProjectionWatermarkStatus = {
  projection_watermark_id: string
  consumer_key: ProjectionWatermarkConsumerKey
  recovery_warrant_id: string
  projection_digest: string
  source_ref: string
  observed_at: string
  expires_at: string
  status: ProjectionWatermarkStatusValue
  reason_codes: string[]
}

export type RecoveryWarrantStatus = {
  recovery_warrant_id: string
  recovery_epoch_id: string
  swarm_name: string
  execution_class: RecoveryWarrantExecutionClass
  admitted_revision: string
  admitted_image_digest: string | null
  runtime_kit_digest: string
  admission_passport_id: string | null
  required_proof_cell_ids: string[]
  active_backlog_seat_count: number
  projection_watermark_ids: string[]
  status: RecoveryWarrantStatusValue
  opened_at: string
  sealed_at: string | null
  superseded_at: string | null
  reason_codes: string[]
}

export type RuntimeAdmissionSnapshot = {
  runtimeKits: RuntimeKitStatus[]
  admissionPassports: AdmissionPassportStatus[]
  servingPassportId: string | null
  recoveryWarrants: RecoveryWarrantStatus[]
  runtimeProofCells: RuntimeProofCellStatus[]
  projectionWatermarks: ProjectionWatermarkStatus[]
}

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
  imageExpectedRef,
}: {
  recoveryWarrantId: string
  runtimeKits: RuntimeKitStatus[]
  imageExpectedRef: string
}) =>
  runtimeKits.flatMap((kit) => {
    const imageRef = kit.image_ref.trim()
    const imageCell = buildRuntimeProofCell({
      recoveryWarrantId,
      kit,
      proofKind: 'image_digest',
      proofSubject: `${kit.kit_class}:image`,
      expectedRef: imageExpectedRef,
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
    return ['service_ready', 'control_plane_status', 'deploy_verification']
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
    swarm_name: 'agents-control-plane',
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
  imageExpectedRef = 'RUNTIME_IMAGE',
}: {
  runtimeKits: RuntimeKitStatus[]
  admissionPassports: AdmissionPassportStatus[]
  imageExpectedRef?: string
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
        imageExpectedRef,
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
