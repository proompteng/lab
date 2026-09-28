#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import process from 'node:process'

type JsonObject = Record<string, unknown>

export type ReadyzPostDeployDecision = 'acceptable' | 'retryable_database_timeout' | 'unacceptable'

type ClassifyReadyzInput = {
  httpStatus: string
  readyz: unknown
}

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const objectAt = (value: unknown, key: string): JsonObject | undefined => {
  if (!isObject(value)) return undefined
  const nested = value[key]
  return isObject(nested) ? nested : undefined
}

const stringAt = (value: unknown, key: string): string => {
  if (!isObject(value)) return ''
  const nested = value[key]
  if (typeof nested === 'string') return nested
  if (typeof nested === 'number' || typeof nested === 'boolean') return String(nested)
  return ''
}

const booleanAt = (value: unknown, key: string): boolean | undefined => {
  if (!isObject(value)) return undefined
  const nested = value[key]
  if (nested === true || nested === 'true') return true
  if (nested === false || nested === 'false') return false
  return undefined
}

const arrayIncludes = (value: unknown, expected: string): boolean => {
  if (!Array.isArray(value)) return false
  return value.some((item) => stringAt({ item }, 'item') === expected)
}

const numberAt = (value: unknown, key: string): number | undefined => {
  if (!isObject(value)) return undefined
  const nested = value[key]
  const parsed = typeof nested === 'number' ? nested : Number(nested)
  return Number.isFinite(parsed) ? parsed : undefined
}

const parseHttpStatus = (value: string): number | undefined => {
  if (!/^[0-9]{3}$/.test(value)) return undefined
  return Number(value)
}

const dependencyOk = (dependencies: JsonObject, name: string): boolean => objectAt(dependencies, name)?.ok === true

const containsDatabaseTimeoutSignal = (value: unknown): boolean => {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    return (
      normalized.includes('statement timeout') ||
      normalized.includes('querycanceled') ||
      normalized.includes('canceling statement due to statement timeout') ||
      normalized.includes('readyz_evaluation_timeout')
    )
  }
  if (Array.isArray(value)) return value.some(containsDatabaseTimeoutSignal)
  if (!isObject(value)) return false
  return Object.values(value).some(containsDatabaseTimeoutSignal)
}

const hasRepairOnlyReadyzContract = (readyz: JsonObject): boolean => {
  if (readyz.status !== 'degraded') return false

  const dependencies = objectAt(readyz, 'dependencies')
  if (!dependencies) return false
  if (!dependencyOk(dependencies, 'postgres')) return false
  if (!dependencyOk(dependencies, 'clickhouse')) return false
  if (!dependencyOk(dependencies, 'database')) return false

  const scheduler = objectAt(readyz, 'scheduler')
  if (!scheduler || scheduler.ok !== true || scheduler.running !== true) return false

  const liveSubmissionGate = objectAt(dependencies, 'live_submission_gate')
  if (!liveSubmissionGate || stringAt(liveSubmissionGate, 'detail') !== 'simple_submit_disabled') return false

  const proofFloor = objectAt(dependencies, 'profitability_proof_floor')
  if (
    !proofFloor ||
    stringAt(proofFloor, 'detail') !== 'repair_only' ||
    stringAt(proofFloor, 'capital_state') !== 'zero_notional'
  ) {
    return false
  }

  return true
}

const hasAcceptedSourceStaleReadyzContract = (readyz: JsonObject): boolean => {
  if (readyz.status !== 'degraded') return false

  const dependencies = objectAt(readyz, 'dependencies')
  if (!dependencies) return false
  if (!dependencyOk(dependencies, 'postgres')) return false
  if (!dependencyOk(dependencies, 'clickhouse')) return false
  if (!dependencyOk(dependencies, 'database')) return false

  const scheduler = objectAt(readyz, 'scheduler')
  if (!scheduler || scheduler.ok !== true || scheduler.running !== true) return false

  const dependencyGate = objectAt(dependencies, 'live_submission_gate')
  if (!dependencyGate || stringAt(dependencyGate, 'detail') !== 'accepted_ta_signal_stale') return false

  const proofFloor = objectAt(dependencies, 'profitability_proof_floor')
  if (
    !proofFloor ||
    stringAt(proofFloor, 'detail') !== 'repair_only' ||
    stringAt(proofFloor, 'capital_state') !== 'zero_notional'
  ) {
    return false
  }

  const liveSubmissionGate = objectAt(readyz, 'live_submission_gate')
  if (!liveSubmissionGate) return false
  if (booleanAt(liveSubmissionGate, 'allowed') !== false) return false
  if (stringAt(liveSubmissionGate, 'reason') !== 'accepted_ta_signal_stale') return false
  if (!arrayIncludes(liveSubmissionGate.blocked_reasons, 'accepted_ta_signal_stale')) return false
  const freshness = objectAt(liveSubmissionGate, 'clickhouse_ta_freshness')
  if (!freshness) return false
  if (stringAt(liveSubmissionGate, 'accepted_source_state') !== 'stale') return false
  if (stringAt(freshness, 'accepted_source_state') !== 'stale') return false
  if (stringAt(liveSubmissionGate, 'blocking_reason') !== 'accepted_ta_signal_stale') return false
  if (stringAt(freshness, 'blocking_reason') !== 'accepted_ta_signal_stale') return false
  if (!arrayIncludes(liveSubmissionGate.accepted_sources, 'ta')) return false
  if (!arrayIncludes(freshness.accepted_sources, 'ta')) return false
  if (!stringAt(liveSubmissionGate, 'latest_accepted_event_at')) return false
  if (stringAt(liveSubmissionGate, 'latest_accepted_event_at') !== stringAt(freshness, 'latest_accepted_event_at')) {
    return false
  }
  const topLevelLagSeconds = numberAt(liveSubmissionGate, 'accepted_lag_seconds')
  const nestedLagSeconds = numberAt(freshness, 'accepted_lag_seconds')
  if (topLevelLagSeconds === undefined || topLevelLagSeconds !== nestedLagSeconds) {
    return false
  }
  const topLevelMaxLagSeconds = numberAt(liveSubmissionGate, 'accepted_max_lag_seconds')
  const nestedMaxLagSeconds = numberAt(freshness, 'accepted_max_lag_seconds')
  if (topLevelMaxLagSeconds === undefined || topLevelMaxLagSeconds !== nestedMaxLagSeconds) {
    return false
  }

  return true
}

const hasCoreDependenciesOnlyReadyzContract = (readyz: JsonObject): boolean => {
  if (readyz.status !== 'degraded') return false
  if (stringAt(readyz, 'readiness_surface') !== 'core_dependencies_only') return false

  const dependencies = objectAt(readyz, 'dependencies')
  if (!dependencies) return false
  if (!dependencyOk(dependencies, 'postgres')) return false
  if (!dependencyOk(dependencies, 'clickhouse')) return false
  if (!dependencyOk(dependencies, 'database')) return false

  const scheduler = objectAt(readyz, 'scheduler')
  if (!scheduler || scheduler.ok !== true || scheduler.running !== true) return false

  const liveSubmissionGate = objectAt(readyz, 'live_submission_gate')
  if (!liveSubmissionGate) return false
  if (booleanAt(liveSubmissionGate, 'allowed') !== false) return false
  if (stringAt(liveSubmissionGate, 'reason') !== 'readyz_core_dependencies_only') return false
  if (!arrayIncludes(liveSubmissionGate.reason_codes, 'readyz_core_dependencies_only')) return false
  if (!arrayIncludes(liveSubmissionGate.blocked_reasons, 'readyz_core_dependencies_only')) return false
  if (stringAt(liveSubmissionGate, 'readiness_surface') !== 'core_dependencies_only') return false
  if (booleanAt(liveSubmissionGate, 'read_model_evaluated') !== false) return false
  for (const authorityKey of [
    'promotion_authority',
    'promotion_authority_ok',
    'final_authority_ok',
    'final_promotion_allowed',
    'final_promotion_authorized',
  ]) {
    if (booleanAt(liveSubmissionGate, authorityKey) !== false) return false
  }

  const activation = objectAt(liveSubmissionGate, 'live_submit_activation')
  if (!activation) return false
  if (booleanAt(activation, 'configured') !== true) return false
  if (booleanAt(activation, 'valid') !== true) return false
  if (!stringAt(activation, 'expires_at')) return false

  return true
}

export const classifyReadyzForPostDeployRetry = ({
  httpStatus,
  readyz,
}: ClassifyReadyzInput): ReadyzPostDeployDecision => {
  const statusCode = parseHttpStatus(httpStatus)
  if (statusCode === undefined || !isObject(readyz)) return 'unacceptable'
  if (statusCode >= 200 && statusCode < 300) return 'acceptable'
  if (statusCode !== 503 || readyz.status !== 'degraded') return 'unacceptable'
  if (hasRepairOnlyReadyzContract(readyz)) return 'acceptable'
  if (hasAcceptedSourceStaleReadyzContract(readyz)) return 'acceptable'
  if (hasCoreDependenciesOnlyReadyzContract(readyz)) return 'acceptable'

  const database = objectAt(objectAt(readyz, 'dependencies'), 'database')
  if (database && database.ok !== true && containsDatabaseTimeoutSignal(database)) {
    return 'retryable_database_timeout'
  }

  return 'unacceptable'
}

const usage = () => {
  console.error('usage: readyz-contract.ts --status <http-status> --readyz-json <path>')
}

const parseArgs = (argv: string[]): { status: string; readyzPath: string } => {
  let status = ''
  let readyzPath = ''

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--status') {
      status = argv[index + 1] ?? ''
      index += 1
    } else if (arg === '--readyz-json') {
      readyzPath = argv[index + 1] ?? ''
      index += 1
    }
  }

  return { status, readyzPath }
}

if (import.meta.main) {
  const { status, readyzPath } = parseArgs(process.argv.slice(2))
  if (!status || !readyzPath) {
    usage()
    process.exit(2)
  }

  try {
    const readyz = JSON.parse(readFileSync(readyzPath, 'utf8')) as unknown
    console.log(classifyReadyzForPostDeployRetry({ httpStatus: status, readyz }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
