import { expect, type FrameLocator, type Locator, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { tengriActionSchema } from '@/lib/tengri/schemas'
import type { TengriCodexRun } from '@/lib/tengri/codex-run'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import { codexThreadTitle, type TengriCodexThreadSummary } from '@/lib/tengri/codex-threads'
import { codexModelFixtures } from './codex-models.fixture'
import { codexEvent } from './codex.fixture'

export const user = {
  id: '424242',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  image: null,
}

export const desktopOrigin =
  process.env.TENGRI_PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.TENGRI_PLAYWRIGHT_PORT ?? '3000'}`

export const readyAgent = {
  id: 'microvm-ada',
  displayName: 'Tengri',
  phase: 'ready',
  architecture: 'amd64',
  cpuMillis: 4_000,
  memoryMib: 8_192,
  workspaceGib: 32,
  uid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  runtimeEpoch: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  power: { idleTimeoutMinutes: 60 },
  nodeName: 'ryzen',
  message: '',
  createdAt: '2026-08-26T12:00:00.000Z',
  readyAt: '2026-08-26T12:00:08.000Z',
  lastActivityAt: '2026-08-26T12:30:00.000Z',
  idleDeadline: '2026-08-26T13:30:00.000Z',
  conditions: [
    { type: 'Ready', status: 'True', reason: 'GuestReady', message: '', lastTransitionAt: '2026-08-26T12:00:08.000Z' },
  ],
}

const workspaceEntries = [
  fileEntry('/workspace/README.md', 418, '2026-08-26T12:02:00.000Z'),
  fileEntry('/workspace/src', 0, '2026-08-26T12:03:00.000Z', true),
  fileEntry('/workspace/package.json', 221, '2026-08-26T12:04:00.000Z'),
]

const sourceEntries = [fileEntry('/workspace/src/main.ts', 128, '2026-08-26T12:05:00.000Z')]

export function previewTicket(sequence: number) {
  return createHash('sha256').update(`fixture-preview-ticket-${sequence}`).digest('base64url')
}

function mockRevision(content: string) {
  return createHash('sha256').update(content).digest('hex')
}

export type TerminalStore = { sessions: Record<string, unknown>[] }
export type ThreadStore = { threads: Array<TengriCodexThreadSummary & { archived: boolean }> }
const runEventHandlers = new WeakMap<Page, (event: Record<string, unknown>) => void>()

export type MockOptions = {
  savedThread?: string
  threadStore?: ThreadStore
  durableRun?: TengriCodexRun
  activeCodexLogin?: boolean
  authenticated?: boolean
  userId?: string
  agent?: typeof readyAgent | null
  codexAuthenticated?: boolean
  codexModels?: typeof codexModelFixtures
  codexModelsError?: { status: number; error: string; code?: string }
  failCreateOnce?: boolean
  commitFailedCreate?: boolean
  failSendTurnOnce?: boolean
  paginateCodexModels?: boolean
  extraFiles?: typeof workspaceEntries
  failCodexAccountUntilReleased?: boolean
  failSnapshotAfterAction?: 'delete-agent' | 'sleep-agent'
  holdCodexAccount?: boolean
  holdCodexModels?: boolean
  holdCodexAccountAfterLogin?: boolean
  holdLifecycleAction?: 'delete-agent' | 'sleep-agent'
  holdReplayResume?: boolean
  holdInitialResume?: boolean
  resumeThreadDelayMs?: number
  resumeThreadEventSequence?: number
  resumeThreadItemEventSequences?: Record<string, number>
  resumeThreadErrors?: Array<{ status: number; error: string; code?: string }>
  resumeThreadTruncatedOnce?: boolean
  resumeThreadRawJson?: string
  resumeThreadRawJsonById?: Record<string, string>
  searchDelays?: Record<string, number>
  searchTruncated?: boolean
  preserveDraftStorageOnReload?: boolean
  terminalStore?: TerminalStore
  supersedeSleepOnce?: boolean
  supersededCreationId?: string
}

export async function mockTengri(page: Page, options: MockOptions = {}) {
  let agent = options.agent === undefined ? readyAgent : options.agent
  let snapshotFailuresRemaining = 0
  let snapshotRequests = 0
  let authenticated = options.authenticated ?? true
  let failCreate = options.failCreateOnce ?? false
  let supersedeSleep = options.supersedeSleepOnce ?? false
  const actions: Record<string, unknown>[] = []
  let resumeThreadRequests = 0
  let resumeThreadResponses = 0
  let createdThreads = 0
  const threadStore = options.threadStore ?? { threads: [] }
  const completedThreads = new Set<string>()
  const runs = new Map<string, { runId: string; agentId: string; threadId: string; state: Record<string, unknown> }>()
  if (options.durableRun) runs.set(options.durableRun.runId, options.durableRun)
  if (!runEventHandlers.has(page))
    await page.exposeFunction('__tengriTestRunEvent', (event: Record<string, unknown>) =>
      runEventHandlers.get(page)?.(event),
    )
  runEventHandlers.set(page, (event) => {
    if (event.method !== 'turn/completed') return
    completedThreads.add(String(event.threadId))
    for (const run of runs.values())
      if (run.threadId === event.threadId) run.state = { phase: 'succeeded', turnId: String(event.turnId || 'turn-1') }
  })
  let codexAccountFailuresReleased = !options.failCodexAccountUntilReleased
  let heldCodexAccountRequest = false
  const heldCodexModels = requestGate()
  let sendTurnFailuresRemaining = options.failSendTurnOnce ? 1 : 0
  let searchRequestsInFlight = 0
  let maxConcurrentSearchRequests = 0
  const heldResume = requestGate()
  const heldCodexAccount = requestGate()
  const heldLifecycleAction = requestGate()
  let files = [...workspaceEntries, ...sourceEntries, ...(options.extraFiles ?? [])]
  const terminalStore = options.terminalStore ?? { sessions: [] }
  const terminalSockets: WebSocketRoute[] = []
  const terminalInput: string[] = []
  const contents = new Map<string, string>([
    ['/workspace/README.md', '# Tengri\n\nA persistent Firecracker workspace.\n'],
    ['/workspace/package.json', '{\n  "name": "tengri-workspace"\n}\n'],
    ['/workspace/src/main.ts', 'export const main = true\n'],
  ])

  function renameFile(sourcePath: string, destinationPath: string) {
    files = files.map((entry) => {
      if (entry.path !== sourcePath && !entry.path.startsWith(`${sourcePath}/`)) return entry
      const path = destinationPath + entry.path.slice(sourcePath.length)
      return { ...entry, path, name: path.slice(path.lastIndexOf('/') + 1) }
    })
    if (contents.has(sourcePath)) {
      contents.set(destinationPath, contents.get(sourcePath) ?? '')
      contents.delete(sourcePath)
    }
  }

  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error.stack ?? error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[browser:console] ${message.text()}`)
  })

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript(
    ({ clearDraftStorage, savedThread }) => {
      if (clearDraftStorage) {
        try {
          localStorage.clear()
        } catch {
          // Sandboxed preview bootstrap documents can have an opaque origin before navigation.
        }
      }
      if (savedThread && window === window.top) localStorage.setItem('tengri-thread:microvm-ada', savedThread)
      const NativeEventSource = window.EventSource
      const eventSourceState = { fileClosed: 0, fileOpened: 0 }
      const eventSources: HealthyEventSource[] = []
      Object.defineProperty(window, '__tengriTestEventSources', {
        configurable: true,
        value: eventSourceState,
      })
      class HealthyEventSource extends EventTarget {
        static readonly CLOSED = 2
        static readonly CONNECTING = 0
        static readonly OPEN = 1
        readonly CLOSED = 2
        readonly CONNECTING = 0
        readonly OPEN = 1
        closed = false
        readonly readyState = 1
        readonly url: string
        readonly withCredentials = false
        onerror: ((event: Event) => void) | null = null
        onmessage: ((event: MessageEvent) => void) | null = null
        onopen: ((event: Event) => void) | null = null
        readonly tracksFiles: boolean

        constructor(url: string | URL) {
          super()
          this.url = String(url)
          this.tracksFiles = new URL(this.url, window.location.href).pathname === '/api/tengri/files/events'
          eventSources.push(this)
          if (this.tracksFiles) eventSourceState.fileOpened += 1
          queueMicrotask(() => this.onopen?.(new Event('open')))
        }

        close() {
          this.closed = true
          if (this.tracksFiles) eventSourceState.fileClosed += 1
        }
      }
      const SelectiveEventSource = new Proxy(NativeEventSource, {
        construct(target, args) {
          const [url] = args as [string | URL]
          const destination = new URL(String(url), window.location.href)
          if (!destination.pathname.startsWith('/api/tengri/')) return Reflect.construct(target, args)
          return new HealthyEventSource(url)
        },
      })
      Object.defineProperty(window, 'EventSource', { configurable: true, value: SelectiveEventSource })
      Object.defineProperty(window, '__tengriEventSources', { configurable: true, value: eventSources })
    },
    {
      savedThread: options.savedThread,
      clearDraftStorage: !options.preserveDraftStorageOnReload,
    },
  )
  await page.routeWebSocket('ws://127.0.0.1:8080/**', (socket) => {
    terminalSockets.push(socket)
    let ready = false
    socket.onMessage((message) => {
      if (typeof message !== 'string') terminalInput.push(message.toString('utf8'))
      if (ready) return
      ready = true
      socket.send(
        JSON.stringify({
          type: 'ready',
          token: 'terminal-resume-0001',
          bufferStart: 0,
          bufferEnd: 0,
        }),
      )
    })
  })
  await page.route('**/api/auth/logout', async (route) => {
    authenticated = false
    await route.fulfill({ json: { success: true } })
  })
  await page.route('**/api/platform/provider-connections**', (route) => route.fulfill({ json: { connections: [] } }))
  await page.route('**/api/tengri/connections**', (route) =>
    route.fulfill({ json: { connections: [], recoveryGeneration: '1' } }),
  )
  await page.route('**/api/tengri', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      snapshotRequests += 1
      const failNext = snapshotFailuresRemaining > 0
      if (failNext) snapshotFailuresRemaining -= 1
      if (
        failNext ||
        (options.failSnapshotAfterAction && actions.some((action) => action.action === options.failSnapshotAfterAction))
      ) {
        return replyWithError(route, 503, 'Tengri control plane is temporarily unavailable')
      }
      return route.fulfill({
        json: {
          authConfigured: true,
          controlPlaneConfigured: true,
          previewGatewayOrigin: 'https://tengri.proompteng.ai',
          authenticated,
          user: authenticated ? { ...user, id: options.userId ?? user.id } : null,
          agents: authenticated && agent ? [agent] : [],
        },
      })
    }

    const action = request.postDataJSON() as Record<string, unknown>
    actions.push(action)
    if (action.action === 'create-agent' && action.operationId === options.supersededCreationId) {
      return replyWithError(route, 409, 'Workspace removed', 'lifecycle_superseded')
    }
    if (action.action === 'create-agent' && failCreate) {
      failCreate = false
      if (options.commitFailedCreate) {
        const owner = createHash('sha256')
          .update(`github:${options.userId ?? user.id}`)
          .digest('hex')
        const id = `agent-${createHash('sha256')
          .update(`ofz.workspace.v1\n${owner}\n${String(action.operationId)}`)
          .digest('hex')
          .slice(0, 32)}`
        agent = { ...readyAgent, id, displayName: String(action.displayName) }
      }
      return replyWithError(route, 503, 'Creation response is uncertain')
    }
    if (action.action === 'sleep-agent' && supersedeSleep) {
      supersedeSleep = false
      return replyWithError(route, 409, 'A newer workspace transition replaced this request.', 'lifecycle_superseded')
    }
    let result: unknown = null
    switch (action.action) {
      case 'create-agent':
        agent = { ...readyAgent, displayName: String(action.displayName) }
        result = agent
        break
      case 'stat-file': {
        const path = String(action.path)
        result = files.find((entry) => entry.path === path) ?? {
          name: path.slice(path.lastIndexOf('/') + 1),
          path,
          directory: path === '/workspace',
          size: 0,
          modifiedAt: '',
        }
        break
      }
      case 'list-files':
        result = {
          path: action.path,
          entries: files.filter((entry) => parentPath(entry.path) === action.path),
        }
        break
      case 'search-files':
        searchRequestsInFlight += 1
        maxConcurrentSearchRequests = Math.max(maxConcurrentSearchRequests, searchRequestsInFlight)
        try {
          await new Promise((resolve) => setTimeout(resolve, options.searchDelays?.[String(action.query)] ?? 0))
          result = {
            entries: files.filter((entry) => entry.name.toLowerCase().includes(String(action.query).toLowerCase())),
            truncated: options.searchTruncated ?? false,
          }
        } finally {
          searchRequestsInFlight -= 1
        }
        break
      case 'read-file': {
        const path = String(action.path)
        const content = contents.get(path)
        if (content === undefined) return replyWithError(route, 404, 'File not found')
        result = { path, content, contentType: 'text/markdown; charset=utf-8', revision: mockRevision(content) }
        break
      }
      case 'write-file': {
        const path = String(action.path)
        const content = String(action.content)
        const currentContent = contents.get(path)
        const currentRevision = currentContent === undefined ? 'missing' : mockRevision(currentContent)
        if (action.expectedRevision !== currentRevision) {
          return replyWithError(route, 409, 'File changed on the guest', 'file_conflict')
        }
        contents.set(path, content)
        if (!files.some((entry) => entry.path === path)) {
          files.push({
            name: path.slice(path.lastIndexOf('/') + 1),
            path,
            directory: false,
            size: content.length,
            modifiedAt: '2026-08-26T12:34:00.000Z',
          })
        }
        result = { path, size: Buffer.byteLength(content), revision: mockRevision(content) }
        break
      }
      case 'create-directory': {
        const path = String(action.path)
        files.push({
          name: path.slice(path.lastIndexOf('/') + 1),
          path,
          directory: true,
          size: 0,
          modifiedAt: '2026-08-26T12:34:00.000Z',
        })
        result = { path }
        break
      }
      case 'move-file': {
        const sourcePath = String(action.sourcePath)
        const destinationPath = String(action.destinationPath)
        renameFile(sourcePath, destinationPath)
        result = { sourcePath, destinationPath }
        break
      }
      case 'delete-file': {
        const path = String(action.path)
        files = files.filter((entry) => entry.path !== path && !entry.path.startsWith(`${path}/`))
        for (const contentPath of contents.keys()) {
          if (contentPath === path || contentPath.startsWith(`${path}/`)) contents.delete(contentPath)
        }
        break
      }
      case 'editor-session':
        return replyWithError(route, 503, 'VS Code is unavailable in this guest.')
      case 'codex-account':
        if (!codexAccountFailuresReleased) {
          return replyWithError(route, 503, 'Codex account is temporarily unavailable')
        }
        if (
          options.holdCodexAccount ||
          (options.holdCodexAccountAfterLogin &&
            !heldCodexAccountRequest &&
            actions.some((candidate) => candidate.action === 'codex-login'))
        ) {
          heldCodexAccountRequest = true
          await heldCodexAccount.hold()
        }
        result = {
          authenticated: options.codexAuthenticated ?? true,
          email: options.codexAuthenticated === false ? '' : 'ada@example.test',
          plan: options.codexAuthenticated === false ? '' : 'pro',
        }
        break
      case 'codex-models':
        if (options.holdCodexModels) {
          await heldCodexModels.hold()
        }
        if (options.codexModelsError) {
          const { status, ...body } = options.codexModelsError
          await route.fulfill({ status, json: body })
          return
        }
        result = options.paginateCodexModels
          ? {
              models: codexModelFixtures.slice(action.cursor ? 1 : 0, action.cursor ? 2 : 1),
              nextCursor: action.cursor ? null : 'models-2',
            }
          : { models: options.codexModels ?? codexModelFixtures, nextCursor: null }
        break
      case 'codex-login-status':
        result = options.activeCodexLogin
          ? {
              loginId: 'login-existing',
              verificationUrl: 'https://auth.openai.com/device',
              userCode: 'TENG-RI99',
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }
          : null
        break
      case 'codex-login':
        result = {
          loginId: 'login-1',
          verificationUrl: 'https://auth.openai.com/device',
          userCode: 'TENG-RI01',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }
        break
      case 'create-thread':
        result = { id: `thread-${++createdThreads}`, rawJson: '{}', eventSequence: 0 }
        break
      case 'list-threads': {
        const cursor = action.cursor ? Number(String(action.cursor).slice('page:'.length)) : 0
        const threads = threadStore.threads
          .filter((thread) => thread.archived === action.archived)
          .sort((left, right) => right.updatedAt - left.updatedAt)
        result = {
          threads: threads.slice(cursor, cursor + 50).map(({ archived: _archived, ...thread }) => thread),
          nextCursor: cursor + 50 < threads.length ? `page:${cursor + 50}` : null,
        }
        break
      }
      case 'set-thread-archived': {
        const thread = threadStore.threads.find((thread) => thread.id === action.threadId)
        if (!thread) {
          return replyWithError(route, 404, 'Chat not found')
        }
        thread.archived = Boolean(action.archived)
        break
      }
      case 'list-terminals':
        result = terminalStore.sessions
        break
      case 'create-terminal': {
        const creationId = String(action.creationId)
        const existing = terminalStore.sessions.find((session) => session.creationId === creationId)
        result = existing ?? {
          id: `terminal-${terminalStore.sessions.length + 1}`,
          creationId,
          cwd: '/workspace',
          createdAt: '2026-08-26T12:34:00.000Z',
          lastActivityAt: '2026-08-26T12:34:00.000Z',
          attached: false,
        }
        if (!existing) terminalStore.sessions = [...terminalStore.sessions, result as Record<string, unknown>]
        break
      }
      case 'terminate-terminal':
        terminalStore.sessions = terminalStore.sessions.filter((session) => session.id !== action.terminalId)
        break
      case 'terminal-ticket':
        result = {
          ticket: 'ticket.signature',
          websocketUrl: 'ws://127.0.0.1:8080/v1/terminal/ws',
          expiresAt: '2026-08-26T12:34:30.000Z',
        }
        break
      case 'resume-thread':
        resumeThreadRequests += 1
        if (options.resumeThreadErrors?.[resumeThreadRequests - 1]) {
          const { status, ...failure } = options.resumeThreadErrors[resumeThreadRequests - 1]
          resumeThreadResponses += 1
          await route.fulfill({ status, json: failure })
          return
        }
        if (
          (options.holdReplayResume && resumeThreadRequests === 2) ||
          (options.holdInitialResume && resumeThreadRequests === 1)
        ) {
          await heldResume.hold()
        }
        if (options.resumeThreadDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.resumeThreadDelayMs))
        }
        resumeThreadResponses += 1
        await route.fulfill({
          contentType: 'application/x-ndjson; charset=utf-8',
          body:
            options.resumeThreadTruncatedOnce && resumeThreadRequests === 1
              ? recoveryRecords(String(action.threadId), options).replace('{"type":"complete"}\n', '')
              : recoveryRecords(String(action.threadId), options),
        })
        return
      case 'active-codex-runs': {
        const existing = [...runs.values()].filter(
          (run) =>
            run.agentId === action.agentId &&
            (!action.threadId || run.threadId === action.threadId) &&
            !['succeeded', 'failed', 'cancelled', 'rejected'].includes(String(run.state.phase)),
        )
        if (existing.length) {
          result = existing
          break
        }
        // Without seeded history there is no recoverable run. Avoid evaluating a
        // document that may be reloading while this request is still in flight.
        if (!options.resumeThreadRawJson && !options.resumeThreadRawJsonById) {
          result = []
          break
        }
        // waitForFunction survives document replacement; a primitive result stays readable after reload.
        const selectedThread = await page.waitForFunction(
          () => localStorage.getItem('tengri-thread:microvm-ada') || true,
        )
        const selected = await selectedThread.jsonValue()
        await selectedThread.dispose()
        const thread = typeof selected === 'string' ? selected : ''
        const raw = options.resumeThreadRawJsonById?.[thread] || options.resumeThreadRawJson
        const active =
          thread && !completedThreads.has(thread) && raw
            ? (JSON.parse(raw).thread?.turns || []).find((turn: { status: string }) => turn.status === 'inProgress')
            : undefined
        if (active) {
          const runId = '11111111-1111-4111-8111-111111111111'
          result = { runId, agentId: action.agentId, threadId: thread, state: { phase: 'running', turnId: active.id } }
          runs.set(
            runId,
            result as { runId: string; agentId: string; threadId: string; state: Record<string, unknown> },
          )
          result = [result]
        } else {
          result = []
        }
        break
      }
      case 'recover-run': {
        const run = runs.get(String(action.runId))
        if (run) run.state = { phase: 'recovering', turnId: run.state.turnId, reason: 'Checking the accepted turn' }
        result = null
        break
      }
      case 'codex-run':
        result = runs.get(String(action.runId)) || null
        break
      case 'send-turn':
        if (sendTurnFailuresRemaining) {
          sendTurnFailuresRemaining -= 1
          return replyWithError(route, 503, 'Temporary image send failure')
        }
        result = {
          runId: action.operationId,
          agentId: action.agentId,
          threadId: action.threadId,
          state: { phase: 'running', turnId: 'turn-1' },
        }
        runs.set(
          String(action.operationId),
          result as { runId: string; agentId: string; threadId: string; state: Record<string, unknown> },
        )
        if (!threadStore.threads.some((thread) => thread.id === action.threadId))
          threadStore.threads.push(
            savedChat(String(action.threadId), codexThreadTitle(String(action.text || '')), Date.now()),
          )
        break
      case 'sleep-agent':
        if (options.holdLifecycleAction === 'sleep-agent') {
          await heldLifecycleAction.hold()
        }
        agent = agent ? { ...agent, phase: 'sleeping' } : agent
        result = agent
        break
      case 'resume-agent':
        agent = agent ? { ...agent, phase: 'ready' } : agent
        result = agent
        break
      case 'update-power-settings': {
        const power = action.power
        if (typeof power !== 'object' || power === null || !('idleTimeoutMinutes' in power)) {
          throw new Error('Missing power settings')
        }
        agent = agent
          ? {
              ...agent,
              power: {
                idleTimeoutMinutes: Number(power.idleTimeoutMinutes),
              },
              idleDeadline: power.idleTimeoutMinutes === 0 ? '' : agent.idleDeadline,
            }
          : agent
        result = agent
        break
      }
      case 'delete-agent':
        if (options.holdLifecycleAction === 'delete-agent') {
          await heldLifecycleAction.hold()
        }
        agent = null
        break
      default:
        result = null
    }
    return replyWithResult(route, result)
  })

  return {
    actions,
    calls: (...names: TengriRequest['action'][]) =>
      actions.filter((request) => names.some((name) => name === request.action)),
    heldCodexModelsStarted: heldCodexModels.started,
    releaseHeldCodexModels: heldCodexModels.release,
    terminalSockets,
    terminalInput,
    failNextSnapshots: (count: number) => {
      snapshotFailuresRemaining = count
    },
    getAgent: () => agent,
    getMaxConcurrentSearchRequests: () => maxConcurrentSearchRequests,
    getResumeThreadResponseCount: () => resumeThreadResponses,
    getSnapshotRequestCount: () => snapshotRequests,
    releaseCodexAccountFailures: () => {
      codexAccountFailuresReleased = true
    },
    releaseHeldCodexAccount: heldCodexAccount.release,
    releaseHeldLifecycleAction: heldLifecycleAction.release,
    releaseHeldResume: heldResume.release,
    setAgent: (nextAgent: typeof readyAgent | null) => {
      agent = nextAgent
    },
    setAuthenticated: (value: boolean) => {
      authenticated = value
    },
    waitForHeldLifecycleAction: () => heldLifecycleAction.started,
    waitForHeldCodexAccount: () => heldCodexAccount.started,
    waitForHeldResume: () => heldResume.started,
  }
}

function parentPath(path: string) {
  const separator = path.lastIndexOf('/')
  return separator <= 0 ? '/workspace' : path.slice(0, separator)
}

export function emitCodexEvent(page: Page, event: Partial<TengriCodexEvent>) {
  return emitCodexEvents(page, [event])
}

export function emitCodexEvents(page: Page, events: Partial<TengriCodexEvent>[]) {
  return page.evaluate((events) => {
    const source = (
      window as typeof window & {
        __tengriEventSources?: Array<{
          closed: boolean
          onmessage: ((event: MessageEvent) => void) | null
          url: string
        }>
      }
    ).__tengriEventSources?.find((candidate) => !candidate.closed && candidate.url.includes('/api/tengri/events?'))
    if (!source?.onmessage) throw new Error('Codex event stream is unavailable')
    const notify = Reflect.get(window, '__tengriTestRunEvent') as
      | ((event: Record<string, unknown>) => Promise<void>)
      | undefined
    for (const payload of events) {
      if (payload.method === 'turn/completed') void notify?.(payload)
      source.onmessage(new MessageEvent('message', { data: JSON.stringify(payload) }))
    }
  }, events.map(codexEvent))
}

function recoveryRecords(threadId: string, options: MockOptions) {
  const result = JSON.parse(
    options.resumeThreadRawJsonById?.[threadId] ?? options.resumeThreadRawJson ?? '{"thread":{"turns":[]}}',
  ) as Record<string, unknown>
  const thread = result.thread as Record<string, unknown>
  const turns = (thread.turns ?? []) as Array<Record<string, unknown>>
  const baseline = options.resumeThreadEventSequence ?? 0
  const records: Array<Record<string, unknown>> = [
    {
      type: 'page',
      part: 'thread',
      eventSequence: baseline,
      rawJson: JSON.stringify({ ...result, thread: { ...thread, id: threadId, historyMode: 'paginated', turns: [] } }),
    },
  ]
  const pages: Array<{ sequence: number; bytes: number; data: Array<Record<string, unknown>> }> = []
  let sequence = baseline
  for (const [index, turn] of turns.entries()) {
    turn.id ??= `fixture-turn-${index}`
    for (const item of (turn.items ?? []) as Array<Record<string, unknown>>) {
      sequence = Math.max(sequence, options.resumeThreadItemEventSequences?.[String(item.id)] ?? baseline)
      const entry = { turnId: turn.id, item }
      const bytes = Buffer.byteLength(JSON.stringify(entry))
      let page = pages.at(-1)
      if (!page || page.sequence !== sequence || page.data.length === 100 || page.bytes + bytes > 8 * 1024 * 1024) {
        page = { sequence, bytes: 0, data: [] }
        pages.push(page)
      }
      page.data.push(entry)
      page.bytes += bytes
    }
  }
  if (!pages.length) pages.push({ sequence, bytes: 0, data: [] })
  for (const [index, page] of pages.entries())
    records.push({
      type: 'page',
      part: 'items',
      eventSequence: page.sequence,
      rawJson: JSON.stringify({
        data: page.data,
        nextCursor: index === pages.length - 1 ? null : `items-${index + 1}`,
      }),
    })
  const turnPages = Math.max(1, Math.ceil(turns.length / 100))
  for (let index = 0; index < turnPages; index++)
    records.push({
      type: 'page',
      part: 'turns',
      eventSequence: sequence,
      rawJson: JSON.stringify({
        data: turns.slice(index * 100, (index + 1) * 100).map((turn) => ({
          ...turn,
          status: turn.status ?? 'completed',
          items: [],
          itemsView: 'notLoaded',
        })),
        nextCursor: index === turnPages - 1 ? null : `turns-${index + 1}`,
      }),
    })
  records.push({ type: 'complete' })
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

export async function openSettingsPane(settings: Locator, name: string) {
  const sidebar = settings
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name, exact: true })
  if (await sidebar.isVisible()) await sidebar.click()
  else {
    const back = settings.getByRole('button', { name: 'Back to General' })
    if (await back.isEnabled()) await back.click()
    await settings.getByRole('button', { name: `Open ${name}`, exact: true }).click()
  }
}

type DesktopApp = 'Finder' | 'Chrome' | 'Tengri' | 'Code' | 'Terminal' | 'Settings'

export const desktopDock = (page: Page) => page.getByRole('navigation', { name: 'Dock' })

export const desktopWindow = (page: Page, app: DesktopApp) =>
  page.getByRole('region', { name: `${app} window`, exact: true })

export const composerInput = (window: Locator) =>
  window.getByRole('form', { name: 'Message composer' }).getByRole('textbox')

export async function openDesktopApp(page: Page, app: DesktopApp) {
  await desktopDock(page)
    .getByRole('button', { name: `Open ${app}`, exact: true })
    .click()
  return desktopWindow(page, app)
}

export async function openSettings(page: Page, section: string) {
  const settings = await openDesktopApp(page, 'Settings')
  await openSettingsPane(settings, section)
  return settings
}

export async function visitDesktop(page: Page, options?: MockOptions) {
  const mock = await mockTengri(page, options)
  await page.goto('/')
  return mock
}

export function selectSavedThread(page: Page, threadId: string) {
  return page.addInitScript((id) => localStorage.setItem('tengri-thread:microvm-ada', id), threadId)
}

type TengriRequest = z.input<typeof tengriActionSchema>
type ActionHandler<Request extends TengriRequest> = (request: Request, route: Route) => Promise<void>

export function routeTengriPost(page: Page, handler: ActionHandler<TengriRequest>) {
  return page.route('**/api/tengri', (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    return handler(route.request().postDataJSON() as TengriRequest, route)
  })
}

export function routeTengriAction<Name extends TengriRequest['action']>(
  page: Page,
  name: Name,
  handler: ActionHandler<Extract<TengriRequest, { action: Name }>>,
) {
  return routeTengriPost(page, (request, route) =>
    request.action === name ? handler(request as Extract<TengriRequest, { action: Name }>, route) : route.fallback(),
  )
}

export function replyWithError(route: Route, status: number, error: string, code?: string) {
  return route.fulfill({ status, json: { error, code } })
}

export function replyWithResult(route: Route, result: unknown) {
  return route.fulfill({ json: { result } })
}

export function requestGate() {
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<void>()
  return {
    started: started.promise,
    hold() {
      started.resolve()
      return response.promise
    },
    release: response.resolve,
  }
}

export const exactButton = (scope: Page | Locator | FrameLocator, name: string | RegExp) =>
  scope.getByRole('button', { name, exact: true })

export function codexRun(runId: string, threadId: string, state: TengriCodexRun['state']): TengriCodexRun {
  return { runId, agentId: readyAgent.id, threadId, state }
}

export function expectTerminalConnected(terminal: Locator) {
  return expect(terminal.getByRole('status').filter({ hasText: /^Connected$/ })).toHaveAttribute(
    'data-connection-state',
    'connected',
  )
}

export function expectTengriCall(
  mock: Awaited<ReturnType<typeof mockTengri>>,
  action: TengriRequest['action'],
  fields: Record<string, unknown>,
) {
  return expect.poll(() => mock.calls(action)).toContainEqual(expect.objectContaining(fields))
}

export function namespaceTarget(name: string, id = 'galactic/' + name) {
  return { name, resource: { kind: 'kubernetes.namespace', id } }
}

export function namespaceOperation(
  name: string,
  description: string,
  targets: ReturnType<typeof namespaceTarget>[],
  action = 'kubernetes.' + name + '.read',
) {
  return { connectorId: 'galactic', name, action, description, targets, readOnly: true }
}

export function mockConnectorCatalog(page: Page, operations: () => unknown[]) {
  return page.route('**/api/platform/connectors', (route) => route.fulfill({ json: { operations: operations() } }))
}

export function savedChat(id: string, title: string, updatedAt: number, archived = false) {
  return { id, title, updatedAt, archived }
}

export function fileEntry(path: string, size: number, modifiedAt: string, directory = false) {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, directory, size, modifiedAt }
}

export function desktopSessionKeys(page: Page) {
  return page.evaluate(
    (agentId) =>
      Object.keys(sessionStorage).filter(
        (key) =>
          key === `tengri:desktop:${agentId}` ||
          key.startsWith(`tengri:windows:${agentId}:`) ||
          key.startsWith(`tengri:terminal:${agentId}:`) ||
          key === `tengri:terminal-cleanup:${agentId}`,
      ),
    readyAgent.id,
  )
}

export function afterPaint(page: Page) {
  return page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}
