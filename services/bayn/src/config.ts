import process from 'node:process'

import { Effect } from 'effect'

import { defaultProtocol } from './protocol'
import type { TsmomProtocol } from './types'

export interface BaynConfig {
  readonly host: string
  readonly port: number
  readonly codeRevision: string
  readonly runOnStartup: boolean
  readonly clickhouse: {
    readonly url: string
    readonly username: string
    readonly password: string
    readonly database: string
    readonly table: string
    readonly datasetVersion: string
  }
  readonly tigerBeetle: {
    readonly clusterId: bigint
    readonly replicaAddresses: readonly string[]
    readonly ledger: number
  }
  readonly protocol: TsmomProtocol
}

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

const positiveInteger = (value: string, name: string): number => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`invalid boolean: ${value}`)
}

export const parseConfig = (environment: NodeJS.ProcessEnv): BaynConfig => ({
  host: environment.BAYN_HTTP_HOST?.trim() || '0.0.0.0',
  port: positiveInteger(environment.BAYN_HTTP_PORT || '8080', 'BAYN_HTTP_PORT'),
  codeRevision: required(environment, 'BAYN_CODE_REVISION'),
  runOnStartup: parseBoolean(environment.BAYN_RUN_ON_STARTUP, true),
  clickhouse: {
    url: required(environment, 'BAYN_CLICKHOUSE_URL'),
    username: required(environment, 'BAYN_CLICKHOUSE_USERNAME'),
    password: required(environment, 'BAYN_CLICKHOUSE_PASSWORD'),
    database: environment.BAYN_CLICKHOUSE_DATABASE?.trim() || 'signal',
    table: environment.BAYN_CLICKHOUSE_TABLE?.trim() || 'adjusted_daily_bars_v1',
    datasetVersion: required(environment, 'BAYN_DATASET_VERSION'),
  },
  tigerBeetle: {
    clusterId: BigInt(environment.BAYN_TIGERBEETLE_CLUSTER_ID || '2001'),
    replicaAddresses: required(environment, 'BAYN_TIGERBEETLE_ADDRESSES')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean),
    ledger: positiveInteger(environment.BAYN_TIGERBEETLE_LEDGER || '7001', 'BAYN_TIGERBEETLE_LEDGER'),
  },
  protocol: defaultProtocol,
})

export const loadConfig = Effect.try({
  try: () => parseConfig(process.env),
  catch: (cause) => new Error(`invalid Bayn configuration: ${String(cause)}`),
})
