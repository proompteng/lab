import { createHash, createHmac } from 'node:crypto'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

void mock.module('server-only', () => ({}))

const secret = 'tengri-bff-test-secret-value-1234567890'
const protoPath = path.resolve(
  import.meta.dir,
  '../../../../../services/tengri/proto/proompteng/runtime/v1/microvm.proto',
)
const definition = protoLoader.loadSync(protoPath, {
  defaults: true,
  enums: String,
  keepCase: false,
  longs: String,
  oneofs: true,
})
const descriptor = grpc.loadPackageDefinition(definition) as unknown as {
  proompteng: {
    runtime: {
      v1: {
        MicroVMControlPlane: grpc.ServiceClientConstructor & { service: grpc.ServiceDefinition }
      }
    }
  }
}

let server: grpc.Server
let receivedMetadata: grpc.Metadata | undefined
let receivedRequest: Record<string, unknown> | undefined

beforeAll(async () => {
  server = new grpc.Server()
  server.addService(descriptor.proompteng.runtime.v1.MicroVMControlPlane.service, {
    createAgent(
      call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
      callback: grpc.sendUnaryData<Record<string, unknown>>,
    ) {
      receivedMetadata = call.metadata
      receivedRequest = call.request
      callback(null, {
        id: 'agent-test',
        displayName: String(call.request.displayName),
        phase: 'AGENT_PHASE_READY',
        architecture: 'ARCHITECTURE_ARM64',
        cpuMillis: 2_000,
        memoryMib: 4_096,
        workspaceGib: 16,
      })
    },
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) reject(error)
      else resolve(boundPort)
    })
  })
  process.env.TENGRI_GRPC_ENDPOINT = `127.0.0.1:${port}`
  process.env.TENGRI_GRPC_TLS = 'false'
  process.env.TENGRI_INTERNAL_HMAC_SECRET = secret
  process.env.TENGRI_PROTO_PATH = protoPath
})

afterAll(async () => {
  const state = globalThis as typeof globalThis & { tengriGrpcClient?: grpc.Client; tengriGrpcService?: unknown }
  state.tengriGrpcClient?.close()
  delete state.tengriGrpcClient
  delete state.tengriGrpcService
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()))
})

describe('Tengri gRPC BFF transport', () => {
  test('projects the public request and signs the GitHub subject for the Rust service', async () => {
    const { createAgent } = await import('./grpc')
    const agent = await createAgent('github:42', 'Tengri')

    expect(receivedRequest).toEqual({ displayName: 'Tengri' })
    expect(agent).toMatchObject({
      id: 'agent-test',
      displayName: 'Tengri',
      phase: 'ready',
      architecture: 'arm64',
      cpuMillis: 2_000,
      memoryMib: 4_096,
      workspaceGib: 16,
    })

    const subject = metadataValue('x-tengri-subject')
    const timestamp = metadataValue('x-tengri-timestamp')
    const nonce = metadataValue('x-tengri-nonce')
    const signature = metadataValue('x-tengri-signature')
    const method = descriptor.proompteng.runtime.v1.MicroVMControlPlane.service.CreateAgent
    const bodyHash = createHash('sha256')
      .update(method.requestSerialize({ displayName: 'Tengri' }))
      .digest('hex')
    expect(subject).toBe('github:42')
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(Number(timestamp)).toBeGreaterThan(0)
    expect(signature).toBe(
      createHmac('sha256', secret)
        .update(`${subject}\n${timestamp}\n${nonce}\n${method.path}\n${bodyHash}`)
        .digest('hex'),
    )
  })
})

function metadataValue(name: string) {
  const value = receivedMetadata?.get(name)[0]
  if (typeof value !== 'string') throw new Error(`missing ${name}`)
  return value
}
