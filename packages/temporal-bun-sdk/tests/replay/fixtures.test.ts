import { expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { fromJson } from '@bufbuild/protobuf'

import { createDefaultDataConverter } from '../../src/common/payloads'
import type { WorkflowInfo } from '../../src/workflow/context'
import type { WorkflowDeterminismState } from '../../src/workflow/determinism'
import { diffDeterminismState, ingestWorkflowHistory } from '../../src/workflow/replay'
import { HistoryEventSchema } from '../../src/proto/temporal/api/history/v1/message_pb'

interface ReplayFixture {
  readonly name: string
  readonly info: WorkflowInfo & { temporalVersion?: string }
  readonly history: unknown[]
  readonly expectedDeterminismState: WorkflowDeterminismState
}

const FIXTURE_DIR = join(import.meta.dir, 'fixtures')

test('replay fixtures remain deterministic', async () => {
  const fixtures = await loadReplayFixtures()
  if (fixtures.length === 0) {
    console.warn('[temporal-bun-sdk] no replay fixtures found; skipping replay assertions')
    return
  }
  const converter = createDefaultDataConverter()

  for (const fixture of fixtures) {
    const events = fixture.history.map((event) => fromJson(HistoryEventSchema, stripTypeAnnotations(event)))
    const replay = await Effect.runPromise(
      ingestWorkflowHistory({
        info: fixture.info,
        history: events,
        dataConverter: converter,
      }),
    )
    expect(replay.determinismState).toEqual(fixture.expectedDeterminismState)

    const diff = await Effect.runPromise(diffDeterminismState(fixture.expectedDeterminismState, replay.determinismState))
    expect(diff.mismatches).toHaveLength(0)
  }
})

const loadReplayFixtures = async (): Promise<ReplayFixture[]> => {
  const filter = process.env.TEMPORAL_REPLAY_FIXTURE?.toLowerCase()
  const files = await readdir(FIXTURE_DIR)
  const fixtures: ReplayFixture[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue
    }
    if (filter && !file.toLowerCase().includes(filter)) {
      continue
    }
    const raw = await readFile(join(FIXTURE_DIR, file), 'utf8')
    fixtures.push(JSON.parse(raw))
  }

  return fixtures
}

const stripTypeAnnotations = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => stripTypeAnnotations(entry))
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$typeName') {
        continue
      }
      next[key] = stripTypeAnnotations(entry)
    }
    return next
  }
  return value
}
