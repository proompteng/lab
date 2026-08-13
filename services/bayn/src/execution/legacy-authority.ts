import type { ExecutionPolicy } from './configuration'
import { CapitalAuthorityKind } from './authority'
import { Authority } from './contracts'

/**
 * Compatibility projection for the historical OBSERVE/PAPER persistence schema.
 * New runtime composition must use ExecutionPolicy and ExecutionAuthority directly.
 */
export const historicalSandboxAuthority = (execution: ExecutionPolicy): Authority =>
  execution.capitalAuthority._tag === CapitalAuthorityKind.None ? Authority.Observe : Authority.Paper
