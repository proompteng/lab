import type { coresdk } from '@temporalio/proto'
import Long from 'long'
import { createDefaultDataConverter, type DataConverter } from '../../common/payloads'
import { buildWorkflowInfo, type WorkflowActivationResult, WorkflowEnvironment } from './environment'

export interface WorkflowEngineOptions {
  workflowsPath: string
  activities?: Record<string, (...args: unknown[]) => unknown>
  showStackTraceSources?: boolean
  interceptors?: readonly string[]
  dataConverter?: DataConverter
}

export interface WorkflowTaskContext {
  namespace: string
  taskQueue: string
}

export class WorkflowEngine {
  readonly #options: WorkflowEngineOptions
  readonly #environments = new Map<string, WorkflowEnvironment>()
  readonly #dataConverter: DataConverter

  constructor(options: WorkflowEngineOptions) {
    this.#options = options
    this.#dataConverter = options.dataConverter ?? createDefaultDataConverter()
  }

  async processWorkflowActivation(
    activation: coresdk.workflow_activation.WorkflowActivation,
    context: WorkflowTaskContext,
  ): Promise<WorkflowActivationResult> {
    if (!activation.runId) {
      throw new Error('Workflow activation is missing runId')
    }

    const environment = await this.#ensureEnvironment(activation, context)
    const result = await environment.processActivation(activation)

    if (shouldEvict(activation)) {
      environment.dispose()
      this.#environments.delete(activation.runId)
    }

    return result
  }

  shutdown(): void {
    for (const [runId, env] of this.#environments.entries()) {
      env.dispose()
      this.#environments.delete(runId)
    }
  }

  async #ensureEnvironment(
    activation: coresdk.workflow_activation.WorkflowActivation,
    context: WorkflowTaskContext,
  ): Promise<WorkflowEnvironment> {
    const existing = this.#environments.get(activation.runId)
    if (existing) {
      return existing
    }

    const initJob = activation.jobs?.find((job) => job.initializeWorkflow)?.initializeWorkflow
    if (!initJob) {
      throw new Error(
        `Received activation for run ${activation.runId} without an InitializeWorkflow job for a new environment`,
      )
    }

    const info = await buildWorkflowInfo(initJob, activation, context, this.#dataConverter)
    const randomnessSeed = toRandomnessSeed(initJob.randomnessSeed)
    const registeredActivityNames = new Set<string>(Object.keys(this.#options.activities ?? {}))

    const environment = await WorkflowEnvironment.create({
      workflowsPath: this.#options.workflowsPath,
      info,
      randomnessSeed,
      now: activation.timestamp ? timestampToMs(activation.timestamp) : Date.now(),
      registeredActivityNames,
      showStackTraceSources: Boolean(this.#options.showStackTraceSources),
      interceptors: this.#options.interceptors,
      dataConverter: this.#dataConverter,
    })

    this.#environments.set(activation.runId, environment)
    return environment
  }
}

const toRandomnessSeed = (seed?: Long | number | null): Uint8Array => {
  if (seed == null) {
    return new Uint8Array([0, 0, 0, 0])
  }
  const long = Long.isLong(seed) ? seed : Long.fromValue(seed)
  return Uint8Array.from(long.toBytes())
}

const timestampToMs = (timestamp: coresdk.workflow_activation.WorkflowActivation['timestamp']): number => {
  if (!timestamp) return Date.now()
  const seconds = typeof timestamp.seconds === 'number' ? timestamp.seconds : Number(timestamp.seconds ?? 0)
  const nanos = timestamp.nanos ?? 0
  return seconds * 1_000 + Math.floor(nanos / 1_000_000)
}

const shouldEvict = (activation: coresdk.workflow_activation.WorkflowActivation): boolean => {
  return Boolean(activation.jobs?.some((job) => job.removeFromCache))
}
