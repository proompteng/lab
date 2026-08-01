import { readFile } from 'node:fs/promises'
import * as vm from 'node:vm'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { Data, Effect, pipe, Result } from 'effect'
import { canonicalHashV1Result } from '../hash'
import type {
  CandidateDevelopmentArtifactRuntimeInput,
  CandidateDevelopmentCommandEvaluation,
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentExecutableProgram,
  CandidateDevelopmentMarketDataWitness,
  CandidateDevelopmentStrategyProtocol,
  CandidateDevelopmentVerifiedSource,
  CandidateDevelopmentVerifiedSourceFiles,
} from './contracts'
import {
  candidateDevelopmentExecutableProgramSchemaVersion,
  decodeCandidateDevelopmentInputManifest,
  decodeCandidateDevelopmentStrategyProtocol,
} from './contracts'
import {
  bindCandidateDevelopmentVerifiedSource,
  preregisterCandidateDevelopmentAttempt,
  sourceVerificationFailure,
  validateCandidateDevelopmentVerifiedSource,
} from './evaluation'
import {
  deriveCandidateDevelopmentArtifactPreflightInput,
  recordOf,
  validateCandidateDevelopmentArtifactStructure,
  validateCandidateDevelopmentCommandEvaluation,
  validateCandidateDevelopmentRuntimeMarketData,
} from './runtime-policy'
import {
  candidateDevelopmentArtifactSchemaVersion,
  candidateDevelopmentArtifactEvaluationTimeoutMs,
  candidateDevelopmentArtifactInitializationTimeoutMs,
  candidateDevelopmentPlanArtifactSchemaVersion,
  buildCandidateDevelopmentPlanEvaluation,
} from './plan-evaluation'
import { verifySelfContainedEsm } from './artifact-policy'
import type { CandidateDevelopmentModuleImporter, CandidateDevelopmentRuntimeMarketDataLoader } from './source-git'

type ExecutableProgram = CandidateDevelopmentExecutableProgram<
  unknown,
  unknown,
  CandidateDevelopmentCommandFailure,
  never
>

const candidateDevelopmentArtifactSource = (moduleUrl: string): string => {
  const prefix = 'data:text/javascript;base64,'
  if (!moduleUrl.startsWith(prefix)) throw new Error('candidate artifact URL is not a base64 JavaScript data URL')
  return Buffer.from(moduleUrl.slice(prefix.length), 'base64').toString('utf8')
}

const candidateDevelopmentArtifactContext = (): vm.Context => {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
    name: 'bayn-candidate-development-artifact',
  })
  vm.runInContext(
    `
      Object.defineProperty(globalThis, 'constructor', {
        value: null,
        writable: false,
        configurable: false,
      })
      Object.defineProperty(Error, 'prepareStackTrace', {
        value: undefined,
        writable: false,
        configurable: false,
      })
      Object.defineProperty(Error, 'captureStackTrace', {
        value: undefined,
        writable: false,
        configurable: false,
      })
      Object.defineProperty(Function.prototype, 'toString', {
        value: function () {
          return 'function () { [source unavailable] }'
        },
        writable: false,
        configurable: false,
      })
      Error.stackTraceLimit = 0
      for (const name of [
        'process',
        'Bun',
        'console',
        'Date',
        'Intl',
        'Loader',
        'Temporal',
        'performance',
        'crypto',
        'navigator',
        'fetch',
        'require',
        'module',
        'exports',
        'Promise',
        'ShadowRealm',
        'Atomics',
        'SharedArrayBuffer',
        'FinalizationRegistry',
        'WeakRef',
        'WebAssembly',
        'Worker',
        'SharedWorker',
        'XMLHttpRequest',
        'WebSocket',
        'EventSource',
        'setTimeout',
        'setInterval',
        'setImmediate',
        'queueMicrotask',
      ]) {
        Object.defineProperty(globalThis, name, {
          value: undefined,
          writable: false,
          configurable: false,
        })
      }
      Object.defineProperty(Math, 'random', {
        value: undefined,
        writable: false,
        configurable: false,
      })
      for (const [prototype, names] of [
        [String.prototype, ['localeCompare', 'toLocaleLowerCase', 'toLocaleUpperCase']],
        [Number.prototype, ['toLocaleString']],
        [BigInt.prototype, ['toLocaleString']],
      ]) {
        for (const name of names) {
          Object.defineProperty(prototype, name, {
            value: undefined,
            writable: false,
            configurable: false,
          })
        }
      }
    `,
    context,
    { timeout: candidateDevelopmentArtifactInitializationTimeoutMs },
  )
  return context
}

const runCandidateDevelopmentArtifactComputation = (
  context: vm.Context,
  runtimeInput: CandidateDevelopmentArtifactRuntimeInput,
): unknown => {
  const runtimeInputJson = JSON.stringify(runtimeInput)
  Object.defineProperty(context, '__candidateDevelopmentRuntimeInputJson', {
    value: runtimeInputJson,
    writable: false,
    configurable: true,
  })
  try {
    const output = vm.runInContext(
      `
        (() => {
          const deepFreeze = (value) => {
            if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
            for (const key of Object.keys(value)) deepFreeze(value[key])
            return Object.freeze(value)
          }
          const runtimeInput = deepFreeze(JSON.parse(globalThis.__candidateDevelopmentRuntimeInputJson))
          const builderName =
            globalThis.__candidateDevelopmentArtifact.schemaVersion === '${candidateDevelopmentPlanArtifactSchemaVersion}'
              ? 'buildPlan'
              : 'buildEvaluation'
          const evaluation = globalThis.__candidateDevelopmentArtifact[builderName](runtimeInput)
          if (
            evaluation !== null &&
            (typeof evaluation === 'object' || typeof evaluation === 'function') &&
            typeof evaluation.then === 'function'
          ) {
            throw new TypeError('candidate artifact ' + builderName + ' must be synchronous')
          }
          const encoded = JSON.stringify(evaluation)
          if (typeof encoded !== 'string') {
            throw new TypeError('candidate artifact output must be JSON serializable')
          }
          if (builderName === 'buildPlan') {
            const repeated = globalThis.__candidateDevelopmentArtifact[builderName](runtimeInput)
            if (
              repeated !== null &&
              (typeof repeated === 'object' || typeof repeated === 'function') &&
              typeof repeated.then === 'function'
            ) {
              throw new TypeError('candidate artifact buildPlan must be synchronous')
            }
            const repeatedEncoded = JSON.stringify(repeated)
            if (repeatedEncoded !== encoded) {
              throw new TypeError('candidate artifact buildPlan must be deterministic')
            }
          }
          return encoded
        })()
      `,
      context,
      { timeout: candidateDevelopmentArtifactEvaluationTimeoutMs },
    )
    if (typeof output !== 'string') throw new TypeError('candidate artifact output did not return JSON')
    return JSON.parse(output) as unknown
  } finally {
    Reflect.deleteProperty(context, '__candidateDevelopmentRuntimeInputJson')
  }
}

interface CandidateDevelopmentArtifactWorkerRequest {
  readonly _tag: 'CandidateDevelopmentArtifactWorkerRequest'
  readonly mode: 'definition' | 'evaluation'
  readonly moduleUrl: string
  readonly verifiedFiles: CandidateDevelopmentVerifiedSourceFiles
  readonly runtimeInput?: CandidateDevelopmentArtifactRuntimeInput
}

interface CandidateDevelopmentArtifactRuntimeEnvelope {
  readonly schemaVersion: unknown
  readonly inputManifest: unknown
  readonly output: unknown
}

type CandidateDevelopmentArtifactWorkerResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

const candidateDevelopmentArtifactWorkerRequest = (
  value: unknown,
): value is CandidateDevelopmentArtifactWorkerRequest => {
  const request = recordOf(value)
  return (
    request?._tag === 'CandidateDevelopmentArtifactWorkerRequest' &&
    (request.mode === 'definition' || request.mode === 'evaluation') &&
    typeof request.moduleUrl === 'string' &&
    recordOf(request.verifiedFiles) !== undefined
  )
}

const cloneableWorkerError = (cause: unknown): unknown => {
  if (!(cause instanceof Error)) return cause
  return { name: cause.name, message: cause.message, stack: cause.stack }
}

const loadCandidateDevelopmentArtifactContext = async (
  moduleUrl: string,
  verifiedFiles: CandidateDevelopmentVerifiedSourceFiles,
): Promise<{ readonly context: vm.Context; readonly definition: unknown }> => {
  const source = candidateDevelopmentArtifactSource(moduleUrl)
  const moduleFormat = verifySelfContainedEsm(source, verifiedFiles.modulePath)
  if (Result.isFailure(moduleFormat)) throw moduleFormat.failure
  const context = candidateDevelopmentArtifactContext()
  const artifactModule = new vm.SourceTextModule(source, {
    context,
    identifier: `git:${verifiedFiles.sourceRevision}:${verifiedFiles.moduleBlobOid}`,
    initializeImportMeta: (meta) => Object.freeze(meta),
  })
  await artifactModule.link(() => {
    throw new TypeError('candidate artifact imports are prohibited')
  })
  await artifactModule.evaluate({ timeout: candidateDevelopmentArtifactInitializationTimeoutMs })
  const artifact = Reflect.get(artifactModule.namespace, 'candidateDevelopmentArtifact') as unknown
  Object.defineProperty(context, '__candidateDevelopmentArtifact', {
    value: artifact,
    writable: false,
    configurable: false,
  })
  const definitionJson = vm.runInContext(
    `
      (() => {
        if (
          globalThis.__candidateDevelopmentArtifact === null ||
          typeof globalThis.__candidateDevelopmentArtifact !== 'object'
        ) {
          throw new TypeError('candidateDevelopmentArtifact export is missing')
        }
        const builderName =
          globalThis.__candidateDevelopmentArtifact.schemaVersion === '${candidateDevelopmentPlanArtifactSchemaVersion}'
            ? 'buildPlan'
            : 'buildEvaluation'
        if (typeof globalThis.__candidateDevelopmentArtifact[builderName] !== 'function') {
          throw new TypeError('candidateDevelopmentArtifact.' + builderName + ' is missing')
        }
        return JSON.stringify({
          schemaVersion: globalThis.__candidateDevelopmentArtifact.schemaVersion,
          input: globalThis.__candidateDevelopmentArtifact.input,
          strategyProtocol: globalThis.__candidateDevelopmentArtifact.strategyProtocol,
          structuralBindings: globalThis.__candidateDevelopmentArtifact.structuralBindings,
          inputManifest: globalThis.__candidateDevelopmentArtifact.inputManifest,
        })
      })()
    `,
    context,
    { timeout: candidateDevelopmentArtifactInitializationTimeoutMs },
  )
  if (typeof definitionJson !== 'string') throw new TypeError('candidate artifact definition is not JSON')
  return { context, definition: JSON.parse(definitionJson) as unknown }
}

const runCandidateDevelopmentArtifactWorkerTask = async (
  request: CandidateDevelopmentArtifactWorkerRequest,
): Promise<unknown> => {
  const loaded = await loadCandidateDevelopmentArtifactContext(request.moduleUrl, request.verifiedFiles)
  if (request.mode === 'definition') return loaded.definition
  if (request.runtimeInput === undefined) throw new TypeError('candidate artifact runtime input is missing')
  const definition = recordOf(loaded.definition)
  const output = runCandidateDevelopmentArtifactComputation(loaded.context, request.runtimeInput)
  if (definition?.schemaVersion === candidateDevelopmentArtifactSchemaVersion) {
    const decoded = validateCandidateDevelopmentCommandEvaluation(output)
    if (Result.isFailure(decoded)) throw decoded.failure
    const sourceBinding = validateCandidateDevelopmentVerifiedSource(decoded.success, request.runtimeInput)
    if (Result.isFailure(sourceBinding)) throw sourceBinding.failure
  }
  return {
    schemaVersion: definition?.schemaVersion,
    inputManifest: definition?.inputManifest,
    output,
  } satisfies CandidateDevelopmentArtifactRuntimeEnvelope
}

class CandidateDevelopmentArtifactWorkerError extends Data.TaggedError('CandidateDevelopmentArtifactWorkerError')<{
  readonly cause: unknown
}> {}

const candidateDevelopmentArtifactWorkerCause = (cause: unknown): unknown =>
  cause instanceof CandidateDevelopmentArtifactWorkerError ? cause.cause : cause

export const missingCandidateDevelopmentRuntimeMarketData: CandidateDevelopmentRuntimeMarketDataLoader = () =>
  Effect.fail(
    sourceVerificationFailure('verify-runtime-market-data', {
      field: 'runtimeMarketData',
      expected: 'a typed content-verified runtime market-data witness',
      observed: null,
    }),
  )

export const loadCandidateDevelopmentRuntimeMarketDataFile =
  (marketDataPath: string): CandidateDevelopmentRuntimeMarketDataLoader =>
  (verifiedSource, strategyProtocol, preflightInput) =>
    Effect.tryPromise({
      try: async (signal) => JSON.parse(await readFile(marketDataPath, { encoding: 'utf8', signal })) as unknown,
      catch: (cause) => sourceVerificationFailure('verify-runtime-market-data', cause),
    }).pipe(
      Effect.flatMap((value) =>
        Effect.fromResult(
          validateCandidateDevelopmentRuntimeMarketData(value, verifiedSource, strategyProtocol, preflightInput),
        ),
      ),
    )

const runCandidateDevelopmentArtifactWorker = <A>(
  request: CandidateDevelopmentArtifactWorkerRequest,
): Effect.Effect<A, CandidateDevelopmentArtifactWorkerError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<A>((resolveWorker, rejectWorker) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: request })
        let settled = false
        const cleanup = () => {
          signal.removeEventListener('abort', abort)
          worker.removeAllListeners()
        }
        const settle = async (response: CandidateDevelopmentArtifactWorkerResponse) => {
          if (settled) return
          settled = true
          cleanup()
          try {
            await worker.terminate()
            if (response.ok) resolveWorker(response.value as A)
            else rejectWorker(response.error)
          } catch (cause) {
            rejectWorker(cause)
          }
        }
        const abort = () => {
          void settle({ ok: false, error: signal.reason ?? new Error('candidate artifact worker aborted') })
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        worker.once('message', (response: CandidateDevelopmentArtifactWorkerResponse) => {
          void settle(response)
        })
        worker.once('error', (error) => {
          void settle({ ok: false, error })
        })
        worker.once('exit', (code) => {
          if (!settled) void settle({ ok: false, error: new Error(`candidate artifact worker exited ${code}`) })
        })
      }),
    catch: (cause) => new CandidateDevelopmentArtifactWorkerError({ cause }),
  })

export const executeCandidateDevelopmentArtifactRuntime = (
  moduleUrl: string,
  verifiedFiles: CandidateDevelopmentVerifiedSourceFiles,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  runtimeInput: CandidateDevelopmentArtifactRuntimeInput,
): Effect.Effect<CandidateDevelopmentCommandEvaluation, CandidateDevelopmentCommandFailure> => {
  const { marketData: unverifiedMarketData, ...runtimeContext } = runtimeInput
  return Effect.fromResult(
    validateCandidateDevelopmentRuntimeMarketData(
      unverifiedMarketData,
      runtimeContext,
      strategyProtocol,
      runtimeContext.preflightInput,
    ),
  ).pipe(
    Effect.flatMap((marketData) =>
      pipe({ ...runtimeContext, marketData }, (verifiedRuntimeInput) =>
        runCandidateDevelopmentArtifactWorker<CandidateDevelopmentArtifactRuntimeEnvelope>({
          _tag: 'CandidateDevelopmentArtifactWorkerRequest',
          mode: 'evaluation',
          moduleUrl,
          verifiedFiles,
          runtimeInput: verifiedRuntimeInput,
        }).pipe(Effect.map((envelope) => ({ envelope, runtimeInput: verifiedRuntimeInput }))),
      ),
    ),
    Effect.flatMap(({ envelope, runtimeInput: verifiedRuntimeInput }) => {
      const evaluation =
        envelope.schemaVersion === candidateDevelopmentArtifactSchemaVersion
          ? validateCandidateDevelopmentCommandEvaluation(envelope.output)
          : envelope.schemaVersion === candidateDevelopmentPlanArtifactSchemaVersion
            ? buildCandidateDevelopmentPlanEvaluation(
                envelope.output,
                envelope.inputManifest,
                verifiedRuntimeInput,
                strategyProtocol,
              )
            : Result.fail<CandidateDevelopmentCommandFailure>({
                _tag: 'CandidateDevelopmentCommandProgramInvalid',
                reason: 'schema-version-mismatch',
              })
      return Effect.fromResult(
        pipe(
          evaluation,
          Result.flatMap((decoded) =>
            pipe(
              validateCandidateDevelopmentVerifiedSource(decoded, verifiedRuntimeInput),
              Result.map(() => decoded),
            ),
          ),
        ),
      )
    }),
    Effect.mapError(
      (cause): CandidateDevelopmentCommandFailure =>
        cause instanceof CandidateDevelopmentArtifactWorkerError
          ? {
              _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
              cause: candidateDevelopmentArtifactWorkerCause(cause),
            }
          : cause,
    ),
  )
}

export const evaluateCandidateDevelopmentArtifact: CandidateDevelopmentModuleImporter = (
  moduleUrl,
  verifiedFiles,
  runtimeMarketDataLoader = missingCandidateDevelopmentRuntimeMarketData,
) =>
  Effect.gen(function* () {
    const moduleLoadFailure = (cause: unknown): CandidateDevelopmentCommandFailure => ({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      modulePath: verifiedFiles.modulePath,
      cause: candidateDevelopmentArtifactWorkerCause(cause),
    })
    const definitionValue = yield* runCandidateDevelopmentArtifactWorker<unknown>({
      _tag: 'CandidateDevelopmentArtifactWorkerRequest',
      mode: 'definition',
      moduleUrl,
      verifiedFiles,
    }).pipe(Effect.mapError(moduleLoadFailure))
    const definition = recordOf(definitionValue)
    if (
      definition?.schemaVersion !== candidateDevelopmentArtifactSchemaVersion &&
      definition?.schemaVersion !== candidateDevelopmentPlanArtifactSchemaVersion
    ) {
      return yield* Effect.fail<CandidateDevelopmentCommandFailure>({
        _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
        modulePath: verifiedFiles.modulePath,
        cause: new TypeError('candidate artifact schema version is invalid'),
      })
    }
    if (definition.schemaVersion === candidateDevelopmentPlanArtifactSchemaVersion) {
      yield* Effect.fromResult(
        pipe(
          decodeCandidateDevelopmentInputManifest(definition.inputManifest),
          Result.mapError((cause) => moduleLoadFailure(cause)),
        ),
      )
    }
    const strategyProtocol = yield* Effect.fromResult(
      decodeCandidateDevelopmentStrategyProtocol(definition.strategyProtocol),
    ).pipe(Effect.mapError(moduleLoadFailure))
    const input = yield* Effect.fromResult(
      deriveCandidateDevelopmentArtifactPreflightInput(
        definition.input,
        verifiedFiles,
        strategyProtocol as CandidateDevelopmentStrategyProtocol,
      ),
    ).pipe(Effect.mapError(moduleLoadFailure))
    const verifiedSource = yield* Effect.fromResult(bindCandidateDevelopmentVerifiedSource(verifiedFiles, input)).pipe(
      Effect.mapError(moduleLoadFailure),
    )
    const expectedProtocolHash = yield* Effect.fromResult(canonicalHashV1Result(strategyProtocol)).pipe(
      Effect.mapError(moduleLoadFailure),
    )
    if (expectedProtocolHash !== input.expectedStrategyProtocolHash) {
      return yield* Effect.fail<CandidateDevelopmentCommandFailure>({
        _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
        modulePath: verifiedFiles.modulePath,
        cause: new TypeError('candidate artifact strategy protocol hash differs from preflight'),
      })
    }
    yield* Effect.fromResult(
      validateCandidateDevelopmentArtifactStructure(
        definition.structuralBindings,
        input,
        strategyProtocol as CandidateDevelopmentStrategyProtocol,
        verifiedSource,
      ),
    ).pipe(Effect.mapError(moduleLoadFailure))
    const typedStrategyProtocol = strategyProtocol as CandidateDevelopmentStrategyProtocol
    const loadRuntimeMarketData = (): Effect.Effect<
      CandidateDevelopmentMarketDataWitness,
      CandidateDevelopmentCommandFailure
    > =>
      runtimeMarketDataLoader(verifiedSource, typedStrategyProtocol, input).pipe(
        Effect.flatMap((value) =>
          Effect.fromResult(
            validateCandidateDevelopmentRuntimeMarketData(value, verifiedSource, typedStrategyProtocol, input),
          ),
        ),
      )
    const evaluation = (
      marketData: CandidateDevelopmentMarketDataWitness,
      observedVerifiedSource: CandidateDevelopmentVerifiedSource,
    ): Effect.Effect<CandidateDevelopmentCommandEvaluation, CandidateDevelopmentCommandFailure> =>
      executeCandidateDevelopmentArtifactRuntime(moduleUrl, verifiedFiles, typedStrategyProtocol, {
        ...observedVerifiedSource,
        runtimeDataSchemaVersion: 'bayn.candidate-development-artifact-runtime-input.v1',
        preflightInput: input,
        marketData,
      })
    const program: ExecutableProgram = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input,
      strategyProtocol: typedStrategyProtocol,
      effects: {
        preregisterCandidate: () => Effect.fromResult(preregisterCandidateDevelopmentAttempt(verifiedSource)),
        loadDevelopmentData: loadRuntimeMarketData,
        evaluateDevelopment: (data, _preflight, observedVerifiedSource) =>
          pipe(
            Result.all({
              expected: canonicalHashV1Result(verifiedSource),
              observed: canonicalHashV1Result(observedVerifiedSource),
            }),
            Result.mapError(
              (cause): CandidateDevelopmentCommandFailure => ({
                _tag: 'CandidateDevelopmentCommandHashFailed',
                cause,
              }),
            ),
            Result.flatMap(({ expected, observed }) =>
              expected === observed
                ? Result.succeed(undefined)
                : Result.fail(sourceVerificationFailure('verify-program-binding', { expected, observed })),
            ),
            Effect.fromResult,
            Effect.flatMap(() =>
              Effect.fromResult(
                validateCandidateDevelopmentRuntimeMarketData(
                  data,
                  observedVerifiedSource,
                  typedStrategyProtocol,
                  input,
                ),
              ),
            ),
            Effect.flatMap((marketData) => evaluation(marketData, observedVerifiedSource)),
          ),
      },
    }
    return { candidateDevelopmentProgram: program }
  })

if (!isMainThread && candidateDevelopmentArtifactWorkerRequest(workerData)) {
  void runCandidateDevelopmentArtifactWorkerTask(workerData).then(
    (value) => parentPort?.postMessage({ ok: true, value } satisfies CandidateDevelopmentArtifactWorkerResponse),
    (error) =>
      parentPort?.postMessage({
        ok: false,
        error: cloneableWorkerError(error),
      } satisfies CandidateDevelopmentArtifactWorkerResponse),
  )
}
