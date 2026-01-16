import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { type CreateTemporalClientOptions, createTemporalClient, type TemporalClient } from '../client'
import { loadTemporalConfig, type TemporalConfig } from '../config'
import { type BunWorkerHandle, type CreateWorkerOptions, createWorker } from '../worker'

export interface TestWorkflowEnvironmentOptions {
  readonly address?: string
  readonly namespace?: string
  readonly taskQueue?: string
  readonly temporalCliPath?: string
  readonly reuseExistingServer?: boolean
}

export interface TimeSkippingTestWorkflowEnvironmentOptions extends TestWorkflowEnvironmentOptions {
  readonly timeSkipping?: true
}

export class TemporalTestServerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemporalTestServerUnavailableError'
  }
}

export class TestWorkflowEnvironment {
  readonly config: TemporalConfig
  readonly client: TemporalClient
  readonly address: string
  readonly namespace: string
  readonly taskQueue: string
  readonly timeSkipping: boolean
  #serverStarted: boolean

  private constructor(params: {
    config: TemporalConfig
    client: TemporalClient
    address: string
    namespace: string
    taskQueue: string
    timeSkipping: boolean
    serverStarted: boolean
  }) {
    this.config = params.config
    this.client = params.client
    this.address = params.address
    this.namespace = params.namespace
    this.taskQueue = params.taskQueue
    this.timeSkipping = params.timeSkipping
    this.#serverStarted = params.serverStarted
  }

  static async createLocal(options: TestWorkflowEnvironmentOptions = {}): Promise<TestWorkflowEnvironment> {
    const config = await loadTemporalConfig({
      defaults: {
        address: options.address,
        namespace: options.namespace,
        taskQueue: options.taskQueue,
      },
    })
    const address = options.address ?? config.address
    const namespace = options.namespace ?? config.namespace
    const taskQueue = options.taskQueue ?? config.taskQueue

    if (!address || !namespace || !taskQueue) {
      throw new TemporalTestServerUnavailableError('Temporal address, namespace, and task queue must be configured')
    }

    if (!options.reuseExistingServer) {
      await startTemporalCli({
        address,
        namespace,
        temporalCliPath: options.temporalCliPath,
        timeSkipping: false,
      })
    }

    const { client } = await createTemporalClient({
      config: {
        ...config,
        address,
        namespace,
        taskQueue,
      },
    })

    return new TestWorkflowEnvironment({
      config: {
        ...config,
        address,
        namespace,
        taskQueue,
      },
      client,
      address,
      namespace,
      taskQueue,
      timeSkipping: false,
      serverStarted: !options.reuseExistingServer,
    })
  }

  static async createTimeSkipping(
    options: TimeSkippingTestWorkflowEnvironmentOptions = {},
  ): Promise<TestWorkflowEnvironment> {
    const config = await loadTemporalConfig({
      defaults: {
        address: options.address,
        namespace: options.namespace,
        taskQueue: options.taskQueue,
      },
    })
    const address = options.address ?? config.address
    const namespace = options.namespace ?? config.namespace
    const taskQueue = options.taskQueue ?? config.taskQueue

    if (!address || !namespace || !taskQueue) {
      throw new TemporalTestServerUnavailableError('Temporal address, namespace, and task queue must be configured')
    }

    if (!options.reuseExistingServer) {
      await startTemporalCli({
        address,
        namespace,
        temporalCliPath: options.temporalCliPath,
        timeSkipping: true,
      })
    }

    const { client } = await createTemporalClient({
      config: {
        ...config,
        address,
        namespace,
        taskQueue,
      },
    })

    return new TestWorkflowEnvironment({
      config: {
        ...config,
        address,
        namespace,
        taskQueue,
      },
      client,
      address,
      namespace,
      taskQueue,
      timeSkipping: true,
      serverStarted: !options.reuseExistingServer,
    })
  }

  static async createExisting(options: TestWorkflowEnvironmentOptions = {}): Promise<TestWorkflowEnvironment> {
    const config = await loadTemporalConfig({
      defaults: {
        address: options.address,
        namespace: options.namespace,
        taskQueue: options.taskQueue,
      },
    })
    const address = options.address ?? config.address
    const namespace = options.namespace ?? config.namespace
    const taskQueue = options.taskQueue ?? config.taskQueue

    if (!address || !namespace || !taskQueue) {
      throw new TemporalTestServerUnavailableError('Temporal address, namespace, and task queue must be configured')
    }

    const { client } = await createTemporalClient({
      config: {
        ...config,
        address,
        namespace,
        taskQueue,
      },
    })

    return new TestWorkflowEnvironment({
      config: {
        ...config,
        address,
        namespace,
        taskQueue,
      },
      client,
      address,
      namespace,
      taskQueue,
      timeSkipping: false,
      serverStarted: false,
    })
  }

  async createWorker(options: CreateWorkerOptions = {}): Promise<BunWorkerHandle> {
    return await createWorker({
      ...options,
      config: {
        ...this.config,
        ...(options.config ?? {}),
        address: this.address,
        namespace: options.namespace ?? this.namespace,
        taskQueue: options.taskQueue ?? this.taskQueue,
      },
    })
  }

  async shutdown(): Promise<void> {
    if (this.#serverStarted) {
      await stopTemporalCli()
      this.#serverStarted = false
    }
    await this.client.shutdown()
  }
}

const startTemporalCli = async (options: {
  address: string
  namespace: string
  temporalCliPath?: string
  timeSkipping: boolean
}) => {
  const projectRoot = join(import.meta.dir, '..', '..')
  const startScript = join(projectRoot, 'scripts', 'start-temporal-cli.ts')
  if (!existsSync(startScript)) {
    throw new TemporalTestServerUnavailableError('Temporal CLI start script is missing')
  }
  const normalized = options.address.includes('://') ? options.address : `http://${options.address}`
  const parsed = new URL(normalized)
  const port = parsed.port || '7233'
  const child = Bun.spawn(['bun', startScript], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      TEMPORAL_ADDRESS: options.address,
      TEMPORAL_PORT: port,
      TEMPORAL_NAMESPACE: options.namespace,
      TEMPORAL_CLI_PATH: options.temporalCliPath ?? process.env.TEMPORAL_CLI_PATH,
      TEMPORAL_TIME_SKIPPING: options.timeSkipping ? '1' : undefined,
    },
  })
  const exitCode = await child.exited
  const stderr = child.stderr ? await readStream(child.stderr) : ''
  if (exitCode !== 0) {
    throw new TemporalTestServerUnavailableError(
      `Temporal CLI start failed (exit ${exitCode}): ${stderr || 'unknown error'}`,
    )
  }
}

const stopTemporalCli = async () => {
  const projectRoot = join(import.meta.dir, '..', '..')
  const stopScript = join(projectRoot, 'scripts', 'stop-temporal-cli.ts')
  if (!existsSync(stopScript)) {
    return
  }
  const child = Bun.spawn(['bun', stopScript], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await child.exited
}

const readStream = async (stream: ReadableStream<Uint8Array<ArrayBufferLike>> | number | null): Promise<string> => {
  if (!stream || typeof stream === 'number') {
    return ''
  }
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  const chunks: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value) {
      chunks.push(decoder.decode(value, { stream: true }))
    }
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

export const createTestWorkflowEnvironment = async (
  options: TestWorkflowEnvironmentOptions = {},
): Promise<TestWorkflowEnvironment> => TestWorkflowEnvironment.createLocal(options)

export const createTimeSkippingWorkflowEnvironment = async (
  options: TimeSkippingTestWorkflowEnvironmentOptions = {},
): Promise<TestWorkflowEnvironment> => TestWorkflowEnvironment.createTimeSkipping(options)

export const createExistingWorkflowEnvironment = async (
  options: TestWorkflowEnvironmentOptions = {},
): Promise<TestWorkflowEnvironment> => TestWorkflowEnvironment.createExisting(options)

export type { CreateTemporalClientOptions }
