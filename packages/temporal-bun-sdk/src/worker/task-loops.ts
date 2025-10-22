import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface WorkflowTask {
  workflowId: string
  runId: string
  workflowType: string
  activation: unknown
}

export interface ActivityTask {
  activityId: string
  activityType: string
  input: unknown[]
  heartbeatTimeoutMs: number
}

export interface TaskLoopOptions {
  pollIntervalMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

export class WorkflowTaskLoop {
  private isRunning = false
  private abortController?: AbortController

  constructor(
    private readonly pollWorkflowTask: () => Promise<WorkflowTask | null>,
    private readonly handleWorkflowTask: (task: WorkflowTask) => Promise<void>,
    private readonly options: TaskLoopOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('WorkflowTaskLoop is already running')
    }

    this.isRunning = true
    this.abortController = new AbortController()

    await this.runLoop()
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    this.isRunning = false
    this.abortController?.abort()
  }

  private async runLoop(): Promise<void> {
    const { pollIntervalMs = 1000, retryDelayMs = 1000 } = this.options

    while (this.isRunning && !this.abortController?.signal.aborted) {
      try {
        const task = await this.pollWorkflowTask()

        if (task) {
          await this.handleWorkflowTask(task)
        } else {
          // No task available, wait before next poll
          await this.sleep(pollIntervalMs)
        }
      } catch (error) {
        if (this.abortController?.signal.aborted) {
          break
        }

        console.error('Workflow task loop error:', error)

        // Exponential backoff on errors
        await this.sleep(retryDelayMs)
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export class ActivityTaskLoop {
  private isRunning = false
  private abortController?: AbortController

  constructor(
    private readonly pollActivityTask: () => Promise<ActivityTask | null>,
    private readonly handleActivityTask: (task: ActivityTask) => Promise<void>,
    private readonly options: TaskLoopOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('ActivityTaskLoop is already running')
    }

    this.isRunning = true
    this.abortController = new AbortController()

    await this.runLoop()
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    this.isRunning = false
    this.abortController?.abort()
  }

  private async runLoop(): Promise<void> {
    const { pollIntervalMs = 1000, retryDelayMs = 1000 } = this.options

    while (this.isRunning && !this.abortController?.signal.aborted) {
      try {
        const task = await this.pollActivityTask()

        if (task) {
          await this.handleActivityTask(task)
        } else {
          // No task available, wait before next poll
          await this.sleep(pollIntervalMs)
        }
      } catch (error) {
        if (this.abortController?.signal.aborted) {
          break
        }

        console.error('Activity task loop error:', error)

        // Exponential backoff on errors
        await this.sleep(retryDelayMs)
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export class WorkflowIsolateManager {
  private isolates = new Map<string, unknown>()
  private workflowsPath: string

  constructor(workflowsPath: string) {
    this.workflowsPath = workflowsPath

    if (!existsSync(workflowsPath)) {
      throw new Error(`Workflows path does not exist: ${workflowsPath}`)
    }
  }

  async loadWorkflow(workflowType: string): Promise<unknown> {
    const cacheKey = workflowType

    if (this.isolates.has(cacheKey)) {
      return this.isolates.get(cacheKey)
    }

    try {
      // Try to import the workflow file directly
      const workflowPath = join(this.workflowsPath, workflowType)
      const workflowModule = await import(workflowPath)

      // Extract the workflow function (assuming default export)
      const workflowFn = workflowModule.default

      if (typeof workflowFn !== 'function') {
        throw new Error(`Workflow function not found for type: ${workflowType}`)
      }

      this.isolates.set(cacheKey, workflowFn)
      return workflowFn
    } catch (error) {
      throw new Error(`Failed to load workflow ${workflowType}: ${error}`)
    }
  }

  async executeWorkflow(workflowType: string, activation: unknown): Promise<unknown> {
    const workflowFn = await this.loadWorkflow(workflowType)

    try {
      // Import workflow runtime
      const { WorkflowRuntime } = await import('../workflow/runtime')

      // Create workflow runtime
      const runtime = new WorkflowRuntime(workflowFn)

      // Execute workflow with proper activation context
      const completion = await runtime.execute({
        workflowId: activation?.workflowId || 'unknown',
        runId: activation?.runId || 'unknown',
        workflowType: workflowType,
        input: activation?.input ?? activation,
        history: activation?.history || [],
        signals: activation?.signals || [],
        queries: activation?.queries || [],
        patches: activation?.patches || [],
      })

      if (!completion.success) {
        throw new Error(completion.error || 'Workflow execution failed')
      }

      // Handle Bun-specific serialization issues
      return this.serializeResult(completion.result)
    } catch (error) {
      throw new Error(`Workflow execution failed: ${error}`)
    }
  }

  private serializeResult(result: unknown): unknown {
    try {
      // Handle BigInt serialization for Bun compatibility
      if (result && typeof result === 'object') {
        return JSON.parse(
          JSON.stringify(result, (_key, value) => {
            if (typeof value === 'bigint') {
              return value.toString()
            }
            if (value instanceof Date) {
              return value.toISOString()
            }
            if (value instanceof ArrayBuffer) {
              return Array.from(new Uint8Array(value))
            }
            return value
          }),
        )
      }
      return result
    } catch (_error) {
      // If serialization fails, return the original result
      // This handles cases where the result contains non-serializable data
      return result
    }
  }

  clearCache(): void {
    this.isolates.clear()
  }
}
