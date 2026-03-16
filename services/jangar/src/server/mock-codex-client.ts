import type { CodexAppServerClient } from '@proompteng/codex'

type MockStreamDelta =
  | { type: 'message' | 'reasoning'; delta: string }
  | {
      type: 'plan'
      explanation: string | null
      plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>
    }
  | { type: 'rate_limits'; rateLimits: Record<string, unknown> }
  | {
      type: 'tool'
      toolKind: 'command' | 'file' | 'mcp' | 'webSearch' | 'dynamicTool' | 'imageGeneration'
      id: string
      status: string
      title?: string
      detail?: string
      delta?: string
      data?: Record<string, unknown>
      changes?: Array<Record<string, unknown>>
    }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'error'; error: Record<string, unknown> }

type MockRunResult = Awaited<ReturnType<CodexAppServerClient['runTurnStream']>>

const MOCK_THREAD_ID = 'mock-openwebui-thread'
const STREAM_DELAY_MS = 5

const parseBooleanEnv = (value: string | undefined) => {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

export const shouldUseMockCodexClient = () =>
  parseBooleanEnv(process.env.JANGAR_MOCK_CODEX) || Boolean(process.env.JANGAR_MOCK_CODEX_SCENARIO?.trim())

const resolveMockCodexScenario = () => {
  const value = process.env.JANGAR_MOCK_CODEX_SCENARIO?.trim()
  return value && value.length > 0 ? value : 'openwebui-e2e'
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const makeLargeText = (prefix: string, lines: number) =>
  Array.from({ length: lines }, (_, index) => `${prefix} ${String(index + 1).padStart(4, '0')}`).join('\n')

const buildMockItems = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, index) => `${prefix} ${index + 1} with mock detail payload ${String(index + 1).padStart(4, '0')}`,
  )

const buildMockImageUrl = () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
    <rect width="1200" height="800" fill="#0f172a" />
    <rect x="80" y="80" width="1040" height="640" rx="28" fill="#111827" stroke="#38bdf8" stroke-width="8" />
    <text x="600" y="360" text-anchor="middle" fill="#e2e8f0" font-family="monospace" font-size="72">status board mock</text>
    <text x="600" y="450" text-anchor="middle" fill="#7dd3fc" font-family="monospace" font-size="28">OpenWebUI Rich Activity</text>
  </svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

const buildLargeDiff = () =>
  [
    '@@ -1,4 +1,120 @@',
    '-export const oldStatus = false',
    '+export const oldStatus = true',
    ...Array.from({ length: 520 }, (_, index) => `+status change ${String(index + 1).padStart(3, '0')}`),
  ].join('\n')

const extractLatestUserPrompt = (prompt: string) => {
  const matches = Array.from(prompt.matchAll(/(?:^|\n)user:\s*(.+)$/gm))
  const latest = matches.at(-1)?.[1]?.trim()
  return latest && latest.length > 0 ? latest : prompt.trim()
}

const buildArithmeticDeltas = (prompt: string): MockStreamDelta[] | null => {
  const latestUserPrompt = extractLatestUserPrompt(prompt)
  const match = latestUserPrompt.match(/add\s+(-?\d+)\s+and\s+(-?\d+)/i)
  if (!match) return null

  const left = Number.parseInt(match[1] ?? '', 10)
  const right = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null

  return [
    { type: 'message', delta: String(left + right) },
    {
      type: 'usage',
      usage: {
        input_tokens: 8,
        output_tokens: 2,
        total_tokens: 10,
      },
    },
  ]
}

const buildRichActivityDemoDeltas = (): MockStreamDelta[] => {
  const commandOutput = ['mock transcript line 1', makeLargeText('mock transcript line', 420)].join('\n')
  const diff = buildLargeDiff()

  return [
    { type: 'message', delta: 'Starting the rich activity demo.' },
    {
      type: 'plan',
      explanation: 'Validate the browser transcript and the staged detail pages.',
      plan: [
        { step: 'Inspect render links', status: 'completed' },
        { step: 'Validate detail pages', status: 'in_progress' },
        { step: 'Confirm transcript continuity', status: 'pending' },
      ],
    },
    {
      type: 'rate_limits',
      rateLimits: {
        planType: 'pro',
        primary: { usedPercent: 35, windowDurationMins: 90, resetsAt: 1_735_000_000 },
        secondary: { usedPercent: 12, windowDurationMins: 60, resetsAt: 1_735_000_600 },
        credits: { hasCredits: true, unlimited: false, balance: '18.20' },
      },
    },
    {
      type: 'reasoning',
      delta:
        '<details type="reasoning" done="true"><summary>Thought</summary>Comparing command transcripts, file changes, and rich detail pages before the final response.</details>',
    },
    {
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'started',
      title: '/bin/bash -lc python scripts/mock-rich-activity.py',
    },
    {
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'completed',
      title: '/bin/bash -lc python scripts/mock-rich-activity.py',
      data: {
        aggregatedOutput: commandOutput,
        exitCode: 0,
        durationMs: 1450,
      },
    },
    {
      type: 'tool',
      toolKind: 'file',
      id: 'file-1',
      status: 'completed',
      title: 'file changes',
      detail: '2 files updated',
      changes: [
        { path: 'src/rich-activity.ts', diff },
        { path: 'src/rich-activity.test.ts', diff },
      ],
    },
    {
      type: 'tool',
      toolKind: 'mcp',
      id: 'mcp-1',
      status: 'completed',
      title: 'catalog.search',
      detail: 'Collected catalog inventory.',
      data: {
        arguments: { collection: 'catalog', pageSize: 20 },
        result: {
          summary: 'Catalog inventory collected.',
          items: buildMockItems('catalog item', 360),
        },
      },
    },
    {
      type: 'tool',
      toolKind: 'dynamicTool',
      id: 'dynamic-1',
      status: 'completed',
      title: 'audit.report',
      detail: 'Generated audit findings for the mock activity.',
      data: {
        tool: 'audit.report',
        arguments: { scope: 'openwebui-rich-activity' },
        result: {
          summary: 'Audit output complete.',
          items: buildMockItems('audit item', 360),
        },
        success: true,
      },
    },
    {
      type: 'tool',
      toolKind: 'webSearch',
      id: 'search-1',
      status: 'completed',
      title: 'openwebui rich activity ux',
      detail: 'Collected ranked search results.',
      data: {
        query: 'openwebui rich activity ux',
        results: Array.from({ length: 240 }, (_, index) => ({
          title: `search item ${index + 1}`,
          url: `https://example.test/search-${index + 1}`,
          snippet: `mock snippet ${index + 1} with additional detail to force a staged OpenWebUI render payload`,
        })),
      },
    },
    {
      type: 'tool',
      toolKind: 'imageGeneration',
      id: 'image-1',
      status: 'completed',
      title: 'status board mock',
      data: {
        prompt: 'Render the mock status board artifact.',
        imageUrl: buildMockImageUrl(),
      },
    },
    { type: 'message', delta: 'Completed the rich activity demo.' },
    {
      type: 'usage',
      usage: {
        input_tokens: 321,
        output_tokens: 654,
        reasoning_output_tokens: 123,
        total_tokens: 1098,
      },
    },
  ]
}

const buildFailureDemoDeltas = (): MockStreamDelta[] => [
  { type: 'message', delta: 'Starting the failure activity demo.' },
  {
    type: 'error',
    error: {
      type: 'upstream',
      code: 'mock_rich_activity_error',
      message: 'mock Codex app server error: command timed out while collecting artifacts',
    },
  },
  {
    type: 'usage',
    usage: {
      input_tokens: 42,
      output_tokens: 17,
      total_tokens: 59,
    },
  },
]

const buildScenarioDeltas = (prompt: string, scenario: string): MockStreamDelta[] => {
  const latestUserPrompt = extractLatestUserPrompt(prompt).toLowerCase()
  if (scenario !== 'openwebui-e2e') {
    return [{ type: 'message', delta: 'Mock Codex ready.' }]
  }

  const arithmetic = buildArithmeticDeltas(prompt)
  if (arithmetic) return arithmetic
  if (latestUserPrompt.includes('rich activity demo')) return buildRichActivityDemoDeltas()
  if (latestUserPrompt.includes('failure activity demo') || latestUserPrompt.includes('rich activity error demo')) {
    return buildFailureDemoDeltas()
  }

  return [{ type: 'message', delta: 'Mock Codex ready.' }]
}

export class MockCodexAppServerClient implements MockCodexClient {
  private nextTurnId = 1
  private readonly scenario = resolveMockCodexScenario()
  private readonly interruptedTurnIds = new Set<string>()

  async ensureReady() {}

  stop() {}

  async interruptTurn(turnId: string, _threadId?: string) {
    this.interruptedTurnIds.add(turnId)
  }

  async runTurnStream(
    prompt: string,
    options?: { model?: string; cwd?: string | null; threadId?: string; effort?: unknown },
  ): Promise<MockRunResult> {
    const turnId = `mock-turn-${this.nextTurnId++}`
    const threadId = options?.threadId ?? MOCK_THREAD_ID
    const deltas = buildScenarioDeltas(prompt, this.scenario)

    const interruptedTurnIds = this.interruptedTurnIds
    const stream = (async function* (): AsyncGenerator<MockStreamDelta, null, void> {
      for (const delta of deltas) {
        if (interruptedTurnIds.has(turnId)) break
        await sleep(STREAM_DELAY_MS)
        yield structuredClone(delta)
      }
      return null
    })()

    return {
      turnId,
      threadId,
      stream,
    } as MockRunResult
  }
}

type MockCodexClient = Pick<CodexAppServerClient, 'ensureReady' | 'interruptTurn' | 'runTurnStream' | 'stop'>
