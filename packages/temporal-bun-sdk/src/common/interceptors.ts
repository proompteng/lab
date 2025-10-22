// Interceptors for @proompteng/temporal-bun-sdk
import type { ActivityInterceptor, InterceptorManager, WorkflowInterceptor } from '../types'

export type { WorkflowInterceptor, ActivityInterceptor, InterceptorManager }

export class DefaultInterceptorManager implements InterceptorManager {
  private readonly workflowInterceptors: WorkflowInterceptor[] = []
  private readonly activityInterceptors: ActivityInterceptor[] = []

  addWorkflowInterceptor(interceptor: WorkflowInterceptor): void {
    this.workflowInterceptors.push(interceptor)
  }

  addActivityInterceptor(interceptor: ActivityInterceptor): void {
    this.activityInterceptors.push(interceptor)
  }

  removeWorkflowInterceptor(interceptor: WorkflowInterceptor): void {
    const index = this.workflowInterceptors.indexOf(interceptor)
    if (index > -1) {
      this.workflowInterceptors.splice(index, 1)
    }
  }

  removeActivityInterceptor(interceptor: ActivityInterceptor): void {
    const index = this.activityInterceptors.indexOf(interceptor)
    if (index > -1) {
      this.activityInterceptors.splice(index, 1)
    }
  }

  getWorkflowInterceptors(): WorkflowInterceptor[] {
    return [...this.workflowInterceptors]
  }

  getActivityInterceptors(): ActivityInterceptor[] {
    return [...this.activityInterceptors]
  }

  async executeWorkflowInterceptors(input: unknown): Promise<unknown> {
    let result = input
    for (const interceptor of this.workflowInterceptors) {
      if (interceptor.execute) {
        result = await interceptor.execute(result)
      }
    }
    return result
  }

  async executeActivityInterceptors(activityName: string, args: unknown[]): Promise<unknown[]> {
    let result = [...args]
    for (const interceptor of this.activityInterceptors) {
      if (interceptor.execute) {
        const interceptorResult = await interceptor.execute(activityName, result)
        if (Array.isArray(interceptorResult)) {
          result = interceptorResult
        }
      }
    }
    return result
  }
}

// Built-in interceptors
export class LoggingInterceptor implements WorkflowInterceptor, ActivityInterceptor {
  constructor(private logger: (level: string, message: string) => void = console.log) {}

  async execute(input: unknown): Promise<unknown> {
    this.logger('info', `Workflow executing with input: ${JSON.stringify(input)}`)
    return input
  }

  async executeActivity(activityName: string, args: unknown[]): Promise<unknown[]> {
    this.logger('info', `Activity ${activityName} executing with args: ${JSON.stringify(args)}`)
    return [...args]
  }
}

export class MetricsInterceptor implements WorkflowInterceptor, ActivityInterceptor {
  private readonly metrics: Map<string, number> = new Map()

  async execute(input: unknown): Promise<unknown> {
    const count = this.metrics.get('workflow_executions') ?? 0
    this.metrics.set('workflow_executions', count + 1)
    return input
  }

  async executeActivity(activityName: string, args: unknown[]): Promise<unknown[]> {
    const key = `activity_${activityName}_executions`
    const count = this.metrics.get(key) ?? 0
    this.metrics.set(key, count + 1)
    return [...args]
  }

  getMetrics(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.metrics)
  }
}
