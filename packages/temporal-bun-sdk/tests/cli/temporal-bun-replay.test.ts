import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'

import { temporalCliTestHooks } from '../../src/bin/temporal-bun'
import type { TemporalConfig } from '../../src/config'
import { parseExecutionFlag, replayCommandTestHooks } from '../../src/bin/replay-command'
import type { HistoryEvent } from '../../src/proto/temporal/api/history/v1/message_pb'
import {
  ObservabilityService,
  TemporalConfigService,
  WorkflowServiceClientService,
} from '../../src/runtime/effect-layers'
import type { WorkflowServiceClient } from '../../src/runtime/effect-layers'
import { createObservabilityStub, createTestTemporalConfig } from '../helpers/observability'

const fixturePath = join(import.meta.dir, '../replay/fixtures/timer-workflow.json')

const baseConfig: TemporalConfig = createTestTemporalConfig({
  workerIdentity: 'replay-test-worker',
  workerIdentityPrefix: 'replay-test',
})

describe('parseExecutionFlag', () => {
  test('parses workflowId/runId values', () => {
    expect(parseExecutionFlag('wf/run')).toEqual({ workflowId: 'wf', runId: 'run' })
  })

  test('throws when format is invalid', () => {
    expect(() => parseExecutionFlag('missing-run')).toThrow()
  })
})

test('loadHistoryFromFile parses replay fixtures', async () => {
  const record = await replayCommandTestHooks.loadHistoryFromFile(fixturePath)
  expect(record.events.length).toBeGreaterThan(0)
  expect(record.source).toBe('file')
  expect(record.metadata.workflowType).toBe('timerWorkflow')
})

test('loadExecutionHistory falls back from CLI to service loaders', async () => {
  const cliError = new Error('cli missing')
  const options = {
    historyFile: undefined,
    execution: { workflowId: 'wf-id', runId: 'run-id' },
    workflowType: 'exampleWorkflow',
    namespaceOverride: undefined,
    temporalCliPath: undefined,
    source: 'auto',
    jsonOutput: false,
  } satisfies Parameters<typeof replayCommandTestHooks.loadExecutionHistory>[0]['options']

  const serviceEvent: HistoryEvent = { eventId: 1n, eventType: 1 }

  const outcome = await replayCommandTestHooks.loadExecutionHistory({
    options,
    config: baseConfig,
    loaders: {
      cli: async () => {
        throw cliError
      },
      service: async () => ({
        events: [serviceEvent],
        source: 'service',
        description: 'service-loader',
        metadata: {
          workflowId: 'wf-id',
          runId: 'run-id',
          namespace: baseConfig.namespace,
        },
      }),
    },
    workflowService: {} as WorkflowServiceClient,
  })

  expect(outcome.record.source).toBe('service')
  expect(outcome.record.events).toHaveLength(1)
  expect(outcome.attempts).toHaveLength(1)
  expect(outcome.attempts[0]?.source).toBe('cli')
})

test('loadHistoryViaCli retries transient Temporal CLI transport failures', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'temporal-bun-replay-'))
  const statePath = join(tempDir, 'attempt.txt')
  const cliPath = join(tempDir, 'fake-temporal.sh')

  await writeFile(statePath, '0', 'utf8')
  await writeFile(
    cliPath,
    `#!/usr/bin/env bash
set -euo pipefail
state_file="\${FAKE_TEMPORAL_STATE_FILE:?}"
attempt="$(cat "$state_file")"
next_attempt="$((attempt + 1))"
printf '%s' "$next_attempt" > "$state_file"
if [ "$next_attempt" -lt 3 ]; then
  echo 'time=2026-03-13T10:00:00Z level=ERROR msg="failed reaching server: context deadline exceeded"' >&2
  exit 1
fi
cat "\${FAKE_TEMPORAL_HISTORY_FILE:?}"
`,
    'utf8',
  )
  await chmod(cliPath, 0o755)

  const previousMaxAttempts = process.env.TEMPORAL_CLI_COMMAND_MAX_ATTEMPTS
  const previousRetryMs = process.env.TEMPORAL_CLI_COMMAND_RETRY_MS
  const previousStateFile = process.env.FAKE_TEMPORAL_STATE_FILE
  const previousHistoryFile = process.env.FAKE_TEMPORAL_HISTORY_FILE

  process.env.TEMPORAL_CLI_COMMAND_MAX_ATTEMPTS = '3'
  process.env.TEMPORAL_CLI_COMMAND_RETRY_MS = '1'
  process.env.FAKE_TEMPORAL_STATE_FILE = statePath
  process.env.FAKE_TEMPORAL_HISTORY_FILE = fixturePath

  try {
    const record = await replayCommandTestHooks.loadHistoryViaCli({
      options: {
        historyFile: undefined,
        execution: { workflowId: 'wf-id', runId: 'run-id' },
        workflowType: 'timerWorkflow',
        namespaceOverride: undefined,
        temporalCliPath: cliPath,
        source: 'cli',
        jsonOutput: false,
        debug: false,
      },
      config: baseConfig,
      namespace: baseConfig.namespace,
    })

    expect(record.source).toBe('cli')
    expect(record.events.length).toBeGreaterThan(0)
    expect(await readFile(statePath, 'utf8')).toBe('3')
  } finally {
    if (previousMaxAttempts === undefined) {
      delete process.env.TEMPORAL_CLI_COMMAND_MAX_ATTEMPTS
    } else {
      process.env.TEMPORAL_CLI_COMMAND_MAX_ATTEMPTS = previousMaxAttempts
    }
    if (previousRetryMs === undefined) {
      delete process.env.TEMPORAL_CLI_COMMAND_RETRY_MS
    } else {
      process.env.TEMPORAL_CLI_COMMAND_RETRY_MS = previousRetryMs
    }
    if (previousStateFile === undefined) {
      delete process.env.FAKE_TEMPORAL_STATE_FILE
    } else {
      process.env.FAKE_TEMPORAL_STATE_FILE = previousStateFile
    }
    if (previousHistoryFile === undefined) {
      delete process.env.FAKE_TEMPORAL_HISTORY_FILE
    } else {
      process.env.FAKE_TEMPORAL_HISTORY_FILE = previousHistoryFile
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('handleReplay logs through injected observability services', async () => {
  const observability = createObservabilityStub()
  const layer = Layer.mergeAll(
    Layer.succeed(TemporalConfigService, baseConfig),
    Layer.succeed(ObservabilityService, observability.services),
    Layer.succeed(WorkflowServiceClientService, {} as WorkflowServiceClient),
  )

  await Effect.runPromise(
    Effect.provide(
      temporalCliTestHooks.handleReplay([], { 'history-file': fixturePath }),
      layer,
    ),
  )

  expect(observability.logs.some((entry) => entry.message === 'temporal-bun replay started')).toBeTrue()
})
