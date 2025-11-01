import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDefaultDataConverter, type DataConverter } from '../src/common/payloads'
import { runReplayHistory } from '../src/workflow/runtime'
import { importNativeBridge } from './helpers/native-bridge'

const { module: nativeBridge, isStub } = await importNativeBridge()

const replaySupported = nativeBridge && !isStub && (await canCreateReplayWorker(nativeBridge.native))

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))
const historiesDir = join(fixturesDir, 'histories')
const workflowsDir = join(fixturesDir, 'workflows')
const simpleHistoryPath = join(historiesDir, 'simple-workflow.json')
const mismatchHistoryPath = join(historiesDir, 'simple-workflow-mismatch.json')
const workflowsPath = join(workflowsDir, 'simple.workflow.ts')

if (!nativeBridge || nativeBridge.bridgeVariant !== 'zig' || isStub || !replaySupported) {
  describe.skip('workflow replay', () => {
    test('skip replay tests without Zig bridge support', () => {})
  })
} else {
  const { NativeBridgeError } = nativeBridge
  process.env.TEMPORAL_BUN_SDK_USE_ZIG = process.env.TEMPORAL_BUN_SDK_USE_ZIG ?? '1'

  const baseOptions = {
    workflowsPath,
    namespace: 'default',
    taskQueue: 'replay-task-queue',
    identity: 'workflow-replay-test',
  }

  describe('workflow replay', () => {
    test('replays workflow history without divergence', async () => {
      const history = await readFile(simpleHistoryPath, 'utf8')
      await expect(
        runReplayHistory({
          ...baseOptions,
          history,
        }),
      ).resolves.toBeUndefined()
    })

    test('throws on deterministic mismatch', async () => {
      const history = await readFile(mismatchHistoryPath, 'utf8')
      let caught: unknown
      try {
        await runReplayHistory({
          ...baseOptions,
          history,
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeDefined()
      if (caught instanceof NativeBridgeError) {
        expect(caught.message.length).toBeGreaterThan(0)
      } else {
        expect(caught).toBeInstanceOf(Error)
        expect((caught as Error).message).toMatch(/replay|deterministic/i)
      }
    })

    test('honours custom data converter during replay', async () => {
      const history = await readFile(simpleHistoryPath, 'utf8')
      const { converter, counter } = createTrackingConverter()
      await expect(
        runReplayHistory({
          ...baseOptions,
          dataConverter: converter,
          history,
        }),
      ).resolves.toBeUndefined()
      expect(counter.value).toBeGreaterThan(0)
    })
  })
}

const createTrackingConverter = (): { converter: DataConverter; counter: { value: number } } => {
  const converter = createDefaultDataConverter()
  const original = converter.payloadConverter
  const counter = { value: 0 }

  converter.payloadConverter = {
    ...original,
    async fromPayload(payload, valueType) {
      counter.value += 1
      return await original.fromPayload(payload, valueType)
    },
  }

  return { converter, counter }
}

async function canCreateReplayWorker(native: typeof import('../src/internal/core-bridge/native.ts').native): Promise<boolean> {
  if (!native || native.bridgeVariant !== 'zig') {
    return false
  }

  const runtime = native.createRuntime({})
  try {
    const worker = native.createReplayWorker(runtime, {
      namespace: 'default',
      taskQueue: 'replay-task-queue',
      identity: 'replay-test-probe',
    })
    native.destroyReplayWorker(worker)
    return true
  } catch {
    return false
  } finally {
    native.runtimeShutdown(runtime)
  }
}
