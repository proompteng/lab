import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect, Layer } from 'effect'

import { executeReplay } from '../../src/bin/replay-command'
import {
  ObservabilityService,
  TemporalConfigService,
  WorkflowServiceClientService,
} from '../../src/runtime/effect-layers'
import type { WorkflowServiceClient } from '../../src/runtime/effect-layers'
import { createObservabilityStub, createTestTemporalConfig } from '../helpers/observability'

describe('temporal-bun replay --history-dir', () => {
  test('replays a directory and emits artifacts when --out is provided', async () => {
    const fixturesDir = join(import.meta.dir, '../replay/fixtures')
    const outDir = resolve(tmpdir(), `temporal-bun-replay-out-${Date.now()}`)
    await mkdir(outDir, { recursive: true })

    const config = createTestTemporalConfig({ workerIdentity: 'replay-test-worker' })
    const observability = createObservabilityStub()
    const layer = Layer.mergeAll(
      Layer.succeed(TemporalConfigService, config),
      Layer.succeed(ObservabilityService, observability.services),
      Layer.succeed(WorkflowServiceClientService, {} as WorkflowServiceClient),
    )

    const result = await Effect.runPromise(
      Effect.provide(
        executeReplay({
          'history-dir': fixturesDir,
          out: outDir,
          json: true,
        }),
        layer,
      ),
    )

    expect('summaries' in result).toBeTrue()
    if ('summaries' in result) {
      expect(result.exitCode).toBe(0)
      expect(result.summaries.length).toBeGreaterThan(0)
      expect(result.reportPath).toBeTruthy()
    }

    const reportPath = join(outDir, 'replay-report.json')
    expect(existsSync(reportPath)).toBeTrue()
    const reportRaw = await readFile(reportPath, 'utf8')
    const parsed = JSON.parse(reportRaw) as { summaries?: unknown[] }
    expect(Array.isArray(parsed.summaries)).toBeTrue()
    expect((parsed.summaries ?? []).length).toBeGreaterThan(0)

    expect(observability.logs.some((entry) => entry.message === 'temporal-bun replay directory started')).toBeTrue()
  })
})

