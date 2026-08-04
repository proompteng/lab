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

const importReviewedModule = (moduleUrl: string, signal: AbortSignal): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let settled = false
    const abort = () => fail(signal.reason ?? new Error('reviewed strategy module import interrupted'))
    const cleanup = () => signal.removeEventListener('abort', abort)
    const succeed = (value: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (cause: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(cause)
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    import(moduleUrl).then(succeed, fail)
  })

/**
 * Load the executable application from the reviewed checkout rather than using a separately composed substitute.
 * The revision query keeps Bun from reusing a module cached from another checked-out source revision.
 */
export const loadReviewedStrategyApplication = (
  absoluteModulePath: string,
  sourceRevision: string,
): Effect.Effect<StrategyApplication<any, any, any>, CandidateDevelopmentSourceModuleError> =>
  Effect.tryPromise({
    try: (signal) => {
      const moduleUrl = `${pathToFileURL(absoluteModulePath).href}?bayn-source-revision=${sourceRevision}`
      return importReviewedModule(moduleUrl, signal).then((loaded: unknown) => {
        const application =
          typeof loaded === 'object' && loaded !== null
            ? (loaded as Record<string, unknown>).strategyApplication
            : undefined
        if (!isStrategyApplication(application)) {
          throw new Error('reviewed candidate module must export strategyApplication')
        }
        return application
      })
    },
    catch: (cause) =>
      new CandidateDevelopmentSourceModuleError({
        message: 'reviewed candidate module could not be loaded as a strategy application',
        cause,
      }),
  })
