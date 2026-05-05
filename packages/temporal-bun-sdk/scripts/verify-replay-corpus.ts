#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { fromJson } from '@bufbuild/protobuf'
import { Effect } from 'effect'

import { createDefaultDataConverter } from '../src/common/payloads'
import { HistoryEventSchema } from '../src/proto/temporal/api/history/v1/message_pb'
import type { WorkflowInfo } from '../src/workflow/context'
import type { WorkflowDeterminismState } from '../src/workflow/determinism'
import { diffDeterminismState, ingestWorkflowHistory } from '../src/workflow/replay'

type ReplayFixture = {
  readonly name: string
  readonly info: WorkflowInfo & { temporalVersion?: string }
  readonly history: unknown[]
  readonly expectedDeterminismState: WorkflowDeterminismState
}

type CorpusManifest = {
  readonly schemaVersion: 1
  readonly fixtures: readonly CorpusEntry[]
}

type CorpusEntry = {
  readonly name: string
  readonly path: string
  readonly workflowType: string
  readonly featureTags: readonly string[]
  readonly historyEventCount: number
  readonly expectedCommandCount: number
}

type CorpusResult = {
  readonly name: string
  readonly path: string
  readonly passed: boolean
  readonly featureTags: readonly string[]
  readonly historyEventCount: number
  readonly expectedCommandCount: number
  readonly mismatchCount: number
}

const packageRoot = join(import.meta.dir, '..')
const manifestPath = join(packageRoot, 'tests', 'replay', 'corpus', 'manifest.json')
const artifactPath = join(packageRoot, '.artifacts', 'replay-corpus', 'report.json')
const minimumFixtures = Math.max(1, Number.parseInt(process.env.TEMPORAL_REPLAY_CORPUS_MIN_FIXTURES ?? '3', 10))

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

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

const describeJsonValue = (value: unknown): string => {
  const encoded = JSON.stringify(value)
  return encoded ?? 'undefined'
}

const verifyEntry = async (entry: CorpusEntry): Promise<CorpusResult> => {
  const resolvedPath = resolve(dirname(manifestPath), entry.path)
  if (!existsSync(resolvedPath)) {
    throw new Error(`Replay corpus fixture missing: ${entry.path}`)
  }
  if (entry.featureTags.length === 0) {
    throw new Error(`Replay corpus fixture ${entry.name} must declare featureTags`)
  }

  const fixture = await readJson<ReplayFixture>(resolvedPath)
  if (fixture.name !== entry.name) {
    throw new Error(`Replay corpus fixture ${entry.name} name mismatch: ${fixture.name}`)
  }
  if (fixture.info.workflowType !== entry.workflowType) {
    throw new Error(`Replay corpus fixture ${entry.name} workflowType mismatch: ${fixture.info.workflowType}`)
  }
  if (fixture.history.length !== entry.historyEventCount) {
    throw new Error(`Replay corpus fixture ${entry.name} history event count drifted`)
  }
  if (fixture.expectedDeterminismState.commandHistory.length !== entry.expectedCommandCount) {
    throw new Error(`Replay corpus fixture ${entry.name} expected command count drifted`)
  }

  const converter = createDefaultDataConverter()
  const events = fixture.history.map((event) => fromJson(HistoryEventSchema, stripTypeAnnotations(event)))
  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info: fixture.info,
      history: events,
      dataConverter: converter,
    }),
  )
  const diff = await Effect.runPromise(diffDeterminismState(fixture.expectedDeterminismState, replay.determinismState))

  return {
    name: entry.name,
    path: entry.path,
    passed: diff.mismatches.length === 0,
    featureTags: entry.featureTags,
    historyEventCount: entry.historyEventCount,
    expectedCommandCount: entry.expectedCommandCount,
    mismatchCount: diff.mismatches.length,
  }
}

const main = async () => {
  if (!existsSync(manifestPath)) {
    throw new Error(`Replay corpus manifest missing: ${manifestPath}`)
  }

  const manifest = await readJson<CorpusManifest>(manifestPath)
  const schemaVersion = (manifest as { readonly schemaVersion?: unknown }).schemaVersion
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported replay corpus manifest schemaVersion=${describeJsonValue(schemaVersion)}`)
  }
  if (manifest.fixtures.length < minimumFixtures) {
    throw new Error(`Replay corpus has ${manifest.fixtures.length} fixtures; ${minimumFixtures} required`)
  }

  const names = new Set<string>()
  for (const entry of manifest.fixtures) {
    if (names.has(entry.name)) {
      throw new Error(`Duplicate replay corpus fixture name: ${entry.name}`)
    }
    names.add(entry.name)
  }

  const results = []
  for (const entry of manifest.fixtures) {
    results.push(await verifyEntry(entry))
  }

  const failed = results.filter((result) => !result.passed)
  const report = {
    generatedAt: new Date().toISOString(),
    minimumFixtures,
    fixtureCount: manifest.fixtures.length,
    passed: failed.length === 0,
    results,
  }

  await mkdir(dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`[temporal-bun-sdk] replay corpus report: ${artifactPath}`)

  if (failed.length > 0) {
    throw new Error(`Replay corpus failed for ${failed.map((result) => result.name).join(', ')}`)
  }
}

await main()
