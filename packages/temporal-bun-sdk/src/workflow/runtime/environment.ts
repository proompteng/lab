import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkerDeploymentVersion } from '@temporalio/common'
import { defaultFailureConverter, defaultPayloadConverter, type WorkflowInfo } from '@temporalio/common'
import {
  decodeSearchAttributes,
  decodeTypedSearchAttributes,
} from '@temporalio/common/lib/converter/payload-search-attributes'
import type { temporal } from '@temporalio/proto'
import { coresdk } from '@temporalio/proto'
import type Long from 'long'
import { native } from '../../internal/core-bridge/native'
import { ensureWorkflowRuntimeBootstrap, withTemporalGlobals } from './bootstrap'
import { convertParentWorkflowInfo, convertRootWorkflowInfo } from './info'

export interface WorkflowEnvironmentOptions {
  workflowsPath: string
  info: WorkflowInfo
  randomnessSeed: Uint8Array
  now: number
  registeredActivityNames: Set<string>
  showStackTraceSources: boolean
  interceptors?: readonly string[]
}

export interface WorkflowActivationResult {
  completion: coresdk.workflow_completion.IWorkflowActivationCompletion
  logs?: temporal.api.common.v1.ILogMessage[]
}

const SOURCE_MAP_STUB = Object.freeze({
  version: 3,
  file: '',
  sources: [] as string[],
  names: [] as string[],
  mappings: '',
})

const makeModuleSpecifier = (absolutePath: string, runId: string) => {
  const url = pathToFileURL(absolutePath)
  // Use run identifier to avoid module cache collisions between workflow instances.
  url.searchParams.set('run', runId)
  return url.href
}

const toArray = (value: Uint8Array | number[]): number[] => Array.from(value)

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
}

type WorkflowGlobalAttributesModule = {
  maybeGetActivatorUntyped?: () => unknown
  setActivatorUntyped?: (activator: unknown) => void
}

export class WorkflowEnvironment {
  readonly #runId: string
  readonly #info: WorkflowInfo
  readonly #randomnessSeed: number[]
  readonly #registeredActivityNames: Set<string>
  readonly #showStackTraceSources: boolean
  readonly #workflowsModuleSpecifier: string
  readonly #interceptors: readonly string[]
  #disposed = false
  #workflowModule: unknown | null = null
  #interceptorsCache: unknown[] | null = null
  #workflowModuleApi: typeof import('@temporalio/workflow/lib/worker-interface.js') | null = null
  #globalAttributes: WorkflowGlobalAttributesModule | null = null
  #activator: unknown | null = null

  private constructor(options: WorkflowEnvironmentOptions) {
    ensureWorkflowRuntimeBootstrap()
    this.#runId = options.info.runId
    this.#info = options.info
    this.#randomnessSeed = toArray(options.randomnessSeed)
    this.#registeredActivityNames = options.registeredActivityNames
    this.#showStackTraceSources = options.showStackTraceSources
    this.#workflowsModuleSpecifier = makeModuleSpecifier(resolve(options.workflowsPath), options.info.runId)
    this.#interceptors = Array.isArray(options.interceptors) ? [...options.interceptors] : []
  }

  static async create(options: WorkflowEnvironmentOptions): Promise<WorkflowEnvironment> {
    const environment = new WorkflowEnvironment(options)
    await environment.#initializeRuntime(options.now)
    return environment
  }

  get runId(): string {
    return this.#runId
  }

  async processActivation(
    activation: coresdk.workflow_activation.WorkflowActivation,
  ): Promise<WorkflowActivationResult> {
    if (this.#disposed) {
      throw new Error(`Workflow environment for run ${this.#runId} has been disposed`)
    }

    try {
      const api = this.#workflowModuleApi ?? failWorkflowModuleNotLoaded(this.#runId)
      this.#restoreWorkflowActivator()
      await withTemporalGlobals(
        {
          importWorkflows: () => this.#workflowModule ?? failWorkflowModuleNotLoaded(this.#runId),
          importInterceptors: () => this.#interceptorsCache ?? [],
        },
        async () => {
          api.activate(activation)
          await flushMicrotasks()
          api.tryUnblockConditions?.()
        },
      )
    } catch (error) {
      const failure = defaultFailureConverter.errorToFailure(error instanceof Error ? error : new Error(String(error)))
      const completion = coresdk.workflow_completion.WorkflowActivationCompletion.create({
        runId: activation.runId,
        failed: coresdk.workflow_completion.Failure.create({ failure }),
      })
      return { completion }
    }

    const api = this.#workflowModuleApi ?? failWorkflowModuleNotLoaded(this.#runId)
    const activationCompletion = api.concludeActivation()
    const commands = activationCompletion.successful?.commands ?? []
    const completion = coresdk.workflow_completion.WorkflowActivationCompletion.create({
      runId: activation.runId,
      successful: coresdk.workflow_completion.Success.create({
        commands,
        usedInternalFlags: activationCompletion.successful?.usedInternalFlags ?? [],
        versioningBehavior: activationCompletion.successful?.versioningBehavior,
      }),
    })

    return { completion }
  }

  dispose(): void {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    void withTemporalGlobals(
      {
        importWorkflows: () => this.#workflowModule ?? failWorkflowModuleNotLoaded(this.#runId),
        importInterceptors: () => this.#interceptorsCache ?? [],
      },
      async () => {
        const api = this.#workflowModuleApi ?? failWorkflowModuleNotLoaded(this.#runId)
        api.dispose()
      },
    )
  }

  async #initializeRuntime(now: number): Promise<void> {
    const workflowsModule = await import(this.#workflowsModuleSpecifier)
    this.#workflowModule = workflowsModule

    const workflowApi = await import('@temporalio/workflow/lib/worker-interface.js')
    const updateScope = await import('@temporalio/workflow/lib/update-scope.js')
    patchAsyncLocalStoragePrototype(updateScope.AsyncLocalStorage?.prototype)
    const cancellationScope = await import('@temporalio/workflow/lib/cancellation-scope.js')
    patchAsyncLocalStoragePrototype(cancellationScope.AsyncLocalStorage?.prototype)
    this.#workflowModuleApi = workflowApi

    if (this.#interceptors.length > 0) {
      this.#interceptorsCache = await Promise.all(
        this.#interceptors.map(async (specifier) => await import(resolveInterceptorSpecifier(specifier))),
      )
    } else {
      this.#interceptorsCache = []
    }

    const timeSource =
      typeof native.getTimeOfDay === 'function' ? native.getTimeOfDay : () => BigInt(Date.now()) * 1000n

    await withTemporalGlobals(
      {
        importWorkflows: () => workflowsModule,
        importInterceptors: () => this.#interceptorsCache ?? [],
      },
      async () => {
        workflowApi.initRuntime({
          info: this.#info,
          randomnessSeed: this.#randomnessSeed,
          now,
          showStackTraceSources: this.#showStackTraceSources,
          sourceMap: SOURCE_MAP_STUB,
          registeredActivityNames: this.#registeredActivityNames,
          getTimeOfDay: timeSource,
        })
      },
    )

    const globalAttributes = (await import(
      '@temporalio/workflow/lib/global-attributes.js'
    )) as WorkflowGlobalAttributesModule
    this.#globalAttributes = globalAttributes
    const activator = globalAttributes.maybeGetActivatorUntyped?.()
    if (!activator) {
      throw new Error('Workflow runtime failed to initialize activator for workflow environment')
    }
    this.#activator = activator
  }

  #restoreWorkflowActivator(): void {
    if (!this.#activator || !this.#globalAttributes?.setActivatorUntyped) {
      return
    }
    this.#globalAttributes.setActivatorUntyped(this.#activator)
  }
}

const resolveInterceptorSpecifier = (specifier: string): string => {
  if (specifier.startsWith('file://') || specifier.startsWith('/') || /^[A-Za-z]:\\/.test(specifier)) {
    return specifier
  }
  const segments = specifier.split(/[\\/]/)
  const resolved = resolve(process.cwd(), ...segments)
  if (sep === '\\') {
    return pathToFileURL(resolved).href
  }
  return pathToFileURL(resolved).href
}

export const buildWorkflowInfo = (
  init: coresdk.workflow_activation.IInitializeWorkflow,
  activation: coresdk.workflow_activation.WorkflowActivation,
  runtime: {
    namespace: string
    taskQueue: string
  },
): WorkflowInfo => {
  if (!init.workflowId || !init.workflowType) {
    throw new TypeError('InitializeWorkflow activation is missing required workflow identifiers')
  }

  const searchAttributes = init.searchAttributes?.indexedFields ?? {}
  const memoFields = init.memo?.fields

  const info: WorkflowInfo = {
    workflowId: init.workflowId,
    runId: activation.runId,
    workflowType: init.workflowType,
    searchAttributes: decodeSearchAttributes(searchAttributes),
    typedSearchAttributes: decodeTypedSearchAttributes(searchAttributes),
    memo: decodeMemoFields(memoFields),
    parent: init.parentWorkflowInfo ? convertParentWorkflowInfo(init.parentWorkflowInfo) : undefined,
    root: init.rootWorkflow ? convertRootWorkflowInfo(init.rootWorkflow) : undefined,
    taskQueue: runtime.taskQueue,
    namespace: runtime.namespace,
    firstExecutionRunId: init.firstExecutionRunId ?? activation.runId,
    continuedFromExecutionRunId: init.continuedFromExecutionRunId ?? undefined,
    startTime: timestampToDate(init.startTime) ?? new Date(),
    runStartTime: timestampToDate(activation.timestamp) ?? new Date(),
    executionTimeoutMs: durationToMs(init.workflowExecutionTimeout),
    executionExpirationTime: timestampToDate(init.workflowExecutionExpirationTime),
    runTimeoutMs: durationToMs(init.workflowRunTimeout),
    taskTimeoutMs: durationToMsRequired(init.workflowTaskTimeout, 'workflowTaskTimeout'),
    retryPolicy: undefined,
    attempt: init.attempt ?? 1,
    cronSchedule: init.cronSchedule ?? undefined,
    cronScheduleToScheduleInterval: durationToMs(init.cronScheduleToScheduleInterval),
    historyLength: activation.historyLength ?? 0,
    historySize: activation.historySizeBytes?.toNumber?.() ?? 0,
    continueAsNewSuggested: activation.continueAsNewSuggested ?? false,
    currentBuildId: activation.deploymentVersionForCurrentTask?.buildId ?? '',
    currentDeploymentVersion: convertDeploymentVersion(activation.deploymentVersionForCurrentTask),
    unsafe: {
      now: () => Date.now(),
      isReplaying: activation.isReplaying ?? false,
    },
    priority: undefined,
    lastResult: decodeLastResult(init.lastCompletionResult),
    lastFailure: init.continuedFailure ? defaultFailureConverter.failureToError(init.continuedFailure) : undefined,
  }

  return info
}

const convertDeploymentVersion = (
  version: temporal.api.deployment.v1.IDeploymentVersion | null | undefined,
): WorkerDeploymentVersion | undefined => {
  if (!version?.buildId) {
    return undefined
  }
  return {
    buildId: version.buildId,
    version: version.version ?? undefined,
  }
}

const decodeMemoFields = (
  fields: Record<string, temporal.api.common.v1.IPayload> | null | undefined,
): Record<string, unknown> => {
  if (!fields) {
    return {}
  }
  const result: Record<string, unknown> = {}
  for (const [key, payload] of Object.entries(fields)) {
    result[key] = payload ? defaultPayloadConverter.fromPayload(payload) : undefined
  }
  return result
}

const decodeLastResult = (payloads: temporal.api.common.v1.IPayloads | null | undefined): unknown => {
  const list = payloads?.payloads
  if (!list || list.length === 0) {
    return undefined
  }
  const first = list[0]
  return first ? defaultPayloadConverter.fromPayload(first) : undefined
}

const timestampToDate = (timestamp: temporal.google.protobuf.ITimestamp | null | undefined): Date | undefined => {
  if (!timestamp) {
    return undefined
  }
  const seconds = toNumber(timestamp.seconds)
  const millis = seconds * 1000 + Math.floor((timestamp.nanos ?? 0) / 1_000_000)
  return new Date(millis)
}

const durationToMs = (duration: temporal.google.protobuf.IDuration | null | undefined): number | undefined => {
  if (!duration) {
    return undefined
  }
  const seconds = toNumber(duration.seconds)
  return seconds * 1000 + Math.floor((duration.nanos ?? 0) / 1_000_000)
}

const durationToMsRequired = (
  duration: temporal.google.protobuf.IDuration | null | undefined,
  label: string,
): number => {
  const ms = durationToMs(duration)
  if (ms === undefined) {
    throw new Error(`${label} must be provided`)
  }
  return ms
}

const toNumber = (value: Long | number | string | null | undefined): number => {
  if (value === null || value === undefined) {
    return 0
  }
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    return Number(value)
  }
  return value.toNumber()
}

const failWorkflowModuleNotLoaded = (runId: string): never => {
  throw new Error(`Workflow module was not initialized for workflow run ${runId}`)
}

const patchAsyncLocalStoragePrototype = (
  proto:
    | {
        run?: (value: unknown, fn: () => unknown) => unknown
        getStore?: () => unknown
        disable?: () => void
        _current?: unknown
      }
    | undefined,
): void => {
  if (!proto || typeof proto.getStore === 'function') {
    return
  }
  proto.run = function run(value: unknown, fn: () => unknown) {
    const previous = this._current
    this._current = value
    try {
      return fn()
    } finally {
      this._current = previous
    }
  }
  proto.getStore = function getStore() {
    return this._current
  }
  proto.disable = function disable() {
    this._current = undefined
  }
}
