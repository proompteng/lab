#!/usr/bin/env bun

import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'

const ROUTE_BOARD_SCHEMA_VERSION = 'torghut.route-reacquisition-board.v1'
const PROOFS_SCHEMA_VERSION = 'torghut.proofs.v1'
const PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION = 'torghut.paper-route-evidence.v1'
const PAPER_ROUTE_TARGETS_SCHEMA_VERSION = 'torghut.next-paper-route-runtime-window-targets.v1'
const RUNTIME_WINDOW_IMPORT_HEALTH_GATE_SCHEMA_VERSION = 'torghut.runtime-window-import-health-gate.v1'
const RUNTIME_WINDOW_IMPORT_HEALTH_GATE_SUMMARY_SCHEMA_VERSION = 'torghut.runtime-window-import-health-gate-summary.v1'
const ACCEPTED_SOURCE_STALE_REASON = 'accepted_ta_signal_stale'

type JsonObject = Record<string, unknown>

type RuntimeWindowImportHealthGate = {
  dependencyQuorumDecision: string
  continuityOk: string
  driftOk: string
}

type PostDeployEvidenceInput = {
  readyzHttpStatus: string
  readyz: unknown
  revenueRepairDigest: unknown
  tradingStatus: unknown
  paperRouteEvidence?: unknown
  simPaperRouteEvidence?: unknown
}

type LiveSubmitContract =
  | 'accepted_source_stale_zero_notional'
  | 'bounded_live_submit_active'
  | 'expired_activation_blocked'
  | 'operational_zero_notional_repair'
  | 'shadow_zero_notional_gate_closed'

export type PostDeployEvidenceResult = {
  readyzAcceptedReason: 'healthy_2xx' | 'repair_only_zero_notional' | 'core_dependencies_only_gate_closed'
  readyzStatusCode: number
  summaryLines: string[]
  liveSubmitContract?: LiveSubmitContract
}

const requireObject = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonObject
}

const requireNonNegativeInteger = (value: unknown, label: string): number => {
  const normalized = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return normalized
}

const formatScalar = (value: unknown, fallback = 'unknown'): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

const normalizedScalar = (value: unknown): string => formatScalar(value, '').trim().toLowerCase()

const requireBoolean = (value: unknown, label: string): boolean => {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new Error(`${label} must be a boolean`)
}

const requireScalarValue = (value: unknown, expected: string, label: string) => {
  if (normalizedScalar(value) !== expected) {
    throw new Error(`${label} must be ${expected}`)
  }
}

const requireTimestamp = (value: unknown, label: string): string => {
  const timestamp = formatScalar(value, '').trim()
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${label} must be a parseable timestamp`)
  }
  return timestamp
}

const requireArrayIncludes = (value: unknown, expected: string, label: string) => {
  const values = requireArray(value, label).map((item) => formatScalar(item, ''))
  if (!values.includes(expected)) {
    throw new Error(`${label} must include ${expected}`)
  }
}

const arrayIncludesScalar = (value: unknown, expected: string): boolean =>
  Array.isArray(value) && value.map((item) => formatScalar(item, '')).includes(expected)

const parseHttpStatus = (value: string): number => {
  if (!/^[0-9]{3}$/.test(value)) {
    throw new Error(`Torghut /readyz returned invalid HTTP status ${value}`)
  }
  return Number(value)
}

const requireDependencyOk = (dependencies: JsonObject, name: string) => {
  const dependency = requireObject(dependencies[name], `readyz dependencies.${name}`)
  if (dependency.ok !== true) {
    throw new Error(`readyz dependencies.${name}.ok must be true for repair-only rollout acceptance`)
  }
}

const requireArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
  return value
}

const collectDependencyFailureNames = (digest: JsonObject): Set<string> => {
  const health = requireObject(digest.health, 'torghut revenue repair digest health')
  const failures = health.dependency_failures
  if (!Array.isArray(failures)) {
    return new Set()
  }

  return new Set(
    failures
      .filter((failure) => failure && typeof failure === 'object' && !Array.isArray(failure))
      .map((failure) => formatScalar((failure as JsonObject).name, ''))
      .filter(Boolean),
  )
}

const assertRepairOnlyZeroNotionalDigest = (digest: JsonObject, expectedReadyzStatus?: 'degraded') => {
  if (digest.business_state !== 'repair_only' || digest.revenue_ready !== false) {
    throw new Error('revenue repair digest must report repair_only and revenue_ready=false')
  }

  const health = requireObject(digest.health, 'torghut revenue repair digest health')
  if (expectedReadyzStatus && health.readyz_status !== expectedReadyzStatus) {
    throw new Error(`revenue repair digest must mirror ${expectedReadyzStatus} readyz state`)
  }

  const capital = requireObject(digest.capital, 'torghut revenue repair digest capital')
  if (
    capital.live_submission_allowed !== false ||
    capital.capital_state !== 'zero_notional' ||
    formatScalar(capital.max_notional, '') !== '0'
  ) {
    throw new Error('repair-only rollout acceptance requires live submission disabled with max_notional=0')
  }

  const allowedFailureNames = new Set(['live_submission_gate', 'profitability_proof_floor'])
  const failureNames = collectDependencyFailureNames(digest)
  const unexpectedFailures = [...failureNames].filter((name) => !allowedFailureNames.has(name))
  if (unexpectedFailures.length > 0) {
    throw new Error(`unexpected readyz dependency failures: ${unexpectedFailures.join(', ')}`)
  }
}

const assertRepairOnlyZeroNotionalReadyz = (readyz: JsonObject, digest: JsonObject) => {
  if (readyz.status !== 'degraded') {
    throw new Error('non-2xx /readyz is only accepted when payload.status is degraded')
  }

  const dependencies = requireObject(readyz.dependencies, 'readyz dependencies')
  requireDependencyOk(dependencies, 'postgres')
  requireDependencyOk(dependencies, 'clickhouse')
  requireDependencyOk(dependencies, 'database')

  const scheduler = requireObject(readyz.scheduler, 'readyz scheduler')
  if (scheduler.ok !== true || scheduler.running !== true) {
    throw new Error('readyz scheduler must be ok and running for repair-only rollout acceptance')
  }

  const liveSubmissionGate = requireObject(
    dependencies.live_submission_gate,
    'readyz dependencies.live_submission_gate',
  )
  if (liveSubmissionGate.detail !== 'simple_submit_disabled') {
    throw new Error('repair-only rollout acceptance requires live_submission_gate.detail=simple_submit_disabled')
  }

  const proofFloor = requireObject(
    dependencies.profitability_proof_floor,
    'readyz dependencies.profitability_proof_floor',
  )
  if (proofFloor.detail !== 'repair_only' || proofFloor.capital_state !== 'zero_notional') {
    throw new Error('repair-only rollout acceptance requires profitability_proof_floor repair_only zero_notional')
  }

  assertRepairOnlyZeroNotionalDigest(digest, 'degraded')
  const health = requireObject(digest.health, 'torghut revenue repair digest health')
  if (health.readyz_ok !== false) {
    throw new Error('revenue repair digest must mirror degraded readyz state')
  }

  const allowedFailureNames = new Set(['live_submission_gate', 'profitability_proof_floor'])
  const failureNames = collectDependencyFailureNames(digest)
  const unexpectedFailures = [...failureNames].filter((name) => !allowedFailureNames.has(name))
  if (unexpectedFailures.length > 0) {
    throw new Error(`unexpected readyz dependency failures: ${unexpectedFailures.join(', ')}`)
  }
  for (const requiredFailure of allowedFailureNames) {
    if (!failureNames.has(requiredFailure)) {
      throw new Error(`missing expected repair-only dependency failure: ${requiredFailure}`)
    }
  }
}

const isAcceptedSourceStaleReadyz = (readyz: JsonObject): boolean => {
  const dependencies =
    readyz.dependencies && typeof readyz.dependencies === 'object' && !Array.isArray(readyz.dependencies)
      ? (readyz.dependencies as JsonObject)
      : {}
  const dependencyGate =
    dependencies.live_submission_gate &&
    typeof dependencies.live_submission_gate === 'object' &&
    !Array.isArray(dependencies.live_submission_gate)
      ? (dependencies.live_submission_gate as JsonObject)
      : {}
  const liveSubmissionGate =
    readyz.live_submission_gate &&
    typeof readyz.live_submission_gate === 'object' &&
    !Array.isArray(readyz.live_submission_gate)
      ? (readyz.live_submission_gate as JsonObject)
      : {}
  return (
    readyz.status === 'degraded' &&
    dependencyGate.detail === ACCEPTED_SOURCE_STALE_REASON &&
    liveSubmissionGate.allowed === false &&
    liveSubmissionGate.reason === ACCEPTED_SOURCE_STALE_REASON
  )
}

const assertAcceptedSourceStaleZeroNotionalReadyz = (readyz: JsonObject, status: JsonObject, digest: JsonObject) => {
  if (readyz.status !== 'degraded') {
    throw new Error('accepted-source stale /readyz is only accepted when payload.status is degraded')
  }

  const dependencies = requireObject(readyz.dependencies, 'readyz dependencies')
  requireDependencyOk(dependencies, 'postgres')
  requireDependencyOk(dependencies, 'clickhouse')
  requireDependencyOk(dependencies, 'database')

  const scheduler = requireObject(readyz.scheduler, 'readyz scheduler')
  if (scheduler.ok !== true || scheduler.running !== true) {
    throw new Error('readyz scheduler must be ok and running for accepted-source stale rollout acceptance')
  }

  const liveSubmissionGate = requireObject(
    dependencies.live_submission_gate,
    'readyz dependencies.live_submission_gate',
  )
  if (liveSubmissionGate.detail !== ACCEPTED_SOURCE_STALE_REASON) {
    throw new Error(
      'accepted-source stale rollout acceptance requires live_submission_gate.detail=accepted_ta_signal_stale',
    )
  }

  const proofFloor = requireObject(
    dependencies.profitability_proof_floor,
    'readyz dependencies.profitability_proof_floor',
  )
  if (proofFloor.detail !== 'repair_only' || proofFloor.capital_state !== 'zero_notional') {
    throw new Error(
      'accepted-source stale rollout acceptance requires profitability_proof_floor repair_only zero_notional',
    )
  }

  assertAcceptedSourceStaleZeroNotionalContract(status, digest)
}

const assertLiveSubmitActivationContract = (activation: JsonObject): LiveSubmitContract => {
  if (requireBoolean(activation.configured, 'torghut live_submit_activation.configured') !== true) {
    throw new Error('torghut live_submit_activation.configured must be true')
  }
  if (requireBoolean(activation.valid, 'torghut live_submit_activation.valid') !== true) {
    throw new Error('torghut live_submit_activation.valid must be true')
  }
  requireTimestamp(activation.expires_at, 'torghut live_submit_activation.expires_at')
  const expired = requireBoolean(activation.expired, 'torghut live_submit_activation.expired')
  const reason = formatScalar(activation.reason, '')
  if (expired) {
    if (reason !== 'live_submit_activation_expired') {
      throw new Error('torghut live_submit_activation.reason must be live_submit_activation_expired after expiry')
    }
    return 'expired_activation_blocked'
  }
  if (activation.reason !== null && activation.reason !== undefined && reason !== '') {
    throw new Error('torghut live_submit_activation.reason must be empty before expiry')
  }
  return 'bounded_live_submit_active'
}

const assertOperationalSubmissionAuthority = (status: JsonObject) => {
  const submissionAuthority = requireObject(status.submission_authority, 'torghut status submission_authority')
  requireScalarValue(
    submissionAuthority.schema_version,
    'torghut.submission-authority.v1',
    'torghut submission_authority.schema_version',
  )
  requireScalarValue(
    submissionAuthority.authority_scope,
    'operational_submission',
    'torghut submission_authority.authority_scope',
  )
  requireScalarValue(
    submissionAuthority.effective_submit_mode,
    'operational_submission',
    'torghut submission_authority.effective_submit_mode',
  )
  requireScalarValue(submissionAuthority.reason, 'operational_submission_ready', 'torghut submission_authority.reason')
  if (requireBoolean(submissionAuthority.can_submit_now, 'torghut submission_authority.can_submit_now') !== true) {
    throw new Error('operational repair-only rollout acceptance requires submission_authority.can_submit_now=true')
  }

  const authorityGate = requireObject(
    submissionAuthority.operational_submission_gate,
    'torghut submission_authority.operational_submission_gate',
  )
  if (
    requireBoolean(authorityGate.allowed, 'torghut submission_authority.operational_submission_gate.allowed') !== true
  ) {
    throw new Error('operational repair-only rollout acceptance requires submission_authority gate allowed=true')
  }
  requireScalarValue(
    authorityGate.reason,
    'operational_submission_ready',
    'torghut submission_authority.operational_submission_gate.reason',
  )
}

const assertCoreDependenciesOnlyReadyz = (readyz: JsonObject) => {
  if (readyz.status !== 'degraded') {
    throw new Error('non-2xx core-dependencies-only /readyz is only accepted when payload.status is degraded')
  }
  requireScalarValue(readyz.readiness_surface, 'core_dependencies_only', 'readyz readiness_surface')

  const dependencies = requireObject(readyz.dependencies, 'readyz dependencies')
  requireDependencyOk(dependencies, 'postgres')
  requireDependencyOk(dependencies, 'clickhouse')
  requireDependencyOk(dependencies, 'database')

  const scheduler = requireObject(readyz.scheduler, 'readyz scheduler')
  if (scheduler.ok !== true || scheduler.running !== true) {
    throw new Error('readyz scheduler must be ok and running for core-dependencies-only rollout acceptance')
  }

  const liveSubmissionGate = requireObject(readyz.live_submission_gate, 'readyz live_submission_gate')
  if (requireBoolean(liveSubmissionGate.allowed, 'readyz live_submission_gate.allowed') !== false) {
    throw new Error('core-dependencies-only rollout acceptance requires live_submission_gate.allowed=false')
  }
  requireScalarValue(liveSubmissionGate.reason, 'readyz_core_dependencies_only', 'readyz live_submission_gate.reason')
  requireArrayIncludes(
    liveSubmissionGate.reason_codes,
    'readyz_core_dependencies_only',
    'readyz live_submission_gate.reason_codes',
  )
  requireArrayIncludes(
    liveSubmissionGate.blocked_reasons,
    'readyz_core_dependencies_only',
    'readyz live_submission_gate.blocked_reasons',
  )
  requireScalarValue(
    liveSubmissionGate.readiness_surface,
    'core_dependencies_only',
    'readyz live_submission_gate.readiness_surface',
  )
  if (requireBoolean(liveSubmissionGate.read_model_evaluated, 'readyz live_submission_gate.read_model_evaluated')) {
    throw new Error(
      'core-dependencies-only rollout acceptance requires live_submission_gate.read_model_evaluated=false',
    )
  }
  for (const authorityKey of [
    'promotion_authority',
    'promotion_authority_ok',
    'final_authority_ok',
    'final_promotion_allowed',
    'final_promotion_authorized',
  ]) {
    if (requireBoolean(liveSubmissionGate[authorityKey], `readyz live_submission_gate.${authorityKey}`) !== false) {
      throw new Error(`core-dependencies-only rollout acceptance requires live_submission_gate.${authorityKey}=false`)
    }
  }
  assertLiveSubmitActivationContract(
    requireObject(liveSubmissionGate.live_submit_activation, 'readyz live_submission_gate.live_submit_activation'),
  )
}

const assertBoundedLiveSubmitContract = (status: JsonObject): LiveSubmitContract => {
  const liveSubmissionGate = requireObject(status.live_submission_gate, 'torghut status live_submission_gate')
  const activation = requireObject(
    liveSubmissionGate.live_submit_activation,
    'torghut status live_submission_gate.live_submit_activation',
  )

  if (requireBoolean(status.autonomy_enabled, 'torghut status autonomy_enabled') !== false) {
    throw new Error('torghut status autonomy_enabled must be false for bounded live-submit rollout')
  }
  assertOperationalSubmissionAuthority(status)
  const liveSubmitContract = assertLiveSubmitActivationContract(activation)
  if (liveSubmitContract === 'expired_activation_blocked') {
    if (requireBoolean(liveSubmissionGate.allowed, 'torghut status live_submission_gate.allowed') !== false) {
      throw new Error('torghut live_submission_gate.allowed must be false after live submit activation expiry')
    }
    requireScalarValue(
      liveSubmissionGate.reason,
      'live_submit_activation_expired',
      'torghut live_submission_gate.reason',
    )
    requireArrayIncludes(
      liveSubmissionGate.blocked_reasons,
      'live_submit_activation_expired',
      'torghut live_submission_gate.blocked_reasons',
    )
  }
  return liveSubmitContract
}

const empiricalJobsDiagnosticLine = (status: JsonObject): string | undefined => {
  const value = status.empirical_jobs
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const empiricalJobs = value as JsonObject
  const blockedReasons = Array.isArray(empiricalJobs.blocked_reasons)
    ? empiricalJobs.blocked_reasons.map((reason) => formatScalar(reason, '')).filter(Boolean)
    : []
  const parts = [`ready=\`${formatScalar(empiricalJobs.ready)}\``, `status=\`${formatScalar(empiricalJobs.status)}\``]
  if (blockedReasons.length > 0) {
    parts.push(`blocked=${blockedReasons.map((reason) => `\`${reason}\``).join(',')}`)
  }
  return `- Empirical jobs diagnostic: ${parts.join(', ')}`
}

const assertShadowZeroNotionalGateClosedContract = (status: JsonObject, digest: JsonObject): LiveSubmitContract => {
  const liveSubmissionGate = requireObject(status.live_submission_gate, 'torghut status live_submission_gate')
  const activation = requireObject(
    liveSubmissionGate.live_submit_activation,
    'torghut status live_submission_gate.live_submit_activation',
  )

  assertRepairOnlyZeroNotionalDigest(digest)
  if (requireBoolean(status.autonomy_enabled, 'torghut status autonomy_enabled') !== false) {
    throw new Error('torghut status autonomy_enabled must be false for shadow zero-notional rollout')
  }
  if (requireBoolean(liveSubmissionGate.allowed, 'torghut status live_submission_gate.allowed') !== false) {
    throw new Error('shadow zero-notional rollout acceptance requires live_submission_gate.allowed=false')
  }
  const reason = formatScalar(liveSubmissionGate.reason, '').trim()
  if (!reason) {
    throw new Error('shadow zero-notional rollout acceptance requires a live_submission_gate reason')
  }
  if (requireArray(liveSubmissionGate.blocked_reasons, 'torghut live_submission_gate.blocked_reasons').length === 0) {
    throw new Error('shadow zero-notional rollout acceptance requires blocked live_submission_gate reasons')
  }
  if (requireBoolean(activation.configured, 'torghut live_submit_activation.configured') !== false) {
    throw new Error('shadow zero-notional rollout acceptance requires live_submit_activation.configured=false')
  }
  if (requireBoolean(activation.valid, 'torghut live_submit_activation.valid') !== true) {
    throw new Error('torghut live_submit_activation.valid must be true')
  }
  if (requireBoolean(activation.expired, 'torghut live_submit_activation.expired') !== false) {
    throw new Error('shadow zero-notional rollout acceptance requires live_submit_activation.expired=false')
  }
  const activationReason = formatScalar(activation.reason, '')
  if (activation.reason !== null && activation.reason !== undefined && activationReason !== '') {
    throw new Error('shadow zero-notional rollout acceptance requires empty live_submit_activation.reason')
  }
  if (
    activation.expires_at !== null &&
    activation.expires_at !== undefined &&
    formatScalar(activation.expires_at, '') !== ''
  ) {
    throw new Error('shadow zero-notional rollout acceptance requires empty live_submit_activation.expires_at')
  }

  return 'shadow_zero_notional_gate_closed'
}

const assertOperationalZeroNotionalRepairContract = (status: JsonObject, digest: JsonObject): LiveSubmitContract => {
  const capital = requireObject(digest.capital, 'torghut revenue repair digest capital')
  if (
    digest.business_state !== 'repair_only' ||
    digest.revenue_ready !== false ||
    capital.capital_state !== 'zero_notional' ||
    formatScalar(capital.max_notional, '') !== '0'
  ) {
    throw new Error('operational repair-only rollout acceptance requires repair_only zero_notional max_notional=0')
  }
  requireScalarValue(
    capital.proof_floor_state,
    'repair_only',
    'torghut revenue repair digest capital.proof_floor_state',
  )
  requireScalarValue(capital.route_state, 'repair_only', 'torghut revenue repair digest capital.route_state')
  if (
    requireBoolean(capital.live_submission_allowed, 'torghut revenue repair digest capital.live_submission_allowed') !==
    true
  ) {
    throw new Error('operational repair-only rollout acceptance requires live_submission_allowed=true')
  }
  requireScalarValue(
    capital.live_submission_reason,
    'operational_submission_ready',
    'torghut revenue repair digest capital.live_submission_reason',
  )

  const liveSubmissionGate = requireObject(status.live_submission_gate, 'torghut status live_submission_gate')
  const operationalSubmissionGate = requireObject(
    status.operational_submission_gate,
    'torghut status operational_submission_gate',
  )
  const proofFloor = requireObject(status.proof_floor, 'torghut status proof_floor')

  if (requireBoolean(status.autonomy_enabled, 'torghut status autonomy_enabled') !== false) {
    throw new Error('torghut status autonomy_enabled must be false for operational zero-notional repair rollout')
  }
  if (requireBoolean(liveSubmissionGate.allowed, 'torghut status live_submission_gate.allowed') !== true) {
    throw new Error('operational repair-only rollout acceptance requires live_submission_gate.allowed=true')
  }
  if (
    requireBoolean(operationalSubmissionGate.allowed, 'torghut status operational_submission_gate.allowed') !== true
  ) {
    throw new Error('operational repair-only rollout acceptance requires operational_submission_gate.allowed=true')
  }
  requireScalarValue(
    operationalSubmissionGate.reason,
    'operational_submission_ready',
    'torghut status operational_submission_gate.reason',
  )
  requireScalarValue(proofFloor.floor_state, 'repair_only', 'torghut status proof_floor.floor_state')
  requireScalarValue(proofFloor.capital_state, 'zero_notional', 'torghut status proof_floor.capital_state')
  requireScalarValue(proofFloor.max_notional, '0', 'torghut status proof_floor.max_notional')

  assertOperationalSubmissionAuthority(status)
  assertLiveSubmitActivationContract(
    requireObject(
      liveSubmissionGate.live_submit_activation,
      'torghut status live_submission_gate.live_submit_activation',
    ),
  )

  return 'operational_zero_notional_repair'
}

const isAcceptedSourceStaleZeroNotionalCandidate = (status: JsonObject, digest: JsonObject): boolean => {
  const capital =
    digest.capital && typeof digest.capital === 'object' && !Array.isArray(digest.capital)
      ? (digest.capital as JsonObject)
      : {}
  const liveSubmissionGate =
    status.live_submission_gate &&
    typeof status.live_submission_gate === 'object' &&
    !Array.isArray(status.live_submission_gate)
      ? (status.live_submission_gate as JsonObject)
      : {}
  const activation =
    liveSubmissionGate.live_submit_activation &&
    typeof liveSubmissionGate.live_submit_activation === 'object' &&
    !Array.isArray(liveSubmissionGate.live_submit_activation)
      ? (liveSubmissionGate.live_submit_activation as JsonObject)
      : {}
  return (
    digest.business_state === 'repair_only' &&
    digest.revenue_ready === false &&
    capital.live_submission_allowed === false &&
    capital.live_submission_reason === ACCEPTED_SOURCE_STALE_REASON &&
    capital.capital_state === 'zero_notional' &&
    formatScalar(capital.max_notional, '') === '0' &&
    liveSubmissionGate.allowed === false &&
    activation.configured === true &&
    arrayIncludesScalar(liveSubmissionGate.blocked_reasons, ACCEPTED_SOURCE_STALE_REASON)
  )
}

const assertAcceptedSourceStaleZeroNotionalContract = (status: JsonObject, digest: JsonObject): LiveSubmitContract => {
  assertRepairOnlyZeroNotionalDigest(digest)

  const capital = requireObject(digest.capital, 'torghut revenue repair digest capital')
  requireScalarValue(
    capital.live_submission_reason,
    ACCEPTED_SOURCE_STALE_REASON,
    'torghut revenue repair digest capital.live_submission_reason',
  )

  const liveSubmissionGate = requireObject(status.live_submission_gate, 'torghut status live_submission_gate')
  const operationalSubmissionGate = requireObject(
    status.operational_submission_gate,
    'torghut status operational_submission_gate',
  )
  const submissionAuthority = requireObject(status.submission_authority, 'torghut status submission_authority')
  const freshness = requireObject(
    liveSubmissionGate.clickhouse_ta_freshness,
    'torghut status live_submission_gate.clickhouse_ta_freshness',
  )

  if (requireBoolean(status.autonomy_enabled, 'torghut status autonomy_enabled') !== false) {
    throw new Error('torghut status autonomy_enabled must be false for accepted-source stale repair rollout')
  }
  if (requireBoolean(liveSubmissionGate.allowed, 'torghut status live_submission_gate.allowed') !== false) {
    throw new Error('accepted-source stale repair rollout requires live_submission_gate.allowed=false')
  }
  requireArrayIncludes(
    liveSubmissionGate.blocked_reasons,
    ACCEPTED_SOURCE_STALE_REASON,
    'torghut live_submission_gate.blocked_reasons',
  )
  if (
    requireBoolean(operationalSubmissionGate.allowed, 'torghut status operational_submission_gate.allowed') !== false
  ) {
    throw new Error('accepted-source stale repair rollout requires operational_submission_gate.allowed=false')
  }
  requireScalarValue(
    operationalSubmissionGate.reason,
    ACCEPTED_SOURCE_STALE_REASON,
    'torghut status operational_submission_gate.reason',
  )
  requireArrayIncludes(
    operationalSubmissionGate.blocked_reasons,
    ACCEPTED_SOURCE_STALE_REASON,
    'torghut operational_submission_gate.blocked_reasons',
  )
  requireScalarValue(
    submissionAuthority.schema_version,
    'torghut.submission-authority.v1',
    'torghut submission_authority.schema_version',
  )
  requireScalarValue(submissionAuthority.authority_scope, 'none', 'torghut submission_authority.authority_scope')
  requireScalarValue(
    submissionAuthority.effective_submit_mode,
    'blocked',
    'torghut submission_authority.effective_submit_mode',
  )
  requireScalarValue(submissionAuthority.reason, ACCEPTED_SOURCE_STALE_REASON, 'torghut submission_authority.reason')
  if (requireBoolean(submissionAuthority.can_submit_now, 'torghut submission_authority.can_submit_now') !== false) {
    throw new Error('accepted-source stale repair rollout requires submission_authority.can_submit_now=false')
  }
  requireScalarValue(
    freshness.accepted_source_state,
    'stale',
    'torghut live_submission_gate.clickhouse_ta_freshness.accepted_source_state',
  )
  requireScalarValue(
    freshness.blocking_reason,
    ACCEPTED_SOURCE_STALE_REASON,
    'torghut live_submission_gate.clickhouse_ta_freshness.blocking_reason',
  )
  requireArrayIncludes(
    freshness.accepted_sources,
    'ta',
    'torghut live_submission_gate.clickhouse_ta_freshness.accepted_sources',
  )
  assertLiveSubmitActivationContract(
    requireObject(
      liveSubmissionGate.live_submit_activation,
      'torghut status live_submission_gate.live_submit_activation',
    ),
  )

  return 'accepted_source_stale_zero_notional'
}

const isRepairOnlyZeroNotionalCandidate = (status: JsonObject, digest: JsonObject): boolean => {
  const capital =
    digest.capital && typeof digest.capital === 'object' && !Array.isArray(digest.capital)
      ? (digest.capital as JsonObject)
      : {}
  const liveSubmissionGate =
    status.live_submission_gate &&
    typeof status.live_submission_gate === 'object' &&
    !Array.isArray(status.live_submission_gate)
      ? (status.live_submission_gate as JsonObject)
      : {}
  const activation =
    liveSubmissionGate.live_submit_activation &&
    typeof liveSubmissionGate.live_submit_activation === 'object' &&
    !Array.isArray(liveSubmissionGate.live_submit_activation)
      ? (liveSubmissionGate.live_submit_activation as JsonObject)
      : {}
  return (
    digest.business_state === 'repair_only' &&
    digest.revenue_ready === false &&
    capital.capital_state === 'zero_notional' &&
    formatScalar(capital.max_notional, '') === '0' &&
    ((capital.live_submission_allowed === false &&
      liveSubmissionGate.allowed === false &&
      activation.configured === false) ||
      isAcceptedSourceStaleZeroNotionalCandidate(status, digest) ||
      (capital.live_submission_allowed === true &&
        liveSubmissionGate.allowed === true &&
        activation.configured === true))
  )
}

type PaperRouteTargetEnvelope = {
  identity: string
  probeSymbols: string[]
  maxNotional: string
  scopeAuthority: string
  strategyScopeApplied: boolean
}

const uniqueSortedSymbols = (value: unknown, label: string): string[] => {
  const values = typeof value === 'string' ? value.split(',') : requireArray(value, label)
  const symbols = values.map((symbol) => formatScalar(symbol, '').trim().toUpperCase()).filter(Boolean)
  return [...new Set(symbols)].sort()
}

const targetEnvelope = (target: unknown, label: string): PaperRouteTargetEnvelope => {
  const targetObject = requireObject(target, label)
  const hypothesisId = formatScalar(targetObject.hypothesis_id, '')
  const candidateId = formatScalar(targetObject.candidate_id, '')
  const strategyName = formatScalar(targetObject.strategy_name ?? targetObject.strategy_id, '')
  const windowStart = formatScalar(targetObject.window_start, '')
  const windowEnd = formatScalar(targetObject.window_end, '')
  if (!hypothesisId || !candidateId || !strategyName || !windowStart || !windowEnd) {
    throw new Error(`${label} missing target identity fields`)
  }
  const identity = [hypothesisId, candidateId, strategyName, windowStart, windowEnd].join('|')
  const probeSymbols = uniqueSortedSymbols(targetObject.paper_route_probe_symbols, `${label} paper_route_probe_symbols`)
  if (probeSymbols.length === 0) {
    throw new Error(`${label} paper_route_probe_symbols must not be empty`)
  }
  requireRuntimeWindowImportHealthGate(targetObject, label)
  return {
    identity,
    probeSymbols,
    maxNotional: formatScalar(targetObject.paper_route_probe_next_session_max_notional, '0'),
    scopeAuthority: formatScalar(targetObject.paper_route_probe_scope_authority, '').trim().toLowerCase(),
    strategyScopeApplied: targetObject.paper_route_probe_strategy_scope_applied === true,
  }
}

const requireNotTrue = (value: unknown, label: string) => {
  if (value === true || value === 'true') {
    throw new Error(`${label} must not be true for paper-route evidence collection`)
  }
}

const requireRuntimeWindowImportHealthGate = (
  targetObject: JsonObject,
  label: string,
): RuntimeWindowImportHealthGate => {
  const dependencyQuorumDecision = formatScalar(targetObject.dependency_quorum_decision, '').trim().toLowerCase()
  const continuityOk = formatScalar(targetObject.continuity_ok, '').trim().toLowerCase()
  const driftOk = formatScalar(targetObject.drift_ok, '').trim().toLowerCase()
  if (!dependencyQuorumDecision || !continuityOk || !driftOk) {
    throw new Error(`${label} missing runtime-window import health gate fields`)
  }
  if (!['true', 'false'].includes(continuityOk)) {
    throw new Error(`${label} continuity_ok must be true or false`)
  }
  if (!['true', 'false'].includes(driftOk)) {
    throw new Error(`${label} drift_ok must be true or false`)
  }

  const gate = requireObject(
    targetObject.runtime_window_import_health_gate,
    `${label} runtime_window_import_health_gate`,
  )
  const schemaVersion = formatScalar(gate.schema_version, 'missing')
  if (schemaVersion !== RUNTIME_WINDOW_IMPORT_HEALTH_GATE_SCHEMA_VERSION) {
    throw new Error(
      `${label} runtime-window health gate schema mismatch: expected ${RUNTIME_WINDOW_IMPORT_HEALTH_GATE_SCHEMA_VERSION}, got ${schemaVersion}`,
    )
  }
  if (formatScalar(gate.dependency_quorum_decision, '').trim().toLowerCase() !== dependencyQuorumDecision) {
    throw new Error(`${label} runtime-window health gate dependency_quorum_decision mismatch`)
  }
  if (formatScalar(gate.continuity_ok, '').trim().toLowerCase() !== continuityOk) {
    throw new Error(`${label} runtime-window health gate continuity_ok mismatch`)
  }
  if (formatScalar(gate.drift_ok, '').trim().toLowerCase() !== driftOk) {
    throw new Error(`${label} runtime-window health gate drift_ok mismatch`)
  }
  requireArray(gate.blockers, `${label} runtime-window health gate blockers`)

  return { dependencyQuorumDecision, continuityOk, driftOk }
}

const selectPaperRouteMirrorPlan = (payload: JsonObject, label: string): JsonObject => {
  const selectedPlan = requireObject(
    payload.next_paper_route_runtime_window_targets,
    `${label} next_paper_route_runtime_window_targets`,
  )
  const selectedSchemaVersion = formatScalar(selectedPlan.schema_version, 'missing')
  if (selectedSchemaVersion === PAPER_ROUTE_TARGETS_SCHEMA_VERSION) {
    return selectedPlan
  }

  const rawPlanValue = payload.raw_next_paper_route_runtime_window_targets
  if (rawPlanValue && typeof rawPlanValue === 'object' && !Array.isArray(rawPlanValue)) {
    const rawPlan = rawPlanValue as JsonObject
    const rawSchemaVersion = formatScalar(rawPlan.schema_version, 'missing')
    if (rawSchemaVersion === PAPER_ROUTE_TARGETS_SCHEMA_VERSION) {
      return rawPlan
    }
  }

  throw new Error(
    `${label} target plan schema mismatch: expected ${PAPER_ROUTE_TARGETS_SCHEMA_VERSION}, got ${selectedSchemaVersion}`,
  )
}

const parsePaperRouteTargets = (
  evidence: unknown,
  label: string,
): { targetCount: number; targetsByIdentity: Map<string, PaperRouteTargetEnvelope> } => {
  const payload = requireObject(evidence, `${label} payload`)
  const schemaVersion = formatScalar(payload.schema_version, 'missing')
  if (schemaVersion === PROOFS_SCHEMA_VERSION) {
    return parseProofTargets(payload, label)
  }
  if (schemaVersion !== PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `${label} schema mismatch: expected ${PROOFS_SCHEMA_VERSION} or ${PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION}, got ${schemaVersion}`,
    )
  }
  const plan = selectPaperRouteMirrorPlan(payload, label)
  const planSchemaVersion = formatScalar(plan.schema_version, 'missing')
  if (planSchemaVersion !== PAPER_ROUTE_TARGETS_SCHEMA_VERSION) {
    throw new Error(
      `${label} target plan schema mismatch: expected ${PAPER_ROUTE_TARGETS_SCHEMA_VERSION}, got ${planSchemaVersion}`,
    )
  }
  const targets = requireArray(plan.targets, `${label} target plan targets`)
  const targetCount = requireNonNegativeInteger(plan.target_count, `${label} target plan target_count`)
  if (targets.length !== targetCount) {
    throw new Error(`${label} target_count mismatch: count=${targetCount}, targets=${targets.length}`)
  }
  requireNotTrue(plan.promotion_allowed, `${label} target plan promotion_allowed`)
  requireNotTrue(plan.final_promotion_allowed, `${label} target plan final_promotion_allowed`)
  requireNotTrue(plan.final_promotion_authorized, `${label} target plan final_promotion_authorized`)
  const planHealthGate = requireObject(
    plan.runtime_window_import_health_gate,
    `${label} target plan runtime_window_import_health_gate`,
  )
  const planHealthGateSchemaVersion = formatScalar(planHealthGate.schema_version, 'missing')
  if (planHealthGateSchemaVersion !== RUNTIME_WINDOW_IMPORT_HEALTH_GATE_SUMMARY_SCHEMA_VERSION) {
    throw new Error(
      `${label} target plan runtime-window health gate schema mismatch: expected ${RUNTIME_WINDOW_IMPORT_HEALTH_GATE_SUMMARY_SCHEMA_VERSION}, got ${planHealthGateSchemaVersion}`,
    )
  }
  const healthGateTargetCount = requireNonNegativeInteger(
    planHealthGate.target_count,
    `${label} target plan runtime-window health gate target_count`,
  )
  if (healthGateTargetCount !== targetCount) {
    throw new Error(
      `${label} target plan runtime-window health gate target_count mismatch: gate=${healthGateTargetCount}, targets=${targetCount}`,
    )
  }
  const healthGateReadyCount = requireNonNegativeInteger(
    planHealthGate.ready_target_count,
    `${label} target plan runtime-window health gate ready_target_count`,
  )
  const healthGateBlockedCount = requireNonNegativeInteger(
    planHealthGate.blocked_target_count,
    `${label} target plan runtime-window health gate blocked_target_count`,
  )
  if (healthGateReadyCount + healthGateBlockedCount !== targetCount) {
    throw new Error(
      `${label} target plan runtime-window health gate count mismatch: ready=${healthGateReadyCount}, blocked=${healthGateBlockedCount}, targets=${targetCount}`,
    )
  }
  requireArray(planHealthGate.blockers, `${label} target plan runtime-window health gate blockers`)
  targets.forEach((target, index) => {
    const targetObject = requireObject(target, `${label} target ${index}`)
    requireNotTrue(targetObject.promotion_allowed, `${label} target ${index} promotion_allowed`)
    requireNotTrue(targetObject.final_promotion_allowed, `${label} target ${index} final_promotion_allowed`)
    requireNotTrue(targetObject.final_promotion_authorized, `${label} target ${index} final_promotion_authorized`)
  })
  const targetsByIdentity = new Map<string, PaperRouteTargetEnvelope>()
  targets.forEach((target, index) => {
    const envelope = targetEnvelope(target, `${label} target ${index}`)
    targetsByIdentity.set(envelope.identity, envelope)
  })
  return { targetCount, targetsByIdentity }
}

const proofTargetEnvelope = (proof: unknown, label: string): PaperRouteTargetEnvelope => {
  const proofObject = requireObject(proof, label)
  const identity = requireObject(proofObject.identity, `${label} identity`)
  const window = requireObject(proofObject.window, `${label} window`)
  const health = requireObject(proofObject.health, `${label} health`)
  const hypothesisId = formatScalar(identity.hypothesis_id, '')
  const candidateId = formatScalar(identity.candidate_id, '')
  const strategyName = formatScalar(identity.runtime_strategy_name ?? identity.strategy_name, '')
  const windowStart = formatScalar(window.start, '')
  const windowEnd = formatScalar(window.end, '')
  if (!hypothesisId || !candidateId || !strategyName || !windowStart || !windowEnd) {
    throw new Error(`${label} missing proof identity fields`)
  }
  for (const key of ['dependency_quorum_ok', 'continuity_ok', 'drift_ok']) {
    if (typeof health[key] !== 'boolean') {
      throw new Error(`${label} health.${key} must be boolean`)
    }
  }
  const probeSymbols = uniqueSortedSymbols(proofObject.symbols, `${label} symbols`)
  if (probeSymbols.length === 0) {
    throw new Error(`${label} symbols must not be empty`)
  }
  return {
    identity: [hypothesisId, candidateId, strategyName, windowStart, windowEnd].join('|'),
    probeSymbols,
    maxNotional: formatScalar(identity.target_notional, '0'),
    scopeAuthority: '',
    strategyScopeApplied: false,
  }
}

const parseProofTargets = (
  payload: JsonObject,
  label: string,
): { targetCount: number; targetsByIdentity: Map<string, PaperRouteTargetEnvelope> } => {
  const promotionAuthority = requireObject(payload.promotion_authority, `${label} promotion_authority`)
  requireNotTrue(promotionAuthority.allowed, `${label} promotion_authority.allowed`)
  requireNotTrue(promotionAuthority.final_promotion_allowed, `${label} promotion_authority.final_promotion_allowed`)
  const proofs = requireArray(payload.proofs, `${label} proofs`)
  const targetsByIdentity = new Map<string, PaperRouteTargetEnvelope>()
  for (const [index, proof] of proofs.entries()) {
    const envelope = proofTargetEnvelope(proof, `${label} proofs[${index}]`)
    targetsByIdentity.set(envelope.identity, envelope)
  }
  return {
    targetCount: proofs.length,
    targetsByIdentity,
  }
}

const requireSameList = (left: string[], right: string[], label: string) => {
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label}: expected ${left.join(',') || 'none'}, got ${right.join(',') || 'none'}`)
  }
}

const missingFrom = (expected: string[], actual: string[]): string[] => {
  const actualValues = new Set(actual)
  return expected.filter((value) => !actualValues.has(value))
}

const extraIn = (actual: string[], expected: string[]): string[] => {
  const expectedValues = new Set(expected)
  return actual.filter((value) => !expectedValues.has(value))
}

const validatePaperRouteMirror = (
  paperRouteEvidence: unknown,
  simPaperRouteEvidence: unknown,
): {
  liveTargetCount: number
  simTargetCount: number
  constrainedTargetCount: number
  constrainedTargets: string[]
} => {
  const liveTargets = parsePaperRouteTargets(paperRouteEvidence, 'torghut paper-route evidence')
  const simTargets = parsePaperRouteTargets(simPaperRouteEvidence, 'torghut-sim paper-route evidence')
  if (liveTargets.targetCount > 0 && simTargets.targetCount === 0) {
    throw new Error('torghut-sim paper-route target plan is empty while live torghut exposes targets')
  }
  const missingSimTargets = [...liveTargets.targetsByIdentity.keys()].filter(
    (identity) => !simTargets.targetsByIdentity.has(identity),
  )
  if (missingSimTargets.length > 0) {
    throw new Error(`torghut-sim paper-route target plan missing live target(s): ${missingSimTargets.join(', ')}`)
  }
  for (const [identity, liveEnvelope] of liveTargets.targetsByIdentity) {
    const simEnvelope = simTargets.targetsByIdentity.get(identity)
    if (!simEnvelope) continue
    const unexpectedSimSymbols = extraIn(simEnvelope.probeSymbols, liveEnvelope.probeSymbols)
    if (unexpectedSimSymbols.length > 0) {
      throw new Error(
        `torghut-sim paper-route target symbols differ from live target ${identity}: unexpected ${unexpectedSimSymbols.join(',')}`,
      )
    }
    const missingLiveSymbols = missingFrom(liveEnvelope.probeSymbols, simEnvelope.probeSymbols)
    if (missingLiveSymbols.length > 0) {
      const explicitlyScoped = simEnvelope.strategyScopeApplied && simEnvelope.scopeAuthority === 'strategy_universe'
      if (!explicitlyScoped) {
        requireSameList(
          liveEnvelope.probeSymbols,
          simEnvelope.probeSymbols,
          `torghut-sim paper-route target symbols differ from live target ${identity}`,
        )
      }
    }
    if (simEnvelope.maxNotional !== liveEnvelope.maxNotional) {
      throw new Error(
        `torghut-sim paper-route target notional differs from live target ${identity}: expected ${liveEnvelope.maxNotional}, got ${simEnvelope.maxNotional}`,
      )
    }
  }
  const constrainedTargets = [...liveTargets.targetsByIdentity.entries()]
    .filter(([identity, liveEnvelope]) => {
      const simEnvelope = simTargets.targetsByIdentity.get(identity)
      return Boolean(simEnvelope && missingFrom(liveEnvelope.probeSymbols, simEnvelope.probeSymbols).length > 0)
    })
    .map(([identity]) => identity)
  return {
    liveTargetCount: liveTargets.targetCount,
    simTargetCount: simTargets.targetCount,
    constrainedTargetCount: constrainedTargets.length,
    constrainedTargets,
  }
}

export const validatePostDeployEvidence = (input: PostDeployEvidenceInput): PostDeployEvidenceResult => {
  const readyzStatusCode = parseHttpStatus(input.readyzHttpStatus)
  const readyz = requireObject(input.readyz, 'torghut readyz payload')
  const digest = requireObject(input.revenueRepairDigest, 'torghut revenue repair digest')
  const status = requireObject(input.tradingStatus, 'torghut status payload')
  const repairQueue = digest.repair_queue
  if (!Array.isArray(repairQueue)) {
    throw new Error('torghut revenue repair digest missing repair_queue')
  }

  let readyzAcceptedReason: PostDeployEvidenceResult['readyzAcceptedReason'] = 'healthy_2xx'
  let liveSubmitContract: LiveSubmitContract | undefined
  if (readyzStatusCode < 200 || readyzStatusCode >= 300) {
    if (readyzStatusCode !== 503) {
      throw new Error(
        `Torghut /readyz returned HTTP ${readyzStatusCode}; expected 2xx, repair-only 503, or core-dependencies-only 503`,
      )
    }
    const dependencies = requireObject(readyz.dependencies, 'readyz dependencies')
    if (dependencies.live_submission_gate !== undefined || dependencies.profitability_proof_floor !== undefined) {
      if (isAcceptedSourceStaleReadyz(readyz)) {
        assertAcceptedSourceStaleZeroNotionalReadyz(readyz, status, digest)
        liveSubmitContract = 'accepted_source_stale_zero_notional'
      } else {
        assertRepairOnlyZeroNotionalReadyz(readyz, digest)
      }
      readyzAcceptedReason = 'repair_only_zero_notional'
    } else {
      assertCoreDependenciesOnlyReadyz(readyz)
      liveSubmitContract = assertBoundedLiveSubmitContract(status)
      readyzAcceptedReason = 'core_dependencies_only_gate_closed'
    }
  } else {
    if (isRepairOnlyZeroNotionalCandidate(status, digest)) {
      const capital = requireObject(digest.capital, 'torghut revenue repair digest capital')
      liveSubmitContract =
        capital.live_submission_allowed === true
          ? assertOperationalZeroNotionalRepairContract(status, digest)
          : isAcceptedSourceStaleZeroNotionalCandidate(status, digest)
            ? assertAcceptedSourceStaleZeroNotionalContract(status, digest)
            : assertShadowZeroNotionalGateClosedContract(status, digest)
      readyzAcceptedReason = 'repair_only_zero_notional'
    } else {
      liveSubmitContract = assertBoundedLiveSubmitContract(status)
    }
  }

  const routeBoard = requireObject(status.route_reacquisition_board, 'torghut status route_reacquisition_board')
  const routeBoardSchemaVersion = formatScalar(routeBoard.schema_version, 'missing')
  if (routeBoardSchemaVersion !== ROUTE_BOARD_SCHEMA_VERSION) {
    throw new Error(
      `torghut route board schema mismatch: expected ${ROUTE_BOARD_SCHEMA_VERSION}, got ${routeBoardSchemaVersion}`,
    )
  }
  const routeBoardSummary = requireObject(routeBoard.summary, 'torghut route board summary')
  const routeBoardRows = routeBoard.rows
  if (!Array.isArray(routeBoardRows)) {
    throw new Error('torghut route board rows must be an array')
  }
  const routeBoardRowCount = requireNonNegativeInteger(
    routeBoardSummary.row_count,
    'torghut route board summary.row_count',
  )
  if (routeBoardRows.length !== routeBoardRowCount) {
    throw new Error(
      `torghut route board row_count mismatch: summary=${routeBoardRowCount}, rows=${routeBoardRows.length}`,
    )
  }
  const zeroNotionalRowCount = requireNonNegativeInteger(
    routeBoardSummary.zero_notional_row_count,
    'torghut route board summary.zero_notional_row_count',
  )
  const expectedUnblockValue = requireNonNegativeInteger(
    routeBoardSummary.expected_unblock_value,
    'torghut route board summary.expected_unblock_value',
  )
  const capitalEligibleSymbolCount = requireNonNegativeInteger(
    routeBoardSummary.capital_eligible_symbol_count,
    'torghut route board summary.capital_eligible_symbol_count',
  )
  const stateCounts = requireObject(routeBoardSummary.state_counts, 'torghut route board summary.state_counts')
  const stateCountText = Object.entries(stateCounts)
    .map(([state, count]) => `${state}:${formatScalar(count, 'unknown')}`)
    .join(', ')
  const topRepairSymbols = Array.isArray(routeBoardSummary.top_repair_symbols)
    ? routeBoardSummary.top_repair_symbols.map((symbol) => String(symbol)).filter(Boolean)
    : []

  const topRepairs = repairQueue
    .slice(0, 5)
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const repair = item as JsonObject
      const code = formatScalar(repair.code)
      const reason = formatScalar(repair.reason)
      const dimension = formatScalar(repair.dimension)
      return `- \`${code}\`: \`${reason}\` (${dimension})`
    })

  const capital = requireObject(digest.capital ?? {}, 'torghut revenue repair digest capital')
  const blockers = Array.isArray(digest.blockers) ? digest.blockers : []
  const blockerReasons = blockers
    .filter(
      (blocker) => blocker && typeof blocker === 'object' && !Array.isArray(blocker) && (blocker as JsonObject).reason,
    )
    .map((blocker) => String((blocker as JsonObject).reason))

  const lines = [
    '## Torghut Revenue Repair Digest',
    '',
    `- Readyz acceptance: \`${readyzAcceptedReason}\` (HTTP ${readyzStatusCode})`,
    `- Business state: \`${formatScalar(digest.business_state)}\``,
    `- Revenue ready: \`${formatScalar(digest.revenue_ready, 'false')}\``,
    `- Capital state: \`${formatScalar(capital.capital_state)}\``,
    `- Max notional: \`${formatScalar(capital.max_notional)}\``,
  ]
  if (liveSubmitContract) {
    lines.push(`- Live submit contract: \`${liveSubmitContract}\``)
  }
  const empiricalJobsDiagnostic = empiricalJobsDiagnosticLine(status)
  if (empiricalJobsDiagnostic) {
    lines.push(empiricalJobsDiagnostic)
  }
  if (blockerReasons.length > 0) {
    lines.push(`- Blockers: ${blockerReasons.map((reason) => `\`${reason}\``).join(', ')}`)
  }
  if (topRepairs.length > 0) {
    lines.push('', 'Top repair queue:', ...topRepairs)
  }
  lines.push(
    '',
    '## Torghut Route Reacquisition Board',
    '',
    `- Schema: \`${routeBoardSchemaVersion}\``,
    `- Board state: \`${formatScalar(routeBoard.state)}\``,
    `- Capital state: \`${formatScalar(routeBoard.capital_state)}\``,
    `- Rows: \`${routeBoardRowCount}\``,
    `- Zero-notional rows: \`${zeroNotionalRowCount}\``,
    `- Capital-eligible symbols: \`${capitalEligibleSymbolCount}\``,
    `- Expected unblock value: \`${expectedUnblockValue}\``,
    `- State counts: \`${stateCountText || 'none'}\``,
  )
  if (topRepairSymbols.length > 0) {
    lines.push(`- Top repair symbols: ${topRepairSymbols.map((symbol) => `\`${symbol}\``).join(', ')}`)
  }

  if (input.paperRouteEvidence !== undefined || input.simPaperRouteEvidence !== undefined) {
    if (input.paperRouteEvidence === undefined || input.simPaperRouteEvidence === undefined) {
      throw new Error('both torghut and torghut-sim paper-route evidence payloads are required for mirror validation')
    }
    const mirror = validatePaperRouteMirror(input.paperRouteEvidence, input.simPaperRouteEvidence)
    lines.push(
      '',
      '## Torghut Paper Route Target Mirror',
      '',
      `- Live target count: \`${mirror.liveTargetCount}\``,
      `- Sim target count: \`${mirror.simTargetCount}\``,
      `- Sim constrained target count: \`${mirror.constrainedTargetCount}\``,
    )
    if (mirror.constrainedTargets.length > 0) {
      lines.push(`- Sim constrained targets: ${mirror.constrainedTargets.map((target) => `\`${target}\``).join(', ')}`)
    }
  }

  return { readyzAcceptedReason, readyzStatusCode, summaryLines: lines, liveSubmitContract }
}

const loadJsonFile = (path: string, label: string): unknown => {
  if (!path.trim()) {
    throw new Error(`${label} path is unset`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

export const runPostDeployEvidenceCli = (env: NodeJS.ProcessEnv = process.env): PostDeployEvidenceResult => {
  const readyzHttpStatus = env.TORGHUT_READYZ_HTTP_STATUS ?? ''
  const result = validatePostDeployEvidence({
    readyzHttpStatus,
    readyz: loadJsonFile(env.TORGHUT_READYZ_PAYLOAD ?? '', 'TORGHUT_READYZ_PAYLOAD'),
    revenueRepairDigest: loadJsonFile(env.TORGHUT_REVENUE_REPAIR_DIGEST ?? '', 'TORGHUT_REVENUE_REPAIR_DIGEST'),
    tradingStatus: loadJsonFile(env.TORGHUT_STATUS_PAYLOAD ?? '', 'TORGHUT_STATUS_PAYLOAD'),
    paperRouteEvidence: env.TORGHUT_PAPER_ROUTE_EVIDENCE
      ? loadJsonFile(env.TORGHUT_PAPER_ROUTE_EVIDENCE, 'TORGHUT_PAPER_ROUTE_EVIDENCE')
      : undefined,
    simPaperRouteEvidence: env.TORGHUT_SIM_PAPER_ROUTE_EVIDENCE
      ? loadJsonFile(env.TORGHUT_SIM_PAPER_ROUTE_EVIDENCE, 'TORGHUT_SIM_PAPER_ROUTE_EVIDENCE')
      : undefined,
  })

  const summaryPath = env.GITHUB_STEP_SUMMARY
  if (summaryPath?.trim()) {
    appendFileSync(summaryPath, `${result.summaryLines.join('\n')}\n`, 'utf8')
  }
  console.log(`Torghut readyz accepted as ${result.readyzAcceptedReason} (HTTP ${result.readyzStatusCode})`)
  return result
}

if (import.meta.main) {
  try {
    runPostDeployEvidenceCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
