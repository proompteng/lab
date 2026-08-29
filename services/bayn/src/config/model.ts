import { Schema, type Redacted } from 'effect'

import type { BrokerConnection, BrokerConnectionDecodeFailure, BrokerProvider } from '../broker/connection'
import type { BrokerEnvironment } from '../broker/identity'
import type { EmbeddedBuildMetadata } from '../build'
import type { EvaluationBounds } from '../contracts'
import type { BrokerAccess } from '../execution/authority'
import {
  CapitalAuthoritySelection,
  type ExecutionPolicy,
  type ExecutionPolicyResolutionFailure,
} from '../execution/configuration'

export const minimumOperationalThresholdMs = 1_000
export const maximumOperationalThresholdMs = 86_400_000

export interface RuntimeBuildMetadata extends EmbeddedBuildMetadata {
  readonly imageDigest: string
  readonly verification: 'embedded' | 'development-configured'
}

export interface RuntimeConfig {
  readonly host: string
  readonly port: number
  readonly capitalActivationRequestJson?: string | undefined
  readonly researchCapitalBuildLineageJson?: string | undefined
  readonly execution: ExecutionPolicy
  readonly build: RuntimeBuildMetadata
  readonly healthIntervalMs: number
  readonly operationTimeoutMs: number
  readonly expectedExecutionControllerPlanHash?: string | undefined
  readonly cycleStallThresholdMs: number
  readonly reconciliationStaleThresholdMs: number
  readonly unknownMutationThresholdMs: number
  readonly alpaca?:
    | (BrokerConnection & {
        readonly authorityGenerationHash: string
        readonly reconciliationIntervalMs: number
      })
    | undefined
  readonly clickhouse: {
    readonly url: string
    readonly username: string
    readonly password: Redacted.Redacted<string>
    readonly snapshotId: string
    readonly publicationAsOf: string
    readonly calendarVersion: string
    readonly bounds: EvaluationBounds
  }
  readonly postgres: {
    readonly url: Redacted.Redacted<string>
    readonly tls: boolean
    readonly caPath: string
  }
  readonly tigerBeetle: {
    readonly clusterId: bigint
    readonly replicaAddresses: readonly string[]
    readonly ledger: number
  }
}

export interface AutonomousCycleRuntimeConfig {
  readonly cyclePollIntervalMs: number
}

export type AlpacaRuntimeConfig = NonNullable<RuntimeConfig['alpaca']>

type LoadedRuntimeConfigBase = Omit<RuntimeConfig, 'alpaca'> & AutonomousCycleRuntimeConfig

/** The deployed binary has one runtime mode: an account-bound autonomous service. */
export type LoadedRuntimeConfig = LoadedRuntimeConfigBase & {
  readonly runtimeMode: 'AutonomousService'
  readonly execution: Exclude<ExecutionPolicy, { readonly brokerIdentity?: undefined }>
  readonly alpaca: AlpacaRuntimeConfig
}

export const CapitalAuthoritySelectionSchema = Schema.Enum(CapitalAuthoritySelection)

export interface ParsedRuntimeConfig {
  readonly host: string
  readonly port: number
  readonly capitalActivationRequestJson?: string | undefined
  readonly researchCapitalBuildLineageJson?: string | undefined
  readonly brokerAccess: BrokerAccess
  readonly capitalAuthority: CapitalAuthoritySelection
  readonly persistedCapitalGrantHash: string | undefined
  readonly configuredBuild: EmbeddedBuildMetadata & {
    readonly imageDigest: string
  }
  readonly provenanceMode: 'production' | 'development'
  readonly healthIntervalMs: number
  readonly operationTimeoutMs: number
  readonly expectedExecutionControllerPlanHash?: string | undefined
  readonly cycleStallThresholdMs: number
  readonly reconciliationStaleThresholdMs: number
  readonly unknownMutationThresholdMs: number
  readonly cyclePollIntervalMs: number
  readonly authorityGenerationHash: string | undefined
  readonly configuredAlpaca: {
    readonly provider: BrokerProvider
    readonly environment: BrokerEnvironment
    readonly baseUrl: string
    readonly accountId: string | undefined
    readonly key: Redacted.Redacted<string> | undefined
    readonly secret: Redacted.Redacted<string> | undefined
    readonly proxyUrl: string
    readonly retryAttempts: number
    readonly reconciliationIntervalMs: number
  }
  readonly clickhouse: RuntimeConfig['clickhouse']
  readonly postgres: RuntimeConfig['postgres']
  readonly tigerBeetle: RuntimeConfig['tigerBeetle']
}

export interface RuntimeConfigResolutionInput {
  readonly parsed: ParsedRuntimeConfig
  readonly embeddedBuildMetadata: EmbeddedBuildMetadata | undefined
}

export interface AlpacaCredentialPresence {
  readonly accountId: boolean
  readonly keyId: boolean
  readonly secretKey: boolean
}

export type RuntimeConfigResolutionFailure =
  | {
      readonly _tag: 'InvalidEvaluationBounds'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'CyclePollIntervalNotShorterThanStallThreshold'
      readonly cyclePollIntervalMs: number
      readonly cycleStallThresholdMs: number
    }
  | {
      readonly _tag: 'ExecutionReconciliationCadenceNotWithinStaleThreshold'
      readonly reconciliationIntervalMs: number
      readonly priorReconciliationTailTimeoutMs: number
      readonly reconciliationPassTimeoutMs: number
      readonly reconciliationStaleThresholdMs: number
    }
  | {
      readonly _tag: 'IncompleteAlpacaCredentials'
      readonly configured: AlpacaCredentialPresence
    }
  | {
      readonly _tag: 'MissingAlpacaCredentials'
    }
  | {
      readonly _tag: 'MissingAlpacaAuthorityGeneration'
    }
  | {
      readonly _tag: 'InvalidBrokerConnection'
      readonly cause: BrokerConnectionDecodeFailure
    }
  | {
      readonly _tag: 'InvalidExecutionPolicy'
      readonly cause: ExecutionPolicyResolutionFailure
    }
  | {
      readonly _tag: 'ProductionProvenanceRequiresEmbeddedMetadata'
      readonly provenanceMode: 'production'
    }
  | {
      readonly _tag: 'EmbeddedMetadataRequiresProductionProvenance'
      readonly provenanceMode: 'development'
    }
  | {
      readonly _tag: 'ProductionPostgresRequiresTls'
      readonly postgresTls: false
    }
  | {
      readonly _tag: 'InvalidEmbeddedBuildMetadata'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'SourceRevisionMismatch'
      readonly configuredSourceRevision: string
      readonly embeddedSourceRevision: string
    }
  | {
      readonly _tag: 'ImageRepositoryMismatch'
      readonly configuredImageRepository: string
      readonly embeddedImageRepository: string
    }
  | {
      readonly _tag: 'StrategyBehaviorHashMismatch'
      readonly configuredStrategyBehaviorHash: string
      readonly embeddedStrategyBehaviorHash: string
    }
  | {
      readonly _tag: 'StrategyParameterHashMismatch'
      readonly configuredStrategyParameterHash: string
      readonly embeddedStrategyParameterHash: string
    }
