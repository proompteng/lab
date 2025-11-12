import { expect, test } from 'bun:test'
import { Code, ConnectError } from '@connectrpc/connect'

import { registerWorkerBuildIdCompatibility } from '../src/worker/build-id'
import type {
  UpdateWorkerBuildIdCompatibilityRequest,
} from '../src/proto/temporal/api/workflowservice/v1/request_response_pb'

test('registers a build ID when the RPC succeeds', async () => {
  const requests: UpdateWorkerBuildIdCompatibilityRequest[] = []
  const service = {
    async updateWorkerBuildIdCompatibility(request: UpdateWorkerBuildIdCompatibilityRequest) {
      requests.push(request)
      return {}
    },
  }

  const info: string[] = []
  const originalInfo = console.info
  console.info = (...args: unknown[]) => info.push(args.join(' '))
  try {
    await registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id')
    expect(requests).toHaveLength(1)
    expect(requests[0].namespace).toBe('namespace')
    expect(requests[0].taskQueue).toBe('task-queue')
    expect(requests[0].operation.case).toBe('addNewBuildIdInNewDefaultSet')
    expect(info.some((value) => value.includes('build ID build-id'))).toBeTrue()
  } finally {
    console.info = originalInfo
  }
})

test('retries transient failures before succeeding', async () => {
  const attempts: number[] = []
  const service = {
    async updateWorkerBuildIdCompatibility() {
      attempts.push(attempts.length + 1)
      if (attempts.length < 3) {
        throw new ConnectError('service unavailable', Code.Unavailable)
      }
      return {}
    },
  }

  const delays: number[] = []
  await registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id', {
    sleep: async (ms) => delays.push(ms),
  })

  expect(attempts).toHaveLength(3)
  expect(delays).toEqual([250, 500])
})

test('warns and continues when the API is not implemented', async () => {
  const service = {
    async updateWorkerBuildIdCompatibility() {
      throw new ConnectError('not implemented', Code.Unimplemented)
    },
  }

  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '))
  try {
    await registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('worker versioning API unavailable')
  } finally {
    console.warn = originalWarn
  }
})

test('propagates fatal errors', async () => {
  const fatal = new ConnectError('invalid', Code.InvalidArgument)
  const service = {
    async updateWorkerBuildIdCompatibility() {
      throw fatal
    },
  }

  await expect(
    registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id'),
  ).rejects.toBe(fatal)
})
