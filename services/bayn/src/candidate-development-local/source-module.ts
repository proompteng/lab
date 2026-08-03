import { pathToFileURL } from 'node:url'

import { Data, Effect } from 'effect'

import type { StrategyApplication } from '../strategy'

export class CandidateDevelopmentSourceModuleError extends Data.TaggedError('CandidateDevelopmentSourceModuleError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const isStrategyApplication = (value: unknown): value is StrategyApplication<any, any, any> => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  const definition = candidate.definition
  return (
    typeof definition === 'object' &&
    definition !== null &&
    typeof (definition as Record<string, unknown>).name === 'string' &&
    typeof (definition as Record<string, unknown>).decide === 'function' &&
    typeof candidate.closeTarget === 'function' &&
    typeof candidate.contextAtSignal === 'function' &&
    typeof candidate.parseManifest === 'function' &&
    typeof candidate.prepareQualificationLock === 'function' &&
    typeof candidate.evaluateCurrentDecision === 'function'
  )
}

/**
 * Load the executable application from the reviewed checkout rather than using a separately composed substitute.
 * The revision query keeps Bun from reusing a module cached from another checked-out source revision.
 */
export const loadReviewedStrategyApplication = (
  absoluteModulePath: string,
  sourceRevision: string,
): Effect.Effect<StrategyApplication<any, any, any>, CandidateDevelopmentSourceModuleError> =>
  Effect.tryPromise({
    try: async () => {
      const moduleUrl = `${pathToFileURL(absoluteModulePath).href}?bayn-source-revision=${sourceRevision}`
      const loaded: unknown = await import(moduleUrl)
      const application =
        typeof loaded === 'object' && loaded !== null
          ? (loaded as Record<string, unknown>).strategyApplication
          : undefined
      if (!isStrategyApplication(application)) {
        throw new Error('reviewed candidate module must export strategyApplication')
      }
      return application
    },
    catch: (cause) =>
      new CandidateDevelopmentSourceModuleError({
        message: 'reviewed candidate module could not be loaded as a strategy application',
        cause,
      }),
  })
