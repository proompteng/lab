import { Effect } from 'effect'
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import { createWorkflowContext, type WorkflowInfo } from '../../src/workflow/context'
import { DeterminismGuard } from '../../src/workflow/determinism'
import { createNvidiaSupplyChainWorkflow, type NvidiaSupplyChainWorkflowInput } from '../../src/workflows/nvidia-supply-chain'
import type { GrafRequestMetadata } from '../../src/graf/client'
import type { GrafConfig } from '../../src/config'

const loadFixture = async (): Promise<NvidiaSupplyChainWorkflowInput> => {
  const raw = await readFile(new URL('./fixtures/artifact.json', import.meta.url), 'utf8')
  return JSON.parse(raw)
}

const makeInfo = (): WorkflowInfo => ({
  namespace: 'default',
  taskQueue: 'nvidia-supply-chain',
  workflowId: 'wf-1',
  runId: 'run-1',
  workflowType: 'ingestCodexArtifact',
})

const makeContext = (input: NvidiaSupplyChainWorkflowInput) => {
  const guard = new DeterminismGuard()
  const info = makeInfo()
  const { context } = createWorkflowContext({ input, info, determinismGuard: guard })
  return { context, info }
}

const makeGrafConfig = (overrides: Partial<GrafConfig> = {}): GrafConfig => ({
  serviceUrl: 'http://graf.test',
  headers: {},
  confidenceThreshold: 0.5,
  requestTimeoutMs: 1_000,
  retryPolicy: {
    maxAttempts: 2,
    initialDelayMs: 1,
    maxDelayMs: 2,
    backoffCoefficient: 1,
    retryableStatusCodes: [500],
  },
  ...overrides,
})

describe('NVIDIA supply chain workflow', () => {
  test('persists high-confidence artifacts and passes metadata', async () => {
    const fixture = await loadFixture()
    const { context } = makeContext(fixture)
    const grafConfig = makeGrafConfig()
    const calls: string[] = []
    const metadataRecords: GrafRequestMetadata[] = []

    const grafClient = {
      async persistEntities(_request: unknown, metadata: GrafRequestMetadata) {
        metadataRecords.push(metadata)
        calls.push('entities')
        return { results: [] }
      },
      async persistRelationships(_request: unknown, metadata: GrafRequestMetadata) {
        metadataRecords.push(metadata)
        calls.push('relationships')
        return { results: [] }
      },
      async complement(_request: unknown, metadata: GrafRequestMetadata) {
        metadataRecords.push(metadata)
        calls.push('complement')
        return { id: 'hint', message: 'ok', artifactId: metadata.artifactId }
      },
      async clean(_request: unknown, metadata: GrafRequestMetadata) {
        metadataRecords.push(metadata)
        calls.push('clean')
        return { affected: 0, message: 'ok' }
      },
    }

    const workflow = createNvidiaSupplyChainWorkflow({ grafClient, grafConfig })
    const result = await Effect.runPromise(workflow.handler(context))

    expect(result.status).toBe('ingested')
    expect(calls).toEqual(['entities', 'relationships', 'complement', 'clean'])
    expect(metadataRecords.every((meta) => meta.artifactId === fixture.artifact.artifactId)).toBe(true)
    expect(metadataRecords.every((meta) => meta.workflowId === 'wf-1')).toBe(true)
  })

  test('skips persistence when confidence is below threshold', async () => {
    const fixture = await loadFixture()
    fixture.artifact.confidence = 0.1
    const { context } = makeContext(fixture)
    const grafConfig = makeGrafConfig({ confidenceThreshold: 0.9 })
    const calls: string[] = []

    const grafClient = {
      async persistEntities() {
        calls.push('entities')
        return { results: [] }
      },
      async persistRelationships() {
        calls.push('relationships')
        return { results: [] }
      },
      async complement() {
        calls.push('complement')
        return { id: 'hint', message: 'ok', artifactId: 'artifact-123' }
      },
      async clean() {
        calls.push('clean')
        return { affected: 0, message: 'ok' }
      },
    }

    const workflow = createNvidiaSupplyChainWorkflow({ grafClient, grafConfig })
    const result = await Effect.runPromise(workflow.handler(context))

    expect(result.status).toBe('skipped')
    expect(result.detail).toContain('confidence')
    expect(calls).toEqual([])
  })
})
