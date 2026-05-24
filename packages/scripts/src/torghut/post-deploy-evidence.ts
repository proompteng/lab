#!/usr/bin/env bun

import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'

const ROUTE_BOARD_SCHEMA_VERSION = 'torghut.route-reacquisition-board.v1'
const PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION = 'torghut.paper-route-evidence.v1'
const PAPER_ROUTE_TARGETS_SCHEMA_VERSION = 'torghut.next-paper-route-runtime-window-targets.v1'

type JsonObject = Record<string, unknown>

type PostDeployEvidenceInput = {
  readyzHttpStatus: string
  readyz: unknown
  revenueRepairDigest: unknown
  tradingStatus: unknown
  paperRouteEvidence?: unknown
  simPaperRouteEvidence?: unknown
}

export type PostDeployEvidenceResult = {
  readyzAcceptedReason: 'healthy_2xx' | 'repair_only_zero_notional'
  readyzStatusCode: number
  summaryLines: string[]
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

  if (digest.business_state !== 'repair_only' || digest.revenue_ready !== false) {
    throw new Error('revenue repair digest must report repair_only and revenue_ready=false')
  }

  const health = requireObject(digest.health, 'torghut revenue repair digest health')
  if (health.readyz_status !== 'degraded' || health.readyz_ok !== false) {
    throw new Error('revenue repair digest must mirror degraded readyz state')
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
  for (const requiredFailure of allowedFailureNames) {
    if (!failureNames.has(requiredFailure)) {
      throw new Error(`missing expected repair-only dependency failure: ${requiredFailure}`)
    }
  }
}

const targetIdentity = (target: unknown, label: string): string => {
  const targetObject = requireObject(target, label)
  const hypothesisId = formatScalar(targetObject.hypothesis_id, '')
  const candidateId = formatScalar(targetObject.candidate_id, '')
  const strategyName = formatScalar(targetObject.strategy_name ?? targetObject.strategy_id, '')
  const windowStart = formatScalar(targetObject.window_start, '')
  const windowEnd = formatScalar(targetObject.window_end, '')
  if (!hypothesisId || !candidateId || !strategyName || !windowStart || !windowEnd) {
    throw new Error(`${label} missing target identity fields`)
  }
  return [hypothesisId, candidateId, strategyName, windowStart, windowEnd].join('|')
}

const requireNotTrue = (value: unknown, label: string) => {
  if (value === true || value === 'true') {
    throw new Error(`${label} must not be true for paper-route evidence collection`)
  }
}

const parsePaperRouteTargets = (evidence: unknown, label: string): { targetCount: number; identities: Set<string> } => {
  const payload = requireObject(evidence, `${label} payload`)
  const schemaVersion = formatScalar(payload.schema_version, 'missing')
  if (schemaVersion !== PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`${label} schema mismatch: expected ${PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION}, got ${schemaVersion}`)
  }
  const plan = requireObject(
    payload.next_paper_route_runtime_window_targets,
    `${label} next_paper_route_runtime_window_targets`,
  )
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
  targets.forEach((target, index) => {
    const targetObject = requireObject(target, `${label} target ${index}`)
    requireNotTrue(targetObject.promotion_allowed, `${label} target ${index} promotion_allowed`)
    requireNotTrue(targetObject.final_promotion_allowed, `${label} target ${index} final_promotion_allowed`)
    requireNotTrue(targetObject.final_promotion_authorized, `${label} target ${index} final_promotion_authorized`)
  })
  return {
    targetCount,
    identities: new Set(targets.map((target, index) => targetIdentity(target, `${label} target ${index}`))),
  }
}

const validatePaperRouteMirror = (
  paperRouteEvidence: unknown,
  simPaperRouteEvidence: unknown,
): { liveTargetCount: number; simTargetCount: number } => {
  const liveTargets = parsePaperRouteTargets(paperRouteEvidence, 'torghut paper-route evidence')
  const simTargets = parsePaperRouteTargets(simPaperRouteEvidence, 'torghut-sim paper-route evidence')
  if (liveTargets.targetCount > 0 && simTargets.targetCount === 0) {
    throw new Error('torghut-sim paper-route target plan is empty while live torghut exposes targets')
  }
  const missingSimTargets = [...liveTargets.identities].filter((identity) => !simTargets.identities.has(identity))
  if (missingSimTargets.length > 0) {
    throw new Error(`torghut-sim paper-route target plan missing live target(s): ${missingSimTargets.join(', ')}`)
  }
  return { liveTargetCount: liveTargets.targetCount, simTargetCount: simTargets.targetCount }
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
  if (readyzStatusCode < 200 || readyzStatusCode >= 300) {
    if (readyzStatusCode !== 503) {
      throw new Error(`Torghut /readyz returned HTTP ${readyzStatusCode}; expected 2xx or repair-only 503`)
    }
    assertRepairOnlyZeroNotionalReadyz(readyz, digest)
    readyzAcceptedReason = 'repair_only_zero_notional'
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
    )
  }

  return { readyzAcceptedReason, readyzStatusCode, summaryLines: lines }
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
