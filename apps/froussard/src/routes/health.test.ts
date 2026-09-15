import { describe, expect, it, vi } from 'vitest'

import type { AppRuntime } from '@/effect/runtime'
import { createHealthHandlers } from '@/routes/health'
import type { KafkaProducerService } from '@/services/kafka'

const createRuntime = () => {
  const runSync = vi.fn<(...args: unknown[]) => boolean>()
  return {
    runSync,
  } as AppRuntime & { runSync: typeof runSync }
}

describe('createHealthHandlers', () => {
  const kafkaEffect = Symbol('kafka-Ready') as never

  it('returns OK for liveness', () => {
    const runtime = createRuntime()
    const handlers = createHealthHandlers({
      runtime,
      kafka: { isReady: kafkaEffect } as unknown as KafkaProducerService,
    })
    const response = handlers.liveness()

    expect(response.status).toBe(200)
  })

  it('returns 503 when kafka is not ready', () => {
    const runtime = createRuntime()
    runtime.runSync.mockReturnValue(false)
    const handlers = createHealthHandlers({
      runtime,
      kafka: { isReady: kafkaEffect } as unknown as KafkaProducerService,
    })
    const response = handlers.readiness()

    expect(response.status).toBe(503)
    expect(runtime.runSync).toHaveBeenCalledWith(kafkaEffect)
  })

  it('returns OK when kafka is ready', () => {
    const runtime = createRuntime()
    runtime.runSync.mockReturnValue(true)
    const handlers = createHealthHandlers({
      runtime,
      kafka: { isReady: kafkaEffect } as unknown as KafkaProducerService,
    })
    const response = handlers.readiness()

    expect(response.status).toBe(200)
    expect(runtime.runSync).toHaveBeenCalledWith(kafkaEffect)
  })
})
