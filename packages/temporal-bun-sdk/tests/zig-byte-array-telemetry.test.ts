import { describe, expect, test } from 'bun:test'
import {
  bridgeVariant,
  native,
  type ByteArrayTelemetrySnapshot,
} from '../src/internal/core-bridge/native.ts'

const zigTest = bridgeVariant === 'zig' ? test : test.skip

describe('zig byte array telemetry', () => {
  zigTest('snapshot/reset broadcast metrics', () => {
    expect(native.byteArrayTelemetry.supported).toBe(true)

    const snapshots: ByteArrayTelemetrySnapshot[] = []
    const unsubscribe = native.byteArrayTelemetry.subscribe((snapshot) => {
      snapshots.push(snapshot)
    })

    const resetSnapshot = native.byteArrayTelemetry.reset()
    expect(resetSnapshot).toMatchObject({
      totalAllocations: 0,
      currentAllocations: 0,
      totalBytes: 0,
      currentBytes: 0,
      allocationFailures: 0,
      maxAllocationSize: 0,
    })
    expect(snapshots).toHaveLength(1)

    const snapshot = native.byteArrayTelemetry.snapshot()
    expect(snapshot).toEqual(resetSnapshot)
    expect(snapshots).toHaveLength(2)

    unsubscribe()
  })

  zigTest('metrics expose counter, gauge, and histogram shells', () => {
    native.byteArrayTelemetry.reset()
    const snapshot = native.byteArrayTelemetry.snapshot()
    expect(Object.values(snapshot).every((value) => value === 0)).toBe(true)

    const metrics = native.byteArrayTelemetry.metrics()
    expect(metrics.counters).toHaveProperty('temporal.byte_array.allocations.total', snapshot.totalAllocations)
    expect(metrics.counters).toHaveProperty('temporal.byte_array.failures.total', snapshot.allocationFailures)
    expect(metrics.gauges).toHaveProperty('temporal.byte_array.allocations.current', snapshot.currentAllocations)
    expect(metrics.gauges).toHaveProperty('temporal.byte_array.bytes.current', snapshot.currentBytes)
    expect(metrics.histograms).toHaveProperty('temporal.byte_array.max_allocation.bytes')
    expect(metrics.histograms['temporal.byte_array.max_allocation.bytes']).toEqual([snapshot.maxAllocationSize])
  })
})
