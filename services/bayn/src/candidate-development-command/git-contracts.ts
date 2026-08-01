import type { Effect } from 'effect'

import type { CandidateDevelopmentPreflightInput } from '../candidate-development'

import type {
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentMarketDataWitness,
  CandidateDevelopmentStrategyProtocol,
  CandidateDevelopmentVerifiedSource,
  CandidateDevelopmentVerifiedSourceFiles,
} from './contracts'

export interface CandidateDevelopmentVerifiedModuleSource {
  readonly files: CandidateDevelopmentVerifiedSourceFiles
  readonly moduleUrl: string
}

export type CandidateDevelopmentModuleImporter = (
  moduleUrl: string,
  verifiedFiles: CandidateDevelopmentVerifiedSourceFiles,
  runtimeMarketDataLoader?: CandidateDevelopmentRuntimeMarketDataLoader,
) => Effect.Effect<unknown, CandidateDevelopmentCommandFailure>

export type CandidateDevelopmentRuntimeMarketDataLoader = (
  verifiedSource: CandidateDevelopmentVerifiedSource,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  preflightInput: CandidateDevelopmentPreflightInput,
) => Effect.Effect<CandidateDevelopmentMarketDataWitness, CandidateDevelopmentCommandFailure>

export type CandidateDevelopmentSourceVerifier = (
  modulePath: string,
  sourceManifestPath: string,
  sourceGit?: CandidateDevelopmentSourceGit,
) => Effect.Effect<CandidateDevelopmentVerifiedModuleSource, CandidateDevelopmentCommandFailure>

export interface CandidateDevelopmentSourceGit {
  readonly text: (repositoryRoot: string, args: readonly string[], signal?: AbortSignal) => Promise<string>
  readonly bytes: (repositoryRoot: string, args: readonly string[], signal?: AbortSignal) => Promise<Buffer>
  readonly openObjectReader?: (
    repositoryRoot: string,
    signal: AbortSignal,
  ) => Promise<CandidateDevelopmentGitObjectReader>
}

export type CandidateDevelopmentGitObjectType = 'blob' | 'commit' | 'tag' | 'tree'

export interface CandidateDevelopmentGitObjectReader {
  readonly read: (oid: string, expectedType: CandidateDevelopmentGitObjectType) => Promise<Buffer>
  readonly close: () => Promise<void>
}
