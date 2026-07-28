/**
 * Compatibility facade for the durable bayn.paper-* wire contracts.
 *
 * New execution code must import neutral domain contracts from
 * `./execution/contracts` and use the explicit codecs exported here only at
 * persistence or external-wire boundaries.
 */
import { Result } from 'effect'

import {
  makePaperAuthorityGenerationResult,
  type PaperAuthorityGeneration,
  type PaperAuthorityGenerationMaterial,
} from './execution/legacy-paper-codecs'

export * from './execution/legacy-paper-codecs'

/**
 * Deprecated source-compatibility facade. New code must use
 * `makePaperAuthorityGenerationResult`; this preserves the historical
 * throwing contract only for unmigrated ownership-boundary callers.
 */
export const makePaperAuthorityGeneration = (input: PaperAuthorityGenerationMaterial): PaperAuthorityGeneration =>
  Result.getOrThrowWith(makePaperAuthorityGenerationResult(input), (failure) => failure.cause)
