import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { status as GrpcStatus, Metadata } from '@grpc/grpc-js'
import type { TemporalConfig } from '../../src/config'

const workerModule = await import('../../src/worker')
const { __testing } = workerModule

type UpdateRequest = Parameters<
  Awaited<ReturnType<typeof createStubConnection>>['workflowService']['updateWorkerVersioningRules']
>[0]

const baseConfig: TemporalConfig = {
  address: '127.0.0.1:7233',
  namespace: 'default',
  taskQueue: 'unit-test',
  allowInsecureTls: true,
  apiKey: undefined as string | undefined,
  tls: undefined,
  host: '127.0.0.1',
  port: 7233,
  workerIdentity: 'test-worker',
  workerIdentityPrefix: 'test-worker',
  showStackTraceSources: false,
}

function createGrpcError(code: number, message: string, details?: string) {
  const error = new Error(message) as Error & {
    code: number
    details?: string
    metadata: Metadata
  }
  error.code = code
  error.details = details
  error.metadata = new Metadata()
  return error
}

type StubResponses = {
  rules?: object
  update?: object
  error?: Error
  updateError?: Error
  systemInfo?: object
  systemError?: Error
  compatibility?: object
  compatibilityAfterUpdate?: object
  compatibilityError?: Error
  compatibilityUpdateError?: Error
}

async function createStubConnection(responses: StubResponses = {}) {
  const defaultRules = {
    assignmentRules: [],
    compatibleRedirectRules: [],
  }

  const rulesResponse = responses.rules ?? defaultRules
  const updateResponse = responses.update ?? defaultRules
  const systemInfoResponse =
    responses.systemInfo ??
    ({
      capabilities: {
        buildIdBasedVersioning: true,
      },
    } as object)

  let compatibility =
    responses.compatibility ??
    ({
      majorVersionSets: [],
    } as object)

  const updates: Record<string, unknown>[] = []
  const compatibilityUpdates: Record<string, unknown>[] = []

  const connection = {
    closed: false,
    workflowService: {
      getSystemInfo: async () => {
        if (responses.systemError) {
          throw responses.systemError
        }
        return systemInfoResponse
      },
      getWorkerVersioningRules: async () => {
        if (responses.error) {
          throw responses.error
        }
        return rulesResponse
      },
      updateWorkerVersioningRules: async (request: Record<string, unknown>) => {
        if (responses.updateError) {
          throw responses.updateError
        }
        updates.push(request)
        return updateResponse
      },
      getWorkerBuildIdCompatibility: async () => {
        if (responses.compatibilityError) {
          throw responses.compatibilityError
        }
        return compatibility
      },
      updateWorkerBuildIdCompatibility: async (request: Record<string, unknown>) => {
        if (responses.compatibilityUpdateError) {
          throw responses.compatibilityUpdateError
        }
        compatibilityUpdates.push(request)
        if (responses.compatibilityAfterUpdate) {
          compatibility = responses.compatibilityAfterUpdate
        }
        return {}
      },
    },
    withDeadline: async <T>(_deadline: number | Date, fn: () => Promise<T>) => await fn(),
    close: async () => {
      connection.closed = true
    },
    updates,
    compatibilityUpdates,
  }

  return connection
}

describe('ensureBuildIdVersioningRule', () => {
  const originalConsoleWarn = console.warn

  beforeEach(() => {
    console.warn = () => {}
  })

  afterEach(() => {
    __testing.resetConnectionFactory()
    console.warn = originalConsoleWarn
  })

  test('commits when buildId is missing', async () => {
    const stub = await createStubConnection()
    __testing.setConnectionFactory(async () => stub)

    await __testing.ensureBuildIdVersioningRule(baseConfig, 'unit-test', 'pkg@1.0.0')

    expect(stub.updates.length).toBe(1)
    expect(stub.updates[0]?.commitBuildId?.targetBuildId).toBe('pkg@1.0.0')
    expect(stub.compatibilityUpdates.length).toBe(0)
    expect(stub.closed).toBeTrue()
  })

  test('commits when buildId exists with partial ramp', async () => {
    const stub = await createStubConnection({
      rules: {
        assignmentRules: [
          {
            rule: {
              targetBuildId: 'pkg@1.0.0',
              percentageRamp: { rampPercentage: 10 },
            },
          },
        ],
      },
    })
    __testing.setConnectionFactory(async () => stub)

    await __testing.ensureBuildIdVersioningRule(baseConfig, 'unit-test', 'pkg@1.0.0')

    expect(stub.updates.length).toBe(1)
    expect(stub.updates[0]?.commitBuildId?.targetBuildId).toBe('pkg@1.0.0')
    expect(stub.compatibilityUpdates.length).toBe(0)
  })

  test('does not commit when fully ramped rule exists', async () => {
    const stub = await createStubConnection({
      rules: {
        assignmentRules: [
          {
            rule: {
              targetBuildId: 'pkg@1.0.0',
            },
          },
        ],
      },
    })
    __testing.setConnectionFactory(async () => stub)

    await __testing.ensureBuildIdVersioningRule(baseConfig, 'unit-test', 'pkg@1.0.0')

    expect(stub.updates.length).toBe(0)
    expect(stub.compatibilityUpdates.length).toBe(0)
  })

  test('skips when server does not advertise build-id versioning', async () => {
    const stub = await createStubConnection({
      systemInfo: {
        capabilities: {
          buildIdBasedVersioning: false,
        },
      },
      compatibilityAfterUpdate: {
        majorVersionSets: [{ buildIds: [{ buildId: 'pkg@1.0.0' }] }],
      },
    })
    __testing.setConnectionFactory(async () => stub)

    await __testing.ensureBuildIdVersioningRule(baseConfig, 'unit-test', 'pkg@1.0.0')

    expect(stub.updates.length).toBe(0)
    expect(stub.compatibilityUpdates.length).toBe(1)
    expect(stub.closed).toBeTrue()
  })

  test('falls back to compatibility API when versioning rules unavailable', async () => {
    const error = createGrpcError(GrpcStatus.FAILED_PRECONDITION, 'worker versioning disabled', 'WORKER VERSIONING disabled')
    const stub = await createStubConnection({
      error,
      compatibilityAfterUpdate: {
        majorVersionSets: [{ buildIds: [{ buildId: 'pkg@1.0.0' }] }],
      },
    })
    __testing.setConnectionFactory(async () => stub)

    await __testing.ensureBuildIdVersioningRule(baseConfig, 'unit-test', 'pkg@1.0.0')

    expect(stub.updates.length).toBe(0)
    expect(stub.compatibilityUpdates.length).toBe(1)
    expect(stub.closed).toBeTrue()
  })

  test('skips when compatibility API is disabled', async () => {
    const error = createGrpcError(GrpcStatus.FAILED_PRECONDITION, 'worker versioning disabled', 'WORKER VERSIONING disabled')
    const stub = await createStubConnection({
      error,
      compatibilityError: error,
    })
    __testing.setConnectionFactory(async () => stub)

    await __testing.ensureBuildIdVersioningRule(baseConfig, 'unit-test', 'pkg@1.0.0')

    expect(stub.updates.length).toBe(0)
    expect(stub.compatibilityUpdates.length).toBe(0)
    expect(stub.closed).toBeTrue()
  })

  test('skips when API is unimplemented', async () => {
    const error = createGrpcError(GrpcStatus.UNIMPLEMENTED, 'unimplemented')
    const stub = await createStubConnection({
      error,
      compatibilityAfterUpdate: {
        majorVersionSets: [{ buildIds: [{ buildId: 'pkg@1.0.0' }] }],
      },
    })
    __testing.setConnectionFactory(async () => stub)

    await __testing.ensureBuildIdVersioningRule(baseConfig, 'unit-test', 'pkg@1.0.0')

    expect(stub.updates.length).toBe(0)
    expect(stub.compatibilityUpdates.length).toBe(1)
    expect(stub.closed).toBeTrue()
  })

  test('wraps unexpected errors in NativeBridgeError', async () => {
    const { NativeBridgeError } = await import('../../src/internal/core-bridge/native')
    const stub = await createStubConnection({
      error: createGrpcError(GrpcStatus.INTERNAL, 'unexpected failure'),
    })
    __testing.setConnectionFactory(async () => stub)

    await expect(
      __testing.ensureBuildIdVersioningRule(baseConfig, 'unit-test', 'pkg@1.0.0'),
    ).rejects.toBeInstanceOf(NativeBridgeError)
  })
})
