import { expect, test } from 'bun:test'
import { Worker } from 'node:worker_threads'
import { type ProjectionWorkerOptions } from './worker'
import { nativeArrivalEpochFixture as epoch } from './native-arrival.test-support'
import type { RuntimeMemorySample } from '../../telemetry-memory'

const options: ProjectionWorkerOptions = {
  kafka: {
    brokers: ['unused:9092'],
    username: 'unused',
    password: 'unused',
    groupPrefix: 'fixture',
    operationTimeoutMs: 1000,
    bootstrapTimeoutMs: 1000,
    timestampPolicy: epoch.bootstrap.timestampPolicy,
  },
  sourceRevision: epoch.build.sourceRevision,
  sources: epoch.sources,
}

test('unacknowledged memory samples stay bounded and recover without blocking normal shutdown', async () => {
  const worker = new Worker(new URL('./worker-memory.test-support.ts', import.meta.url), {
    workerData: { ...options, fixtureClock: true },
    env: { PATH: process.env['PATH'] },
  })
  const frames: {
    _tag: string
    memory?: RuntimeMemorySample
  }[] = []
  worker.on('message', (message) => frames.push(message))
  const waitFor = (tag: string) =>
    new Promise<void>((resolve, reject) => {
      const onMessage = (message: { _tag: string }) => {
        if (message._tag === tag) {
          worker.off('message', onMessage)
          worker.off('error', reject)
          resolve()
        }
      }
      worker.on('message', onMessage)
      worker.once('error', reject)
    })
  try {
    await waitFor('Ready')
    let advanced = waitFor('FixtureAdvanced')
    worker.postMessage({ operation: 'cancel', id: -1, fixtureAdvance: 60_000 })
    await advanced
    expect(frames.filter((frame) => frame._tag === 'Memory')).toHaveLength(1)
    advanced = waitFor('FixtureAdvanced')
    worker.postMessage({ operation: 'memory-ack' })
    worker.postMessage({ operation: 'cancel', id: -1, fixtureAdvance: 15_000 })
    await advanced
    const samples = frames.filter((frame) => frame._tag === 'Memory')
    expect(samples).toHaveLength(2)
    expect(samples[1]?.memory?.heapUsed).toBeGreaterThan(0)
    expect(samples[1]?.memory?.heapTotal).toBeGreaterThan(0)
    expect(samples[1]?.memory?.observedAtSeconds).toBe(75)
    const stopped = waitFor('Stopped')
    worker.postMessage({ operation: 'stop', id: 1 })
    await stopped
    expect(frames.filter((frame) => frame._tag === 'Memory')).toHaveLength(2)
  } finally {
    await worker.terminate()
  }
}, 10_000)
