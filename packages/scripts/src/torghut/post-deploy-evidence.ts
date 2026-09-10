#!/usr/bin/env bun

import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'

type JsonObject = Record<string, unknown>

export type PostDeployEvidenceInput = {
  apiReadyzHttpStatus: string
  apiReadyz: unknown
  schedulerReplicas: string
  schedulerReadyzHttpStatus?: string
  schedulerReadyz?: unknown
  simTradingEnabled: string
  simStatusHttpStatus: string
  simStatus: unknown
  tradingStatusHttpStatus: string
  tradingStatus: unknown
}

export type PostDeployEvidenceResult = {
  readinessContract: 'active_session_ready' | 'api_containment' | 'market_closed'
  simulationContract: 'simulation_active' | 'simulation_containment'
  apiReadyzStatusCode: number
  schedulerReadyzStatusCode?: number
  summaryLines: string[]
}

type GateSnapshot = {
  allowed: boolean
  blockedReasons: string[]
  reason: string
  route: string
  schemaVersion: string
}

const EXPECTED_CAPITAL_LIMITS = {
  buying_power_reserve_bps: 1_000,
  daily_loss_limit: 0.01,
  drawdown_limit: 0.05,
  gross_limit: 1,
  net_limit: 0.5,
  symbol_limit: 0.5,
} as const

const OPTIONAL_RECONCILIATION_DIAGNOSTICS = new Set([
  'tigerbeetle_reconciliation_missing',
  'tigerbeetle_reconciliation_stale',
])

const requireObject = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonObject
}

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

const requireBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`)
  }
  return value
}

const requireStringList = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
  return [...value]
}

const requireHttpStatus = (value: string, label: string): number => {
  if (!/^\d{3}$/.test(value)) {
    throw new Error(`${label} must be a three-digit status, got ${value || 'unset'}`)
  }
  return Number(value)
}

const requireSchedulerReplicas = (value: string): 0 | 1 => {
  if (value === '0') return 0
  if (value === '1') return 1
  throw new Error(`Torghut scheduler replicas must be exactly 0 or 1, got ${value || 'unset'}`)
}

const requireExactKeys = (value: JsonObject, label: string, expectedKeys: string[]) => {
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`)
  }
}

const gateSnapshot = (value: unknown, label: string): GateSnapshot => {
  const gate = requireObject(value, label)
  const route = requireObject(gate.execution_route, `${label}.execution_route`)
  return {
    allowed: requireBoolean(gate.allowed, `${label}.allowed`),
    blockedReasons: requireStringList(gate.blocked_reasons, `${label}.blocked_reasons`),
    reason: requireString(gate.reason, `${label}.reason`),
    route: requireString(route.route, `${label}.execution_route.route`),
    schemaVersion: requireString(gate.schema_version, `${label}.schema_version`),
  }
}

const requireSameGate = (readyzGate: GateSnapshot, statusGate: GateSnapshot) => {
  if (JSON.stringify(readyzGate) !== JSON.stringify(statusGate)) {
    throw new Error('readyz and trading status live_submission_gate contracts differ')
  }
}

const requireSameBuild = (readyz: JsonObject, status: JsonObject) => {
  const readyzBuild = requireObject(readyz.build, 'readyz.build')
  const statusBuild = requireObject(status.build, 'trading status build')
  for (const key of ['commit', 'image_digest', 'active_revision'] as const) {
    const readyzValue = requireString(readyzBuild[key], `readyz.build.${key}`)
    const statusValue = requireString(statusBuild[key], `trading status build.${key}`)
    if (readyzValue !== statusValue) {
      throw new Error(`readyz and trading status build.${key} differ`)
    }
  }
}

const requireHealthyDependencies = (readyz: JsonObject) => {
  const dependencies = requireObject(readyz.dependencies, 'readyz.dependencies')
  for (const [name, value] of Object.entries(dependencies)) {
    if (name === 'live_submission_gate' || name === 'readiness_cache') continue
    const dependency = requireObject(value, `readyz.dependencies.${name}`)
    if (dependency.ok !== true) {
      throw new Error(`readyz dependency ${name} is not healthy`)
    }
  }
}

const requireCapitalLimits = (status: JsonObject) => {
  const controls = requireObject(status.capital_controls, 'trading status capital_controls')
  for (const [key, expected] of Object.entries(EXPECTED_CAPITAL_LIMITS)) {
    if (controls[key] !== expected) {
      throw new Error(`capital_controls.${key} must be ${expected}, got ${String(controls[key])}`)
    }
  }
}

const requireExecutionProjection = (status: JsonObject, gate: GateSnapshot) => {
  const execution = requireObject(status.execution, 'trading status execution')
  const executionGate = requireObject(execution.gate, 'trading status execution.gate')
  if (
    executionGate.allowed !== gate.allowed ||
    executionGate.reason !== gate.reason ||
    execution.route !== gate.route ||
    JSON.stringify(executionGate.blocked_reasons) !== JSON.stringify(gate.blockedReasons)
  ) {
    throw new Error('execution status does not project the live_submission_gate contract')
  }
}

const requireLedgerHealth = (status: JsonObject) => {
  const ledger = requireObject(status.tigerbeetle_ledger, 'trading status tigerbeetle_ledger')
  if (
    !requireBoolean(ledger.ok, 'trading status tigerbeetle_ledger.ok') ||
    !requireBoolean(ledger.protocol_ok, 'trading status tigerbeetle_ledger.protocol_ok')
  ) {
    throw new Error('TigerBeetle ledger protocol is not healthy')
  }
  const reconciliationRequired = requireBoolean(
    ledger.reconciliation_required,
    'trading status tigerbeetle_ledger.reconciliation_required',
  )
  const blockers = requireStringList(ledger.blockers, 'trading status tigerbeetle_ledger.blockers')
  if (!reconciliationRequired) {
    const blockingDiagnostics = blockers.filter((blocker) => !OPTIONAL_RECONCILIATION_DIAGNOSTICS.has(blocker))
    if (blockingDiagnostics.length > 0) {
      throw new Error(`TigerBeetle ledger has blockers: ${blockingDiagnostics.join(', ')}`)
    }
    return
  }
  if (ledger.reconciliation_ok !== true || ledger.reconciliation_stale !== false) {
    throw new Error('TigerBeetle ledger reconciliation is not current and healthy')
  }
  if (blockers.length > 0) {
    throw new Error('TigerBeetle ledger reconciliation has blockers')
  }
}

const validateReadinessContract = (
  readyzStatusCode: number,
  readyz: JsonObject,
  gate: GateSnapshot,
): PostDeployEvidenceResult['readinessContract'] => {
  if (readyzStatusCode >= 200 && readyzStatusCode < 300) {
    if (readyz.status !== 'ok' || !gate.allowed || gate.reason !== 'operational_submission_ready') {
      throw new Error('readyz 2xx requires an allowed operational submission gate')
    }
    if (gate.route !== 'alpaca' || gate.blockedReasons.length > 0) {
      throw new Error('active-session readiness requires an unblocked Alpaca route')
    }
    return 'active_session_ready'
  }

  if (readyzStatusCode !== 503 || readyz.status !== 'degraded') {
    throw new Error(`Torghut /readyz returned unsupported HTTP ${readyzStatusCode}`)
  }
  if (
    gate.allowed ||
    gate.reason !== 'mainnet_route_unavailable' ||
    gate.route !== 'closed' ||
    JSON.stringify(gate.blockedReasons) !== JSON.stringify(['mainnet_route_unavailable'])
  ) {
    throw new Error('readyz 503 is acceptable only when the regular market session is closed')
  }
  return 'market_closed'
}

const requireApiReadiness = (apiReadyzStatusCode: number, apiReadyz: JsonObject) => {
  if (apiReadyzStatusCode < 200 || apiReadyzStatusCode >= 300) {
    throw new Error(`stable API /readyz must return HTTP 2xx, got ${apiReadyzStatusCode}`)
  }

  requireExactKeys(apiReadyz, 'stable API readyz payload', [
    'process_role',
    'reason_codes',
    'runtime_owner',
    'scheduler',
    'status',
  ])
  if (
    apiReadyz.status !== 'ok' ||
    apiReadyz.process_role !== 'api' ||
    apiReadyz.runtime_owner !== 'torghut-scheduler' ||
    !Array.isArray(apiReadyz.reason_codes) ||
    apiReadyz.reason_codes.length !== 0
  ) {
    throw new Error('stable API readyz must report the process-local API role and external scheduler owner')
  }

  const scheduler = requireObject(apiReadyz.scheduler, 'stable API readyz scheduler')
  requireExactKeys(scheduler, 'stable API readyz scheduler', ['availability', 'owner', 'ownership'])
  if (
    scheduler.ownership !== 'external' ||
    scheduler.owner !== 'torghut-scheduler' ||
    scheduler.availability !== 'not_evaluated'
  ) {
    throw new Error('stable API readyz scheduler ownership contract is invalid')
  }
}

const requireSimulationRuntime = (
  desiredTradingEnabled: string,
  simStatusCode: number,
  simStatus: JsonObject,
): PostDeployEvidenceResult['simulationContract'] => {
  if (simStatusCode < 200 || simStatusCode >= 300) {
    throw new Error(`torghut-sim /trading/status must return HTTP 2xx, got ${simStatusCode}`)
  }
  if (
    simStatus.service !== 'torghut' ||
    simStatus.mode !== 'paper' ||
    simStatus.process_role !== 'simulation' ||
    simStatus.runtime_owner !== 'torghut-sim'
  ) {
    throw new Error('torghut-sim status must describe the local paper simulation runtime')
  }
  if (desiredTradingEnabled === 'false') {
    if (simStatus.enabled !== false || simStatus.running !== false) {
      throw new Error('torghut-sim desired disabled state requires enabled=false and running=false')
    }
    return 'simulation_containment'
  }
  if (desiredTradingEnabled === 'true') {
    if (simStatus.enabled !== true || simStatus.running !== true) {
      throw new Error('torghut-sim desired enabled state requires enabled=true and running=true')
    }
    return 'simulation_active'
  }
  throw new Error(`TORGHUT_SIM_TRADING_ENABLED must be exactly true or false, got ${desiredTradingEnabled || 'unset'}`)
}

const simulationSummaryLine = (contract: PostDeployEvidenceResult['simulationContract']): string =>
  contract === 'simulation_active'
    ? '- Simulation runtime: `simulation_active` (local paper, running)'
    : '- Simulation runtime: `simulation_containment` (local paper, disabled)'

const validateApiContainment = (
  apiReadyzStatusCode: number,
  tradingStatusCode: number,
  status: JsonObject,
  simulationContract: PostDeployEvidenceResult['simulationContract'],
): PostDeployEvidenceResult => {
  if (tradingStatusCode !== 503) {
    throw new Error(`scheduler replicas=0 requires /trading/status HTTP 503, got ${tradingStatusCode}`)
  }
  if (
    status.ok !== false ||
    status.detail !== 'scheduler_runtime_unavailable' ||
    status.owner !== 'torghut-scheduler' ||
    !requireString(status.error_class, 'API containment trading status error_class')
  ) {
    throw new Error('API containment trading status must report the unavailable torghut-scheduler runtime')
  }

  return {
    readinessContract: 'api_containment',
    simulationContract,
    apiReadyzStatusCode,
    summaryLines: [
      '## Torghut Runtime Contract',
      '',
      '- Readiness: `api_containment`',
      '- Scheduler replicas: `0`',
      '- Runtime owner: `torghut-scheduler` (external)',
      '- Trading status: `scheduler_runtime_unavailable` (HTTP 503)',
      simulationSummaryLine(simulationContract),
    ],
  }
}

export const validatePostDeployEvidence = (input: PostDeployEvidenceInput): PostDeployEvidenceResult => {
  const schedulerReplicas = requireSchedulerReplicas(input.schedulerReplicas)
  const apiReadyzStatusCode = requireHttpStatus(input.apiReadyzHttpStatus, 'TORGHUT_API_READYZ_HTTP_STATUS')
  const simStatusCode = requireHttpStatus(input.simStatusHttpStatus, 'TORGHUT_SIM_STATUS_HTTP_STATUS')
  const tradingStatusCode = requireHttpStatus(input.tradingStatusHttpStatus, 'TORGHUT_STATUS_HTTP_STATUS')
  const apiReadyz = requireObject(input.apiReadyz, 'Torghut stable API readyz payload')
  const simStatus = requireObject(input.simStatus, 'torghut-sim trading status payload')
  const status = requireObject(input.tradingStatus, 'torghut trading status payload')
  requireApiReadiness(apiReadyzStatusCode, apiReadyz)
  const simulationContract = requireSimulationRuntime(input.simTradingEnabled, simStatusCode, simStatus)

  if (schedulerReplicas === 0) {
    return validateApiContainment(apiReadyzStatusCode, tradingStatusCode, status, simulationContract)
  }

  if (tradingStatusCode < 200 || tradingStatusCode >= 300) {
    throw new Error(`scheduler replicas=1 requires /trading/status HTTP 2xx, got ${tradingStatusCode}`)
  }
  const schedulerReadyzStatusCode = requireHttpStatus(
    input.schedulerReadyzHttpStatus ?? '',
    'TORGHUT_SCHEDULER_READYZ_HTTP_STATUS',
  )
  const schedulerReadyz = requireObject(input.schedulerReadyz, 'Torghut scheduler readyz payload')
  if (status.service !== 'torghut' || status.mode !== 'live' || status.enabled !== true) {
    throw new Error('trading status must describe the enabled live Torghut runtime')
  }

  const readyzGate = gateSnapshot(schedulerReadyz.live_submission_gate, 'scheduler readyz.live_submission_gate')
  const statusGate = gateSnapshot(status.live_submission_gate, 'trading status live_submission_gate')
  requireSameGate(readyzGate, statusGate)
  requireSameBuild(schedulerReadyz, status)
  requireHealthyDependencies(schedulerReadyz)
  requireCapitalLimits(status)
  requireExecutionProjection(status, statusGate)
  requireLedgerHealth(status)
  const readinessContract = validateReadinessContract(schedulerReadyzStatusCode, schedulerReadyz, readyzGate)

  return {
    readinessContract,
    simulationContract,
    apiReadyzStatusCode,
    schedulerReadyzStatusCode,
    summaryLines: [
      '## Torghut Runtime Contract',
      '',
      `- Readiness: \`${readinessContract}\``,
      '- API readiness: `process-local` (external scheduler owner)',
      `- Live gate: \`${statusGate.reason}\``,
      `- Execution route: \`${statusGate.route}\``,
      '- Capital limits: `1x gross`, `0.5x net`, `0.5x symbol`, `10% buying-power reserve`',
      '- TigerBeetle reconciliation: `current`',
      simulationSummaryLine(simulationContract),
    ],
  }
}

const loadJsonFile = (path: string, label: string): unknown => {
  if (!path.trim()) throw new Error(`${label} path is unset`)
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

export const runPostDeployEvidenceCli = (env: NodeJS.ProcessEnv = process.env): PostDeployEvidenceResult => {
  const result = validatePostDeployEvidence({
    apiReadyzHttpStatus: env.TORGHUT_API_READYZ_HTTP_STATUS ?? '',
    apiReadyz: loadJsonFile(env.TORGHUT_API_READYZ_PAYLOAD ?? '', 'TORGHUT_API_READYZ_PAYLOAD'),
    schedulerReplicas: env.TORGHUT_SCHEDULER_REPLICAS ?? '',
    schedulerReadyzHttpStatus: env.TORGHUT_SCHEDULER_READYZ_HTTP_STATUS,
    schedulerReadyz: env.TORGHUT_SCHEDULER_READYZ_PAYLOAD?.trim()
      ? loadJsonFile(env.TORGHUT_SCHEDULER_READYZ_PAYLOAD, 'TORGHUT_SCHEDULER_READYZ_PAYLOAD')
      : undefined,
    simTradingEnabled: env.TORGHUT_SIM_TRADING_ENABLED ?? '',
    simStatusHttpStatus: env.TORGHUT_SIM_STATUS_HTTP_STATUS ?? '',
    simStatus: loadJsonFile(env.TORGHUT_SIM_STATUS_PAYLOAD ?? '', 'TORGHUT_SIM_STATUS_PAYLOAD'),
    tradingStatusHttpStatus: env.TORGHUT_STATUS_HTTP_STATUS ?? '',
    tradingStatus: loadJsonFile(env.TORGHUT_STATUS_PAYLOAD ?? '', 'TORGHUT_STATUS_PAYLOAD'),
  })
  if (env.GITHUB_STEP_SUMMARY?.trim()) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.summaryLines.join('\n')}\n`, 'utf8')
  }
  const schedulerReadyzSummary =
    result.schedulerReadyzStatusCode === undefined ? '' : `, scheduler readyz HTTP ${result.schedulerReadyzStatusCode}`
  console.log(
    `Torghut post-deploy contract: ${result.readinessContract} (API readyz HTTP ${result.apiReadyzStatusCode}${schedulerReadyzSummary})`,
  )
  return result
}

if (import.meta.main) {
  try {
    runPostDeployEvidenceCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
