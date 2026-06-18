import { describe, expect, test } from 'vitest'

import { isLoopDetected } from './run'
import type { LoopDetectionEvidence, ToolEvent } from './types'

describe('Anypi loop detection types', () => {
  test('tool event type includes timestamp', () => {
    const event: ToolEvent = {
      type: 'tool_execution_start',
      toolName: 'bash',
      timestamp: '2026-06-18T00:00:00.000Z',
    }
    expect(event.type).toBe('tool_execution_start')
    expect(event.toolName).toBe('bash')
    expect(event.timestamp).toBeDefined()
  })

  test('loop detection evidence includes all required fields', () => {
    const evidence: LoopDetectionEvidence = {
      elapsedSeconds: 42,
      lastTools: ['bash', 'read'],
      recentEvents: [],
      finishFinalizationEvents: 3,
      readBashStatusEvents: 5,
      gitStatusShort: 'M src/file.ts',
    }
    expect(evidence.elapsedSeconds).toBe(42)
    expect(evidence.lastTools).toEqual(['bash', 'read'])
    expect(evidence.recentEvents).toEqual([])
    expect(evidence.finishFinalizationEvents).toBe(3)
    expect(evidence.readBashStatusEvents).toBe(5)
    expect(evidence.gitStatusShort).toBe('M src/file.ts')
  })

  test('loop detection evidence includes optional fields', () => {
    const evidence: LoopDetectionEvidence = {
      elapsedSeconds: 42,
      lastTools: [],
      recentEvents: [],
      finishFinalizationEvents: 0,
      readBashStatusEvents: 0,
      gitStatusShort: '',
      gitDiffStat: '1 file changed, 1 insertion(+)',
      patchArtifactPath: '/tmp/anypi-loop-patch-123.patch',
    }
    expect(evidence.gitDiffStat).toBe('1 file changed, 1 insertion(+)')
    expect(evidence.patchArtifactPath).toBe('/tmp/anypi-loop-patch-123.patch')
  })
})

describe('Anypi loop detection helpers', () => {
  test('detects loop with many finish/finalization events', () => {
    const evidence: LoopDetectionEvidence = {
      elapsedSeconds: 30,
      lastTools: [],
      recentEvents: [],
      finishFinalizationEvents: 3,
      readBashStatusEvents: 0,
      gitStatusShort: '',
    }
    expect(isLoopDetected(evidence)).toBe(true)
  })

  test('detects loop with many benign commands', () => {
    const evidence: LoopDetectionEvidence = {
      elapsedSeconds: 30,
      lastTools: [],
      recentEvents: [],
      finishFinalizationEvents: 1,
      readBashStatusEvents: 5,
      gitStatusShort: '',
    }
    expect(isLoopDetected(evidence)).toBe(true)
  })

  test('does not detect loop when counts are low', () => {
    const evidence: LoopDetectionEvidence = {
      elapsedSeconds: 30,
      lastTools: [],
      recentEvents: [],
      finishFinalizationEvents: 1,
      readBashStatusEvents: 1,
      gitStatusShort: '',
    }
    expect(isLoopDetected(evidence)).toBe(false)
  })

  test('does not detect loop when evidence is undefined', () => {
    expect(isLoopDetected(undefined as unknown as LoopDetectionEvidence)).toBe(false)
  })

  test('does not detect loop with zero events', () => {
    const evidence: LoopDetectionEvidence = {
      elapsedSeconds: 30,
      lastTools: [],
      recentEvents: [],
      finishFinalizationEvents: 0,
      readBashStatusEvents: 0,
      gitStatusShort: '',
    }
    expect(isLoopDetected(evidence)).toBe(false)
  })
})
