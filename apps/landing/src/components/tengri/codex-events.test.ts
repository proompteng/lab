import { describe, expect, test } from 'bun:test'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import { agentMessage, codexEvent, codexHistory, codexParams, completedTurn, runningTurn } from './codex.fixture'
import {
  appendCodexEvent,
  appendCodexEventAfterRestore,
  codexAccountRefreshIsCurrent,
  codexThreadTurnState,
  codexEventClientTurnIds,
  codexApprovalDecisions,
  codexEventDisplayText,
  codexEventContinuesRestoredItem,
  codexEventMatchesThread,
  codexEventShouldRender,
  codexEventSupersedesRestoredItem,
  codexLoginCompletionError,
  codexLoginCompletionIsUncorrelated,
  codexLoginCompletionMatches,
  codexReconciledActiveTurnId,
  codexResumeCommitIsCurrent,
  codexTranscriptFromThread,
  parseCodexEvent,
  reconcileCodexEventsWithRestoredHistory,
  reconcileSubmittedPrompts,
  retainSubmittedPromptImages,
  retireCodexAsyncQuestions,
} from './codex-events'

const makeEvent = (fields: Partial<TengriCodexEvent> = {}) =>
  codexEvent({ sequence: 7, itemId: 'item-1', text: 'Ready', ...fields })
const event = makeEvent()

function displayEvent(fields: Partial<TengriCodexEvent>) {
  return codexEventDisplayText(makeEvent(fields))
}

function commandDelta(sequence: number, text: string) {
  return makeEvent({ sequence, kind: 'tool-output', method: 'item/commandExecution/outputDelta', text })
}

function commandApproval(sequence: number, approvalId: string, text = event.text) {
  return makeEvent({ sequence, kind: 'approval', method: 'item/commandExecution/requestApproval', approvalId, text })
}

test('replaces native image progress with completion or failure without regressing on replay', () => {
  const started: TengriCodexEvent = makeEvent({
    sequence: 1,
    kind: 'tool-call',
    method: 'item/started',
    rawJson: codexParams({ item: { type: 'imageGeneration', id: event.itemId, status: 'in_progress' } }),
  })
  for (const status of ['completed', 'failed']) {
    const completed: TengriCodexEvent = {
      ...started,
      sequence: 2,
      kind: 'tool-output',
      method: 'item/completed',
      rawJson: codexParams({
        item: { type: 'imageGeneration', id: event.itemId, status, savedPath: '/workspace/cat.png' },
      }),
    }
    const current = appendCodexEvent([started], completed)
    expect(current).toHaveLength(1)
    expect(current[0]?.rawJson).toBe(completed.rawJson)
    expect(appendCodexEvent(current, started)).toBe(current)
    expect(appendCodexEvent(current, { ...started, sequence: 3 })).toBe(current)
    expect(appendCodexEvent(current, { ...completed, sequence: 4, turnId: 'other-turn' })).toHaveLength(2)
  }
})

describe('Accepted prompt retention', () => {
  test('restores textless async questions with their choices instead of dropping them', () => {
    const items = codexTranscriptFromThread(
      codexHistory([
        {
          items: [
            {
              id: 'question-call',
              type: 'agentMessage',
              text: '',
              delivery: 'async',
              questions: [{ title: 'Which environment?', options: ['Staging', 'Production'] }],
            },
          ],
        },
      ]),
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'question-call',
      questionRequest: {
        fields: [
          { title: 'Which environment?', freeText: true, choices: [{ label: 'Staging' }, { label: 'Production' }] },
        ],
      },
    })
  })

  const prompt = {
    id: 'sent-1',
    threadId: 'thread-1',
    text: 'Inspect the workspace.',
    previousItemIds: new Set(['previous-user', 'previous-answer']),
  }
  const previous = { id: 'previous-user', kind: 'user-message' as const, text: prompt.text }

  test('keeps an accepted prompt before the new response when its echo is absent', () => {
    const answer = { id: 'new-answer', kind: 'assistant-text' as const, text: 'Reading files.' }
    const result = reconcileSubmittedPrompts([previous, answer], [prompt])
    expect(result.acknowledged.size).toBe(0)
    expect(result.pending).toEqual([{ prompt, beforeItemId: answer.id }])
  })

  test('acknowledges a new canonical item without matching an identical earlier prompt', () => {
    const next = { ...previous, id: 'new-user' }
    const result = reconcileSubmittedPrompts([previous, next], [prompt])
    expect([...result.acknowledged]).toEqual(['sent-1'])
    expect(result.pending).toEqual([])
  })

  test('one server echo cannot consume two identical accepted prompts', () => {
    const second = { ...prompt, id: 'sent-2' }
    const result = reconcileSubmittedPrompts([{ ...previous, id: 'new-user' }], [prompt, second])
    expect([...result.acknowledged]).toEqual(['sent-1'])
    expect(result.pending.map(({ prompt }) => prompt.id)).toEqual(['sent-2'])
  })

  test('releases image bytes only for the one-to-one matched canonical input', () => {
    const imagePrompt = {
      ...prompt,
      text: '[Image]',
      images: [{ mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }],
    }
    const second = { ...imagePrompt, id: 'sent-2' }
    const canonical = {
      id: 'canonical-image',
      kind: 'user-message' as const,
      text: '[Local image: /workspace/.tengri-attachments/11111111-1111-4111-8111-111111111111.png]',
    }
    const { matches } = reconcileSubmittedPrompts([canonical], [imagePrompt, second])
    const retained = retainSubmittedPromptImages(imagePrompt, matches.get(imagePrompt.id))
    expect(retained.images).toBeUndefined()
    expect(retained.text).toBe(canonical.text)
    expect(retainSubmittedPromptImages(second, matches.get(second.id))).toBe(second)
  })

  test('matches restored image inputs to the accepted image-only prompt', () => {
    const imagePrompt = { ...prompt, text: '[Image]' }
    const result = reconcileSubmittedPrompts(
      [{ ...previous, id: 'new-image', text: '[Local image: /workspace/.tengri-attachments/image.png]' }],
      [imagePrompt],
    )
    expect([...result.acknowledged]).toEqual(['sent-1'])
    expect(result.pending).toEqual([])
  })

  test.each([
    { text: '', imageCount: 1 },
    { text: 'Inspect these screenshots.', imageCount: 1 },
    { text: 'Inspect these screenshots.', imageCount: 2 },
  ])('reconciles structured live image inputs ($text, $imageCount images)', ({ text, imageCount }) => {
    const paths = Array.from(
      { length: imageCount },
      (_, index) => `/workspace/.tengri-attachments/11111111-1111-4111-8111-${String(index).padStart(12, '0')}.png`,
    )
    const input = {
      id: 'new-image',
      type: 'userMessage',
      content: [...(text ? [{ type: 'text', text }] : []), ...paths.map((path) => ({ type: 'localImage', path }))],
    }
    const live = makeEvent({
      kind: 'user-message',
      method: 'item/completed',
      itemId: input.id,
      text,
      rawJson: codexParams({ item: input }),
    })
    const canonicalText = [text, ...paths.map((path) => `[Local image: ${path}]`)].filter(Boolean).join('\n')
    expect(codexEventDisplayText(live)).toBe(canonicalText)
    const imagePrompt = {
      ...prompt,
      text: [text, ...paths.map(() => '[Image]')].filter(Boolean).join('\n'),
      images: paths.map(() => ({ mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' })),
    }
    const canonical = { id: input.id, kind: live.kind, text: codexEventDisplayText(live) }
    const { matches, pending, acknowledged } = reconcileSubmittedPrompts([canonical], [imagePrompt])
    expect(pending).toEqual([])
    expect([...acknowledged]).toEqual([imagePrompt.id])
    expect(retainSubmittedPromptImages(imagePrompt, matches.get(imagePrompt.id))).toMatchObject({
      text: canonicalText,
      images: undefined,
    })
  })
})

describe('Codex event replay', () => {
  test('retains unanswered async questions until they are retired, then restores ordinary eviction', () => {
    const question = makeEvent({
      itemId: 'async-call',
      text: '',
      rawJson: codexParams({
        item: {
          id: 'async-call',
          type: 'agentMessage',
          text: '',
          questions: [{ title: 'Which environment?', options: ['Staging'] }],
        },
      }),
    })
    let events = appendCodexEvent([], question)
    const fill = (start: number) => {
      for (let sequence = start; sequence < start + 501; sequence++)
        events = appendCodexEvent(events, {
          ...event,
          sequence,
          kind: 'tool-output',
          itemId: `tool-${sequence}`,
          text: 'Working',
          rawJson: '{}',
        })
    }
    fill(10)
    expect(events.some((item) => item.itemId === 'async-call')).toBe(true)
    const answered = new Set(['["request_user_input_async","async-call",0]'])
    expect(retireCodexAsyncQuestions(events, 'another-thread', answered)).toBe(events)
    events = retireCodexAsyncQuestions(events, event.threadId, answered)
    expect(events.find((item) => item.itemId === 'async-call')?.asyncQuestionResolved).toBe(true)
    fill(600)
    expect(events.some((item) => item.itemId === 'async-call')).toBe(false)
    expect(events).toHaveLength(500)
  })

  test('keeps one pending request when an approval is replayed with a newer sequence', () => {
    const approval = makeEvent({
      kind: 'approval',
      method: 'item/commandExecution/requestApproval',
      approvalId: 'request-1',
      text: 'Run the check?',
    })
    const first = appendCodexEvent([], approval)
    const replayed = appendCodexEvent(first, { ...approval, sequence: 8, text: 'Run the updated check?' })
    expect(replayed).toHaveLength(1)
    expect(replayed[0].text).toBe('Run the updated check?')
    expect(appendCodexEvent(replayed, approval)).toBe(replayed)
    expect(appendCodexEvent(replayed, { ...approval, sequence: 9, approvalId: 'request-2' })).toHaveLength(2)
  })

  const runtimeError = makeEvent({
    kind: 'error',
    method: 'error',
    threadId: '',
    turnId: '',
    itemId: '',
    text: 'Codex app-server is restarting',
  })

  test('keeps only the latest unscoped runtime error', () => {
    const latest = { ...runtimeError, sequence: 8 }
    expect(appendCodexEvent([runtimeError], latest)).toEqual([latest])
    expect(appendCodexEvent([latest], runtimeError)).toEqual([latest])
  })

  test.each([
    makeEvent({ sequence: 8, kind: 'thread-state', method: 'turn/started' }),
    codexEvent({ ...runtimeError, sequence: 8, kind: 'thread-state', method: 'tengri/runtimeReady', text: '' }),
  ])('clears a recovered restart notice on $method without hiding turn errors or warnings', (recovery) => {
    const turnError = { ...runtimeError, threadId: 'thread-1', turnId: 'turn-1' }
    const warning = codexEvent({ ...runtimeError, kind: 'warning' })
    expect(appendCodexEvent([runtimeError, turnError, warning], recovery)).toEqual([turnError, warning, recovery])
    const laterError = { ...runtimeError, sequence: 9 }
    expect(appendCodexEvent([laterError], recovery)).toEqual([laterError, recovery])
  })

  test('does not replay a runtime error older than a successful thread snapshot', () => {
    expect(appendCodexEventAfterRestore([], runtimeError, new Map(), 8)).toEqual([])
    const laterError = { ...runtimeError, sequence: 9 }
    expect(appendCodexEventAfterRestore([], laterError, new Map(), 8)).toEqual([laterError])
  })

  test('keeps pending approvals when later notices exceed the event buffer', () => {
    const approval = commandApproval(event.sequence, '101')
    let current = appendCodexEvent([], approval)
    for (let sequence = 8; sequence < 520; sequence += 1) {
      current = appendCodexEvent(current, {
        ...event,
        sequence,
        kind: 'warning',
        method: 'tengri/eventOmitted',
        approvalId: '',
      })
    }
    expect(current.filter((event) => event.kind === 'approval')).toEqual([approval])
    expect(current.filter((event) => event.kind === 'warning').length).toBeLessThanOrEqual(500)
    const resolved = appendCodexEvent(current, {
      ...event,
      sequence: 520,
      kind: 'thread-state',
      method: 'serverRequest/resolved',
      rawJson: '{"params":{"requestId":101}}',
    })
    expect(resolved.filter((event) => event.kind === 'approval')).toEqual([])
  })

  test('removes approvals when their turn completes without a resolution notification', () => {
    const approval = commandApproval(event.sequence, '101')
    const anotherTurn = { ...approval, turnId: 'turn-2', approvalId: '102' }
    const anotherThread = { ...approval, threadId: 'thread-2', approvalId: '103' }
    const completed = makeEvent({ sequence: 8, kind: 'thread-state', method: 'turn/completed', itemId: '', text: '' })
    const next = appendCodexEvent([approval, anotherTurn, anotherThread], completed)
    expect(next.filter((event) => event.kind === 'approval')).toEqual([anotherTurn, anotherThread])
    expect(
      appendCodexEvent(appendCodexEvent([], approval), completed).filter((event) => event.kind === 'approval'),
    ).toEqual([])
  })

  test('deduplicates an event replayed after an SSE reconnect', () => {
    const current = [event]
    expect(appendCodexEvent(current, { ...event })).toBe(current)
  })

  test('keeps the newest 500 distinct events', () => {
    const current = Array.from({ length: 500 }, (_, sequence) => ({ ...event, sequence }))
    const next = appendCodexEvent(current, { ...event, sequence: 500 })
    expect(next).toHaveLength(500)
    expect(next[0]?.sequence).toBe(1)
    expect(next.at(-1)?.sequence).toBe(500)
  })

  test('keeps only the newest cumulative usage snapshots', () => {
    const tokenUsage = makeEvent({
      sequence: 10,
      kind: 'usage',
      method: 'thread/tokenUsage/updated',
      itemId: '',
      text: 'Tokens: 10 input · 4 output',
    })
    const rateLimits = {
      ...tokenUsage,
      sequence: 11,
      method: 'account/rateLimits/updated',
      threadId: '',
      text: '7d window: 10% used',
    }
    const newerTokenUsage = { ...tokenUsage, sequence: 12, text: 'Tokens: 20 input · 6 output' }
    const newerRateLimits = { ...rateLimits, sequence: 13, text: '7d window: 12% used' }
    const otherThreadUsage = {
      ...newerTokenUsage,
      sequence: 14,
      threadId: 'thread-2',
      text: 'Tokens: 5 input · 2 output',
    }

    const current = [tokenUsage, rateLimits].reduce<TengriCodexEvent[]>(
      (next, currentEvent) => appendCodexEvent(next, currentEvent),
      [],
    )
    const updated = [newerTokenUsage, newerRateLimits, otherThreadUsage].reduce(
      (next, currentEvent) => appendCodexEvent(next, currentEvent),
      current,
    )

    expect(updated).toEqual([newerTokenUsage, newerRateLimits, otherThreadUsage])
    expect(appendCodexEvent(updated, tokenUsage)).toBe(updated)
  })

  test('keeps independent rate-limit buckets and merges sparse rolling updates', () => {
    const rateLimitEvent = (sequence: number, rateLimits: Record<string, unknown>, text = ''): TengriCodexEvent => ({
      ...event,
      sequence,
      kind: 'usage',
      method: 'account/rateLimits/updated',
      threadId: '',
      itemId: '',
      text,
      rawJson: codexParams({ rateLimits }),
    })
    const codex = rateLimitEvent(20, {
      limitId: 'codex',
      limitName: 'Codex',
      primary: { usedPercent: 10, windowDurationMins: 300 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080 },
      credits: { hasCredits: true, unlimited: false, balance: '8' },
      individualLimit: null,
      spendControlReached: false,
      planType: 'pro',
      rateLimitReachedType: 'rate_limit_reached',
    })
    const other = rateLimitEvent(21, {
      limitId: 'codex_other',
      limitName: 'Codex Other',
      primary: { usedPercent: 50, windowDurationMins: 30 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    })
    const sparseCodexUpdate = rateLimitEvent(22, {
      limitId: null,
      limitName: null,
      primary: { usedPercent: 12, windowDurationMins: 300 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    })

    const updated = [codex, other, sparseCodexUpdate].reduce<TengriCodexEvent[]>(
      (next, currentEvent) => appendCodexEvent(next, currentEvent),
      [],
    )

    expect(updated).toHaveLength(2)
    expect(updated[1]).toEqual(other)
    expect(codexEventDisplayText(updated[0]!)).toBe(
      '5h window 88% left · Weekly 80% left · Credits: 8 · Limit state: rate limit reached',
    )
  })

  test.each([
    ['Hel', 'lo', 'Hello'],
    ['aGk=', 'IHRoZXJl', 'hi there'],
  ])('coalesces consecutive command deltas %s + %s', (firstChunk, nextChunk, text) => {
    const first = commandDelta(1, firstChunk)
    const next = commandDelta(2, nextChunk)
    const output = appendCodexEvent(appendCodexEvent([], first), next)
    expect(output.map((item) => [item.itemId, item.text])).toEqual([[event.itemId, text]])
  })

  test('replaces streamed text with the authoritative completed item', () => {
    const delta = makeEvent({ method: 'item/agentMessage/delta', text: 'Hel', sequence: 1 })
    const completed = makeEvent({ method: 'item/completed', text: 'Hello', sequence: 2 })
    expect(appendCodexEvent([delta], completed)).toEqual([completed])
  })

  test('coalesces same-item lifecycle events without collapsing repeated prompts', () => {
    const started = makeEvent({
      sequence: 1,
      kind: 'user-message',
      method: 'item/started',
      itemId: 'user-1',
      text: 'Repeat this prompt',
    })
    const repeatedPrompt = { ...started, sequence: 2, itemId: 'user-2' }
    const completed = { ...started, sequence: 3, method: 'item/completed' }

    const next = [started, repeatedPrompt, completed].reduce<TengriCodexEvent[]>(
      (current, currentEvent) => appendCodexEvent(current, currentEvent),
      [],
    )

    expect(next).toEqual([completed, repeatedPrompt])
  })

  test('coalesces file-diff lifecycle events and keeps item IDs scoped to their turn', () => {
    const firstTurnStarted = makeEvent({
      sequence: 1,
      kind: 'file-diff',
      method: 'item/started',
      turnId: 'turn-1',
      itemId: 'file-1',
      text: 'initial diff',
    })
    const secondTurnStarted = { ...firstTurnStarted, sequence: 2, turnId: 'turn-2', text: 'other diff' }
    const firstTurnCompleted = { ...firstTurnStarted, sequence: 3, method: 'item/completed', text: 'complete diff' }

    const next = [firstTurnStarted, secondTurnStarted, firstTurnCompleted].reduce<TengriCodexEvent[]>(
      (current, currentEvent) => appendCodexEvent(current, currentEvent),
      [],
    )

    expect(next).toEqual([firstTurnCompleted, secondTurnStarted])
  })

  test('coalesces same-kind tool lifecycles without merging tool-call and tool-output kinds', () => {
    const started = makeEvent({
      sequence: 1,
      kind: 'tool-call',
      method: 'item/started',
      itemId: 'tool-1',
      text: 'View /workspace/image.png',
    })
    const completed = { ...started, sequence: 2, method: 'item/completed', text: 'View completed' }
    const output = { ...completed, sequence: 3, kind: 'tool-output' as const, text: 'image output' }

    expect(appendCodexEvent(appendCodexEvent([], started), completed)).toEqual([completed])
    expect(appendCodexEvent(appendCodexEvent([], started), output)).toEqual([started, output])
  })

  test('bounds coalesced deltas instead of allowing an unbounded transcript item', () => {
    const first = commandDelta(1, 'x'.repeat((512 << 10) - 8))
    const second = commandDelta(2, 'y'.repeat(128))
    const [combined] = appendCodexEvent(appendCodexEvent([], first), second)

    expect(new TextEncoder().encode(combined?.text).byteLength).toBeLessThanOrEqual(512 << 10)
    expect(combined?.text).toEndWith('… output truncated …')
  })

  test('never stores or coalesces raw reasoning content deltas', () => {
    const raw = makeEvent({
      kind: 'reasoning-summary',
      method: 'item/reasoning/textDelta',
      text: 'private reasoning',
      sequence: 1,
    })
    const summary = { ...raw, method: 'item/reasoning/summaryTextDelta', text: 'Public summary', sequence: 2 }

    expect(appendCodexEvent([], raw)).toEqual([])
    const result = appendCodexEvent(appendCodexEvent([], raw), summary)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject(summary)
    expect(codexEventDisplayText(raw)).toBe('')
  })

  test('keeps pending approval controls visible when their item is present in restored history', () => {
    const approval = commandApproval(event.sequence, 'approval-1')
    const restoredItemIds = new Set([approval.itemId])

    expect(codexEventShouldRender(approval, approval.threadId, restoredItemIds)).toBe(true)
    expect(codexEventShouldRender(event, event.threadId, restoredItemIds)).toBe(false)
    expect(codexEventShouldRender(approval, 'thread-2', restoredItemIds)).toBe(false)
  })

  test('keeps usage and developer deprecation notices out of the conversation during streaming and replay', () => {
    const tokenUsage = makeEvent({ kind: 'usage', method: 'thread/tokenUsage/updated', itemId: '' })
    const rateLimits = { ...tokenUsage, method: 'account/rateLimits/updated' }
    const deprecation = makeEvent({ kind: 'warning', method: 'deprecationNotice', itemId: '' })
    for (const snapshotSequence of [0, event.sequence + 1]) {
      expect(codexEventShouldRender(tokenUsage, event.threadId, new Set(), snapshotSequence)).toBe(false)
      expect(codexEventShouldRender(rateLimits, event.threadId, new Set(), snapshotSequence)).toBe(false)
      expect(codexEventShouldRender(deprecation, event.threadId, new Set(), snapshotSequence)).toBe(false)
    }
  })

  test('keeps only post-resume item updates plus snapshot-independent events visible', () => {
    const restoredItemIds = new Set([event.itemId])
    const itemlessSnapshotEvent = makeEvent({ kind: 'usage', itemId: '' })
    const renamedSnapshotItem = makeEvent({ itemId: 'app-server-generated-id' })
    const snapshotWarning = makeEvent({ kind: 'warning', itemId: '', text: 'Replay warning' })
    const snapshotError = makeEvent({ kind: 'error', itemId: '', text: 'Turn failed' })

    expect(codexEventShouldRender(event, event.threadId, restoredItemIds)).toBe(false)
    expect(codexEventShouldRender(event, event.threadId, restoredItemIds, event.sequence)).toBe(false)
    expect(codexEventShouldRender(itemlessSnapshotEvent, event.threadId, restoredItemIds, event.sequence)).toBe(false)
    expect(codexEventShouldRender(renamedSnapshotItem, event.threadId, restoredItemIds, event.sequence)).toBe(false)
    expect(codexEventShouldRender(snapshotWarning, event.threadId, restoredItemIds, event.sequence)).toBe(true)
    expect(codexEventShouldRender(snapshotError, event.threadId, restoredItemIds, event.sequence)).toBe(true)
    expect(codexEventShouldRender(event, event.threadId, restoredItemIds, event.sequence - 1)).toBe(true)
  })

  test('seeds the first post-resume delta with the authoritative restored prefix', () => {
    const restored = { id: event.itemId, kind: 'assistant-text', text: 'restored prefix' } as const
    const delta = makeEvent({
      sequence: 43,
      kind: 'assistant-text',
      method: 'item/agentMessage/delta',
      text: ' plus live delta',
    })

    expect(codexEventContinuesRestoredItem(delta, restored, 42)).toBe(true)
    expect(codexEventContinuesRestoredItem({ ...delta, sequence: 42 }, restored, 42)).toBe(false)
    expect(codexEventContinuesRestoredItem({ ...delta, kind: 'tool-output' }, restored, 42)).toBe(false)
    expect(appendCodexEvent([], delta, restored.text)[0]?.text).toBe('restored prefix plus live delta')
  })

  test('replaces a stale restored operation with its newer completion event', () => {
    const restored = { id: event.itemId, kind: 'tool-call', text: 'Web search: Kata Firecracker' } as const
    const completed = makeEvent({
      sequence: 43,
      kind: 'tool-output',
      method: 'item/completed',
      text: 'Search completed',
    })

    expect(codexEventContinuesRestoredItem(completed, restored, 42)).toBe(false)
    expect(codexEventSupersedesRestoredItem(completed, restored, 42)).toBe(true)
    expect(reconcileCodexEventsWithRestoredHistory([completed], new Map([[restored.id, restored]]), 42)).toEqual([
      completed,
    ])
  })

  test('rejects stale or cross-thread resume responses', () => {
    expect(codexResumeCommitIsCurrent(3, 3, 'thread-1', 'thread-1')).toBe(true)
    expect(codexResumeCommitIsCurrent(2, 3, 'thread-1', 'thread-1')).toBe(false)
    expect(codexResumeCommitIsCurrent(3, 3, 'thread-1', 'thread-2')).toBe(false)
  })

  test('reconciles live messages against their own history page without dropping later updates to earlier pages', () => {
    const history = codexTranscriptFromThread(
      codexHistory([
        {
          items: [agentMessage('item-1', 'First'), agentMessage('item-2', 'Second')],
        },
      ]),
      { 'item-1': 20, 'item-2': 30 },
    )
    const restored = new Map(history.map((item) => [item.id, item]))
    const delta = makeEvent({ method: 'item/agentMessage/delta' })
    const replay = [
      { ...delta, sequence: 18, itemId: 'item-1', text: 'rst' },
      { ...delta, sequence: 24, itemId: 'item-1', text: ' live' },
      { ...delta, sequence: 28, itemId: 'item-2', text: 'ond' },
      { ...delta, sequence: 31, itemId: 'item-2', text: ' live' },
      { ...event, sequence: 12, itemId: 'new-item', text: 'Created while paging' },
    ]
    const reconciled = reconcileCodexEventsWithRestoredHistory(replay, restored, 10)
    const coalesced = replay.reduce(
      (current, next) => appendCodexEvent(current, next),
      [] as ReturnType<typeof appendCodexEvent>,
    )
    expect(
      reconcileCodexEventsWithRestoredHistory(coalesced, restored, 10).map(({ itemId, text }) => ({ itemId, text })),
    ).toEqual(reconciled.map(({ itemId, text }) => ({ itemId, text })))
    expect(reconciled.map(({ itemId, text }) => ({ itemId, text }))).toEqual([
      { itemId: 'item-1', text: 'First live' },
      { itemId: 'item-2', text: 'Second live' },
      { itemId: 'new-item', text: 'Created while paging' },
    ])
    expect(appendCodexEventAfterRestore(reconciled, replay[0]!, restored, 10)).toBe(reconciled)
    expect(codexEventSupersedesRestoredItem(replay[2]!, restored.get('item-2'), 10)).toBe(false)
    expect(codexEventSupersedesRestoredItem(replay[1]!, restored.get('item-1'), 10)).toBe(true)
  })

  test('retains page cursors for items omitted by the visible transcript cap', () => {
    const items = Array.from({ length: 501 }, (_, index) => agentMessage(`item-${index}`, `Message ${index}`))
    const itemSequences = new Map(items.map((item) => [item.id, 30]))
    const history = codexTranscriptFromThread(codexHistory([{ items }]), Object.fromEntries(itemSequences))
    const restored = new Map(history.map((item) => [item.id, item]))
    expect(history).toHaveLength(500)
    expect(restored.has('item-0')).toBe(false)
    const staleDelta = makeEvent({ itemId: 'item-0', method: 'item/agentMessage/delta', sequence: 20, text: 'stale' })
    const staleCompletion = { ...staleDelta, method: 'item/completed', sequence: 25 }
    for (const buffered of [[staleDelta], [staleCompletion], appendCodexEvent([], staleDelta)]) {
      expect(reconcileCodexEventsWithRestoredHistory(buffered, restored, 10, itemSequences)).toEqual([])
    }
    expect(appendCodexEventAfterRestore([], staleDelta, restored, 10, itemSequences)).toEqual([])
    const newer = { ...staleCompletion, sequence: 31, text: 'Updated after the page snapshot' }
    expect(appendCodexEventAfterRestore([], newer, restored, 10, itemSequences)[0]?.text).toBe(newer.text)
    const newItem = { ...staleCompletion, itemId: 'new-item', sequence: 12, text: 'Created while paging' }
    expect(appendCodexEventAfterRestore([], newItem, restored, 10, itemSequences)[0]?.text).toBe(newItem.text)
  })

  test('drops all snapshot-covered replay events when restored transcript IDs were synthesized', () => {
    const restoredById = new Map([
      ['item-1', { id: 'item-1', kind: 'user-message' as const, text: 'Create the proof file.' }],
      ['item-2', { id: 'item-2', kind: 'assistant-text' as const, text: 'Creating the file.' }],
      ['item-3', { id: 'item-3', kind: 'assistant-text' as const, text: '/workspace/proof.txt' }],
    ])
    const replayed = [
      { ...event, sequence: 9, kind: 'user-message' as const, itemId: 'msg-user-live', text: 'Create the proof file.' },
      { ...event, sequence: 13, itemId: 'msg-agent-live', text: 'Creating the file.' },
      {
        ...event,
        sequence: 26,
        kind: 'file-diff' as const,
        method: 'turn/diff/updated',
        itemId: '',
        text: '+++ /workspace/proof.txt',
      },
      { ...event, sequence: 42, itemId: 'msg-agent-final-live', text: '/workspace/proof.txt' },
    ]
    const snapshotUsage = makeEvent({
      sequence: 27,
      kind: 'usage',
      method: 'thread/tokenUsage/updated',
      itemId: '',
      text: 'Tokens: 10 input · 4 output',
    })
    const snapshotWarning = makeEvent({
      sequence: 44,
      kind: 'warning',
      method: 'tengri/eventOmitted',
      itemId: '',
      text: 'One oversized event was omitted',
    })
    const snapshotError = makeEvent({
      sequence: 45,
      kind: 'error',
      method: 'turn/completed',
      itemId: '',
      text: 'The turn failed',
    })
    const postSnapshot = makeEvent({ sequence: 54, kind: 'warning', itemId: '', text: 'Live warning' })

    expect(
      reconcileCodexEventsWithRestoredHistory(
        [...replayed, snapshotUsage, snapshotWarning, snapshotError, postSnapshot],
        restoredById,
        53,
      ),
    ).toEqual([snapshotUsage, snapshotWarning, snapshotError, postSnapshot])
  })

  test('rebases streamed fragments again without repeating a prior restored prefix or a completed item', () => {
    const delta = makeEvent({ method: 'item/agentMessage/delta', sequence: 12, text: ' live' })
    const firstHistory = new Map([
      [event.itemId, { id: event.itemId, kind: 'assistant-text' as const, text: 'First', eventSequence: 10 }],
    ])
    const first = appendCodexEventAfterRestore([], delta, firstHistory, 10)
    const secondDelta = { ...delta, sequence: 22, text: ' again' }
    const buffered = appendCodexEvent(first, secondDelta)
    const secondHistory = new Map([
      [event.itemId, { id: event.itemId, kind: 'assistant-text' as const, text: 'First live', eventSequence: 20 }],
    ])
    const rebased = reconcileCodexEventsWithRestoredHistory(buffered, secondHistory, 20)
    expect(rebased[0]?.text).toBe('First live again')
    expect(reconcileCodexEventsWithRestoredHistory(rebased, secondHistory, 20)[0]?.text).toBe('First live again')

    const completed = makeEvent({ sequence: 21, text: 'Authoritative replacement' })
    const afterCompletion = appendCodexEvent([completed], secondDelta)
    expect(reconcileCodexEventsWithRestoredHistory(afterCompletion, secondHistory, 20)[0]?.text).toBe(
      'Authoritative replacement again',
    )
    expect(appendCodexEvent(afterCompletion, delta)).toBe(afterCompletion)
  })

  test('keeps only post-snapshot deltas regardless of delivery order', () => {
    const restored = { id: event.itemId, kind: 'assistant-text', text: 'snapshot includes delta' } as const
    const history = new Map([[restored.id, restored]])
    const covered = makeEvent({ sequence: 42, method: 'item/agentMessage/delta', text: ' covered delta' })
    const live = { ...covered, sequence: 43, text: ' plus newer output' }

    expect(reconcileCodexEventsWithRestoredHistory([covered], history, 42)).toEqual([])
    expect(appendCodexEventAfterRestore([], covered, history, 42)).toEqual([])
    for (const updated of [
      reconcileCodexEventsWithRestoredHistory([live], history, 42),
      appendCodexEventAfterRestore([], live, history, 42),
    ]) {
      expect(updated.map(({ text }) => text)).toEqual(['snapshot includes delta plus newer output'])
    }
    const approval = { ...covered, kind: 'approval' as const, approvalId: 'approval-1' }
    expect(appendCodexEventAfterRestore([], approval, history, 42)).toEqual([approval])
  })

  test('retires a resolved approval without hiding another pending request, before or after replay', () => {
    const request = commandApproval(20, '7')
    const other = commandApproval(21, '8')
    const resolved = makeEvent({
      sequence: 22,
      kind: 'thread-state',
      method: 'serverRequest/resolved',
      itemId: '',
      rawJson: codexParams({ threadId: event.threadId, requestId: 7 }),
    })
    expect(appendCodexEvent([request, other], resolved)).toEqual([other])
    expect(reconcileCodexEventsWithRestoredHistory([request, other, resolved], new Map(), 42)).toEqual([other])
  })

  test.each([
    ['plan', 'turn/plan/updated', '- [ ] First plan', '- [x] Updated plan', '- [ ] Other turn'],
    ['file-diff', 'turn/diff/updated', '--- first diff', '--- current diff', '--- other turn'],
  ] as const)('replaces %s snapshots only within the same turn', (kind, method, earlier, latest, unrelated) => {
    const first = makeEvent({ sequence: 1, kind, method, itemId: '', text: earlier })
    const next = appendCodexEvent([first], { ...first, sequence: 2, text: latest })
    expect(next.map(({ text }) => text)).toEqual([latest])
    const otherTurn = { ...first, sequence: 3, turnId: 'turn-2', text: unrelated }
    expect(appendCodexEvent(next, otherTurn).map(({ text }) => text)).toEqual([latest, unrelated])
  })
})

describe('Codex event decoding', () => {
  test('accepts a bounded typed server event', () => {
    expect(parseCodexEvent(JSON.stringify(event))).toEqual(event)
  })

  test('rejects malformed and unbounded events', () => {
    expect(parseCodexEvent('{')).toBeNull()
    expect(parseCodexEvent(JSON.stringify({ ...event, sequence: -1 }))).toBeNull()
    expect(parseCodexEvent(JSON.stringify({ ...event, kind: 'made-up' }))).toBeNull()
    expect(parseCodexEvent(JSON.stringify({ ...event, method: '' }))).toBeNull()
    const bounded = parseCodexEvent(JSON.stringify({ ...event, text: 'x'.repeat((512 << 10) + 1) }))?.text || ''
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(512 << 10)
    expect(bounded).toEndWith('… output truncated …')
  })

  test('shows the complete command, file, and permission scope of approval requests', () => {
    expect(
      displayEvent({
        kind: 'approval',
        text: '',
        rawJson: codexParams({
          reason: 'Needs network',
          command: ['git', 'fetch', 'origin', 'feature branch'],
          cwd: '/workspace',
          proposedExecpolicyAmendment: ['git fetch'],
          networkApprovalContext: { host: 'api.github.com', protocol: 'https' },
          proposedNetworkPolicyAmendments: [
            { host: 'api.github.com', action: 'allow' },
            { host: 'tracker.invalid', action: 'deny' },
          ],
          fileChanges: {
            '/workspace/app.ts': { type: 'update' },
            '/workspace/new.ts': { type: 'add' },
          },
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ['/workspace/input'],
              write: ['/workspace/output'],
              entries: [{ path: { type: 'glob_pattern', pattern: '/tmp/*.json' }, access: 'read' }],
            },
          },
          additionalPermissions: {
            network: null,
            fileSystem: { read: null, write: ['/var/tmp'], entries: [] },
          },
        }),
      }),
    ).toBe(
      [
        'Needs network',
        "Command: git fetch origin 'feature branch'",
        'Working directory: /workspace',
        'Proposed command policy:',
        '- git fetch',
        'Network target: api.github.com (https)',
        'Proposed network policy:',
        '- allow api.github.com',
        '- deny tracker.invalid',
        'Files:',
        '- /workspace/app.ts (update)',
        '- /workspace/new.ts (add)',
        'Requested permissions:',
        'Network: enabled',
        'Read access:',
        '- /workspace/input',
        'Write access:',
        '- /workspace/output',
        '- /tmp/*.json (read)',
        'Additional permissions:',
        'Write access:',
        '- /var/tmp',
      ].join('\n'),
    )
  })

  test('scopes approvals to the active thread and exposes only advertised decisions', () => {
    const approval = makeEvent({
      kind: 'approval',
      method: 'item/commandExecution/requestApproval',
      rawJson: codexParams({ availableDecisions: ['accept', 'decline'] }),
    })

    expect(codexEventMatchesThread(approval, 'thread-1')).toBe(true)
    expect(codexEventMatchesThread({ ...approval, threadId: '' }, 'thread-1')).toBe(false)
    expect(codexEventMatchesThread(approval, 'thread-2')).toBe(false)
    expect(codexEventMatchesThread({ ...event, threadId: '' }, 'thread-1')).toBe(true)
    expect(codexApprovalDecisions(approval)).toEqual(['approve-once', 'deny'])
    expect(
      codexApprovalDecisions({
        ...approval,
        rawJson: codexParams({
          availableDecisions: [
            { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git status'] } },
            { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'github.com', action: 'allow' } } },
            'decline',
          ],
        }),
      }),
    ).toEqual(['approve-exec-policy-amendment', 'approve-network-policy-amendment', 'deny'])
    expect(codexApprovalDecisions({ ...approval, rawJson: codexParams({}) })).toEqual([
      'approve-once',
      'approve-session',
      'deny',
    ])
  })

  test('shows MCP tool confirmations with arguments and only the advertised session scope', () => {
    const params = {
      mode: 'form',
      message: 'Allow the fixture MCP server to run tool "exec"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: ['session', 'always'],
        tool_description: 'Execute a command in the selected workspace.',
        tool_params: { command: 'printf fixture', cwd: '/tmp/fixture' },
      },
    }
    const approval = makeEvent({
      kind: 'approval',
      method: 'mcpServer/elicitation/request',
      rawJson: codexParams(params),
    })
    expect(codexApprovalDecisions(approval)).toEqual(['approve-once', 'approve-session', 'deny'])
    expect(codexEventDisplayText(approval)).toContain(params.message)
    expect(codexEventDisplayText(approval)).toContain('printf fixture')
    expect(codexEventDisplayText(approval)).toContain('/tmp/fixture')
    expect(codexEventDisplayText(approval)).toContain('Session approval applies to this tool')
    expect(codexEventMatchesThread(approval, 'thread-2')).toBe(false)
    for (const persist of [undefined, 'always', []]) {
      expect(
        codexApprovalDecisions({
          ...approval,
          rawJson: codexParams({ ...params, _meta: { ...params._meta, persist } }),
        }),
      ).toEqual(['approve-once', 'deny'])
    }
  })

  test('keeps MCP controls and an omission notice after large arguments are bounded', () => {
    for (const persist of [undefined, 'session']) {
      const approval = makeEvent({
        kind: 'approval',
        method: 'mcpServer/elicitation/request',
        text: 'Allow the fixture tool?',
        rawJson: JSON.stringify({
          params: { _meta: { codex_approval_kind: 'mcp_tool_call', persist } },
          rawOmitted: true,
        }),
      })
      expect(codexApprovalDecisions(approval)).toEqual(
        persist === 'session' ? ['approve-once', 'approve-session', 'deny'] : ['approve-once', 'deny'],
      )
      expect(codexEventDisplayText(approval)).toContain('Allow the fixture tool?')
      expect(codexEventDisplayText(approval)).toContain('Arguments were omitted')
    }
  })

  test('renders token usage and rate-limit snapshots', () => {
    expect(
      displayEvent({
        kind: 'usage',
        text: '',
        rawJson: codexParams({ tokenUsage: { total: { inputTokens: 12, outputTokens: 4 } } }),
      }),
    ).toBe('Tokens: 12 input · 4 output')
    expect(
      displayEvent({
        kind: 'usage',
        text: '',
        rawJson: codexParams({
          rateLimits: {
            primary: { usedPercent: 12, windowDurationMins: 300 },
            secondary: { usedPercent: 45, windowDurationMins: 10_080 },
            credits: { balance: '17.50' },
            rateLimitReachedType: null,
          },
        }),
      }),
    ).toBe('5h window 88% left · Weekly 55% left · Credits: 18')
  })

  test.each([
    [9.1, '62306.900236', 'Weekly 90% left · Credits: 62,307'],
    [0, 0, 'Weekly 100% left · Credits: 0'],
    [100, '17', 'Weekly 0% left · Credits: 17'],
    [110, 'invalid', 'Weekly 0% left'],
    [12.5, '', 'Weekly 87% left'],
  ])('formats remaining weekly usage %s and credits %s', (usedPercent, balance, expected) => {
    expect(
      displayEvent({
        kind: 'usage',
        rawJson: codexParams({
          rateLimits: { secondary: { usedPercent, windowDurationMins: 10_080 }, credits: { balance } },
        }),
      }),
    ).toBe(expected)
  })

  test('extracts a failed device-login completion error', () => {
    const failedLogin = makeEvent({
      kind: 'error',
      method: 'account/login/completed',
      text: 'device code expired',
      rawJson: codexParams({ loginId: 'login-1', success: false, error: 'device code expired' }),
    })

    expect(codexLoginCompletionError(failedLogin)).toBe('device code expired')
    expect(codexLoginCompletionMatches(failedLogin, 'login-1')).toBe(true)
    expect(codexLoginCompletionMatches(failedLogin, 'login-2')).toBe(false)
    const uncorrelatedCompletion = {
      ...failedLogin,
      rawJson: codexParams({ loginId: null, success: false }),
    }
    expect(codexLoginCompletionMatches(uncorrelatedCompletion, 'login-2')).toBe(false)
    expect(codexLoginCompletionIsUncorrelated(uncorrelatedCompletion)).toBe(true)
    expect(codexLoginCompletionIsUncorrelated(failedLogin)).toBe(false)
    expect(codexLoginCompletionIsUncorrelated({ ...failedLogin, method: 'thread/started' })).toBe(false)
    expect(
      codexLoginCompletionError({
        ...failedLogin,
        kind: 'thread-state',
        text: '',
        rawJson: codexParams({ loginId: 'login-1', success: true, error: null }),
      }),
    ).toBe('')
  })

  test('does not recover an active turn already completed by the event stream', () => {
    expect(codexReconciledActiveTurnId('turn-1', new Set(['turn-1']))).toBe('')
    expect(codexReconciledActiveTurnId('turn-2', new Set(['turn-1']))).toBe('turn-2')
  })

  test('applies only the newest account refresh for the active login attempt', () => {
    expect(codexAccountRefreshIsCurrent(2, 2, 'login-2', 'login-2')).toBe(true)
    expect(codexAccountRefreshIsCurrent(1, 2, 'login-2', 'login-2')).toBe(false)
    expect(codexAccountRefreshIsCurrent(3, 3, 'login-1', 'login-2')).toBe(false)
  })

  test('decodes printable base64 command output without corrupting ordinary text', () => {
    expect(codexEventDisplayText(commandDelta(1, 'aGVsbG8K'))).toBe('hello\n')
    expect(displayEvent({ kind: 'tool-output', text: '12 pass' })).toBe('12 pass')
    for (const [type, text] of [
      ['mcpToolCall', 'dGVzdA=='],
      ['commandExecution', 'test'],
    ]) {
      expect(displayEvent({ kind: 'tool-output', text: 'dGVzdA==', rawJson: codexParams({ item: { type } }) })).toBe(
        text,
      )
    }
  })

  test('shows web search and sub-agent activity from typed raw events', () => {
    expect(
      displayEvent({
        kind: 'tool-call',
        text: '',
        rawJson: codexParams({ item: { type: 'webSearch', query: 'Kata Firecracker' } }),
      }),
    ).toBe('Web search: Kata Firecracker')
    expect(
      displayEvent({
        kind: 'tool-call',
        text: '',
        rawJson: codexParams({
          item: {
            type: 'subAgentActivity',
            kind: 'started',
            agentPath: '/root/reviewer',
            agentThreadId: 'thread-child',
          },
        }),
      }),
    ).toBe('Sub-agent: started: /root/reviewer')
  })
})

describe('Codex thread restoration', () => {
  test('links native client identities to turns in streamed items and recovered history', () => {
    const item = { type: 'userMessage', id: 'user-1', clientId: 'run-identity', content: [] }
    expect(codexEventClientTurnIds({ ...event, kind: 'user-message', rawJson: codexParams({ item }) })).toEqual([
      ['run-identity', 'turn-1'],
    ])
    expect(
      codexEventClientTurnIds({
        ...event,
        rawJson: codexParams({ item: { ...item, type: 'commandExecution' } }),
      }),
    ).toEqual([])
    expect(codexEventClientTurnIds({ ...event, rawJson: '{' })).toEqual([])
    expect(codexThreadTurnState(codexHistory([completedTurn('turn-1', [item])]))).toEqual({
      activeTurnId: '',
      completedTurnIds: ['turn-1'],
      clientTurnIds: new Map([['run-identity', 'turn-1']]),
    })
  })

  test('recovers the active turn from the authoritative resumed thread', () => {
    const thread = codexHistory([completedTurn('turn-complete'), runningTurn('turn-active')])

    expect(codexThreadTurnState(thread)).toEqual({
      activeTurnId: 'turn-active',
      completedTurnIds: ['turn-complete'],
      clientTurnIds: new Map(),
    })
    expect(codexThreadTurnState('{')).toEqual({ activeTurnId: '', completedTurnIds: [], clientTurnIds: new Map() })
  })

  test('restores persisted typed items in thread order', () => {
    const transcript = codexTranscriptFromThread(
      codexHistory([
        {
          items: [
            { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Build it' }] },
            {
              id: 'user-2',
              type: 'userMessage',
              content: [
                { type: 'image', url: 'data:image/png;base64,opaque' },
                { type: 'localImage', path: '/workspace/reference.png' },
                { type: 'skill', name: 'release', path: '/skills/release/SKILL.md' },
                { type: 'mention', name: 'api.ts', path: '/workspace/api.ts' },
              ],
            },
            agentMessage('assistant-1', 'Done'),
            { id: 'plan-1', type: 'plan', text: '- [x] Build it' },
            { id: 'reasoning-1', type: 'reasoning', summary: ['Checked the result'], content: [] },
            { id: 'command-1', type: 'commandExecution', command: 'bun test', aggregatedOutput: '12 pass' },
            {
              id: 'command-2',
              type: 'commandExecution',
              command: 'true',
              status: 'completed',
              aggregatedOutput: '',
              exitCode: 0,
            },
            {
              id: 'file-1',
              type: 'fileChange',
              changes: [{ path: '/workspace/app.ts', diff: '+export {}' }],
            },
            {
              id: 'mcp-1',
              type: 'mcpToolCall',
              server: 'linear',
              tool: 'get_issue',
              result: { content: [], structuredContent: { id: 'ENG-123', state: 'Done' } },
            },
            { id: 'search-1', type: 'webSearch', query: 'Kata Firecracker', action: null },
            {
              id: 'collab-1',
              type: 'collabAgentToolCall',
              tool: 'spawnAgent',
              status: 'completed',
              receiverThreadIds: ['thread-child'],
              prompt: 'Review this change',
            },
            {
              id: 'subagent-1',
              type: 'subAgentActivity',
              kind: 'started',
              agentPath: '/root/reviewer',
              agentThreadId: 'thread-child',
            },
          ],
        },
      ]),
    )
    expect(transcript).toEqual([
      { id: 'user-1', kind: 'user-message', text: 'Build it' },
      {
        id: 'user-2',
        kind: 'user-message',
        text: [
          '[Image]',
          '[Local image: /workspace/reference.png]',
          '[Skill: release — /skills/release/SKILL.md]',
          '[Mention: @api.ts — /workspace/api.ts]',
        ].join('\n'),
      },
      { id: 'assistant-1', kind: 'assistant-text', text: 'Done' },
      { id: 'plan-1', kind: 'plan', text: '- [x] Build it' },
      { id: 'reasoning-1', kind: 'reasoning-summary', text: 'Checked the result' },
      { id: 'command-1', kind: 'tool-output', text: '12 pass', activityTitle: 'bun test' },
      { id: 'command-2', kind: 'tool-output', text: 'Command completed (exit 0)', activityTitle: 'true' },
      { id: 'file-1', kind: 'file-diff', text: '+export {}' },
      {
        id: 'mcp-1',
        kind: 'tool-output',
        activityTitle: 'linear/get_issue',
        text: 'linear/get_issue\n{\n  "id": "ENG-123",\n  "state": "Done"\n}',
      },
      { id: 'search-1', kind: 'tool-call', text: 'Web search: Kata Firecracker' },
      {
        id: 'collab-1',
        kind: 'tool-output',
        text: 'Agent collaboration: spawnAgent: completed\nPrompt: Review this change\nAgents: thread-child',
      },
      { id: 'subagent-1', kind: 'tool-call', text: 'Sub-agent: started: /root/reviewer' },
    ])
  })

  test('ignores invalid history and duplicate item IDs', () => {
    expect(codexTranscriptFromThread('{')).toEqual([])
    expect(
      codexTranscriptFromThread(
        codexHistory([{ items: [agentMessage('same', 'First')] }, { items: [agentMessage('same', 'Duplicate')] }]),
      ),
    ).toEqual([{ id: 'same', kind: 'assistant-text', text: 'First' }])
  })
})

describe('Codex buffering equivalence', () => {
  test('preserves split surrogate deltas while rebasing a partially covered replay', () => {
    const restored = { id: event.itemId, kind: 'assistant-text' as const, text: 'restored\ud800', eventSequence: 20 }
    const history = new Map([[restored.id, restored]])
    let current = appendCodexEventAfterRestore([], { ...event, sequence: 20, text: 'covered' }, history, 20)
    let expected = restored.text
    let pageText = ''
    for (let sequence = 21; sequence <= 140; sequence += 1) {
      const text = sequence % 2 ? '\udc00漢' : '😀a'.repeat(40)
      current = appendCodexEventAfterRestore(
        current,
        { ...event, sequence, method: 'item/agentMessage/delta', text },
        history,
        20,
      )
      expected += text
      expect(current[0]!.text).toBe(expected)
      if (sequence === 80) pageText = expected
    }
    const rebased = reconcileCodexEventsWithRestoredHistory(
      current,
      new Map([[restored.id, { ...restored, text: pageText, eventSequence: 80 }]]),
      20,
      new Map([[restored.id, 80]]),
    )
    expect(rebased[0]!.text).toBe(expected)
    const fresh = makeEvent({ sequence: 141, method: 'item/agentMessage/delta', text: ' live tail' })
    expect(appendCodexEvent(rebased, fresh).map(({ text }) => text)).toEqual([expected + ' live tail'])
    expect(appendCodexEvent(rebased, { ...fresh, sequence: 80, text: ' covered' })).toEqual(rebased)
  })

  test('matches serialized item identity after normalizing untrusted wire values', () => {
    const values: unknown[] = [
      '',
      'x',
      'x:y',
      'x"y',
      'x\\y',
      'x\u0000y',
      '😀',
      '\ud800',
      null,
      0,
      1,
      false,
      undefined,
      {},
      [],
    ]
    for (const field of ['threadId', 'turnId', 'itemId']) {
      for (const left of values) {
        for (const right of values) {
          const first = parseCodexEvent(
            JSON.stringify({ ...event, sequence: 1, method: 'item/started', [field]: left }),
          )!
          const next = parseCodexEvent(
            JSON.stringify({ ...event, sequence: 2, method: 'item/completed', [field]: right }),
          )!
          const identity = (value: TengriCodexEvent) =>
            value.itemId ? JSON.stringify([value.threadId, value.turnId, value.itemId, value.kind]) : ''
          const matches = Boolean(identity(next)) && identity(first) === identity(next)
          expect(appendCodexEvent([first], next)).toEqual(matches ? [next] : [first, next])
        }
      }
    }
  })

  test('matches UTF-8 truncation around the length fast path and byte cap', () => {
    const cap = 512 << 10
    const marker = '\n… output truncated …'
    const encoder = new TextEncoder()
    const reference = (value: string) => {
      const bytes = encoder.encode(value)
      if (bytes.length <= cap) return value
      let end = cap - encoder.encode(marker).length
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
      return new TextDecoder().decode(bytes.subarray(0, end)) + marker
    }
    const lengths = [0, 1, Math.floor(cap / 3) - 1, Math.floor(cap / 3), Math.floor(cap / 3) + 1, cap - 1, cap, cap + 1]
    for (const unit of ['a', 'é', '漢', '😀', '\ud800', '\udc00', 'a\ud800b', '\ud800\udc00']) {
      for (const length of lengths) {
        const text = unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
        const first = makeEvent({ sequence: 1, method: 'item/agentMessage/delta', text })
        let current = appendCodexEvent([], first)
        let expected = reference(text)
        expect(current[0]!.text).toBe(expected)
        expect(parseCodexEvent(JSON.stringify(first))!.text).toBe(expected)
        for (const [index, delta] of ['a', '漢', '\ud800', '\udc00', '😀'].entries()) {
          current = appendCodexEvent(current, { ...first, sequence: index + 2, text: delta })
          if (!expected.endsWith(marker)) expected = reference(expected + delta)
          expect(current[0]!.text).toBe(expected)
          expect(encoder.encode(current[0]!.text).length).toBeLessThanOrEqual(cap)
        }
      }
    }
  })
})

test('app tools expose their arguments and structured result instead of generic transport text', () => {
  const item = {
    type: 'mcpToolCall',
    server: 'codex_apps',
    tool: 'github.create_branch',
    arguments: { repository_full_name: 'proompteng/lab', branch_name: 'codex/ui' },
  }
  const call = makeEvent({ kind: 'tool-call', text: 'codex_apps/github.create_branch', rawJson: codexParams({ item }) })
  expect(codexEventDisplayText(call)).toBe(
    'codex_apps/github.create_branch\n{\n  "repository_full_name": "proompteng/lab",\n  "branch_name": "codex/ui"\n}',
  )
  const completed = {
    ...item,
    result: { content: [{ type: 'text', text: 'Action completed.' }], structuredContent: { branch: 'codex/ui' } },
  }
  const output = {
    ...call,
    kind: 'tool-output' as const,
    text: 'Action completed.',
    rawJson: codexParams({ item: completed }),
  }
  expect(codexEventDisplayText(output)).toContain('"branch": "codex/ui"')
  const history = codexTranscriptFromThread(codexHistory([{ items: [{ ...completed, id: 'app-output' }] }]))
  expect(history[0].text).toBe(codexEventDisplayText(output))
})

test('keeps status-only connector outcomes visible', () => {
  for (const type of ['mcpToolCall', 'dynamicToolCall']) {
    for (const [status, expected] of [
      ['completed', 'Command completed'],
      ['failed', 'Command failed'],
      ['declined', 'Command declined'],
    ]) {
      const output = makeEvent({ kind: 'tool-output', text: '', rawJson: codexParams({ item: { type, status } }) })
      expect(codexEventDisplayText(output)).toBe(expected)
      expect(codexEventShouldRender(output, output.threadId, new Set(), 0)).toBe(true)
    }
  }
})

test('decodes complete JSON string connector results before adding tool labels', () => {
  for (const type of ['mcpToolCall', 'dynamicToolCall']) {
    const item = {
      id: 'encoded-result',
      type,
      server: 'codex_apps',
      tool: 'github.fetch',
      result: JSON.stringify('First line\nSecond line'),
    }
    const output = makeEvent({ kind: 'tool-output', text: '', rawJson: codexParams({ item }) })
    const expected = 'codex_apps/github.fetch\nFirst line\nSecond line'
    expect(codexEventDisplayText(output)).toBe(expected)
    expect(codexTranscriptFromThread(codexHistory([{ items: [item] }]))[0].text).toBe(expected)
  }
})
