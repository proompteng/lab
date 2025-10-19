import { describe, expect, test } from 'bun:test'
import { NativeBridgeError, bridgeVariant, native } from '../src/internal/core-bridge/native.ts'

const telemetryTest = bridgeVariant === 'zig' ? test : test.skip

describe('native telemetry bridge', () => {
  telemetryTest('surfaces missing core runtime until Zig bridge is wired', () => {
    const runtime = native.createRuntime({})
    try {
      expect(() =>
        native.configureTelemetry(runtime, {
          metrics: {
            type: 'prometheus',
            bindAddress: '127.0.0.1:9464',
          },
        }),
      ).toThrowError(/runtime telemetry requires Temporal core runtime/)
    } finally {
      native.runtimeShutdown(runtime)
    }
  })

  telemetryTest('rejects unsupported exporter type', () => {
    const runtime = native.createRuntime({})
    try {
      expect(() =>
        native.configureTelemetry(runtime, {
          metrics: {
            type: 'unsupported',
          },
        }),
      ).toThrow(NativeBridgeError)
    } finally {
      native.runtimeShutdown(runtime)
    }
  })
})
