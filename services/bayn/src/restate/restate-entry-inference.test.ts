import { expect, test } from 'bun:test'
import type * as restate from '@restatedev/restate-sdk'

import { makeBaynEntryInference } from './restate-entry-inference'
import type { JevInferenceCompletion } from '../jev/inference-work'

const config = {
  controllerKey: 'a'.repeat(64),
  planHash: 'b'.repeat(64),
  sourceRevision: 'c'.repeat(40),
  operationTimeoutMs: 30_000,
}
const request = {
  schemaVersion: 'bayn.inference-dispatch.v1',
  controllerKey: config.controllerKey,
  epoch: 2,
  sourceRevision: config.sourceRevision,
  jobId: 'd'.repeat(64),
}
const completed: JevInferenceCompletion = {
  schemaVersion: 'bayn.jev-inference-completion.v1',
  jobId: request.jobId,
  batchId: request.jobId,
  cycleId: 'e'.repeat(64),
  authorityGenerationHash: 'f'.repeat(64),
  expiresAt: '2026-11-11T18:01:00.000Z',
  completedAt: '2026-11-11T18:00:10.000Z',
  status: 'Completed',
  resultHash: '1'.repeat(64),
}
const evaluate = (runtime: Parameters<typeof makeBaynEntryInference>[1]) =>
  (
    makeBaynEntryInference(config, runtime) as unknown as {
      service: { evaluate: (ctx: restate.Context, input: unknown) => Promise<void> }
    }
  ).service.evaluate

test('inference completion returns only a durable hint to the same account owner', async () => {
  const sends: unknown[] = []
  let calls = 0
  await evaluate({
    executeInference: async (jobId) => {
      calls += 1
      expect(jobId).toBe(request.jobId)
      return completed
    },
  })(
    {
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ attemptCompletedSignal: new AbortController().signal }),
      genericSend: (send: unknown) => sends.push(send),
    } as unknown as restate.Context,
    request,
  )
  expect(calls).toBe(1)
  expect(sends).toEqual([
    expect.objectContaining({
      service: 'BaynExecutionController',
      method: 'wake',
      key: config.controllerKey,
      parameter: expect.objectContaining({
        _tag: 'InferenceCompleted',
        epoch: 2,
        jobId: request.jobId,
        expiresAt: completed.expiresAt,
      }),
    }),
  ])
})

test('an unknown claimed outcome waits for its original expiry and never gets a fresh deadline', async () => {
  let calls = 0
  const sleeps: unknown[] = []
  const { resultHash: _resultHash, ...identity } = completed
  await evaluate({
    executeInference: async () => {
      calls += 1
      return calls === 1 ? { ...identity, status: 'Pending' } : completed
    },
  })(
    {
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ attemptCompletedSignal: new AbortController().signal }),
      genericSend: () => undefined,
      date: { now: async () => Date.parse('2026-11-11T18:00:50.000Z') },
      sleep: async (duration: unknown) => {
        sleeps.push(duration)
      },
    } as unknown as restate.Context,
    request,
  )
  expect(calls).toBe(2)
  expect(sleeps).toEqual([{ milliseconds: 10_000 }])
})

test('a foreign account or source cannot dispatch provider work', async () => {
  const handler = evaluate({
    executeInference: async () => {
      throw new Error('must not dispatch')
    },
  })
  const wrongAccount = await handler({} as restate.Context, { ...request, controllerKey: 'f'.repeat(64) }).catch(
    (cause: unknown) => cause,
  )
  const wrongSource = await handler({} as restate.Context, { ...request, sourceRevision: 'f'.repeat(40) }).catch(
    (cause: unknown) => cause,
  )
  expect(String(wrongAccount)).toContain('immutable account')
  expect(String(wrongSource)).toContain('immutable account')
})
