#!/usr/bin/env bun

import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'

type JsonObject = Record<string, unknown>

export type PostDeployEvidenceInput = {
  readyzHttpStatus: string
  readyz: unknown
  tradingStatus: unknown
}

export type PostDeployEvidenceResult = {
  readinessContract: 'active_session_ready' | 'market_closed'
  readyzStatusCode: number
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
  gross_limit: 4,
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

const requireHttpStatus = (value: string): number => {
  if (!/^\d{3}$/.test(value)) {
    throw new Error(`TORGHUT_READYZ_HTTP_STATUS must be a three-digit status, got ${value || 'unset'}`)
  }
  return Number(value)
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

export const validatePostDeployEvidence = (input: PostDeployEvidenceInput): PostDeployEvidenceResult => {
  const readyzStatusCode = requireHttpStatus(input.readyzHttpStatus)
  const readyz = requireObject(input.readyz, 'torghut readyz payload')
  const status = requireObject(input.tradingStatus, 'torghut trading status payload')
  if (status.service !== 'torghut' || status.mode !== 'live' || status.enabled !== true) {
    throw new Error('trading status must describe the enabled live Torghut runtime')
  }

  const readyzGate = gateSnapshot(readyz.live_submission_gate, 'readyz.live_submission_gate')
  const statusGate = gateSnapshot(status.live_submission_gate, 'trading status live_submission_gate')
  requireSameGate(readyzGate, statusGate)
  requireSameBuild(readyz, status)
  requireHealthyDependencies(readyz)
  requireCapitalLimits(status)
  requireExecutionProjection(status, statusGate)
  requireLedgerHealth(status)
  const readinessContract = validateReadinessContract(readyzStatusCode, readyz, readyzGate)

  return {
    readinessContract,
    readyzStatusCode,
    summaryLines: [
      '## Torghut Runtime Contract',
      '',
      `- Readiness: \`${readinessContract}\``,
      `- Live gate: \`${statusGate.reason}\``,
      `- Execution route: \`${statusGate.route}\``,
      '- Capital limits: `4x gross`, `0.5x net`, `0.5x symbol`, `10% buying-power reserve`',
      '- TigerBeetle reconciliation: `current`',
    ],
  }
}

const loadJsonFile = (path: string, label: string): unknown => {
  if (!path.trim()) throw new Error(`${label} path is unset`)
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

export const runPostDeployEvidenceCli = (env: NodeJS.ProcessEnv = process.env): PostDeployEvidenceResult => {
  const result = validatePostDeployEvidence({
    readyzHttpStatus: env.TORGHUT_READYZ_HTTP_STATUS ?? '',
    readyz: loadJsonFile(env.TORGHUT_READYZ_PAYLOAD ?? '', 'TORGHUT_READYZ_PAYLOAD'),
    tradingStatus: loadJsonFile(env.TORGHUT_STATUS_PAYLOAD ?? '', 'TORGHUT_STATUS_PAYLOAD'),
  })
  if (env.GITHUB_STEP_SUMMARY?.trim()) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.summaryLines.join('\n')}\n`, 'utf8')
  }
  console.log(`Torghut post-deploy contract: ${result.readinessContract} (HTTP ${result.readyzStatusCode})`)
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
