import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test'
import { createHash } from 'node:crypto'
import { codexModelFixtures } from './codex-models.fixture'

const user = {
  id: '424242',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  image: null,
}

const desktopOrigin =
  process.env.TENGRI_PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.TENGRI_PLAYWRIGHT_PORT ?? '3000'}`

const readyAgent = {
  id: 'microvm-ada',
  displayName: 'Tengri',
  phase: 'ready',
  architecture: 'amd64',
  cpuMillis: 2_000,
  memoryMib: 4_096,
  workspaceGib: 16,
  power: { idleTimeoutMinutes: 60 },
  nodeName: 'ryzen',
  message: '',
  createdAt: '2026-08-26T12:00:00.000Z',
  readyAt: '2026-08-26T12:00:08.000Z',
  lastActivityAt: '2026-08-26T12:30:00.000Z',
  idleDeadline: '2026-08-26T13:30:00.000Z',
  expiresAt: '2026-08-26T16:00:00.000Z',
  conditions: [
    { type: 'Ready', status: 'True', reason: 'GuestReady', message: '', lastTransitionAt: '2026-08-26T12:00:08.000Z' },
  ],
}

const workspaceEntries = [
  {
    name: 'README.md',
    path: '/README.md',
    directory: false,
    size: 418,
    modifiedAt: '2026-08-26T12:02:00.000Z',
  },
  { name: 'src', path: '/src', directory: true, size: 0, modifiedAt: '2026-08-26T12:03:00.000Z' },
  {
    name: 'package.json',
    path: '/package.json',
    directory: false,
    size: 221,
    modifiedAt: '2026-08-26T12:04:00.000Z',
  },
]

const sourceEntries = [
  {
    name: 'main.ts',
    path: '/src/main.ts',
    directory: false,
    size: 128,
    modifiedAt: '2026-08-26T12:05:00.000Z',
  },
]

function previewTicket(sequence: number) {
  return `${'a'.repeat(47)}${sequence.toString(36)}.${'b'.repeat(43)}`
}

function previewSessionToken(sequence: number) {
  return `${'c'.repeat(47)}${sequence.toString(36)}.${'d'.repeat(43)}`
}

function mockRevision(content: string) {
  return createHash('sha256').update(content).digest('hex')
}

function previewBootstrapDocument() {
  return '<!doctype html><meta charset="utf-8"><title>Tengri Preview</title><script src="/_tengri/bootstrap.js" defer></script>'
}

function previewBootstrapScript() {
  return `(() => {
    const token = decodeURIComponent(window.location.hash.slice(1));
    const target = window.location.pathname + window.location.search;
    history.replaceState(null, '', target);
    if (!token) {
      document.body.textContent = 'Preview session is missing or expired.';
      return;
    }
    fetch('/_tengri/bootstrap', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('preview session rejected');
        const payload = await response.json();
        if (typeof payload.fragment !== 'string') throw new Error('preview fragment missing');
        history.replaceState(null, '', target + payload.fragment);
        window.location.reload();
      })
      .catch(() => {
        document.body.textContent = 'Preview session is missing or expired.';
      });
  })();`
}

function embeddedPreviewDocument() {
  return `<!doctype html><title>Tengri preview</title><main>Live microVM preview</main><p data-preview-route></p><script>
    (() => {
      const channel = 'tengri-preview-v1';
      const desktopOrigin = ${JSON.stringify(desktopOrigin)};
      const match = window.location.hostname.match(/^tengri-([a-z0-9]{24})\\./);
      const renderRoute = () => {
        document.querySelector('[data-preview-route]').textContent = window.location.hash === '#bridge-ready'
          ? 'Editor route ready'
          : 'Default route ready';
      };
      renderRoute();
      window.addEventListener('hashchange', renderRoute);
      if (match && window.parent !== window) {
        const sessionId = match[1];
        const send = (message) => window.parent.postMessage({ channel, sessionId, ...message }, desktopOrigin);
        window.addEventListener('pageshow', () => send({ type: 'navigation', mode: 'load', url: window.location.href }));
      }
    })();
  </script>`
}

type TerminalStore = { sessions: Record<string, unknown>[] }

type MockOptions = {
  activeCodexLogin?: boolean
  authenticated?: boolean
  agent?: typeof readyAgent | null
  blockDraftStorage?: boolean
  codexAuthenticated?: boolean
  codexModels?: typeof codexModelFixtures
  failCodexModels?: boolean
  failSendTurnOnce?: boolean
  legacyCodexModels?: boolean
  paginateCodexModels?: boolean
  deferSleepReconciliation?: boolean
  extraFiles?: typeof workspaceEntries
  failCodexAccountUntilReleased?: boolean
  failSnapshotAfterAction?: 'delete-agent' | 'sleep-agent'
  holdCodexAccount?: boolean
  holdCodexAccountAfterLogin?: boolean
  holdLifecycleAction?: 'delete-agent' | 'sleep-agent'
  holdReplayResume?: boolean
  legacyFileRevision?: boolean
  resumeThreadDelayMs?: number
  resumeThreadEventSequence?: number
  resumeThreadItemEventSequences?: Record<string, number>
  resumeThreadErrors?: Array<{ status: number; error: string; code?: string }>
  resumeThreadRawJson?: string
  searchDelays?: Record<string, number>
  searchTruncated?: boolean
  preserveDraftStorageOnReload?: boolean
  terminalStore?: TerminalStore
}

async function mockTengri(page: Page, options: MockOptions = {}) {
  let agent = options.agent === undefined ? readyAgent : options.agent
  let snapshotFailuresRemaining = 0
  let snapshotRequests = 0
  let authenticated = options.authenticated ?? true
  const actions: Record<string, unknown>[] = []
  let resumeThreadRequests = 0
  let resumeThreadResponses = 0
  let codexAccountFailuresReleased = !options.failCodexAccountUntilReleased
  let heldCodexAccountRequest = false
  let sendTurnFailuresRemaining = options.failSendTurnOnce ? 1 : 0
  let searchRequestsInFlight = 0
  let maxConcurrentSearchRequests = 0
  const readFileFailures = new Map<string, number>()
  const heldReads = new Map<
    string,
    {
      consumed: boolean
      markStarted: () => void
      promise: Promise<void>
      release: () => void
      started: Promise<void>
    }
  >()
  let previewSessionSequence = 0
  let holdNextPreviewSession = false
  const pendingPreviewLaunches: Array<{
    id: string
    path: string
    fragment: string
    ticket: string
    sessionToken: string
  }> = []
  let releaseHeldResume = () => {}
  let markHeldResumeStarted = () => {}
  let releaseHeldCodexAccount = () => {}
  let markHeldCodexAccountStarted = () => {}
  let releaseHeldLifecycleAction = () => {}
  let markHeldLifecycleActionStarted = () => {}
  let releaseHeldPreviewSession = () => {}
  let markHeldPreviewSessionStarted = () => {}
  const heldResume = new Promise<void>((resolve) => {
    releaseHeldResume = resolve
  })
  const heldResumeStarted = new Promise<void>((resolve) => {
    markHeldResumeStarted = resolve
  })
  const heldCodexAccount = new Promise<void>((resolve) => {
    releaseHeldCodexAccount = resolve
  })
  const heldCodexAccountStarted = new Promise<void>((resolve) => {
    markHeldCodexAccountStarted = resolve
  })
  const heldLifecycleAction = new Promise<void>((resolve) => {
    releaseHeldLifecycleAction = resolve
  })
  const heldLifecycleActionStarted = new Promise<void>((resolve) => {
    markHeldLifecycleActionStarted = resolve
  })
  const heldPreviewSession = new Promise<void>((resolve) => {
    releaseHeldPreviewSession = resolve
  })
  const heldPreviewSessionStarted = new Promise<void>((resolve) => {
    markHeldPreviewSessionStarted = resolve
  })
  let files = [...workspaceEntries, ...sourceEntries, ...(options.extraFiles ?? [])]
  const terminalStore = options.terminalStore ?? { sessions: [] }
  const terminalSockets: WebSocketRoute[] = []
  const terminalInput: string[] = []
  const contents = new Map<string, string>([
    ['/README.md', '# Tengri\n\nA persistent Firecracker workspace.\n'],
    ['/package.json', '{\n  "name": "tengri-workspace"\n}\n'],
    ['/src/main.ts', 'export const main = true\n'],
  ])

  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error.stack ?? error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[browser:console] ${message.text()}`)
  })

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript(
    ({ blockDraftStorage, clearDraftStorage }: { blockDraftStorage: boolean; clearDraftStorage: boolean }) => {
      if (clearDraftStorage) {
        try {
          localStorage.clear()
        } catch {
          // Sandboxed preview bootstrap documents can have an opaque origin before navigation.
        }
      }
      if (blockDraftStorage) {
        try {
          const nativeStorage = localStorage
          const blockedStorage = new Proxy(nativeStorage, {
            get(target, property) {
              if (property === 'length') {
                throw new DOMException('Storage is blocked for this test', 'QuotaExceededError')
              }
              if (property === 'getItem' || property === 'key' || property === 'removeItem' || property === 'setItem') {
                return () => {
                  throw new DOMException('Storage is blocked for this test', 'QuotaExceededError')
                }
              }
              return Reflect.get(target, property, target)
            },
          })
          Object.defineProperty(window, 'localStorage', { configurable: true, value: blockedStorage })
        } catch {
          // The browser may expose an immutable localStorage property on opaque origins.
        }
      }
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
      blockDraftStorage: options.blockDraftStorage ?? false,
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
  await page.context().route('**/v1/preview/open', async (route) => {
    if (pendingPreviewLaunches.length === 0) {
      await route.fulfill({ status: 410, body: 'Preview session is unavailable' })
      return
    }
    const launchLocations = Object.fromEntries(
      pendingPreviewLaunches.map((session) => [
        session.ticket,
        `https://tengri-${session.id}.proompteng.ai${session.path}#${session.sessionToken}`,
      ]),
    )
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Opening preview</title><script>location.replace(${JSON.stringify(launchLocations)}[decodeURIComponent(location.hash.slice(1))])</script>`,
    })
  })
  await page.route('**/api/auth/sign-out', async (route) => {
    authenticated = false
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const match = url.hostname.match(/^tengri-([a-z0-9]+)\.proompteng\.ai$/)
    if (!match) {
      await route.fallback()
      return
    }
    const session = pendingPreviewLaunches.find((candidate) => candidate.id === match[1])
    if (!session) {
      await route.fulfill({ status: 410, body: 'Preview session is unavailable' })
      return
    }
    if (url.pathname === '/_tengri/bootstrap.js') {
      await route.fulfill({ contentType: 'text/javascript', body: previewBootstrapScript() })
      return
    }
    if (url.pathname === '/_tengri/bootstrap') {
      const input = JSON.parse(route.request().postData() ?? '{}') as { token?: unknown }
      if (route.request().method() !== 'POST' || input.token !== session.sessionToken) {
        await route.fulfill({ status: 401, body: 'Preview session is unavailable' })
        return
      }
      await page.context().addCookies([
        {
          name: '__Host-tengri_preview',
          value: session.sessionToken,
          url: `https://${url.hostname}/`,
          httpOnly: true,
          secure: true,
          // Local E2E embeds the production-shaped preview host from 127.0.0.1;
          // production desktop and preview hosts are same-site and use Lax.
          sameSite: 'None',
        },
      ])
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'cache-control': 'no-store',
          'set-cookie': `__Host-tengri_preview=${session.sessionToken}; Path=/; HttpOnly; Secure; SameSite=None`,
        },
        body: JSON.stringify({ fragment: session.fragment }),
      })
      return
    }
    const cookie = route.request().headers().cookie ?? ''
    if (!cookie.split(';').some((value) => value.trim() === `__Host-tengri_preview=${session.sessionToken}`)) {
      await route.fulfill({
        contentType: 'text/html',
        headers: { 'content-security-policy': `frame-ancestors ${desktopOrigin}` },
        body: previewBootstrapDocument(),
      })
      return
    }
    await route.fulfill({
      contentType: 'text/html',
      headers: { 'content-security-policy': `frame-ancestors ${desktopOrigin}` },
      body: embeddedPreviewDocument(),
    })
  })

  await page.route('**/api/tengri', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      snapshotRequests += 1
      if (snapshotFailuresRemaining > 0) {
        snapshotFailuresRemaining -= 1
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Tengri control plane is temporarily unavailable' }),
        })
        return
      }
      if (
        options.failSnapshotAfterAction &&
        actions.some((action) => action.action === options.failSnapshotAfterAction)
      ) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Tengri control plane is temporarily unavailable' }),
        })
        return
      }
      const previewGatewayOrigin = 'https://tengri.proompteng.ai'
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          authConfigured: true,
          controlPlaneConfigured: true,
          previewGatewayOrigin,
          authenticated,
          user: authenticated ? user : null,
          agents: authenticated && agent ? [agent] : [],
        }),
      })
      return
    }

    const action = request.postDataJSON() as Record<string, unknown>
    actions.push(action)
    let result: unknown = null
    switch (action.action) {
      case 'create-agent':
        agent = { ...readyAgent, displayName: String(action.displayName) }
        result = agent
        break
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
      case 'read-file':
        if ((readFileFailures.get(String(action.path)) ?? 0) > 0) {
          readFileFailures.set(String(action.path), (readFileFailures.get(String(action.path)) ?? 1) - 1)
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Guest filesystem is temporarily unavailable' }),
          })
          return
        }
        {
          const path = String(action.path)
          const heldRead = heldReads.get(path)
          if (heldRead && !heldRead.consumed) {
            heldRead.consumed = true
            heldRead.markStarted()
            await heldRead.promise
            heldReads.delete(path)
          }
          const content = contents.get(path)
          if (content === undefined) {
            await route.fulfill({
              status: 404,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'File not found' }),
            })
            return
          }
          result = {
            path,
            content,
            contentType: 'text/markdown; charset=utf-8',
            revision: options.legacyFileRevision ? '' : mockRevision(content),
          }
        }
        break
      case 'write-file': {
        const path = String(action.path)
        const content = String(action.content)
        const currentContent = contents.get(path)
        const currentRevision = currentContent === undefined ? 'missing' : mockRevision(currentContent)
        if (action.expectedRevision !== currentRevision) {
          await route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'File changed on the guest', code: 'file_conflict' }),
          })
          return
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
        files = files.map((entry) => {
          if (entry.path !== sourcePath && !entry.path.startsWith(`${sourcePath}/`)) return entry
          const path = destinationPath + entry.path.slice(sourcePath.length)
          return { ...entry, path, name: path.slice(path.lastIndexOf('/') + 1) }
        })
        if (contents.has(sourcePath)) {
          contents.set(destinationPath, contents.get(sourcePath) ?? '')
          contents.delete(sourcePath)
        }
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
        await route.fulfill({ status: 503, json: { error: 'VS Code is unavailable in this guest.' } })
        return
      case 'preview-session':
        previewSessionSequence += 1
        if (holdNextPreviewSession) {
          holdNextPreviewSession = false
          markHeldPreviewSessionStarted()
          await heldPreviewSession
        }
        const previewSessionId = `preview${String(previewSessionSequence).padStart(17, '0')}`
        const ticket = previewTicket(previewSessionSequence)
        const sessionToken = previewSessionToken(previewSessionSequence)
        pendingPreviewLaunches.push({
          id: previewSessionId,
          path: String(action.path),
          fragment: String(action.fragment),
          ticket,
          sessionToken,
        })
        result = {
          id: previewSessionId,
          launchUrl: `https://tengri.proompteng.ai/v1/preview/open#${ticket}`,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          previewOrigin: `https://tengri-${previewSessionId}.proompteng.ai`,
        }
        break
      case 'codex-account':
        if (!codexAccountFailuresReleased) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Codex account is temporarily unavailable' }),
          })
          return
        }
        if (
          options.holdCodexAccount ||
          (options.holdCodexAccountAfterLogin &&
            !heldCodexAccountRequest &&
            actions.some((candidate) => candidate.action === 'codex-login'))
        ) {
          heldCodexAccountRequest = true
          markHeldCodexAccountStarted()
          await heldCodexAccount
        }
        result = {
          authenticated: options.codexAuthenticated ?? true,
          email: options.codexAuthenticated === false ? '' : 'ada@example.test',
          plan: options.codexAuthenticated === false ? '' : 'pro',
        }
        break
      case 'codex-models':
        if (options.legacyCodexModels) {
          await route.fulfill({
            status: 412,
            json: {
              error: 'Model selection needs an updated guest. Chat continues with existing Codex settings.',
              code: 'model_selection_unavailable',
            },
          })
          return
        }
        if (options.failCodexModels) {
          await route.fulfill({ status: 503, json: { error: 'Codex model catalog unavailable' } })
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
        result = { id: 'thread-1', rawJson: '{}', eventSequence: 0 }
        break
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
        if (options.holdReplayResume && resumeThreadRequests === 2) {
          markHeldResumeStarted()
          await heldResume
        }
        if (options.resumeThreadDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.resumeThreadDelayMs))
        }
        resumeThreadResponses += 1
        result = {
          id: action.threadId,
          rawJson: options.resumeThreadRawJson ?? '{"thread":{"turns":[]}}',
          eventSequence: options.resumeThreadEventSequence ?? 0,
          itemEventSequences: options.resumeThreadItemEventSequences ?? {},
        }
        break
      case 'send-turn':
        if (sendTurnFailuresRemaining) {
          sendTurnFailuresRemaining -= 1
          await route.fulfill({ status: 503, json: { error: 'Temporary image send failure' } })
          return
        }
        result = { id: 'turn-1', threadId: action.threadId }
        break
      case 'sleep-agent':
        if (options.holdLifecycleAction === 'sleep-agent') {
          markHeldLifecycleActionStarted()
          await heldLifecycleAction
        }
        if (!options.deferSleepReconciliation) agent = agent ? { ...agent, phase: 'sleeping' } : agent
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
          markHeldLifecycleActionStarted()
          await heldLifecycleAction
        }
        agent = null
        break
      default:
        result = null
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result }) })
  })

  return {
    actions,
    terminalSockets,
    terminalInput,
    completeSleepReconciliation: () => {
      agent = agent ? { ...agent, phase: 'sleeping' } : agent
    },
    failNextReads: (path: string, count = 1) => {
      readFileFailures.set(path, count)
    },
    failNextSnapshots: (count: number) => {
      snapshotFailuresRemaining = count
    },
    getAgent: () => agent,
    getMaxConcurrentSearchRequests: () => maxConcurrentSearchRequests,
    getResumeThreadResponseCount: () => resumeThreadResponses,
    getSnapshotRequestCount: () => snapshotRequests,
    holdNextRead: (path: string) => {
      let markStarted = () => {}
      let release = () => {}
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      heldReads.set(path, { consumed: false, markStarted, promise, release, started })
    },
    holdNextPreviewSession: () => {
      holdNextPreviewSession = true
    },
    releaseCodexAccountFailures: () => {
      codexAccountFailuresReleased = true
    },
    releaseHeldCodexAccount,
    releaseHeldLifecycleAction,
    releaseHeldPreviewSession,
    releaseHeldResume,
    releaseHeldRead: (path: string) => {
      heldReads.get(path)?.release()
    },
    deleteFileContent: (path: string) => {
      contents.delete(path)
    },
    renameFileContent: (sourcePath: string, destinationPath: string) => {
      files = files.map((entry) => {
        if (entry.path !== sourcePath && !entry.path.startsWith(`${sourcePath}/`)) return entry
        const path = destinationPath + entry.path.slice(sourcePath.length)
        return { ...entry, path, name: path.slice(path.lastIndexOf('/') + 1) }
      })
      if (contents.has(sourcePath)) {
        contents.set(destinationPath, contents.get(sourcePath) ?? '')
        contents.delete(sourcePath)
      }
    },
    setFileContent: (path: string, content: string) => {
      contents.set(path, content)
    },
    setAgent: (nextAgent: typeof readyAgent | null) => {
      agent = nextAgent
    },
    waitForHeldLifecycleAction: () => heldLifecycleActionStarted,
    waitForHeldCodexAccount: () => heldCodexAccountStarted,
    waitForHeldResume: () => heldResumeStarted,
    waitForHeldRead: (path: string) => {
      const heldRead = heldReads.get(path)
      if (!heldRead) throw new Error(`No held read for ${path}`)
      return heldRead.started
    },
    waitForHeldPreviewSession: () => heldPreviewSessionStarted,
  }
}

test('serializes slow Finder refreshes and reports bounded search results', async ({ page }) => {
  const mock = await mockTengri(page, {
    searchDelays: { missing: 2_100 },
    searchTruncated: true,
  })
  await page.goto('/')

  await page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Finder' }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  await finder.getByRole('button', { name: 'Search files' }).click()
  await finder.getByRole('textbox', { name: 'Search files' }).fill('missing')

  await expect(finder.getByText('Search limit reached · Narrow your search')).toBeVisible({ timeout: 5_000 })
  await expect
    .poll(() => mock.actions.filter((action) => action.action === 'search-files').length, { timeout: 7_000 })
    .toBeGreaterThanOrEqual(2)
  expect(mock.getMaxConcurrentSearchRequests()).toBe(1)
})

function parentPath(path: string) {
  const separator = path.lastIndexOf('/')
  return separator <= 0 ? '/' : path.slice(0, separator)
}

function emitCodexEvent(page: Page, event: Record<string, unknown>) {
  return page.evaluate((payload) => {
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
    source.onmessage(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }, event)
}

async function resizeWindow(
  page: Page,
  frame: Locator,
  edge: 'e' | 'n' | 'ne' | 'nw' | 's' | 'se' | 'sw' | 'w',
  delta: { x: number; y: number },
  expected: { height: number; width: number; x: number; y: number },
  grabPoint?: { x: number; y: number },
) {
  const before = await frame.boundingBox()
  expect(before).not.toBeNull()
  const handle = frame.locator('..').locator(`.cursor-${edge}-resize`)
  const handleBounds = await handle.boundingBox()
  expect(handleBounds).not.toBeNull()
  const point = grabPoint ?? {
    x: handleBounds!.x + handleBounds!.width / 2,
    y: handleBounds!.y + handleBounds!.height / 2,
  }
  await expect
    .poll(() =>
      page.evaluate(
        ({ x, y }) => ({
          className: document.elementFromPoint(x, y)?.getAttribute('class'),
          tagName: document.elementFromPoint(x, y)?.tagName,
        }),
        point,
      ),
    )
    .toMatchObject({ className: expect.stringContaining(`cursor-${edge}-resize`) })

  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + delta.x, point.y + delta.y, { steps: 3 })
  await page.mouse.up()

  for (const property of ['x', 'y', 'width', 'height'] as const) {
    await expect
      .poll(async () => (await frame.boundingBox())?.[property])
      .toBeCloseTo(before![property] + expected[property], 0)
  }
}

test('supports Dock-only launching, Spotlight, menus, Finder Quick Look, and window controls', async ({ page }) => {
  const terminalDisposeFailures: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('[tengri-terminal] terminal dispose failed')) {
      terminalDisposeFailures.push(message.text())
    }
  })
  const mock = await mockTengri(page, {
    extraFiles: Array.from({ length: 8 }, (_, index) => ({
      name: `test-${index + 1}.txt`,
      path: `/workspace/test-${index + 1}.txt`,
      directory: false,
      size: 1,
      modifiedAt: '2026-08-26T12:06:00.000Z',
    })),
    searchDelays: { readme: 750 },
  })
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await expect(dock).toBeVisible()
  await expect(dock.getByRole('button')).toHaveCount(5)
  for (const app of ['Finder', 'Chrome', 'Code', 'Terminal', 'Settings']) {
    await expect(dock.getByRole('button', { name: `Open ${app}` })).toBeVisible()
  }
  await expect(page.getByText('Docs', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Mail', { exact: true })).toHaveCount(0)

  await expect(page.getByRole('region', { name: 'Chrome window' })).toBeVisible()
  await page.keyboard.press('Meta+Space')
  const spotlight = page.getByRole('dialog', { name: 'Spotlight' })
  await expect(spotlight).toBeVisible()
  await spotlight.getByRole('combobox').fill('Settings')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Settings window' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Settings window' })).toBeFocused()

  const fileMenu = page.getByRole('menuitem', { name: 'File', exact: true })
  await fileMenu.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^New .* Window/ })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('menuitem', { name: 'Undo' })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('menuitem', { name: /^New .* Window/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(fileMenu).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: /^New .* Window/ }).press('Enter')
  const settingsWindows = page.getByRole('region', { name: 'Settings window' })
  await expect(settingsWindows).toHaveCount(2)
  await expect(settingsWindows.last()).toBeFocused()

  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  await expect(finder).toBeVisible()
  await finder.getByRole('button', { name: /README\.md/ }).click()
  await finder.getByRole('button', { name: 'Quick Look' }).click()
  const quickLook = page.getByRole('dialog', { name: /README\.md/ })
  await expect(quickLook).toBeVisible()
  await page.keyboard.press('Meta+Space')
  await expect(spotlight).toHaveCount(0)
  await expect(quickLook).toBeVisible()
  await page.locator('button[aria-label="Close Quick Look"]').click()
  await expect(page.locator('button[aria-label="Close Quick Look"]')).toHaveCount(0)

  await page.keyboard.press('Meta+Space')
  await spotlight.getByRole('combobox').fill('te')
  await expect.poll(() => spotlight.getByRole('option').count()).toBeGreaterThan(8)
  const optionCount = await spotlight.getByRole('option').count()
  const resultsList = spotlight.getByRole('listbox')
  await expect.poll(() => resultsList.evaluate((element) => element.scrollTop)).toBe(0)
  for (let index = 1; index < optionCount; index += 1) await page.keyboard.press('ArrowDown')
  await expect(spotlight.getByRole('option').last()).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => resultsList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await spotlight.getByRole('combobox').fill('src')
  await expect(spotlight.getByRole('option', { name: /src/ })).toBeVisible()
  await spotlight.getByRole('combobox').fill('readme')
  await expect(spotlight.getByRole('option', { name: /src/ })).toHaveCount(0, { timeout: 400 })
  await expect(spotlight.getByRole('option', { name: /README\.md/ })).toBeVisible()
  expect(mock.actions.filter((action) => action.action === 'search-files').at(-1)?.path).toBe('/')
  await spotlight.getByRole('combobox').fill('src')
  await expect(spotlight.getByRole('option', { name: /src/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(finder.getByRole('button', { name: /main\.ts/ })).toBeVisible()
  await expect
    .poll(() => mock.actions.some((action) => action.action === 'list-files' && action.path === '/src'))
    .toBe(true)
  expect(mock.actions.some((action) => action.action === 'read-file' && action.path === '/src')).toBe(false)

  const finderFrame = page.locator('section[aria-label="Finder window"]')
  const finderWatchBeforeMinimize = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __tengriTestEventSources: { fileClosed: number; fileOpened: number }
        }
      ).__tengriTestEventSources,
  )
  expect(finderWatchBeforeMinimize.fileOpened - finderWatchBeforeMinimize.fileClosed).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Minimize Finder' }).click()
  await expect(finderFrame).toHaveAttribute('aria-hidden', 'true')
  await expect(finderFrame).toHaveCSS('pointer-events', 'none')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __tengriTestEventSources: { fileClosed: number; fileOpened: number }
            }
          ).__tengriTestEventSources.fileClosed,
      ),
    )
    .toBe(finderWatchBeforeMinimize.fileClosed)
  await dock.getByRole('button', { name: 'Open Finder' }).click()
  await expect(finderFrame).not.toHaveAttribute('aria-hidden', 'true')
  await expect(finderFrame).toHaveCSS('pointer-events', 'auto')
  await page.getByRole('button', { name: 'Maximize Finder' }).click()
  await expect(page.getByRole('button', { name: 'Restore Finder' })).toBeVisible()

  await dock.getByRole('button', { name: 'Open Terminal' }).click()
  const terminal = page.getByRole('region', { name: 'Terminal window' })
  await expect(terminal.getByLabel('Interactive Tengri terminal')).toHaveAttribute('data-renderer', 'canvas')
  await expect(terminal.locator('.xterm canvas')).not.toHaveCount(0)
  await expect.poll(() => mock.actions.some((action) => action.action === 'create-terminal')).toBe(true)
  await expect.poll(() => mock.actions.some((action) => action.action === 'terminal-ticket')).toBe(true)
  await expect(terminal.getByRole('status').filter({ hasText: /^Connected$/ })).toHaveAttribute(
    'data-connection-state',
    'connected',
  )
  await page.keyboard.press('Meta+Space')
  await spotlight.getByRole('combobox').fill('New Terminal')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Terminal window' })).toHaveCount(2)
  await expect.poll(() => mock.actions.filter((action) => action.action === 'create-terminal').length).toBe(2)
  const terminalCreations = mock.actions.filter((action) => action.action === 'create-terminal')
  expect(new Set(terminalCreations.map((action) => action.creationId)).size).toBe(2)
  expect(terminalCreations.every((action) => action.cwd === '/')).toBe(true)
  const creationIdPattern = new RegExp(`^tengri-${readyAgent.id}-[0-9a-f]{32}-terminal-[0-9]+$`)
  expect(terminalCreations.every((action) => creationIdPattern.test(String(action.creationId)))).toBe(true)
  await page.getByRole('button', { name: 'Close Terminal' }).last().click()
  await expect(page.getByRole('region', { name: 'Terminal window' })).toHaveCount(1)
  await expect.poll(() => mock.actions.some((action) => action.action === 'terminate-terminal')).toBe(true)
  expect(terminalDisposeFailures).toEqual([])
})

test('disables terminal input while connecting and reconnecting without replaying blocked keystrokes', async ({
  page,
}) => {
  const mock = await mockTengri(page)
  let releaseTicket = () => {}
  let ticketGate = new Promise<void>((resolve) => {
    releaseTicket = resolve
  })
  await page.route('**/api/tengri', async (route) => {
    const request = route.request()
    if (request.method() === 'POST' && request.postDataJSON().action === 'terminal-ticket') await ticketGate
    await route.fallback()
  })
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Terminal' }).click()
  const terminal = page.getByRole('region', { name: 'Terminal window' })
  const input = terminal.locator('.xterm-helper-textarea')
  await expect(input).toHaveJSProperty('readOnly', true)
  await input.focus()
  await page.keyboard.type('BLOCKED_INITIAL')
  releaseTicket()
  await expect(terminal.locator('[data-connection-state="connected"]')).toBeAttached()
  await expect(input).toHaveJSProperty('readOnly', false)
  await input.focus()
  await page.keyboard.type('connected')
  await expect.poll(() => mock.terminalInput.join('')).toBe('connected')

  ticketGate = new Promise<void>((resolve) => {
    releaseTicket = resolve
  })
  await mock.terminalSockets[0]!.close({ code: 1012, reason: 'Release reconnect test' })
  await expect(terminal.locator('[data-connection-state="reconnecting"]')).toBeAttached()
  await expect(input).toHaveJSProperty('readOnly', true)
  await input.focus()
  await page.keyboard.type('BLOCKED_RECONNECT')
  releaseTicket()
  await expect(terminal.locator('[data-connection-state="connected"]')).toBeAttached()
  await expect(input).toHaveJSProperty('readOnly', false)
  await input.focus()
  await page.keyboard.type('resumed')
  await expect.poll(() => mock.terminalInput.join('')).toBe('connectedresumed')
  expect(mock.terminalSockets).toHaveLength(2)
})

test('keeps the terminal background continuous through its gutters after resizing', async ({ page }, testInfo) => {
  await mockTengri(page)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Terminal' }).click()

  const terminal = page.getByRole('region', { name: 'Terminal window' })
  await expect(terminal.getByLabel('Interactive Tengri terminal')).toHaveAttribute('data-renderer', 'canvas')
  await expect(terminal.getByRole('status').filter({ hasText: /^Connected$/ })).toHaveAttribute(
    'data-connection-state',
    'connected',
  )
  await testInfo.attach('terminal-before-resize', { body: await terminal.screenshot(), contentType: 'image/png' })
  await expect(terminal.locator('.xterm-viewport')).toHaveCSS('background-color', 'rgb(30, 30, 30)')

  const connectionStatus = terminal.getByRole('status').filter({ hasText: /^Connected$/ })
  const statusBounds = await connectionStatus.boundingBox()
  expect(statusBounds?.width).toBeLessThanOrEqual(1)
  expect(statusBounds?.height).toBeLessThanOrEqual(1)
  await expect(connectionStatus).toHaveCSS('clip-path', 'inset(50%)')

  await resizeWindow(page, terminal, 'se', { x: 73, y: 41 }, { x: 0, y: 0, width: 73, height: 41 })
  await expect(terminal.locator('.xterm-viewport')).toHaveCSS('background-color', 'rgb(30, 30, 30)')
  const screenshotPath = testInfo.outputPath('terminal-after-resize.png')
  await terminal.screenshot({ path: screenshotPath })
  await testInfo.attach('terminal-after-resize', { path: screenshotPath, contentType: 'image/png' })
})

test('preserves terminal identity on reload and BFCache restore while isolating a duplicated desktop tab', async ({
  page,
}) => {
  const terminalStore: TerminalStore = { sessions: [] }
  const originalMock = await mockTengri(page, { terminalStore })
  await page.goto('/')

  const openTerminal = (target: Page) =>
    target.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Terminal' }).click()
  await openTerminal(page)
  await expect.poll(() => originalMock.actions.filter((action) => action.action === 'create-terminal').length).toBe(1)
  const originalCreationId = String(
    originalMock.actions.find((action) => action.action === 'create-terminal')?.creationId,
  )
  await expect(
    page
      .getByRole('region', { name: 'Terminal window' })
      .getByRole('status')
      .filter({ hasText: /^Connected$/ }),
  ).toHaveAttribute('data-connection-state', 'connected')

  await page.reload()
  await expect(page.getByRole('region', { name: 'Terminal window' })).toHaveCount(1)
  await expect(
    page
      .getByRole('region', { name: 'Terminal window' })
      .getByRole('status')
      .filter({ hasText: /^Connected$/ }),
  ).toHaveAttribute('data-connection-state', 'connected')
  expect(originalMock.actions.filter((action) => action.action === 'create-terminal')).toHaveLength(1)

  await page.evaluate(() => {
    globalThis.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })

  const inheritedSessionStorage = await page.evaluate(() => Object.entries(sessionStorage))
  const duplicate = await page.context().newPage()
  await duplicate.addInitScript((entries: Array<[string, string]>) => {
    for (const [key, value] of entries) sessionStorage.setItem(key, value)
  }, inheritedSessionStorage)
  const duplicateMock = await mockTengri(duplicate, { terminalStore })
  await duplicate.goto('/')
  await openTerminal(duplicate)
  await expect.poll(() => duplicateMock.actions.filter((action) => action.action === 'create-terminal').length).toBe(1)
  await expect(
    duplicate
      .getByRole('region', { name: 'Terminal window' })
      .getByRole('status')
      .filter({ hasText: /^Connected$/ }),
  ).toHaveAttribute('data-connection-state', 'connected')

  const duplicateCreationId = String(
    duplicateMock.actions.find((action) => action.action === 'create-terminal')?.creationId,
  )
  expect(duplicateCreationId).not.toBe(originalCreationId)
  expect(terminalStore.sessions).toHaveLength(2)
  await duplicate.close()
})

test('restores and isolates desktop sessions without Web Locks or BroadcastChannel', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined })
  })
  const terminalStore: TerminalStore = { sessions: [] }
  const mock = await mockTengri(page, { terminalStore })
  await page.goto('/')

  await page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Terminal' }).click()
  await expect(
    page
      .getByRole('region', { name: 'Terminal window' })
      .getByRole('status')
      .filter({ hasText: /^Connected$/ }),
  ).toHaveAttribute('data-connection-state', 'connected')
  const desktopId = await page.evaluate((agentId) => sessionStorage.getItem(`tengri:desktop:${agentId}`), readyAgent.id)

  await page.reload()

  await expect(page.getByRole('region', { name: 'Terminal window' })).toHaveCount(1)
  await expect(
    page
      .getByRole('region', { name: 'Terminal window' })
      .getByRole('status')
      .filter({ hasText: /^Connected$/ }),
  ).toHaveAttribute('data-connection-state', 'connected')
  expect(await page.evaluate((agentId) => sessionStorage.getItem(`tengri:desktop:${agentId}`), readyAgent.id)).toBe(
    desktopId,
  )
  expect(mock.actions.filter((action) => action.action === 'create-terminal')).toHaveLength(1)

  const originalCreationId = String(mock.actions.find((action) => action.action === 'create-terminal')?.creationId)
  const inheritedSessionStorage = await page.evaluate(() => Object.entries(sessionStorage))
  const duplicate = await page.context().newPage()
  await duplicate.addInitScript((entries: Array<[string, string]>) => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined })
    for (const [key, value] of entries) sessionStorage.setItem(key, value)
  }, inheritedSessionStorage)
  const duplicateMock = await mockTengri(duplicate, { terminalStore })
  await duplicate.goto('/')
  await duplicate.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Terminal' }).click()
  await expect.poll(() => duplicateMock.actions.filter((action) => action.action === 'create-terminal').length).toBe(1)
  const duplicateCreationId = String(
    duplicateMock.actions.find((action) => action.action === 'create-terminal')?.creationId,
  )
  expect(duplicateCreationId).not.toBe(originalCreationId)
  expect(
    await duplicate.evaluate((agentId) => sessionStorage.getItem(`tengri:desktop:${agentId}`), readyAgent.id),
  ).not.toBe(desktopId)
  expect(terminalStore.sessions).toHaveLength(2)
  await duplicate.close()
})

test('reports the desktop window limit for shortcuts, Dock launches, and Spotlight actions', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  for (let index = 0; index < 17; index += 1) await page.keyboard.press('Meta+N')
  await expect(page.getByRole('region', { name: 'Settings window' })).toHaveCount(18)

  await page.keyboard.press('Meta+N')
  const capacityAlert = page.getByRole('alert').filter({ hasText: 'at most 20 open windows' }).first()
  await expect(capacityAlert).toBeVisible()
  await expect(page.getByRole('region', { name: 'Settings window' })).toHaveCount(18)

  await dock.getByRole('button', { name: 'Open Terminal' }).click()
  await expect(page.getByRole('region', { name: 'Terminal window' })).toHaveCount(0)
  await expect(capacityAlert).toBeVisible()

  await page.keyboard.press('Meta+Space')
  const spotlight = page.getByRole('dialog', { name: 'Spotlight' })
  await spotlight.getByRole('combobox').fill('New Terminal')
  await page.keyboard.press('Enter')
  await expect(spotlight).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Terminal window' })).toHaveCount(0)
  await expect(capacityAlert).toBeVisible()
})

test('closes Chrome with its last tab and keeps the new-tab button next to the tabs', async ({ page }, testInfo) => {
  const mock = await mockTengri(page)
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const dockChrome = page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Chrome' })
  const tabs = chrome.getByRole('tablist', { name: 'Browser tabs' }).getByRole('tab')
  const newTab = chrome.getByRole('button', { name: 'New tab' })

  await newTab.click()
  await expect(tabs).toHaveCount(2)
  const lastTabBounds = await tabs.last().boundingBox()
  const newTabBounds = await newTab.boundingBox()
  if (!lastTabBounds || !newTabBounds) throw new Error('Chrome tab geometry is missing')
  expect(newTabBounds.x - (lastTabBounds.x + lastTabBounds.width)).toBeGreaterThanOrEqual(0)
  expect(newTabBounds.x - (lastTabBounds.x + lastTabBounds.width)).toBeLessThanOrEqual(8)
  await page.mouse.move(0, 0)
  const screenshotPath = testInfo.outputPath('chrome-tabs.png')
  await chrome.screenshot({ path: screenshotPath })
  await testInfo.attach('chrome-tabs', { path: screenshotPath, contentType: 'image/png' })

  await tabs.first().locator('[data-close-chrome-tab]').click()
  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await tabs.first().locator('[data-close-chrome-tab]').click()
  await expect(chrome).toHaveCount(0)

  await dockChrome.click()
  await expect(tabs).toHaveCount(1)
  await tabs.first().click({ button: 'middle' })
  await expect(chrome).toHaveCount(0)

  await dockChrome.click()
  await chrome.getByRole('textbox', { name: 'Message your agent' }).focus()
  await page.keyboard.press('Meta+w')
  await expect(chrome).toHaveCount(0)
  await dockChrome.click()
  await expect(tabs).toHaveCount(1)
  expect(mock.actions.some((action) => ['delete-agent', 'sleep-agent'].includes(String(action.action)))).toBe(false)
})

test('closes the last embedded preview tab through its shortcut bridge and releases the preview', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await chrome.getByLabel('Address').fill('localhost:4321')
  await chrome.getByLabel('Address').press('Enter')
  const previewFrame = chrome.getByTitle('localhost:4321')
  await expect(previewFrame.contentFrame().getByText('Live microVM preview')).toBeVisible()
  const frame = await (await previewFrame.elementHandle())?.contentFrame()
  if (!frame) throw new Error('Embedded preview is unavailable')
  const sessionId = new URL(frame.url()).hostname.slice('tengri-'.length, -'.proompteng.ai'.length)
  await frame.evaluate(
    ({ sessionId, desktopOrigin }) => {
      window.parent.postMessage({ channel: 'tengri-preview-v1', sessionId, type: 'shortcut', key: 'w' }, desktopOrigin)
    },
    { sessionId, desktopOrigin },
  )
  await expect(chrome).toHaveCount(0)
  await expect
    .poll(() =>
      mock.actions.some((action) => action.action === 'revoke-preview-session' && action.sessionId === sessionId),
    )
    .toBe(true)
})

test('offers old-editor drafts for download without overwriting guest files or exposing another owner', async ({
  page,
}) => {
  const mock = await mockTengri(page)
  await page.goto('/')
  await page.evaluate(
    ({ ownerId, agentId, agentCreatedAt }) => {
      for (const [owner, content] of [
        [ownerId, 'Recovered local edits'],
        ['another-owner', 'Private other-owner draft'],
      ]) {
        const path = '/README.md'
        const draft = {
          schemaVersion: 1,
          draftId: 'legacy-draft',
          ownerId: owner,
          agentId,
          agentCreatedAt,
          path,
          content,
          contentType: 'text/markdown',
          baseRevision: 'a'.repeat(64),
          updatedAt: Date.now(),
        }
        localStorage.setItem(
          'tengri:code-draft:v1:' +
            [owner, agentId, agentCreatedAt, path, draft.draftId].map(encodeURIComponent).join(':'),
          JSON.stringify(draft),
        )
      }
    },
    { ownerId: user.id, agentId: readyAgent.id, agentCreatedAt: readyAgent.createdAt },
  )
  await page.getByRole('button', { name: 'Open Code', exact: true }).click()
  const code = page.getByRole('region', { name: 'Code window' })
  await expect(code.getByRole('alert')).toContainText('VS Code is unavailable')
  await expect(code.getByRole('button', { name: 'Download /README.md' })).toHaveCount(1)
  const downloadPromise = page.waitForEvent('download')
  await code.getByRole('button', { name: 'Download /README.md' }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  if (!stream) throw new Error('Draft download is unavailable')
  let content = ''
  for await (const chunk of stream) content += String(chunk)
  expect(content).toBe('Recovered local edits')
  expect(mock.actions.some((action) => action.action === 'write-file')).toBe(false)
  await code.getByRole('button', { name: 'Close Code', exact: true }).click()
  await expect(code).toHaveCount(0)
})

async function selectCodexOption(page: Page, picker: Locator, label: string) {
  await picker.click()
  await page.getByRole('option', { name: label, exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
}

test('opens composer menus above the picker and supports keyboard selection on desktop and mobile', async ({
  page,
}, testInfo) => {
  await mockTengri(page)
  await page.goto('/')
  const model = page.getByRole('combobox', { name: 'Model', exact: true })
  await expect(model).toBeEnabled()
  await model.focus()
  await model.press('ArrowUp')
  const menu = page.getByRole('listbox')
  await expect(menu).toBeVisible()
  await expect(page.getByRole('option', { name: 'GPT-6.1 Sol', exact: true })).toHaveAttribute('aria-selected', 'true')
  const triggerBounds = (await model.boundingBox())!
  const menuBounds = (await menu.boundingBox())!
  expect(menuBounds.y + menuBounds.height).toBeLessThan(triggerBounds.y)
  await page.screenshot({ path: testInfo.outputPath('composer-model-picker.png'), animations: 'disabled' })
  const accessibility = await new AxeBuilder({ page }).include('[data-slot="select-content"]').analyze()
  expect(accessibility.violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(model).toBeFocused()
  await model.press('ArrowDown')
  await expect(menu).toBeVisible()
  await page.keyboard.press('End')
  await expect(page.getByRole('option', { name: 'GPT-5.6 Luna', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(model.locator('[data-slot="select-value"]')).toHaveText('GPT-5.6 Luna')
  await expect(menu).toHaveCount(0)
  const reasoning = page.getByRole('combobox', { name: 'Reasoning effort' })
  await expect(reasoning.locator('[data-slot="select-value"]')).toHaveText('Default (Low)')
  await page.setViewportSize({ width: 390, height: 680 })
  await reasoning.click()
  await expect(menu).toBeVisible()
  const mobileBounds = (await menu.boundingBox())!
  expect(mobileBounds.x).toBeGreaterThanOrEqual(0)
  expect(mobileBounds.x + mobileBounds.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: testInfo.outputPath('composer-reasoning-picker-mobile.png'), animations: 'disabled' })
  await page.getByRole('option', { name: 'Medium', exact: true }).click()
  await expect(reasoning.locator('[data-slot="select-value"]')).toHaveText('Medium')
  await expect(reasoning).toBeFocused()
})

test('keeps composer menus clickable after repeated desktop window switches', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  const model = page.getByRole('combobox', { name: 'Model', exact: true })
  await expect(model).toBeEnabled()
  for (let switchIndex = 0; switchIndex < 28; switchIndex += 1) {
    await page.getByRole('button', { name: 'Open Terminal', exact: true }).click()
    await page.getByRole('button', { name: 'Open Chrome', exact: true }).click()
  }
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  expect(Number(await chrome.locator('..').evaluate((element) => getComputedStyle(element).zIndex))).toBeGreaterThan(50)
  await model.click()
  const option = page.getByRole('option', { name: 'GPT-5.6 Luna', exact: true })
  await expect(option).toBeVisible()
  expect(
    await option.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
    }),
  ).toBe(true)
  await option.click()
  await expect(model.locator('[data-slot="select-value"]')).toHaveText('GPT-5.6 Luna')
})

test('selects and persists Codex models and reasoning for subsequent turns', async ({ page }) => {
  const mock = await mockTengri(page, { preserveDraftStorageOnReload: true, paginateCodexModels: true })
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const model = chrome.getByRole('combobox', { name: 'Model', exact: true })
  const reasoning = chrome.getByRole('combobox', { name: 'Reasoning effort' })
  await expect(model.locator('[data-slot="select-value"]')).toHaveText('GPT-6.1 Sol')
  await expect(model).toBeEnabled()
  await selectCodexOption(page, reasoning, 'High')
  await chrome.getByRole('textbox', { name: 'Message your agent' }).fill('Read the workspace')
  await chrome.getByRole('button', { name: 'Send message' }).click()
  await expect
    .poll(() => mock.actions.find((action) => action.action === 'send-turn'))
    .toMatchObject({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
      text: 'Read the workspace',
    })
  expect(mock.actions.find((action) => action.action === 'create-thread')).toMatchObject({
    model: 'gpt-6.1-sol',
    reasoningEffort: 'high',
  })
  await expect(model).toBeDisabled()
  await emitCodexEvent(page, {
    sequence: 1,
    kind: 'thread-state',
    method: 'turn/completed',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: '',
    approvalId: '',
    text: '',
    rawJson: '{"params":{"turn":{"id":"turn-1","status":"completed"}}}',
  })
  await expect(model).toBeEnabled()
  await page.reload()
  await expect(reasoning.locator('[data-slot="select-value"]')).toHaveText('High')
  await expect(reasoning).toBeEnabled()
  await expect
    .poll(() => mock.actions.filter((action) => action.action === 'resume-thread').at(-1))
    .toMatchObject({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
    })
  await selectCodexOption(page, model, 'GPT-5.6 Luna')
  await expect(reasoning.locator('[data-slot="select-value"]')).toHaveText('Default (Low)')
  await reasoning.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect(page.getByRole('option', { name: 'High', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await chrome.getByRole('textbox', { name: 'Message your agent' }).fill('Use the selected model')
  await chrome.getByRole('button', { name: 'Send message' }).click()
  await expect
    .poll(() => mock.actions.filter((action) => action.action === 'send-turn').at(-1))
    .toMatchObject({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      text: 'Use the selected model',
    })
})

test('reports a model catalog outage and retries without creating a conversation', async ({ page }) => {
  const options = { failCodexModels: true }
  const mock = await mockTengri(page, options)
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await expect(chrome.getByRole('alert')).toContainText('Codex model catalog unavailable')
  await chrome.getByRole('textbox', { name: 'Message your agent' }).fill('Read the workspace')
  await expect(chrome.getByRole('button', { name: 'Send message' })).toBeDisabled()
  expect(mock.actions.some((action) => action.action === 'create-thread')).toBe(false)
  options.failCodexModels = false
  await chrome.getByRole('button', { name: 'Retry models' }).click()
  await expect(chrome.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled()
  await expect(chrome.getByRole('button', { name: 'Send message' })).toBeEnabled()
})

for (const savedThread of [false, true]) {
  test(`continues ${savedThread ? 'saved' : 'new'} conversations while model selection awaits a guest update`, async ({
    page,
  }) => {
    const options = { legacyCodexModels: true }
    const mock = await mockTengri(page, options)
    if (savedThread) {
      await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-existing'))
    }
    await page.goto('/')
    const chrome = page.getByRole('region', { name: 'Chrome window' })
    await expect(chrome.getByRole('alert')).toContainText('Chat continues with existing Codex settings')
    await expect(chrome.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled()
    await chrome.getByRole('textbox', { name: 'Message your agent' }).fill('Continue in this workspace')
    await chrome.getByRole('button', { name: 'Send message' }).click()
    await expect.poll(() => mock.actions.some((action) => action.action === 'send-turn')).toBe(true)
    for (const action of mock.actions.filter((action) =>
      ['create-thread', 'resume-thread', 'send-turn'].includes(String(action.action)),
    )) {
      expect(action).not.toHaveProperty('model')
      expect(action).not.toHaveProperty('reasoningEffort')
    }
    expect(mock.actions.some((action) => action.action === 'create-thread')).toBe(!savedThread)
    await emitCodexEvent(page, {
      sequence: 1,
      kind: 'thread-state',
      method: 'turn/completed',
      threadId: savedThread ? 'thread-existing' : 'thread-1',
      turnId: 'turn-1',
      itemId: '',
      approvalId: '',
      text: '',
      rawJson: '{"params":{"turn":{"id":"turn-1","status":"completed"}}}',
    })
    options.legacyCodexModels = false
    await chrome.getByRole('button', { name: 'Retry models' }).click()
    await expect(chrome.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled()
    await selectCodexOption(page, chrome.getByRole('combobox', { name: 'Reasoning effort' }), 'High')
    await chrome.getByRole('textbox', { name: 'Message your agent' }).fill('Use the selected settings')
    await chrome.getByRole('button', { name: 'Send message' }).click()
    await expect
      .poll(() => mock.actions.filter((action) => action.action === 'send-turn').at(-1))
      .toMatchObject({ model: 'gpt-6.1-sol', reasoningEffort: 'high', text: 'Use the selected settings' })
  })
}

for (const unavailable of ['model', 'effort']) {
  test(`can replace a saved unavailable ${unavailable} after conversation recovery fails`, async ({ page }) => {
    const mock = await mockTengri(page, {
      resumeThreadErrors: [{ status: 400, error: 'Saved Codex settings are unavailable' }],
    })
    await page.addInitScript((unavailable) => {
      localStorage.setItem('tengri-thread:microvm-ada', 'thread-existing')
      localStorage.setItem(
        'tengri-codex-options:microvm-ada',
        JSON.stringify({
          model: unavailable === 'model' ? 'removed-model' : 'gpt-5.6-luna',
          reasoningEffort: 'high',
        }),
      )
    }, unavailable)
    await page.goto('/')
    const chrome = page.getByRole('region', { name: 'Chrome window' })
    await expect(chrome.getByText('Saved Codex settings are unavailable', { exact: true })).toBeVisible()
    const model = chrome.getByRole('combobox', { name: 'Model', exact: true })
    await expect(model).toBeEnabled()
    if (unavailable === 'model') await selectCodexOption(page, model, 'GPT-6.1 Sol')
    const reasoning = chrome.getByRole('combobox', { name: 'Reasoning effort' })
    await expect(reasoning).toBeEnabled()
    await selectCodexOption(page, reasoning, 'Low')
    await chrome.getByRole('button', { name: 'Retry conversation recovery' }).click()
    await expect(chrome.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
    expect(mock.actions.filter((action) => action.action === 'resume-thread').at(-1)).toMatchObject({
      model: unavailable === 'model' ? 'gpt-6.1-sol' : 'gpt-5.6-luna',
      reasoningEffort: 'low',
    })
    expect(mock.actions.some((action) => action.action === 'create-thread')).toBe(false)
    await chrome.getByRole('textbox', { name: 'Message your agent' }).fill('Continue this conversation')
    await chrome.getByRole('button', { name: 'Send message' }).click()
    await expect.poll(() => mock.actions.some((action) => action.action === 'send-turn')).toBe(true)
  })
}

test('keeps an unavailable default visible until the user selects an available model', async ({ page }) => {
  await mockTengri(page, { codexModels: codexModelFixtures.slice(1) })
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const model = chrome.getByRole('combobox', { name: 'Model', exact: true })
  await expect(chrome.getByRole('alert')).toContainText('This model is unavailable')
  await expect(model.locator('[data-slot="select-value"]')).toHaveText('gpt-6.1-sol (unavailable)')
  await chrome.getByRole('textbox', { name: 'Message your agent' }).fill('Read the workspace')
  await expect(chrome.getByRole('button', { name: 'Send message' })).toBeDisabled()
  await selectCodexOption(page, model, 'GPT-5.6 Luna')
  await expect(chrome.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await expect(chrome.getByRole('alert')).toHaveCount(0)
})

test('persists Finder changes and exposes a localhost preview from Chrome', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  await finder.getByRole('button', { name: 'Finder actions' }).click()
  await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click()
  await expect(finder.getByLabel('New folder name')).toBeFocused()
  await finder.getByLabel('New folder name').fill('sandbox')
  await finder.getByLabel('New folder name').press('Enter')
  const sandbox = finder.getByRole('button', { name: /sandbox/ })
  await expect(sandbox).toBeVisible()

  await sandbox.click()
  await finder.getByRole('button', { name: 'Finder actions' }).click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await finder.getByLabel('Rename item').fill('workspace-notes')
  await finder.getByLabel('Rename item').press('Enter')
  const renamed = finder.getByRole('button', { name: /workspace-notes/ })
  await expect(renamed).toBeVisible()
  await finder.getByRole('button', { name: 'Search files' }).click()
  await finder.getByRole('textbox', { name: 'Search files' }).fill('workspace-notes')
  await expect(renamed).toBeVisible()
  await finder.getByRole('textbox', { name: 'Search files' }).fill('')

  await renamed.click()
  await finder.getByRole('button', { name: 'Finder actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click()
  const deleteDialog = page.getByRole('alertdialog', { name: 'Delete this item?' })
  await expect(deleteDialog).toContainText('workspace-notes')
  await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(finder.getByRole('button', { name: /workspace-notes/ })).toHaveCount(0)

  await dock.getByRole('button', { name: 'Open Chrome' }).click()
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await chrome.getByLabel('Address').fill('localhost:4321/app?mode=dev')
  await expect(chrome.getByRole('button', { name: 'Go' })).toBeVisible()
  await chrome.getByRole('button', { name: 'Go' }).click()
  const previewFrame = chrome.getByTitle('localhost:4321')
  await expect(previewFrame).toBeVisible()
  await expect(previewFrame.contentFrame().getByText('Live microVM preview')).toBeVisible()
  await expect(chrome.getByText('Connecting to localhost…')).toHaveCount(0)
  const previewElement = await previewFrame.elementHandle()
  const previewDocument = await previewElement?.contentFrame()
  expect(previewDocument).not.toBeNull()
  const embeddedSessionId = new URL(previewDocument!.url()).hostname.slice('tengri-'.length, -'.proompteng.ai'.length)
  await previewDocument!.evaluate(
    ({ sessionId, desktopOrigin }) => {
      window.parent.postMessage(
        {
          channel: 'tengri-preview-v1',
          sessionId,
          type: 'navigation',
          mode: 'replace',
          url: `${window.location.origin}${window.location.pathname}${window.location.search}#bridge-ready`,
        },
        desktopOrigin,
      )
    },
    { sessionId: embeddedSessionId, desktopOrigin },
  )
  await expect(chrome.getByLabel('Address')).toHaveValue('http://localhost:4321/app?mode=dev#bridge-ready')
  const embeddedPreviewHash = async () => {
    const frameElement = await chrome.getByTitle('localhost:4321').elementHandle()
    const frame = await frameElement?.contentFrame()
    return frame ? new URL(frame.url()).hash : ''
  }
  await chrome.getByRole('button', { name: 'Reload' }).click()
  await expect.poll(embeddedPreviewHash).toBe('#bridge-ready')
  await expect(chrome.getByTitle('localhost:4321').contentFrame().getByText('Editor route ready')).toBeVisible()
  await expect(chrome.getByLabel('Address')).toHaveValue('http://localhost:4321/app?mode=dev#bridge-ready')

  await chrome.getByRole('button', { name: 'Back' }).click()
  await expect(chrome.getByLabel('Address')).toHaveValue('tengri://agent')
  await chrome.getByRole('button', { name: 'Forward' }).click()
  await expect.poll(embeddedPreviewHash).toBe('#bridge-ready')
  await expect(chrome.getByLabel('Address')).toHaveValue('http://localhost:4321/app?mode=dev#bridge-ready')
  await expect
    .poll(() =>
      mock.actions.some(
        (action) => action.action === 'preview-session' && action.port === 4321 && action.path === '/app?mode=dev',
      ),
    )
    .toBe(true)
  expect(
    mock.actions
      .filter((action) => action.action === 'preview-session' && action.port === 4321)
      .every((action) => !String(action.path).includes('#')),
  ).toBe(true)
  expect(
    mock.actions.some(
      (action) =>
        action.action === 'preview-session' &&
        action.port === 4321 &&
        action.path === '/app?mode=dev' &&
        action.fragment === '#bridge-ready',
    ),
  ).toBe(true)

  const previewSessionCount = () =>
    mock.actions.filter(
      (action) => action.action === 'preview-session' && action.port === 4321 && action.path === '/app?mode=dev',
    ).length
  const previewCountBeforeExternalOpen = previewSessionCount()
  const [external] = await Promise.all([
    page.waitForEvent('popup'),
    chrome.getByRole('button', { name: 'Open current preview in browser' }).click(),
  ])
  await expect.poll(previewSessionCount).toBe(previewCountBeforeExternalOpen + 1)
  await expect(external).toHaveURL(/^https:\/\/tengri-[a-z0-9]{24}\.proompteng\.ai\/app\?mode=dev#bridge-ready$/)
  const externalSessionId = new URL(external.url()).hostname.slice('tengri-'.length, -'.proompteng.ai'.length)
  await expect(external.getByText('Live microVM preview')).toBeVisible()
  await expect(external.getByText('Editor route ready')).toBeVisible()
  await page.getByRole('button', { name: 'Close Chrome' }).click()
  await expect(page.getByRole('region', { name: 'Chrome window' })).toHaveCount(0)
  await external.reload()
  await expect(external.getByText('Live microVM preview')).toBeVisible()
  await page.waitForTimeout(300)
  expect(
    mock.actions.some((action) => action.action === 'revoke-preview-session' && action.sessionId === externalSessionId),
  ).toBe(false)
  await external.close()
  await expect
    .poll(() =>
      mock.actions.some(
        (action) => action.action === 'revoke-preview-session' && action.sessionId === externalSessionId,
      ),
    )
    .toBe(true)
})

test('tracks an external preview that finishes opening after virtual Chrome closes', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')

  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await chrome.getByLabel('Address').fill('localhost:4321/delayed')
  await chrome.getByRole('button', { name: 'Go' }).click()
  await expect(chrome.getByTitle('localhost:4321').contentFrame().getByText('Live microVM preview')).toBeVisible()
  mock.holdNextPreviewSession()

  const [external] = await Promise.all([
    page.waitForEvent('popup'),
    chrome.getByRole('button', { name: 'Open current preview in browser' }).click(),
  ])
  await mock.waitForHeldPreviewSession()
  await page.getByRole('button', { name: 'Close Chrome' }).click()
  mock.releaseHeldPreviewSession()

  await expect(external).toHaveURL(/^https:\/\/tengri-[a-z0-9]{24}\.proompteng\.ai\/delayed$/)
  await expect(external.getByText('Live microVM preview')).toBeVisible()
  const externalSessionId = new URL(external.url()).hostname.slice('tengri-'.length, -'.proompteng.ai'.length)
  expect(
    mock.actions.some((action) => action.action === 'revoke-preview-session' && action.sessionId === externalSessionId),
  ).toBe(false)

  await external.close()
  await expect
    .poll(() =>
      mock.actions.some(
        (action) => action.action === 'revoke-preview-session' && action.sessionId === externalSessionId,
      ),
    )
    .toBe(true)
})

test('keeps the application menu and status controls separate on narrow viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockTengri(page)
  await page.goto('/')

  const applicationMenu = page.getByRole('menubar', { name: 'Application menu' })
  const desktopStatus = page.getByLabel('Desktop status')
  const tengriMenu = applicationMenu.getByRole('menuitem', { name: 'Tengri menu' })
  await expect(tengriMenu).toBeVisible()
  await expect
    .poll(() =>
      tengriMenu
        .locator('img')
        .evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
    )
    .toBe(true)
  await expect(applicationMenu.getByRole('menuitem', { name: 'Chrome', exact: true })).toBeVisible()
  await expect(applicationMenu.getByRole('menuitem', { name: 'File', exact: true, includeHidden: true })).toBeHidden()
  await expect(applicationMenu.getByRole('menuitem', { name: 'Help', exact: true, includeHidden: true })).toBeHidden()
  await expect(desktopStatus).toBeVisible()

  const menuBounds = await applicationMenu.boundingBox()
  const statusBounds = await desktopStatus.boundingBox()
  expect(menuBounds).not.toBeNull()
  expect(statusBounds).not.toBeNull()
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(statusBounds!.x)
})

test('sends a real agent turn and executes sleep, resume, and confirmed deletion', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')

  const prompt = page.getByLabel('Message your agent')
  await prompt.fill('Inspect the workspace and summarize it.')
  await prompt.press('Enter')
  await expect.poll(() => mock.actions.some((action) => action.action === 'create-thread')).toBe(true)
  await expect
    .poll(() =>
      mock.actions.some(
        (action) => action.action === 'send-turn' && action.text === 'Inspect the workspace and summarize it.',
      ),
    )
    .toBe(true)

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = page.getByRole('region', { name: 'Settings window' })
  await settings.getByRole('button', { name: 'Sleep Agent' }).click()
  await expect.poll(() => mock.actions.some((action) => action.action === 'sleep-agent')).toBe(true)
  const sleeping = page.getByRole('dialog', { name: 'Tengri is sleeping' })
  await expect(sleeping).toBeVisible()
  await sleeping.getByRole('button', { name: 'Resume Agent' }).click()
  await expect(dock).toBeVisible()
  await expect.poll(() => mock.getAgent()?.phase).toBe('ready')

  await dock.getByRole('button', { name: 'Open Terminal' }).click()
  await expect(
    page
      .getByRole('region', { name: 'Terminal window' })
      .getByRole('status')
      .filter({ hasText: /^Connected$/ }),
  ).toHaveAttribute('data-connection-state', 'connected')
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  await settings.getByRole('button', { name: 'Delete Agent' }).click()
  const deleteDialog = page.getByRole('alertdialog', { name: /Delete “Tengri”/ })
  await expect(deleteDialog).toContainText('persistent workspace')
  await page.keyboard.press('Meta+Space')
  await expect(page.getByRole('dialog', { name: 'Spotlight' })).toHaveCount(0)
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: 'Delete Agent' }).click()
  const create = page.getByRole('dialog', { name: 'Create your agent' })
  await expect(create).toBeVisible()
  expect(
    await page.evaluate(
      (agentId) =>
        Object.keys(sessionStorage).filter(
          (key) =>
            key === `tengri:desktop:${agentId}` ||
            key.startsWith(`tengri:windows:${agentId}:`) ||
            key.startsWith(`tengri:terminal:${agentId}:`) ||
            key === `tengri:terminal-cleanup:${agentId}`,
        ),
      readyAgent.id,
    ),
  ).toEqual([])

  await create.getByLabel('Agent name').fill('Replacement')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(page.getByRole('navigation', { name: 'Dock' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Terminal window' })).toHaveCount(0)
})

test('renders one chat bubble per item lifecycle and preserves repeated prompts', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')
  const text = 'Inspect the workspace again.'
  const log = page.getByRole('log')

  for (const index of [0, 1]) {
    const prompt = page.getByLabel('Message your agent')
    await prompt.fill(text)
    await prompt.press('Enter')
    await expect.poll(() => mock.actions.filter((action) => action.action === 'send-turn').length).toBe(index + 1)
    await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
    const item = {
      kind: 'user-message',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: `user-${index}`,
      text,
      approvalId: '',
      rawJson: '{}',
    }
    await emitCodexEvent(page, { ...item, sequence: index * 3 + 1, method: 'item/started' })
    await expect(log.getByText(text, { exact: true })).toHaveCount(index + 1)
    await emitCodexEvent(page, { ...item, sequence: index * 3 + 2, method: 'item/completed' })
    await emitCodexEvent(page, {
      ...item,
      sequence: index * 3 + 3,
      method: 'turn/completed',
      kind: 'thread-state',
      itemId: '',
      text: '',
    })
    await expect(page.getByLabel('Message your agent')).toBeVisible()
    await expect(log.getByText(text, { exact: true })).toHaveCount(index + 1)
  }
})

test('keeps the Dock clear of new and maximized window controls', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  const dock = page.getByRole('navigation', { name: 'Dock' })
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  const dockBounds = await dock.boundingBox()
  expect(dockBounds).not.toBeNull()
  for (const region of await page.getByRole('region', { name: /window$/ }).all()) {
    const bounds = await region.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.y + bounds!.height).toBeLessThan(dockBounds!.y)
  }
  await chrome.getByRole('button', { name: 'Maximize Chrome' }).click()
  await expect
    .poll(async () => {
      const bounds = await chrome.boundingBox()
      return bounds ? bounds.y + bounds.height : Number.POSITIVE_INFINITY
    })
    .toBeLessThan(dockBounds!.y)
  await expect(page.getByRole('button', { name: 'Restore Chrome' })).toBeVisible()
})

test('refits persisted windows above the Dock after reload and browser resize', async ({ page }) => {
  await mockTengri(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  const chrome = page.locator('section[aria-label="Chrome window"]')
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  const desktopId = await page.evaluate((agentId) => sessionStorage.getItem(`tengri:desktop:${agentId}`), readyAgent.id)
  expect(desktopId).toMatch(/^[0-9a-f]{32}$/)

  const oldBounds = { x: 300, y: 149, width: 1060, height: 700 }
  await page.evaluate(
    ({ agentId, desktopId, oldBounds }) => {
      if (!desktopId) throw new Error('desktop identity was not persisted')
      const key = `tengri:windows:${agentId}:${desktopId}`
      const state = JSON.parse(sessionStorage.getItem(key) ?? 'null') as {
        windows?: Array<{ app?: string; bounds?: object; restoredBounds?: object; mode?: string }>
      }
      const chrome = state.windows?.find((window) => window.app === 'chrome')
      if (!chrome) throw new Error('persisted Chrome window was not found')
      chrome.bounds = oldBounds
      chrome.restoredBounds = oldBounds
      chrome.mode = 'normal'
      sessionStorage.setItem(key, JSON.stringify(state))
    },
    { agentId: readyAgent.id, desktopId, oldBounds },
  )

  await page.reload()
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  await expect(chrome).toBeVisible()

  const expectChromeAboveDock = async () => {
    const [chromeBounds, dockBounds] = await Promise.all([chrome.boundingBox(), dock.boundingBox()])
    return chromeBounds && dockBounds ? chromeBounds.y + chromeBounds.height - dockBounds.y : Number.POSITIVE_INFINITY
  }
  await expect.poll(expectChromeAboveDock).toBeLessThanOrEqual(0)

  await page.setViewportSize({ width: 1440, height: 774 })
  await expect.poll(expectChromeAboveDock).toBeLessThanOrEqual(0)

  await chrome.getByRole('button', { name: 'Minimize Chrome' }).click()
  await expect(chrome).toHaveAttribute('aria-hidden', 'true')
  await dock.getByRole('button', { name: 'Open Chrome' }).click()
  await expect(chrome).not.toHaveAttribute('aria-hidden', 'true')
  await expect.poll(expectChromeAboveDock).toBeLessThanOrEqual(0)

  await chrome.getByRole('button', { name: 'Maximize Chrome' }).click()
  await expect(chrome.getByRole('button', { name: 'Restore Chrome' })).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.setViewportSize({ width: 1440, height: 774 })
  await chrome.getByRole('button', { name: 'Restore Chrome' }).click()
  await expect(chrome.getByRole('button', { name: 'Maximize Chrome' })).toBeVisible()
  await expect.poll(expectChromeAboveDock).toBeLessThanOrEqual(0)
})

test('propagates deletion cleanup to every open desktop tab', async ({ page }) => {
  const terminalStore: TerminalStore = { sessions: [] }
  await mockTengri(page, { terminalStore })
  await page.goto('/')

  const duplicate = await page.context().newPage()
  await mockTengri(duplicate, { terminalStore })
  await duplicate.goto('/')
  await duplicate.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Terminal' }).click()
  await expect(
    duplicate
      .getByRole('region', { name: 'Terminal window' })
      .getByRole('status')
      .filter({ hasText: /^Connected$/ }),
  ).toHaveAttribute('data-connection-state', 'connected')
  expect(
    await duplicate.evaluate(
      (agentId) =>
        Object.keys(sessionStorage).some(
          (key) => key.startsWith(`tengri:windows:${agentId}:`) || key.startsWith(`tengri:terminal:${agentId}:`),
        ),
      readyAgent.id,
    ),
  ).toBe(true)

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = page.getByRole('region', { name: 'Settings window' })
  await settings.getByRole('button', { name: 'Delete Agent' }).click()
  await page
    .getByRole('alertdialog', { name: /Delete “Tengri”/ })
    .getByRole('button', { name: 'Delete Agent' })
    .click()

  await expect(page.getByRole('dialog', { name: 'Create your agent' })).toBeVisible()
  await expect(duplicate.getByRole('heading', { name: 'Deleting Tengri' })).toBeVisible()
  await expect
    .poll(() =>
      duplicate.evaluate(
        (agentId) =>
          Object.keys(sessionStorage).filter(
            (key) =>
              key === `tengri:desktop:${agentId}` ||
              key.startsWith(`tengri:windows:${agentId}:`) ||
              key.startsWith(`tengri:terminal:${agentId}:`) ||
              key === `tengri:terminal-cleanup:${agentId}`,
          ),
        readyAgent.id,
      ),
    )
    .toEqual([])
  await duplicate.close()
})

test('retries cross-tab deletion refreshes after a transient failure', async ({ page }) => {
  const failedAgent = {
    ...readyAgent,
    phase: 'failed',
    message: 'Guest startup failed.',
  }
  await mockTengri(page, { agent: failedAgent })
  await page.goto('/')

  const duplicate = await page.context().newPage()
  const duplicateMock = await mockTengri(duplicate, { agent: failedAgent })
  await duplicate.goto('/')
  await expect(duplicate.getByRole('heading', { name: 'Agent could not start' })).toBeVisible()

  const snapshotRequestsBeforeDeletion = duplicateMock.getSnapshotRequestCount()
  duplicateMock.setAgent(null)
  duplicateMock.failNextSnapshots(1)
  await page.getByRole('button', { name: 'Delete Failed Agent' }).click()
  await page
    .getByRole('alertdialog', { name: /Delete “Tengri”/ })
    .getByRole('button', { name: 'Delete Agent' })
    .click()

  await expect(page.getByRole('dialog', { name: 'Create your agent' })).toBeVisible()
  await expect
    .poll(() => duplicateMock.getSnapshotRequestCount())
    .toBeGreaterThanOrEqual(snapshotRequestsBeforeDeletion + 2)
  await expect(duplicate.getByRole('dialog', { name: 'Create your agent' })).toBeVisible({ timeout: 6_000 })
  await duplicate.close()
})

test('blocks lifecycle changes while Settings has a guest request in flight', async ({ page }) => {
  const mock = await mockTengri(page, { holdCodexAccount: true })
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = page.getByRole('region', { name: 'Settings window' })
  const lifecycleButtons = settings.getByRole('button').filter({ hasText: /Sleep Agent|Sign Out|Delete Agent/ })
  await expect.poll(() => mock.actions.filter((action) => action.action === 'codex-account').length).toBeGreaterThan(1)
  await expect(lifecycleButtons).toHaveCount(3)
  for (const button of await lifecycleButtons.all()) await expect(button).toBeDisabled()
  expect(mock.actions.some((action) => action.action === 'sleep-agent')).toBe(false)

  mock.releaseHeldCodexAccount()
  await expect(settings.getByRole('button', { name: 'Sleep Agent' })).toBeEnabled()
  await settings.getByRole('button', { name: 'Sleep Agent' }).click()
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
})

test('blocks lifecycle changes while Chrome has a device-login refresh in flight', async ({ page }) => {
  const mock = await mockTengri(page, { codexAuthenticated: false, holdCodexAccountAfterLogin: true })
  await page.goto('/')

  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await chrome.getByRole('button', { name: 'Start device login' }).click()
  await chrome.getByRole('button', { name: 'I’ve completed login' }).click()
  await mock.waitForHeldCodexAccount()

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = page.getByRole('region', { name: 'Settings window' })
  await expect.poll(() => mock.actions.filter((action) => action.action === 'codex-account').length).toBeGreaterThan(2)
  for (const button of await settings
    .getByRole('button')
    .filter({ hasText: /Sleep Agent|Sign Out|Delete Agent/ })
    .all()) {
    await expect(button).toBeDisabled()
  }

  mock.releaseHeldCodexAccount()
  await expect(settings.getByRole('button', { name: 'Sleep Agent' })).toBeEnabled()
  await settings.getByRole('button', { name: 'Sleep Agent' }).click()
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
})

test('restores an active Codex device login without replacing its code', async ({ page }) => {
  const mock = await mockTengri(page, {
    activeCodexLogin: true,
    codexAuthenticated: false,
  })
  await page.goto('/')

  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await expect(chrome.getByText('TENG-RI99')).toBeVisible()
  expect(mock.actions.filter((action) => action.action === 'codex-login-status')).toHaveLength(1)
  expect(mock.actions.some((action) => action.action === 'codex-login')).toBe(false)
})

test('restores an active Codex device login after retrying a failed account check', async ({ page }) => {
  const mock = await mockTengri(page, {
    activeCodexLogin: true,
    codexAuthenticated: false,
    failCodexAccountUntilReleased: true,
  })
  await page.goto('/')

  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await expect(chrome.getByRole('button', { name: 'Retry' })).toBeVisible()
  mock.releaseCodexAccountFailures()
  await chrome.getByRole('button', { name: 'Retry' }).click()
  await expect(chrome.getByText('TENG-RI99')).toBeVisible()
  expect(mock.actions.filter((action) => action.action === 'codex-login-status')).toHaveLength(1)
  expect(mock.actions.some((action) => action.action === 'codex-login')).toBe(false)
})

test('does not refresh the guest account after sleep starts', async ({ page }) => {
  const mock = await mockTengri(page, { holdLifecycleAction: 'sleep-agent' })
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = page.getByRole('region', { name: 'Settings window' })
  await expect(settings.getByRole('button', { name: 'Sleep Agent' })).toBeEnabled()
  await settings.getByRole('button', { name: 'Sleep Agent' }).click()
  await mock.waitForHeldLifecycleAction()
  const accountRequestCount = mock.actions.filter((action) => action.action === 'codex-account').length

  await dock.getByRole('button', { name: 'Open Finder' }).click()
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  await page.waitForTimeout(100)
  expect(mock.actions.filter((action) => action.action === 'codex-account')).toHaveLength(accountRequestCount)

  mock.releaseHeldLifecycleAction()
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
})

test('keeps a committed delete transition gated when snapshot refresh fails', async ({ page }) => {
  await mockTengri(page, { failSnapshotAfterAction: 'delete-agent' })
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  await page.getByRole('region', { name: 'Settings window' }).getByRole('button', { name: 'Delete Agent' }).click()
  await page
    .getByRole('alertdialog', { name: /Delete “Tengri”/ })
    .getByRole('button', { name: 'Delete Agent' })
    .click()

  await expect(page.getByRole('heading', { name: 'Deleting Tengri' })).toBeVisible()
  await expect(page.getByText('Waiting for controller state')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Dock' })).toHaveCount(0)
})

test('keeps a missing conversation until the user chooses to start a new one in the same workspace', async ({
  page,
}) => {
  const failure = { status: 404, error: 'Codex conversation could not be found', code: 'conversation_not_found' }
  const mock = await mockTengri(page, { resumeThreadErrors: [failure, failure] })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-missing'))
  await page.goto('/')

  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const prompt = chrome.getByRole('textbox', { name: 'Message your agent' })
  await expect(chrome.getByRole('alert')).toHaveText('Codex conversation could not be found')
  await expect(
    chrome.getByText(
      'This saved conversation is no longer available. Start a new conversation to continue in this workspace.',
    ),
  ).toBeVisible()
  await expect(prompt).toBeDisabled()
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-missing')

  await chrome.getByRole('button', { name: 'Retry conversation recovery' }).click()
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBe(2)
  await expect(chrome.getByRole('button', { name: 'Start a new conversation', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-missing')
  expect(mock.actions.some((action) => action.action === 'create-thread')).toBe(false)

  await chrome.getByRole('button', { name: 'Start a new conversation', exact: true }).click()
  await expect(prompt).toBeEnabled()
  await expect(prompt).toBeFocused()
  await expect(chrome.getByRole('alert')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBeNull()
  await prompt.fill('Continue in this workspace.')
  await prompt.press('Enter')
  await expect
    .poll(() => mock.actions.some((action) => action.action === 'send-turn' && action.threadId === 'thread-1'))
    .toBe(true)
  expect(mock.actions.filter((action) => action.action === 'create-thread')).toHaveLength(1)
  expect(
    mock.actions.filter((action) =>
      ['create-agent', 'delete-agent', 'sleep-agent', 'resume-agent'].includes(String(action.action)),
    ),
  ).toHaveLength(0)
})

test('retries a temporary conversation failure without replacing the saved thread', async ({ page }) => {
  const mock = await mockTengri(page, {
    resumeThreadErrors: [{ status: 503, error: 'Tengri control plane is unavailable' }],
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-recoverable'))
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await expect(chrome.getByRole('alert')).toHaveText('Tengri control plane is unavailable')
  await expect(chrome.getByRole('button', { name: 'Start a new conversation', exact: true })).toHaveCount(0)
  await chrome.getByRole('button', { name: 'Retry conversation recovery' }).click()
  await expect(chrome.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await expect(chrome.getByRole('alert')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-recoverable')
  expect(mock.actions.filter((action) => action.action === 'create-thread')).toHaveLength(0)
})

test('uses one composer control for sending, steering, and stopping a response', async ({ page }, testInfo) => {
  const mock = await mockTengri(page)
  await page.goto('/')
  const composer = page.getByRole('form', { name: 'Message composer' })
  const prompt = composer.getByRole('textbox')
  const action = composer.getByRole('button')
  await expect(action).toHaveCount(1)
  await expect(action).toHaveAccessibleName('Send message')
  await expect(action).toBeDisabled()
  await prompt.fill('Inspect the workspace.')
  await action.click()
  await expect(action).toHaveAccessibleName('Stop response')
  await expect(action).toBeEnabled()
  await expect(action).toHaveCount(1)
  await prompt.press('Enter')
  expect(mock.actions.some((item) => item.action === 'interrupt-turn')).toBe(false)
  const screenshotPath = testInfo.outputPath('composer-stop.png')
  await composer.screenshot({ path: screenshotPath })
  await testInfo.attach('composer-stop', { path: screenshotPath, contentType: 'image/png' })

  await prompt.fill('Only inspect the current directory.')
  await expect(action).toHaveAccessibleName('Steer turn')
  await action.click()
  await expect
    .poll(() => mock.actions.some((item) => item.action === 'steer-turn' && item.turnId === 'turn-1'))
    .toBe(true)
  await expect(action).toHaveAccessibleName('Stop response')
  await action.click()
  await expect
    .poll(() => mock.actions.some((item) => item.action === 'interrupt-turn' && item.turnId === 'turn-1'))
    .toBe(true)
  await emitCodexEvent(page, {
    sequence: 1,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: '',
    kind: 'thread-state',
    method: 'turn/completed',
    text: '',
    approvalId: '',
    rawJson: '{}',
  })
  await expect(action).toHaveAccessibleName('Send message')
  await expect(action).toHaveCount(1)
  await expect(action).toBeDisabled()
})

test('shows a text highlight while thinking and keeps reduced-motion status readable', async ({ page }, testInfo) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const thinking = chrome.getByRole('status', { name: 'Agent activity' })
  await expect(thinking).toHaveCount(0)
  await chrome.getByRole('textbox', { name: 'Message your agent' }).fill('Inspect the workspace.')
  await chrome.getByRole('button', { name: 'Send message' }).click()
  await expect(thinking).toHaveText('Thinking')
  await expect(thinking.locator('svg')).toHaveCount(0)
  await expect(chrome.getByText('Codex is working…', { exact: true })).toHaveCount(0)
  const label = thinking.getByText('Thinking', { exact: true })
  const sweep = await label.evaluate((element) => {
    const style = getComputedStyle(element)
    const frames = element
      .getAnimations()
      .flatMap((animation) => (animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : []))
    return {
      backgroundSize: Number.parseFloat(style.backgroundSize),
      positions: frames.map((frame) => Number.parseFloat(String(frame.backgroundPositionX))),
    }
  })
  await expect(label).toHaveCSS('animation-duration', '1s')
  expect(sweep.backgroundSize).toBeGreaterThan(100)
  expect(sweep.positions).toHaveLength(2)
  expect(sweep.positions[0]).toBeGreaterThan(sweep.positions[1])
  for (const [name, progress] of [
    ['left', 0.3],
    ['right', 0.7],
  ] as const) {
    await label.evaluate((element, fraction) => {
      const animation = element.getAnimations()[0]
      if (!animation?.effect) throw new Error('Thinking animation is missing')
      animation.pause()
      animation.currentTime = Number(animation.effect.getComputedTiming().duration) * fraction
    }, progress)
    const path = testInfo.outputPath(`thinking-highlight-${name}.png`)
    await thinking.screenshot({ path })
    await testInfo.attach(`thinking-highlight-${name}`, { path, contentType: 'image/png' })
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(label).toHaveCSS('animation-name', 'none')
  await expect(label).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)')
  await expect(thinking).toHaveText('Thinking')
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'active' })
  await expect(label).toHaveCSS('animation-name', 'none')
  await expect(label).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)')
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
  await emitCodexEvent(page, {
    sequence: 1,
    kind: 'approval',
    method: 'item/commandExecution/requestApproval',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'approval-thinking',
    approvalId: 'approval-thinking',
    text: 'Run the workspace checks?',
    rawJson: '{"params":{"availableDecisions":["accept","decline"]}}',
  })
  await expect(chrome.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  await expect(thinking).toHaveCount(0)
  await chrome.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(thinking).toBeVisible()
  await emitCodexEvent(page, {
    sequence: 2,
    kind: 'thread-state',
    method: 'turn/completed',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: '',
    approvalId: '',
    text: '',
    rawJson: '{"params":{"turn":{"id":"turn-1","status":"completed"}}}',
  })
  await expect(thinking).toHaveCount(0)
  await expect(chrome.getByRole('button', { name: 'Send message' })).toBeDisabled()
})

test('steers a recovered in-progress turn when sending during thread resume', async ({ page }) => {
  const mock = await mockTengri(page, {
    resumeThreadDelayMs: 400,
    resumeThreadRawJson: JSON.stringify({
      thread: { turns: [{ id: 'turn-active', status: 'inProgress', items: [] }] },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-active'))
  await page.goto('/')

  const prompt = page.getByRole('textbox', { name: /Message your agent|Steer the current turn/ })
  await prompt.fill('Continue with the current turn.')
  await prompt.press('Enter')

  await expect
    .poll(() =>
      mock.actions.some(
        (action) =>
          action.action === 'steer-turn' &&
          action.threadId === 'thread-active' &&
          action.turnId === 'turn-active' &&
          action.text === 'Continue with the current turn.',
      ),
    )
    .toBe(true)
  expect(mock.actions.some((action) => action.action === 'send-turn')).toBe(false)
})

test('does not duplicate snapshot-covered Codex messages when event replay races thread resume', async ({ page }) => {
  const promptText = 'Create the live proof file.'
  const progressText = 'Creating the file now.'
  const finalText = '/workspace/tengri-codex-live-proof.txt'
  const mock = await mockTengri(page, {
    resumeThreadDelayMs: 1_000,
    resumeThreadEventSequence: 53,
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-complete',
            status: 'completed',
            items: [
              { id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: promptText }] },
              { id: 'item-2', type: 'agentMessage', text: progressText },
              { id: 'item-3', type: 'agentMessage', text: finalText },
            ],
          },
        ],
      },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-complete'))
  await page.goto('/')
  await expect.poll(() => mock.actions.filter((action) => action.action === 'resume-thread').length).toBe(1)

  for (const replayedEvent of [
    {
      sequence: 9,
      kind: 'user-message',
      method: 'item/completed',
      itemId: 'msg-user-live',
      text: promptText,
    },
    {
      sequence: 13,
      kind: 'assistant-text',
      method: 'item/completed',
      itemId: 'msg-agent-live',
      text: progressText,
    },
    {
      sequence: 42,
      kind: 'assistant-text',
      method: 'item/completed',
      itemId: 'msg-agent-final-live',
      text: finalText,
    },
    {
      sequence: 41,
      kind: 'usage',
      method: 'thread/tokenUsage/updated',
      itemId: '',
      text: 'Tokens: 10 input · 4 output',
    },
    {
      sequence: 42,
      kind: 'usage',
      method: 'account/rateLimits/updated',
      itemId: '',
      text: 'Weekly 90% left · Credits: 62,307',
    },
    {
      sequence: 43,
      kind: 'usage',
      method: 'thread/tokenUsage/updated',
      itemId: '',
      text: 'Tokens: 20 input · 6 output',
    },
    {
      sequence: 44,
      kind: 'usage',
      method: 'account/rateLimits/updated',
      itemId: '',
      text: 'Weekly 88% left · Credits: 62,307',
    },
    {
      sequence: 45,
      kind: 'warning',
      method: 'tengri/eventOmitted',
      itemId: '',
      text: 'One oversized Codex event was omitted',
    },
    {
      sequence: 46,
      kind: 'error',
      method: 'turn/completed',
      itemId: '',
      text: 'The turn failed',
    },
  ]) {
    await emitCodexEvent(page, {
      ...replayedEvent,
      threadId: 'thread-complete',
      turnId: 'turn-complete',
      approvalId: '',
      rawJson: '{}',
    })
  }

  await expect(page.getByText(promptText, { exact: true })).toHaveCount(1)
  await expect(page.getByText(progressText, { exact: true })).toHaveCount(1)
  await expect(page.getByText(finalText, { exact: true })).toHaveCount(1)
  await expect(page.getByText('Tokens: 10 input · 4 output', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Weekly 90% left · Credits: 62,307', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Tokens: 20 input · 6 output', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Weekly 88% left · Credits: 62,307', { exact: true })).toHaveCount(1)
  await expect(page.getByText('One oversized Codex event was omitted', { exact: true })).toHaveCount(1)
  await expect(page.getByText('The turn failed', { exact: true })).toHaveCount(1)
})

test('keeps capped history items from returning through delayed replay', async ({ page }) => {
  const items = Array.from({ length: 501 }, (_, index) => ({
    id: `answer-${index}`,
    type: 'agentMessage',
    text: `Restored answer ${index}`,
  }))
  const mock = await mockTengri(page, {
    resumeThreadDelayMs: 500,
    resumeThreadEventSequence: 10,
    resumeThreadItemEventSequences: Object.fromEntries(items.map((item) => [item.id, 30])),
    resumeThreadRawJson: JSON.stringify({
      thread: { turns: [{ id: 'turn-capped', status: 'completed', items }] },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-capped'))
  await page.goto('/')
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  const staleDelta = {
    sequence: 20,
    itemId: 'answer-0',
    text: 'Stale omitted fragment',
    kind: 'assistant-text',
    method: 'item/agentMessage/delta',
    threadId: 'thread-capped',
    turnId: 'turn-capped',
    approvalId: '',
    rawJson: '{}',
  }
  await emitCodexEvent(page, staleDelta)
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBe(1)
  await expect(page.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await expect(page.getByRole('article', { name: 'Codex response' })).toHaveCount(500)
  await expect(page.getByText('Stale omitted fragment', { exact: true })).toHaveCount(0)
  await emitCodexEvent(page, { ...staleDelta, sequence: 25, method: 'item/completed' })
  await emitCodexEvent(page, { ...staleDelta, sequence: 31, itemId: 'new-answer', text: 'Fresh answer after restore' })
  await expect(page.getByText('Fresh answer after restore', { exact: true })).toBeVisible()
  await expect(page.getByText('Stale omitted fragment', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Restored answer 500', { exact: true })).toBeVisible()
})

test('reconciles paginated item snapshots while keeping the transcript compact and approvals usable', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  const mock = await mockTengri(page, {
    resumeThreadDelayMs: 500,
    resumeThreadEventSequence: 10,
    resumeThreadItemEventSequences: { 'answer-one': 20, 'answer-two': 30 },
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-one',
            status: 'inProgress',
            items: [
              {
                id: 'user-one',
                type: 'userMessage',
                content: [{ type: 'text', text: 'Inspect the desktop and verify the fixes locally.' }],
              },
              { id: 'answer-one', type: 'agentMessage', text: 'The terminal background is continuous.' },
              {
                id: 'output-one',
                type: 'commandExecution',
                status: 'completed',
                exitCode: 0,
                aggregatedOutput: '✓ Terminal resize\n✓ Window drag\n✓ Dock alignment',
              },
              { id: 'answer-two', type: 'agentMessage', text: 'The browser checks pass.' },
            ],
          },
        ],
      },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-paged'))
  await page.goto('/')
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  for (const event of [
    { sequence: 18, itemId: 'answer-one', text: 'The terminal background is continuous.' },
    { sequence: 24, itemId: 'answer-one', text: ' Corner handles are easy to grab.' },
    { sequence: 28, itemId: 'answer-two', text: 'The browser checks pass.' },
    { sequence: 31, itemId: 'answer-two', text: ' Tooltips stay above the icons.' },
  ]) {
    await emitCodexEvent(page, {
      ...event,
      kind: 'assistant-text',
      method: 'item/agentMessage/delta',
      threadId: 'thread-paged',
      turnId: 'turn-one',
      approvalId: '',
      rawJson: '{}',
    })
  }
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBe(1)
  await expect(page.getByRole('textbox', { name: 'Steer the current turn' })).toBeEnabled()
  await expect(page.getByRole('article', { name: 'Codex response' }).first().locator('p')).toHaveText(
    'The terminal background is continuous. Corner handles are easy to grab.',
  )
  await expect(page.getByText('The browser checks pass. Tooltips stay above the icons.', { exact: true })).toHaveCount(
    1,
  )
  await emitCodexEvent(page, {
    sequence: 32,
    itemId: 'approval-item',
    kind: 'approval',
    method: 'item/commandExecution/requestApproval',
    threadId: 'thread-paged',
    turnId: 'turn-one',
    approvalId: 'approval-one',
    text: 'Run the production build?',
    rawJson: JSON.stringify({ params: { availableDecisions: ['accept', 'decline'] } }),
  })
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await expect(chrome.getByRole('button', { name: 'Approve once', exact: true })).toBeVisible()
  await expect(chrome.getByRole('button', { name: 'Approve for session', exact: true })).toHaveCount(0)
  await chrome.getByRole('article', { name: 'Codex output' }).locator('summary').click()
  const outputCharacterWidths = await chrome
    .getByRole('article', { name: 'Codex output' })
    .locator('pre')
    .evaluate(async (element) => {
      const context = document.createElement('canvas').getContext('2d')
      if (!context) throw new Error('Canvas is unavailable')
      const style = getComputedStyle(element)
      context.font = `${style.fontSize} ${style.fontFamily}`
      const loadedFonts = await document.fonts.load(context.font, 'iiiWWW✓✓✓')
      return {
        loadedFonts: loadedFonts.length,
        narrow: context.measureText('iii').width,
        wide: context.measureText('WWW').width,
        symbols: context.measureText('✓✓✓').width,
      }
    })
  expect(outputCharacterWidths.loadedFonts).toBeGreaterThan(0)
  expect(outputCharacterWidths.narrow).toBeCloseTo(outputCharacterWidths.wide, 1)
  expect(outputCharacterWidths.symbols).toBeCloseTo(outputCharacterWidths.wide, 1)
  const user = chrome.getByRole('article', { name: 'Your message' })
  const response = chrome.getByRole('article', { name: 'Codex response' }).first()
  const conversation = chrome.getByRole('log', { name: 'Conversation' })
  await expect(conversation.getByText('You', { exact: true })).toHaveCount(0)
  await expect(conversation.getByText('Codex', { exact: true })).toHaveCount(0)
  await expect(user).toHaveCSS('text-align', 'left')
  await expect(response).toHaveCSS('text-align', 'left')
  await expect(user).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(response).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(response).toHaveCSS('border-radius', '0px')
  await expect(response).toHaveCSS('padding-top', '0px')
  await expect(response).toHaveCSS('padding-bottom', '0px')
  const [userBounds, responseBounds, conversationBounds] = await Promise.all([
    user.boundingBox(),
    response.boundingBox(),
    conversation.boundingBox(),
  ])
  if (!userBounds || !responseBounds || !conversationBounds) throw new Error('Transcript rows are missing')
  expect(userBounds.x).toBeGreaterThan(responseBounds.x)
  expect(userBounds.x + userBounds.width).toBeCloseTo(conversationBounds.x + conversationBounds.width, 0)
  expect(responseBounds.x).toBeCloseTo(conversationBounds.x, 0)
  await chrome.getByRole('button', { name: 'Close Chrome' }).hover()
  await expect(chrome).toHaveScreenshot('tengri-compact-chat.png')
  await chrome.getByRole('button', { name: 'Approve once', exact: true }).click()
  await expect
    .poll(() =>
      mock.actions.some(
        (action) =>
          action.action === 'resolve-approval' &&
          action.approvalId === 'approval-one' &&
          action.decision === 'approve-once',
      ),
    )
    .toBe(true)
  await expect(chrome.getByRole('button', { name: 'Approve once', exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(response).toBeVisible()
  await expect(async () => {
    const [narrowUserBounds, narrowResponseBounds, narrowConversationBounds] = await Promise.all([
      user.boundingBox(),
      response.boundingBox(),
      conversation.boundingBox(),
    ])
    if (!narrowUserBounds || !narrowResponseBounds || !narrowConversationBounds) {
      throw new Error('Narrow transcript rows are missing')
    }
    expect(narrowUserBounds.x).toBeGreaterThan(narrowResponseBounds.x)
    expect(narrowUserBounds.x + narrowUserBounds.width).toBeCloseTo(
      narrowConversationBounds.x + narrowConversationBounds.width,
      0,
    )
    expect(narrowResponseBounds.x).toBeCloseTo(narrowConversationBounds.x, 0)
  }).toPass({ timeout: 10_000 })
  await page.mouse.move(0, 0)
  await expect(chrome).toHaveScreenshot('tengri-compact-chat-narrow.png')
})

test('does not resurrect a turn completed while replay recovery is in flight', async ({ page }) => {
  const mock = await mockTengri(page, {
    holdReplayResume: true,
    resumeThreadRawJson: JSON.stringify({
      thread: { turns: [{ id: 'turn-active', status: 'inProgress', items: [] }] },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-active'))
  await page.goto('/')
  await expect(page.getByLabel('Steer the current turn')).toBeVisible()
  const initialResumeResponses = mock.getResumeThreadResponseCount()

  await emitCodexEvent(page, {
    sequence: 10,
    kind: 'warning',
    method: 'tengri/replayWarning',
    threadId: 'thread-active',
    turnId: '',
    itemId: '',
    text: 'Replay window exceeded',
    approvalId: '',
    rawJson: '{}',
  })
  await mock.waitForHeldResume()
  await emitCodexEvent(page, {
    sequence: 11,
    kind: 'thread-state',
    method: 'turn/completed',
    threadId: 'thread-active',
    turnId: 'turn-active',
    itemId: '',
    text: '',
    approvalId: '',
    rawJson: '{}',
  })
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  mock.releaseHeldResume()
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBeGreaterThan(initialResumeResponses)
  await expect(page.getByLabel('Message your agent')).toBeVisible()

  const prompt = page.getByLabel('Message your agent')
  await prompt.fill('Start the next turn.')
  await prompt.press('Enter')
  await expect
    .poll(() => mock.actions.some((action) => action.action === 'send-turn' && action.text === 'Start the next turn.'))
    .toBe(true)
  expect(mock.actions.some((action) => action.action === 'steer-turn')).toBe(false)
})

test('resizes across all visible corners while keeping window controls clickable', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  const frame = page.getByRole('region', { name: 'Chrome window' })
  await expect(frame).toBeVisible()

  for (const inset of [8, -8]) {
    for (const edge of ['nw', 'ne', 'sw', 'se'] as const) {
      const bounds = await frame.boundingBox()
      expect(bounds).not.toBeNull()
      const west = edge.includes('w')
      const north = edge.includes('n')
      await resizeWindow(
        page,
        frame,
        edge,
        { x: west ? 12 : -12, y: north ? 12 : -12 },
        { x: west ? 12 : 0, y: north ? 12 : 0, width: -12, height: -12 },
        {
          x: bounds!.x + (west ? inset : bounds!.width - inset),
          y: bounds!.y + (north ? inset : bounds!.height - inset),
        },
      )
    }
  }

  for (const name of ['Close Chrome', 'Minimize Chrome', 'Maximize Chrome']) {
    const button = frame.getByRole('button', { name, exact: true })
    const bounds = await button.boundingBox()
    expect(bounds).not.toBeNull()
    for (const point of [
      { x: 2, y: 12 },
      { x: 12, y: 2 },
      { x: 22, y: 12 },
      { x: 12, y: 22 },
    ]) {
      await expect
        .poll(() =>
          page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), {
            x: bounds!.x + point.x,
            y: bounds!.y + point.y,
          }),
        )
        .toBe(name)
    }
  }
  await frame.getByRole('button', { name: 'Maximize Chrome', exact: true }).click()
  await frame.getByRole('button', { name: 'Restore Chrome', exact: true }).click()
  await frame.getByRole('button', { name: 'Minimize Chrome', exact: true }).click()
  await expect(frame).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Chrome', exact: true }).click()
  await frame.getByRole('button', { name: 'Close Chrome', exact: true }).click()
  await expect(frame).toHaveCount(0)
})

test('magnifies the Dock without relayout and minimizes with native transform animation', async ({
  page,
}, testInfo) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const dock = page.getByRole('navigation', { name: 'Dock' })
  await expect(dock).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await expect
    .poll(() =>
      dock
        .locator('img')
        .evaluateAll((images) =>
          images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true)
  const client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const metrics = async () =>
    new Map((await client.send('Performance.getMetrics')).metrics.map((entry) => [entry.name, entry.value]))
  const bounds = await dock.boundingBox()
  if (!bounds) throw new Error('Dock is unavailable')
  const before = await metrics()
  await page.mouse.move(bounds.x + 30, bounds.y + 35)
  for (let sweep = 0; sweep < 4; sweep += 1) {
    await page.mouse.move(bounds.x + bounds.width - 30, bounds.y + 35, { steps: 24 })
    await page.mouse.move(bounds.x + 30, bounds.y + 35, { steps: 24 })
  }
  await page.mouse.move(40, 60)
  const after = await metrics()
  const delta = Object.fromEntries(
    ['LayoutCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].map((key) => {
      const start = before.get(key)
      const end = after.get(key)
      if (start === undefined || end === undefined) throw new Error(`Chromium did not report ${key}`)
      return [key, end - start]
    }),
  )
  await testInfo.attach('dock-rendering-4x-cpu', {
    body: JSON.stringify(delta, null, 2),
    contentType: 'application/json',
  })
  expect(delta.LayoutCount).toBeLessThan(10)

  const chrome = page.getByRole('region', { name: 'Chrome window', includeHidden: true })
  const wrapper = chrome.locator('..')
  const normalBounds = await chrome.boundingBox()
  const nativeTransforms = await wrapper.evaluateHandle((element) => {
    const transforms: ComputedKeyframe[][] = []
    const animate = element.animate.bind(element)
    element.animate = (...args: Parameters<Element['animate']>) => {
      const animation = animate(...args)
      if (animation.effect instanceof KeyframeEffect) {
        const frames = animation.effect.getKeyframes().filter((frame) => 'transform' in frame)
        if (frames.length > 0) transforms.push(frames)
      }
      return animation
    }
    return transforms
  })
  await chrome.getByRole('button', { name: 'Minimize Chrome', exact: true }).click()
  await expect(wrapper).toHaveCSS('visibility', 'hidden')
  const nativeTransform = await nativeTransforms.evaluate((transforms) => transforms.flat())
  expect(nativeTransform.length).toBeGreaterThanOrEqual(2)
  expect(nativeTransform[0]?.transform).toBe('translate(0px, 0px) scale(1)')
  expect(nativeTransform.at(-1)?.transform).toMatch(/scale\(0\./)
  await dock.getByRole('button', { name: 'Open Chrome' }).click()
  await expect(wrapper).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
  await expect.poll(() => chrome.boundingBox()).toEqual(normalBounds)
  await expect(chrome.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await nativeTransforms.dispose()
  await client.detach()
})

test('tracks the pointer during dragging without repeated desktop layout reads or release snapback', async ({
  page,
}) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const frame = page.getByRole('region', { name: 'Chrome window' })
  await expect(frame).toBeVisible()
  const before = await frame.boundingBox()
  const header = await frame.locator(':scope > header').boundingBox()
  if (!before || !header) throw new Error('Chrome window is missing')
  const start = { x: header.x + header.width / 2, y: header.y + header.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()

  const layoutReads = frame.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        const stage = element.parentElement?.parentElement
        if (!stage) throw new Error('Desktop stage is missing')
        const getBounds = stage.getBoundingClientRect.bind(stage)
        let reads = 0
        stage.getBoundingClientRect = () => {
          reads += 1
          return getBounds()
        }
        document.addEventListener(
          'pointerup',
          () => {
            stage.getBoundingClientRect = getBounds
            resolve(reads)
          },
          { once: true, capture: true },
        )
      }),
  )
  for (const delta of [12, 24, 36, 48, 60]) {
    await page.mouse.move(start.x + delta, start.y - delta / 4, { steps: 3 })
    await expect.poll(async () => (await frame.boundingBox())?.x).toBeCloseTo(before.x + delta, 0)
    await expect.poll(async () => (await frame.boundingBox())?.y).toBeCloseTo(before.y - delta / 4, 0)
  }
  await page.mouse.up()
  expect(await layoutReads).toBe(0)
  await expect.poll(async () => (await frame.boundingBox())?.x).toBeCloseTo(before.x + 60, 0)
  await expect.poll(async () => (await frame.boundingBox())?.y).toBeCloseTo(before.y - 15, 0)
  await frame.getByRole('button', { name: 'Minimize Chrome', exact: true }).click()
  await expect(frame).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Chrome', exact: true }).click()
  await expect.poll(async () => (await frame.boundingBox())?.x).toBeCloseTo(before.x + 60, 0)
  await expect.poll(async () => (await frame.boundingBox())?.y).toBeCloseTo(before.y - 15, 0)
})

test('keeps window dimensions within the desktop when the browser shrinks during a resize', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  const frame = page.getByRole('region', { name: 'Chrome window' })
  const handle = frame.locator('..').locator('.cursor-e-resize')
  const bounds = await handle.boundingBox()
  if (!bounds) throw new Error('Chrome resize handle is missing')
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + 24, bounds.y + bounds.height / 2)
  await page.setViewportSize({ width: 860, height: 650 })
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeLessThanOrEqual(848)
  await page.mouse.up()
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeLessThanOrEqual(848)
  await expect.poll(async () => (await frame.boundingBox())?.height).toBeLessThanOrEqual(512)
})

test('supports desktop window shortcuts, independent windows, drag, and eight-edge resize behavior', async ({
  page,
}) => {
  await mockTengri(page)
  await page.goto('/')

  const chromeWindows = page.getByRole('region', { name: 'Chrome window' })
  const chromeFrames = page.locator('section[aria-label="Chrome window"]')
  await expect(chromeWindows).toHaveCount(1)
  await chromeWindows.getByRole('textbox', { name: 'Address' }).focus()
  await page.keyboard.press('Meta+n')
  await expect(chromeWindows).toHaveCount(2)
  await chromeWindows.last().getByRole('button', { name: 'New tab' }).click()
  const secondWindowTabs = chromeWindows.last().getByRole('tab')
  await secondWindowTabs.last().focus()
  await page.keyboard.press('ArrowLeft')
  await expect(secondWindowTabs.first()).toBeFocused()
  await page.keyboard.press('Delete')
  await expect(secondWindowTabs).toHaveCount(1)
  await expect(secondWindowTabs.first()).toBeFocused()
  await expect(chromeWindows.first().getByRole('tab')).toHaveCount(1)
  await chromeWindows.last().getByRole('textbox', { name: 'Address' }).focus()
  await page.keyboard.press('Meta+o')
  await expect(page.getByRole('dialog', { name: 'Spotlight' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Spotlight' })).toHaveCount(0)

  const frontmost = chromeWindows.last()
  const beforeDrag = await frontmost.boundingBox()
  expect(beforeDrag).not.toBeNull()
  const header = frontmost.locator(':scope > header')
  const headerBounds = await header.boundingBox()
  expect(headerBounds).not.toBeNull()
  await page.mouse.move(headerBounds!.x + headerBounds!.width / 2, headerBounds!.y + headerBounds!.height / 2)
  await page.mouse.down()
  await page.mouse.move(headerBounds!.x + headerBounds!.width / 2 + 72, headerBounds!.y + headerBounds!.height / 2 - 44)
  await page.mouse.up()
  await expect.poll(async () => (await frontmost.boundingBox())?.x).toBeGreaterThan(beforeDrag!.x + 50)

  const frameBounds = await frontmost.boundingBox()
  const eastHandleBounds = await frontmost.locator('..').locator('.cursor-e-resize').boundingBox()
  expect(frameBounds).not.toBeNull()
  expect(eastHandleBounds).not.toBeNull()
  const frameRight = frameBounds!.x + frameBounds!.width
  expect(eastHandleBounds!.x).toBeGreaterThanOrEqual(frameRight - 2)
  expect(eastHandleBounds!.x + eastHandleBounds!.width).toBeGreaterThan(frameRight)

  const resizeCases = [
    ['n', { x: 0, y: 20 }, { x: 0, y: 20, width: 0, height: -20 }],
    ['s', { x: 0, y: -20 }, { x: 0, y: 0, width: 0, height: -20 }],
    ['e', { x: -20, y: 0 }, { x: 0, y: 0, width: -20, height: 0 }],
    ['w', { x: 20, y: 0 }, { x: 20, y: 0, width: -20, height: 0 }],
    ['ne', { x: -20, y: 20 }, { x: 0, y: 20, width: -20, height: -20 }],
    ['nw', { x: 20, y: 20 }, { x: 20, y: 20, width: -20, height: -20 }],
    ['se', { x: -20, y: -20 }, { x: 0, y: 0, width: -20, height: -20 }],
    ['sw', { x: 20, y: -20 }, { x: 20, y: 0, width: -20, height: -20 }],
  ] as const
  for (const [edge, delta, expected] of resizeCases) {
    await resizeWindow(page, frontmost, edge, delta, expected)
  }

  await frontmost.getByRole('button', { name: 'Minimize Chrome', exact: true }).focus()
  await page.keyboard.press('Meta+Backquote')
  await expect
    .poll(async () => {
      const firstZ = Number(
        await chromeWindows
          .first()
          .locator('..')
          .evaluate((element) => getComputedStyle(element).zIndex),
      )
      const lastZ = Number(
        await chromeWindows
          .last()
          .locator('..')
          .evaluate((element) => getComputedStyle(element).zIndex),
      )
      return firstZ > lastZ
    })
    .toBe(true)
  await expect(page.locator('[data-tengri-modal="true"][aria-modal="true"]')).toHaveCount(0)
  await page.keyboard.press('Meta+m')
  const minimizedChrome = page.locator('section[aria-label="Chrome window"][aria-hidden="true"]')
  await expect(minimizedChrome).toHaveCount(1)
  await expect(minimizedChrome).toHaveCSS('pointer-events', 'none')
  await page.keyboard.press('Meta+w')
  await expect(chromeFrames).toHaveCount(1)
})

test('renders truthful booting, sleeping, and failed lifecycle states', async ({ page }) => {
  await mockTengri(page, { agent: { ...readyAgent, phase: 'sleeping' } })
  await page.goto('/')
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()

  await page.unrouteAll({ behavior: 'wait' })
  await mockTengri(page, { agent: { ...readyAgent, phase: 'booting' } })
  await page.reload()
  await expect(page.getByRole('status', { name: 'Booting your microVM' })).toBeVisible()

  await page.unrouteAll({ behavior: 'wait' })
  const mock = await mockTengri(page, {
    agent: { ...readyAgent, phase: 'failed', message: 'Guest readiness probe failed without fabricated progress.' },
  })
  await page.reload()
  const staleDesktopId = '0123456789abcdef0123456789abcdef'
  await page.evaluate(
    ({ agentId, desktopId }) => {
      sessionStorage.setItem(`tengri:desktop:${agentId}`, desktopId)
      sessionStorage.setItem(`tengri:windows:${agentId}:${desktopId}`, '{"windows":[]}')
      sessionStorage.setItem(`tengri:terminal:${agentId}:${desktopId}:terminal-4`, '{"sessionId":"stale"}')
      sessionStorage.setItem(`tengri:terminal-cleanup:${agentId}`, '[]')
      localStorage.setItem(`tengri-thread:${agentId}`, 'stale-thread')
      localStorage.setItem(`tengri:spotlight:${agentId}:recents`, '["app:chrome"]')
      localStorage.setItem('tengri-thread:other-agent', 'other-thread')
      localStorage.setItem('tengri:spotlight:other-agent:recents', '["app:finder"]')
    },
    { agentId: readyAgent.id, desktopId: staleDesktopId },
  )
  const failed = page.getByRole('dialog', { name: 'Agent could not start' })
  await expect(failed).toContainText('Guest readiness probe failed without fabricated progress.')
  await failed.getByRole('button', { name: 'Delete Failed Agent' }).click()
  await page
    .getByRole('alertdialog', { name: /Delete “Tengri”/ })
    .getByRole('button', { name: 'Delete Agent' })
    .click()
  await expect(page.getByRole('dialog', { name: 'Create your agent' })).toBeVisible()
  expect(
    await page.evaluate(
      (agentId) =>
        Object.keys(sessionStorage).filter(
          (key) =>
            key === `tengri:desktop:${agentId}` ||
            key.startsWith(`tengri:windows:${agentId}:`) ||
            key.startsWith(`tengri:terminal:${agentId}:`) ||
            key === `tengri:terminal-cleanup:${agentId}`,
        ),
      readyAgent.id,
    ),
  ).toEqual([])
  expect(
    await page.evaluate(
      (agentId) => ({
        deletedThread: localStorage.getItem(`tengri-thread:${agentId}`),
        deletedRecents: localStorage.getItem(`tengri:spotlight:${agentId}:recents`),
        otherThread: localStorage.getItem('tengri-thread:other-agent'),
        otherRecents: localStorage.getItem('tengri:spotlight:other-agent:recents'),
      }),
      readyAgent.id,
    ),
  ).toEqual({
    deletedThread: null,
    deletedRecents: null,
    otherThread: 'other-thread',
    otherRecents: '["app:finder"]',
  })

  const create = page.getByRole('dialog', { name: 'Create your agent' })
  await create.getByLabel('Agent name').fill('Recreated Tengri')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(page.getByRole('navigation', { name: 'Dock' })).toBeVisible()
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  expect(mock.actions.some((action) => action.action === 'resume-thread')).toBe(false)
})

test('stops a failed agent without deleting its persistent workspace', async ({ page }) => {
  const failedAgent = {
    ...readyAgent,
    phase: 'failed',
    message: 'No proven Firecracker node can schedule this agent.',
  }
  const mock = await mockTengri(page, { agent: failedAgent, deferSleepReconciliation: true })
  await page.goto('/')

  const failed = page.getByRole('dialog', { name: 'Agent could not start' })
  await failed.getByRole('button', { name: 'Sleep and Keep Workspace' }).click()

  await expect.poll(() => mock.actions.some((action) => action.action === 'sleep-agent')).toBe(true)
  expect(mock.actions.some((action) => action.action === 'delete-agent')).toBe(false)
  await expect(page.getByRole('status', { name: 'Putting agent to sleep' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete Failed Agent' })).toHaveCount(0)

  mock.completeSleepReconciliation()
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
})

test('shows native-feeling unauthenticated and create-agent states', async ({ page }) => {
  await mockTengri(page, { authenticated: false })
  await page.goto('/')
  const signIn = page.getByRole('dialog', { name: 'Sign in to Tengri' })
  await expect(signIn).toBeVisible()
  const signInControls = signIn.getByRole('group', { name: 'Window controls' }).getByRole('button')
  await expect(signInControls).toHaveCount(3)
  for (const button of await signInControls.all()) await expect(button).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible()

  await page.unrouteAll({ behavior: 'wait' })
  await mockTengri(page, { agent: null })
  await page.reload()
  const create = page.getByRole('dialog', { name: 'Create your agent' })
  await expect(create).toBeVisible()
  const createControls = create.getByRole('group', { name: 'Window controls' }).getByRole('button')
  await expect(createControls).toHaveCount(3)
  for (const button of await createControls.all()) await expect(button).toBeDisabled()
  await create.getByLabel('Agent name').fill('Ada')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(page.getByRole('navigation', { name: 'Dock' })).toBeVisible()
})

test('has no serious or critical Axe violations', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Dock' })).toBeVisible()
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(
    results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'),
  ).toEqual([])
})

test('preserves a menu focus choice made before a pending window activation frame', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Chrome window' })).toBeVisible()
  await page.clock.install({ time: new Date('2026-09-08T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-08T12:00:01Z'))

  await page.keyboard.press('Meta+Space')
  const spotlight = page.getByRole('dialog', { name: 'Spotlight' })
  await spotlight.getByRole('combobox').fill('Settings')
  await page.clock.runFor(500)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Settings window' })).toBeFocused()

  const fileMenu = page.getByRole('menuitem', { name: 'File', exact: true })
  await fileMenu.focus()
  await page.clock.runFor(32)
  await expect(fileMenu).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: /^New Settings Window/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(fileMenu).toBeFocused()
})

test('restores keyboard focus when opening and switching desktop windows', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  const prompt = page.getByRole('textbox', { name: 'Message your agent' })
  await expect(prompt).toBeFocused()
  await prompt.fill('Keep this draft')
  await page.getByRole('button', { name: 'Open Terminal', exact: true }).click()
  const terminal = page.getByRole('textbox', { name: 'Terminal input' })
  await expect(terminal).toBeFocused()
  await page.getByRole('button', { name: 'Open Chrome', exact: true }).click()
  await expect(prompt).toBeFocused()
  await expect(prompt).toHaveValue('Keep this draft')
  await page.keyboard.press('Meta+m')
  await expect(terminal).toBeFocused()
  await page.getByRole('button', { name: 'Open Chrome', exact: true }).click()
  await expect(prompt).toBeFocused()
  const address = page.getByRole('textbox', { name: 'Address', exact: true })
  await address.focus()
  await page.getByRole('button', { name: 'Open Terminal', exact: true }).click()
  await expect(terminal).toBeFocused()
  await page.getByRole('button', { name: 'Open Chrome', exact: true }).click()
  await expect(address).toBeFocused()
  await page.getByRole('button', { name: 'Open Spotlight', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Spotlight' }).getByRole('combobox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Spotlight' })).toHaveCount(0)
})

test('preserves zoom across minimize and window switching and lists individual windows', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const normalBounds = await chrome.boundingBox()
  await chrome.getByRole('button', { name: 'Maximize Chrome' }).click()
  const zoomedBounds = await chrome.boundingBox()
  await chrome.getByRole('button', { name: 'Minimize Chrome' }).click()
  await page.getByRole('button', { name: 'Open Chrome', exact: true }).click()
  await expect(chrome.getByRole('button', { name: 'Restore Chrome' })).toBeVisible()
  await expect.poll(() => chrome.boundingBox()).toEqual(zoomedBounds)
  await page.getByRole('menuitem', { name: 'View', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Restore Window', exact: false })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+n')
  await expect(chrome).toHaveCount(2)
  await page.getByRole('menuitem', { name: 'Window', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Window', exact: true })
  await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(2)
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Chrome 2', exact: true })).toBeChecked()
  await menu.getByRole('menuitemcheckbox', { name: 'Chrome 1', exact: true }).click()
  await expect(chrome.first()).toHaveAttribute('data-active', 'true')
  await expect(chrome.first().getByRole('button', { name: 'Restore Chrome' })).toBeVisible()
  await chrome.first().getByRole('button', { name: 'Restore Chrome' }).click()
  await expect.poll(() => chrome.first().boundingBox()).toEqual(normalBounds)
})

test('opens Dock apps from the raised top of magnified artwork', async ({ page }) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const code = page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Code' })
  await code.hover()
  await expect.poll(async () => (await code.locator('img').boundingBox())?.width ?? 0).toBeGreaterThan(75)
  const image = await code.locator('img').boundingBox()
  const button = await code.boundingBox()
  if (!image || !button) throw new Error('Dock artwork is missing')
  expect(image.y + 2).toBeLessThan(button.y)
  await page.mouse.move(image.x + image.width / 2, image.y + 2)
  await expect(code.locator('[role="tooltip"]')).toHaveCSS('opacity', '1')
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.id, {
      x: image.x + image.width / 2,
      y: image.y + 2,
    }),
  ).toBe('tengri-dock-code')
  await page.mouse.click(image.x + image.width / 2, image.y + 2)
  await expect(page.getByRole('region', { name: 'Code window' })).toBeVisible()
})

test('magnified Dock icons keep separate hit targets at desktop and narrow widths', async ({ page }) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const dock = page.getByRole('navigation', { name: 'Dock' })
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const name of ['Open Finder', 'Open Chrome', 'Open Code', 'Open Settings']) {
      await dock.getByRole('button', { name, exact: true }).hover()
      await expect(dock.getByRole('button', { name, exact: true }).locator('[role="tooltip"]')).toHaveCSS(
        'opacity',
        '1',
      )
      const minimumGap = await dock.locator('img').evaluateAll(
        (images) =>
          new Promise<number>((resolve) => {
            const start = performance.now()
            let gap = Infinity
            const measure = () => {
              const bounds = images.map((image) => image.getBoundingClientRect())
              bounds.forEach((bound, index) => {
                gap = Math.min(
                  gap,
                  bound.left,
                  innerWidth - bound.right,
                  index === 0 ? Infinity : bound.left - bounds[index - 1]!.right,
                )
              })
              if (performance.now() - start < 250) requestAnimationFrame(measure)
              else resolve(gap)
            }
            measure()
          }),
      )
      expect(minimumGap).toBeGreaterThanOrEqual(0)
    }
    await page.mouse.move(0, 0)
  }
})

test('uses functional close controls and disables unavailable actions in confirmation windows', async ({
  page,
}, testInfo) => {
  const mock = await mockTengri(page, { holdLifecycleAction: 'delete-agent' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings window' })
  await settings.getByRole('button', { name: 'Delete Agent' }).click()
  const dialog = page.getByRole('alertdialog', { name: /Delete “Tengri”/ })
  const controls = dialog.getByRole('group', { name: 'Window controls' })
  await expect(controls.getByRole('button', { name: 'Minimize Tengri' })).toBeDisabled()
  await expect(controls.getByRole('button', { name: 'Maximize Tengri' })).toBeDisabled()
  await dialog.screenshot({ path: testInfo.outputPath('confirmation-window.png') })
  await controls.getByRole('button', { name: 'Close Tengri' }).click()
  await expect(dialog).toHaveCount(0)
  expect(mock.actions.some((action) => action.action === 'delete-agent')).toBe(false)
  await expect(settings.getByRole('button', { name: 'Delete Agent' })).toBeFocused()

  await settings.getByRole('button', { name: 'Delete Agent' }).click()
  await dialog.getByRole('button', { name: 'Delete Agent' }).click()
  await mock.waitForHeldLifecycleAction()
  for (const button of await controls.getByRole('button').all()) await expect(button).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  mock.releaseHeldLifecycleAction()
  await expect(page.getByRole('dialog', { name: 'Create your agent' })).toBeVisible()
})

test.describe('native traffic-light rendering', () => {
  test.use({ deviceScaleFactor: 2 })

  test('matches native traffic-light glyphs at Retina scale', async ({ page }) => {
    await mockTengri(page)
    await page.goto('/')
    const chrome = page.getByRole('region', { name: 'Chrome window' })
    await chrome.focus()
    await page.mouse.move(0, 0)
    const controls = chrome.getByRole('group', { name: 'Window controls' })
    await expect(controls).toHaveScreenshot('tengri-window-controls-idle.png', {
      maxDiffPixels: 0,
      threshold: 0.05,
      scale: 'device',
    })
    await controls.getByRole('button', { name: 'Minimize Chrome' }).hover()
    await expect(controls).toHaveScreenshot('tengri-window-controls-hover.png', {
      maxDiffPixels: 0,
      threshold: 0.05,
      scale: 'device',
    })
    await controls.getByRole('button', { name: 'Maximize Chrome' }).click()
    await controls.getByRole('button', { name: 'Restore Chrome' }).hover()
    await expect(controls).toHaveScreenshot('tengri-window-controls-restore.png', {
      maxDiffPixels: 0,
      threshold: 0.05,
      scale: 'device',
    })
  })
})

for (const app of ['Finder', 'Chrome', 'Code', 'Terminal', 'Settings']) {
  test(`keeps native window control states and actions correct in ${app}`, async ({ page }, testInfo) => {
    await mockTengri(page)
    await page.goto('/')
    const dock = page.getByRole('navigation', { name: 'Dock' })
    await dock.getByRole('button', { name: `Open ${app}`, exact: true }).click()
    const frame = page.locator(`section[aria-label="${app} window"]`)
    const controls = frame.locator('[aria-label="Window controls"]')
    const buttons = controls.getByRole('button')
    await expect(buttons).toHaveCount(3)
    await page.mouse.move(0, 0)
    await frame.focus()
    await expect(frame).toHaveAttribute('data-active', 'true')
    const bounds = await frame.boundingBox()
    if (!bounds) throw new Error(`${app} window is missing`)
    const colors = ['rgb(255, 92, 96)', 'rgb(250, 200, 0)', 'rgb(53, 199, 89)']
    for (const [index, color] of colors.entries()) {
      const button = buttons.nth(index)
      const light = button.locator(':scope > span')
      await expect(light).toHaveCSS('background-color', color)
      await expect(light).toHaveCSS('width', '14px')
      await expect(light).toHaveCSS('height', '14px')
      await expect(light.locator(':scope > span')).toHaveCSS('opacity', '0')
      const target = await button.boundingBox()
      if (!target) throw new Error(`${app} window control is missing`)
      expect(target.width).toBeGreaterThanOrEqual(24)
      expect(target.height).toBeGreaterThanOrEqual(24)
    }
    const lightCenters = await buttons.locator(':scope > span').evaluateAll((lights) =>
      lights.map((light) => {
        const bounds = light.getBoundingClientRect()
        return bounds.x + bounds.width / 2
      }),
    )
    expect(lightCenters).toEqual([bounds.x + 25, bounds.x + 48, bounds.x + 71])
    await controls.screenshot({ path: testInfo.outputPath(`${app.toLowerCase()}-controls-idle.png`) })
    await controls.getByRole('button', { name: `Minimize ${app}` }).hover()
    for (const button of await buttons.all()) {
      await expect(button.locator(':scope > span > span')).toHaveCSS('opacity', '1')
    }
    await controls.screenshot({ path: testInfo.outputPath(`${app.toLowerCase()}-controls-hover.png`) })
    await controls.getByRole('button', { name: `Maximize ${app}` }).click()
    const restore = controls.getByRole('button', { name: `Restore ${app}` })
    await expect(restore).toBeVisible()
    await expect.poll(async () => (await frame.boundingBox())?.width).toBeGreaterThan(bounds.width)
    await restore.click()
    await expect.poll(() => frame.boundingBox()).toEqual(bounds)

    await controls.getByRole('button', { name: `Minimize ${app}` }).click()
    await expect(frame).toHaveAttribute('aria-hidden', 'true')
    await dock.getByRole('button', { name: `Open ${app}`, exact: true }).click()
    await expect(frame).toHaveAttribute('aria-hidden', 'false')
    await expect.poll(() => frame.boundingBox()).toEqual(bounds)

    await dock.getByRole('button', { name: `Open ${app === 'Chrome' ? 'Finder' : 'Chrome'}`, exact: true }).click()
    await page.mouse.move(0, 0)
    await expect(frame).toHaveAttribute('data-active', 'false')
    const inactiveColors = await buttons
      .locator(':scope > span')
      .evaluateAll((elements) => elements.map((light) => getComputedStyle(light).backgroundColor))
    expect(new Set(inactiveColors).size).toBe(1)
    expect(colors).not.toContain(inactiveColors[0])
    await dock.getByRole('button', { name: `Open ${app}`, exact: true }).click()
    await controls.getByRole('button', { name: `Close ${app}` }).press('Enter')
    await expect(frame).toHaveCount(0)
  })
}

test('aligns native window controls with app toolbars and keeps narrow layouts usable', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  const dock = page.getByRole('navigation', { name: 'Dock' })
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const controls = await chrome.getByRole('button', { name: 'Close Chrome' }).boundingBox()
  const tabs = await chrome.getByRole('tablist', { name: 'Browser tabs' }).boundingBox()
  if (!controls || !tabs) throw new Error('Chrome toolbar is missing')
  expect(Math.abs(controls.y + controls.height / 2 - tabs.y - tabs.height / 2)).toBeLessThan(5)
  expect(tabs.x).toBeGreaterThan(controls.x + 72)

  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  const close = await finder.getByRole('button', { name: 'Close Finder' }).boundingBox()
  const back = await finder.getByRole('button', { name: 'Back', exact: true }).boundingBox()
  if (!close || !back) throw new Error('Finder toolbar is missing')
  expect(Math.abs(close.y + close.height / 2 - back.y - back.height / 2)).toBeLessThan(1)

  await finder.getByRole('button', { name: 'Maximize Finder' }).click()
  await dock.getByRole('button', { name: 'Open Chrome' }).click()
  await expect(finder).toHaveAttribute('data-active', 'false')
  await finder.locator('aside [data-window-drag-region]').click({ position: { x: 140, y: 26 } })
  await expect(finder).toHaveAttribute('data-active', 'true')
  await finder.getByRole('button', { name: 'Restore Finder' }).click()

  await page.setViewportSize({ width: 390, height: 680 })
  await finder.getByRole('button', { name: 'Maximize Finder' }).click()
  const narrowControls = await finder.getByRole('button', { name: 'Close Finder' }).boundingBox()
  const narrowBack = await finder.getByRole('button', { name: 'Back', exact: true }).boundingBox()
  expect(narrowControls).not.toBeNull()
  expect(narrowBack).not.toBeNull()
  expect(narrowBack!.y).toBeGreaterThanOrEqual(narrowControls!.y + narrowControls!.height)
  await finder.getByRole('button', { name: 'Close Finder' }).click()
  await expect(finder).toHaveCount(0)
})

test('magnifies neighboring Dock icons without pointer-frame layout reads and respects reduced motion', async ({
  page,
}) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const dock = page.getByRole('navigation', { name: 'Dock' })
  const code = dock.getByRole('button', { name: 'Open Code' })
  const chrome = dock.getByRole('button', { name: 'Open Chrome' })
  const before = await code.locator('img').boundingBox()
  const button = await code.boundingBox()
  if (!before || !button) throw new Error('Dock geometry is missing')
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2)
  await expect.poll(async () => (await code.locator('img').boundingBox())!.width).toBeGreaterThan(before.width * 1.3)
  await expect.poll(async () => (await chrome.locator('img').boundingBox())!.width).toBeGreaterThan(before.width * 1.1)
  const geometryReads = dock.evaluate(
    (element) =>
      new Promise<string[]>((resolve) => {
        const reads: string[] = []
        const originals = [...element.querySelectorAll('button')].map((button) => {
          const original = button.getBoundingClientRect.bind(button)
          button.getBoundingClientRect = () => {
            reads.push(new Error('Dock layout read during pointer movement').stack ?? button.id)
            return original()
          }
          return { button, original }
        })
        element.addEventListener(
          'pointerleave',
          () => {
            for (const { button, original } of originals) button.getBoundingClientRect = original
            resolve(reads)
          },
          { once: true },
        )
      }),
  )
  await page.keyboard.press('Meta+n')
  await expect(page.getByRole('region', { name: 'Chrome window' })).toHaveCount(2)
  await page.mouse.move(button.x - 40, button.y + 30, { steps: 12 })
  await page.mouse.move(button.x + 70, button.y + 30, { steps: 18 })
  await page.mouse.move(0, 0)
  expect(await geometryReads).toEqual([])
  await expect.poll(async () => (await code.locator('img').boundingBox())!.width).toBeCloseTo(before.width, 0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await code.focus()
  await code.hover()
  await expect.poll(async () => (await code.locator('img').boundingBox())!.width).toBeCloseTo(before.width, 1)
  await expect(code.locator('[role="tooltip"]')).toHaveCSS('opacity', '1')
  await code.press('Enter')
  await expect(page.getByRole('region', { name: 'Code window' })).toBeVisible()

  await page.setViewportSize({ width: 320, height: 680 })
  const narrowDock = await dock.boundingBox()
  if (!narrowDock) throw new Error('Dock disappeared at mobile width')
  expect(narrowDock.x).toBeGreaterThanOrEqual(0)
  expect(narrowDock.x + narrowDock.width).toBeLessThanOrEqual(320)
})

test('keeps Dock tooltips above magnified artwork, centers idle icons, and stays within the viewport', async ({
  page,
}, testInfo) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  const code = dock.getByRole('button', { name: 'Open Code' })
  const codeImage = code.locator('img')
  const dockBounds = await dock.boundingBox()
  const codeBounds = await code.boundingBox()
  if (!dockBounds || !codeBounds) throw new Error('Dock geometry is missing')
  for (const icon of await dock.locator('img').all()) {
    await expect.poll(() => icon.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
    const artworkBounds = await icon.evaluate((element) => {
      if (!(element instanceof HTMLImageElement) || !element.complete || element.naturalWidth === 0) {
        throw new Error('Dock artwork is not ready')
      }
      const canvas = document.createElement('canvas')
      canvas.width = element.naturalWidth
      canvas.height = element.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas is unavailable')
      context.drawImage(element, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let top = canvas.height
      let bottom = -1
      let left = canvas.width
      let right = -1
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          if (pixels[(y * canvas.width + x) * 4 + 3] <= 16) continue
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
          left = Math.min(left, x)
          right = Math.max(right, x)
        }
      }
      if (right < left || bottom < top) throw new Error('Dock artwork has no visible pixels')
      const bounds = element.getBoundingClientRect()
      const scaleX = bounds.width / canvas.width
      const scaleY = bounds.height / canvas.height
      return {
        bottom: bounds.top + (bottom + 1) * scaleY,
        left: bounds.left + left * scaleX,
        right: bounds.left + (right + 1) * scaleX,
        top: bounds.top + top * scaleY,
      }
    })
    const dockCenterY = dockBounds.y + dockBounds.height / 2
    const artworkCenterY = (artworkBounds.top + artworkBounds.bottom) / 2
    expect(
      Math.abs(artworkCenterY - dockCenterY),
      (await icon.getAttribute('src')) ?? 'Dock artwork',
    ).toBeLessThanOrEqual(3)
  }

  const codeTooltip = code.locator('[role="tooltip"]')
  await code.hover({ position: { x: codeBounds.width / 2, y: codeBounds.height / 2 } })
  await expect(codeTooltip).toHaveCSS('opacity', '1')
  await expect
    .poll(async () => {
      const [icon, tooltip] = await Promise.all([codeImage.boundingBox(), codeTooltip.boundingBox()])
      return icon && tooltip ? icon.y - (tooltip.y + tooltip.height) : Number.NEGATIVE_INFINITY
    })
    .toBeGreaterThanOrEqual(6)
  const dockTooltipPath = testInfo.outputPath('dock-tooltip.png')
  await page.screenshot({
    path: dockTooltipPath,
    clip: {
      x: dockBounds.x - 24,
      y: dockBounds.y - 100,
      width: dockBounds.width + 48,
      height: dockBounds.height + 112,
    },
  })
  await testInfo.attach('dock-tooltip', { path: dockTooltipPath, contentType: 'image/png' })

  await page.setViewportSize({ width: 320, height: 680 })
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Viewport size is unavailable')
  const expectWithinViewport = async (button: Locator) => {
    const tooltip = button.locator('[role="tooltip"]')
    await expect(tooltip).toHaveCSS('opacity', '1')
    const bounds = await tooltip.boundingBox()
    if (!bounds) throw new Error('Dock tooltip is missing')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
  }

  await dock.getByRole('button', { name: 'Open Finder' }).hover()
  await expectWithinViewport(dock.getByRole('button', { name: 'Open Finder' }))
  await dock.getByRole('button', { name: 'Open Settings' }).hover()
  await expectWithinViewport(dock.getByRole('button', { name: 'Open Settings' }))

  await page.mouse.move(0, 0)
  const finder = dock.getByRole('button', { name: 'Open Finder' })
  await finder.focus()
  await expect(finder).toBeFocused()
  await expect(finder.locator('[role="tooltip"]')).toHaveCSS('opacity', '1')
  await expectWithinViewport(finder)
  await expect
    .poll(async () => {
      const [icon, tooltip] = await Promise.all([
        finder.locator('img').boundingBox(),
        finder.locator('[role="tooltip"]').boundingBox(),
      ])
      return icon && tooltip ? icon.y - (tooltip.y + tooltip.height) : Number.POSITIVE_INFINITY
    })
    .toBeLessThanOrEqual(16)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const settings = dock.getByRole('button', { name: 'Open Settings' })
  await settings.focus()
  await expect(settings).toBeFocused()
  await expect(settings.locator('[role="tooltip"]')).toHaveCSS('opacity', '1')
  await expectWithinViewport(settings)
})

test('minimizes to the app icon and leaves hidden window geometry idle during clock and menu updates', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-08-26T12:34:00.000Z') })
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const chrome = page.locator('[data-app="chrome"]')
  const outer = chrome.locator('..')
  await chrome.getByRole('button', { name: 'Minimize Chrome' }).click()
  await expect(outer).toHaveCSS('visibility', 'hidden')
  const target = await page.locator('#tengri-dock-chrome').boundingBox()
  const minimized = await outer.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  })
  if (!target) throw new Error('Minimize target is missing')
  expect(minimized.x + minimized.width / 2).toBeCloseTo(target.x + target.width / 2, 0)
  expect(minimized.y + minimized.height / 2).toBeCloseTo(target.y + target.height / 2, 0)

  await chrome.evaluate((element) => {
    const stage = element.parentElement?.parentElement
    if (!stage) throw new Error('Desktop stage is missing')
    const original = stage.getBoundingClientRect.bind(stage)
    stage.dataset.layoutReads = '0'
    stage.getBoundingClientRect = () => {
      stage.dataset.layoutReads = String(Number(stage.dataset.layoutReads) + 1)
      return original()
    }
  })
  const oldTime = await page.locator('time').textContent()
  await page.clock.fastForward(61_000)
  await expect(page.locator('time')).not.toHaveText(oldTime!)
  await page.getByRole('menuitem', { name: 'File', exact: true }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  expect(await chrome.evaluate((element) => element.parentElement?.parentElement?.dataset.layoutReads)).toBe('0')
  await page.keyboard.press('Escape')
  await page.locator('#tengri-dock-chrome').click()
  await expect(outer).toHaveCSS('visibility', 'visible')
  await expect(page.getByRole('region', { name: 'Chrome window' })).toBeVisible()
})

test('matches the macOS desktop at required production viewports', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  await mockTengri(page)
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Dock' })).toBeVisible()
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  await expect(page.getByRole('button', { name: 'Open Next.js Dev Tools' })).toHaveCount(0)
  const dockIcons = page.getByRole('navigation', { name: 'Dock' }).locator('img')
  await expect(dockIcons).toHaveCount(5)
  for (const icon of await dockIcons.all()) {
    await expect.poll(() => icon.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expect(icon).toHaveAttribute('draggable', 'false')
  }
  await expect.poll(async () => (await page.getByRole('region', { name: 'Finder window' }).boundingBox())?.x).toBe(212)

  await expect.soft(page).toHaveScreenshot('tengri-desktop-1440x900.png', {
    fullPage: true,
  })
  await page.getByRole('navigation', { name: 'Dock' }).screenshot({ path: test.info().outputPath('tengri-dock.png') })

  await page.evaluate(() => sessionStorage.clear())
  await page.setViewportSize({ width: 1728, height: 1117 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Dock' })).toBeVisible()
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  await expect.poll(async () => (await page.getByRole('region', { name: 'Finder window' }).boundingBox())?.x).toBe(356)
  await expect.soft(page).toHaveScreenshot('tengri-desktop-1728x1117.png', {
    fullPage: true,
  })
})

test('navigates Finder with sortable columns, breadcrumbs, Go to Folder, and file artwork', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open Finder', exact: true }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  const files = finder.locator('[data-file-entry]')
  const names = () => files.evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))
  await expect(files).toHaveCount(3)
  await expect.poll(names).toEqual(['package.json', 'README.md', 'src'])
  await finder.getByRole('button', { name: 'Sort by Size', exact: true }).click()
  await expect.poll(names).toEqual(['src', 'package.json', 'README.md'])
  await finder.getByRole('button', { name: 'Sort by Size', exact: true }).click()
  await expect.poll(names).toEqual(['README.md', 'package.json', 'src'])
  await files.first().click()
  await files.last().click({ modifiers: ['Shift'] })
  await expect(finder.getByRole('status', { name: 'Folder status' })).toHaveText('3 of 3 selected')
  await finder.getByRole('button', { name: 'src', exact: true }).dblclick()
  await expect(finder.getByRole('button', { name: 'main.ts', exact: true })).toBeVisible()
  const path = finder.getByRole('navigation', { name: 'Folder path' })
  await expect(path.getByRole('button')).toHaveCount(2)
  await path.getByRole('button', { name: 'Workspace', exact: true }).click()
  await expect(files).toHaveCount(3)
  await finder.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(finder.getByRole('button', { name: 'main.ts', exact: true })).toBeVisible()

  await finder.getByRole('button', { name: 'Go to folder', exact: true }).click()
  const location = page.getByRole('dialog', { name: 'Go to Folder', exact: true })
  await location.getByRole('textbox', { name: 'Folder location' }).fill('/../../outside')
  await location.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(location.getByRole('alert')).toHaveText('Enter an absolute path inside the workspace')
  await location.getByRole('textbox', { name: 'Folder location' }).fill('/')
  await location.getByRole('textbox', { name: 'Folder location' }).press('Enter')
  await expect(location).toHaveCount(0)
  await expect(files).toHaveCount(3)
  await finder.getByRole('button', { name: 'Icon view' }).click()
  const folder = finder.getByRole('button', { name: 'src', exact: true })
  await expect(folder.locator('img')).toHaveAttribute('src', '/tengri/icons/folder.png')
  await expect(finder.getByRole('button', { name: 'README.md', exact: true }).locator('img')).toHaveAttribute(
    'src',
    '/tengri/icons/document.png',
  )
  await expect
    .poll(() =>
      folder
        .locator('img')
        .evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
    )
    .toBe(true)
  await page.mouse.move(0, 0)
  await expect(finder).toHaveScreenshot('tengri-finder-icons.png')
  await finder.getByRole('button', { name: 'Finder actions' }).click()
  await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click()
  await finder.getByRole('textbox', { name: 'New folder name' }).fill('empty')
  await finder.getByRole('textbox', { name: 'New folder name' }).press('Enter')
  await finder.getByRole('button', { name: 'empty', exact: true }).dblclick()
  await finder.getByRole('button', { name: 'List view' }).click()
  await expect(finder.getByRole('button', { name: 'Sort by Name', exact: true })).toBeVisible()
  await expect(finder.getByRole('status', { name: 'Folder status' })).toHaveText('0 items')
  await expect(files).toHaveCount(0)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(
    accessibility.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'),
  ).toEqual([])
})

test('renders native Finder and Settings layouts with accessible navigation', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  await mockTengri(page)
  await page.goto('/')
  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  await expect(finder.getByRole('button', { name: 'README.md' })).toBeVisible()
  await expect
    .poll(() =>
      finder
        .locator('img')
        .evaluateAll((images) =>
          images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true)
  await page.mouse.move(0, 0)
  await expect(finder).toHaveScreenshot('tengri-finder.png')

  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = page.getByRole('region', { name: 'Settings window' })
  await expect(settings.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(settings).toHaveScreenshot('tengri-settings.png')
  await page.screenshot({ path: test.info().outputPath('tengri-desktop-polish.png') })
  await settings.getByRole('button', { name: 'Runtime', exact: true }).click()
  await expect(settings.getByRole('heading', { name: 'Runtime', exact: true })).toBeInViewport()
  await settings.getByRole('button', { name: 'Lifecycle', exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Sleep Agent' })).toBeInViewport()
  const results = await new AxeBuilder({ page }).analyze()
  expect(
    results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'),
  ).toEqual([])

  await page.setViewportSize({ width: 390, height: 680 })
  await settings.getByRole('button', { name: 'Maximize Settings' }).click()
  const bounds = await settings.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.width).toBeLessThanOrEqual(390)
  await expect(settings.getByRole('button', { name: 'Sleep Agent' })).toBeVisible()
})

test('saves power settings, validates idle limits, and reads them back after reload', async ({ page }) => {
  const fixture = await mockTengri(page)
  await page.goto('/')
  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = page.getByRole('region', { name: 'Settings window' })
  await settings.getByRole('button', { name: 'Lifecycle', exact: true }).click()
  const automaticSleep = settings.getByRole('switch', { name: 'Automatic sleep' })
  const timeout = settings.getByLabel('Idle timeout in minutes')
  await expect(automaticSleep).toBeChecked()
  await expect(timeout).toHaveValue('60')
  await timeout.fill('1441')
  await settings.getByRole('button', { name: 'Save power settings' }).click()
  await expect(timeout).toHaveAttribute('aria-invalid', 'true')
  expect(fixture.actions.filter((action) => action.action === 'update-power-settings')).toHaveLength(0)
  await automaticSleep.click()
  await settings.getByRole('button', { name: 'Save power settings' }).click()
  await expect(settings.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  expect(fixture.actions.filter((action) => action.action === 'update-power-settings')).toEqual([
    {
      action: 'update-power-settings',
      agentId: readyAgent.id,
      power: { idleTimeoutMinutes: 0 },
    },
  ])
  await page.reload()
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  await settings.getByRole('button', { name: 'Lifecycle', exact: true }).click()
  await expect(automaticSleep).not.toBeChecked()
  await expect(timeout).toHaveValue('0')
  await automaticSleep.click()
  await timeout.fill('5')
  await settings.getByRole('button', { name: 'Save power settings' }).click()
  await expect(settings.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  expect(fixture.actions.filter((action) => action.action === 'update-power-settings').at(-1)).toEqual({
    action: 'update-power-settings',
    agentId: readyAgent.id,
    power: { idleTimeoutMinutes: 5 },
  })
  await settings.screenshot({ path: test.info().outputPath('tengri-power-settings.png') })
  await page.setViewportSize({ width: 390, height: 680 })
  await settings.getByRole('button', { name: 'Maximize Settings' }).click()
  await automaticSleep.scrollIntoViewIfNeeded()
  await expect(automaticSleep).toBeVisible()
  await expect(timeout).toBeVisible()
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(
    accessibility.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'),
  ).toEqual([])
})

test('prepares suggested prompts and grows multiline drafts without sending them', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const prompt = chrome.getByRole('textbox', { name: 'Message your agent' })
  await chrome.getByRole('button', { name: 'Explore the project', exact: true }).click()
  await expect(prompt).toBeFocused()
  await expect(prompt).toHaveValue('Explore this workspace and explain how the project is organized.')
  expect(mock.actions.some((action) => action.action === 'create-thread' || action.action === 'send-turn')).toBe(false)
  const initialHeight = (await prompt.boundingBox())!.height
  await prompt.press('Shift+Enter')
  await expect(prompt).toHaveValue('Explore this workspace and explain how the project is organized.\n')
  await prompt.press('End')
  await prompt.fill(Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1}`).join('\n'))
  await expect.poll(async () => (await prompt.boundingBox())!.height).toBeGreaterThan(initialHeight)
  expect((await prompt.boundingBox())!.height).toBeLessThanOrEqual(160)
  expect(mock.actions.some((action) => action.action === 'send-turn')).toBe(false)
  await selectCodexOption(page, chrome.getByRole('combobox', { name: 'Model', exact: true }), 'GPT-5.6 Luna')
  await selectCodexOption(page, chrome.getByRole('combobox', { name: 'Reasoning effort' }), 'Medium')
  await page.setViewportSize({ width: 390, height: 680 })
  await expect(chrome.getByRole('combobox', { name: 'Model', exact: true })).toBeInViewport()
  await expect(chrome.getByRole('combobox', { name: 'Reasoning effort' })).toBeInViewport()
  await expect(chrome.getByRole('button', { name: 'Send message' })).toBeInViewport()
  expect(await chrome.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await prompt.press('Enter')
  await expect
    .poll(() => mock.actions.find((action) => action.action === 'send-turn'))
    .toMatchObject({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      text: Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1}`).join('\n'),
    })
  await expect(chrome.getByRole('heading', { name: 'Let’s build' })).toHaveCount(0)
  await expect(chrome.getByRole('button', { name: 'Stop response' })).toBeEnabled()
})

test('renders restored and streamed Mermaid diagrams and recovers from incomplete syntax', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const flowchart = 'flowchart LR\n  A[Start] --> B[Finish]\n'
  const sequence = 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Ready\n'
  const restored = `\`\`\`mermaid\n${flowchart}\`\`\`\n\n\`\`\`mermaid\n${sequence}\`\`\`\n\n\`\`\`sh\nbun test\n\`\`\``
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          { id: 'turn-1', status: 'inProgress', items: [{ id: 'restored', type: 'agentMessage', text: restored }] },
        ],
      },
    }),
  })
  await page.addInitScript(() => {
    localStorage.setItem('tengri-thread:microvm-ada', 'thread-1')
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          ;(window as typeof window & { copiedCode?: string }).copiedCode = text
        },
      },
    })
  })
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const response = chrome.getByRole('article', { name: 'Codex response' }).first()
  await expect(response.locator('pre code.language-mermaid, [aria-label="Mermaid diagram"]')).toHaveCount(2)
  await testInfo.attach('restored-mermaid', {
    body: await response.screenshot(),
    contentType: 'image/png',
  })
  const diagrams = response.getByRole('img', { name: 'Mermaid diagram', exact: true })
  await expect(diagrams).toHaveCount(2)
  for (const [index, diagram] of (await diagrams.all()).entries()) {
    await expect(diagram.locator('svg')).toBeVisible()
    expect(await diagram.locator('svg').evaluate((svg) => svg.getBoundingClientRect().height)).toBeGreaterThan(50)
    expect(await diagram.locator('svg path').count()).toBeGreaterThan(0)
    const diagramPath = testInfo.outputPath(`mermaid-${index}.png`)
    await diagram.screenshot({ path: diagramPath })
    await testInfo.attach(`diagram-${index}`, { path: diagramPath, contentType: 'image/png' })
  }
  const ids = await diagrams.locator('svg').evaluateAll((svgs) => svgs.map((svg) => svg.id))
  expect(new Set(ids).size).toBe(2)
  await expect(response.locator('pre code.language-sh')).toHaveText('bun test\n')
  await expect(response.getByRole('button', { name: 'Copy code block' })).toHaveCount(1)
  await response.getByRole('button', { name: 'Copy diagram source' }).first().click()
  expect(await page.evaluate(() => (window as typeof window & { copiedCode?: string }).copiedCode)).toBe(flowchart)
  const renderedPath = testInfo.outputPath('rendered-mermaid.png')
  await response.screenshot({ path: renderedPath })
  await testInfo.attach('rendered-mermaid', { path: renderedPath, contentType: 'image/png' })

  const event = {
    threadId: 'thread-1',
    turnId: 'turn-1',
    approvalId: '',
    rawJson: '{}',
    itemId: 'streamed',
    kind: 'assistant-text',
    method: 'item/agentMessage/delta',
  }
  await emitCodexEvent(page, { ...event, sequence: 1, text: '```mermaid\nflowchart LR\n  X[' })
  const streamed = chrome.getByRole('article', { name: 'Codex response' }).last()
  await expect(streamed.locator('pre code')).toContainText('X[')
  await expect(streamed.getByRole('status')).toContainText('Diagram unavailable')
  await emitCodexEvent(page, { ...event, sequence: 2, text: 'Streaming] --> Y[Complete]\n' })
  await emitCodexEvent(page, { ...event, sequence: 3, text: '  Y --> Z[Latest]\n```' })
  const streamedDiagram = streamed.getByRole('img', { name: 'Mermaid diagram', exact: true }).locator('svg')
  await expect(streamedDiagram).toBeVisible()
  await expect(streamedDiagram).toContainText('Latest')
  await expect(streamed.getByRole('status')).toHaveCount(0)
  await expect(streamed.locator('pre')).toHaveCount(0)
  await expect(diagrams).toHaveCount(2)
  const streamedPath = testInfo.outputPath('streamed-mermaid.png')
  await streamed.screenshot({ path: streamedPath })
  await testInfo.attach('streamed-mermaid', { path: streamedPath, contentType: 'image/png' })
  const streamedId = await streamedDiagram.getAttribute('id')
  await emitCodexEvent(page, { ...event, sequence: 4, text: '\n\nTail after diagram.' })
  await expect(streamed).toContainText('Tail after diagram.')
  await expect(streamedDiagram).toHaveAttribute('id', streamedId!)
  await expect(streamed.getByRole('status')).toHaveCount(0)

  await emitCodexEvent(page, { ...event, sequence: 5, itemId: 'invalid', text: '```mermaid\nnot a diagram\n```' })
  const invalid = chrome.getByRole('article', { name: 'Codex response' }).last()
  await expect(invalid.getByRole('status')).toContainText('Diagram unavailable')
  await expect(invalid.locator('pre code')).toHaveText('not a diagram\n')
  await expect(chrome.getByRole('img', { name: 'Mermaid diagram', exact: true })).toHaveCount(3)
  await expect(page.locator('body > [id^="dtengri-mermaid-"]')).toHaveCount(0)

  await page.setViewportSize({ width: 700, height: 900 })
  for (const diagram of await diagrams.all()) {
    expect(
      await diagram.evaluate((container) => {
        const svg = container.querySelector('svg')!
        return svg.getBoundingClientRect().width <= container.getBoundingClientRect().width
      }),
    ).toBe(true)
  }
  expect(pageErrors).toEqual([])
})

test('coalesces Mermaid streaming updates before rendering the latest source', async ({ page }) => {
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'inProgress',
            items: [{ id: 'warm', type: 'agentMessage', text: '```mermaid\nflowchart LR\nA --> B\n```' }],
          },
        ],
      },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-1'))
  await page.goto('/')
  await expect(page.getByRole('img', { name: 'Mermaid diagram', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const renders: string[] = []
    ;(window as typeof window & { mermaidRenders?: string[] }).mermaidRenders = renders
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.id.startsWith('dtengri-mermaid-')) renders.push(node.id)
        }
      }
    }).observe(document.body, { childList: true })
  })
  const event = {
    threadId: 'thread-1',
    turnId: 'turn-1',
    approvalId: '',
    rawJson: '{}',
    itemId: 'burst',
    kind: 'assistant-text',
    method: 'item/agentMessage/delta',
  }
  await emitCodexEvent(page, { ...event, sequence: 1, text: '```mermaid\nflowchart LR\nA[Start]\n' })
  for (let sequence = 2; sequence <= 9; sequence++) {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    await emitCodexEvent(page, { ...event, sequence, text: `A --> N${sequence}[Update ${sequence}]\n` })
  }
  await emitCodexEvent(page, { ...event, sequence: 10, text: 'A --> Z[Latest burst]\n```' })
  const response = page.getByRole('article', { name: 'Codex response' }).last()
  await expect(response.getByRole('img', { name: 'Mermaid diagram', exact: true })).toContainText('Latest burst')
  expect(
    await page.evaluate(() => (window as typeof window & { mermaidRenders?: string[] }).mermaidRenders),
  ).toHaveLength(1)
})

for (const mode of ['streamed responses', 'unchanged completed responses', 'diagram-specific modules']) {
  const completed = mode !== 'streamed responses'
  const diagramChunk = mode === 'diagram-specific modules'
  test(`retries Mermaid loading after a failed lazy chunk request for ${mode}`, async ({ page }) => {
    await mockTengri(page, {
      resumeThreadRawJson: JSON.stringify({
        thread: {
          turns: [
            {
              id: 'turn-1',
              status: 'inProgress',
              items: [
                {
                  id: 'warm',
                  type: 'agentMessage',
                  text: diagramChunk ? '```mermaid\nflowchart LR\nA[Warm] --> B[Ready]\n```' : 'Ready to stream.',
                },
              ],
            },
          ],
        },
      }),
    })
    await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-1'))
    await page.goto('/')
    if (diagramChunk) await expect(page.getByRole('img', { name: 'Mermaid diagram', exact: true })).toBeVisible()
    else await expect(page.getByRole('article', { name: 'Codex response' })).toContainText('Ready to stream.')
    const chunkPattern = '**/_next/static/chunks/**'
    let blockedChunk: string | undefined
    let blockedRequests = 0
    await page.route(chunkPattern, (route) => {
      if (route.request().resourceType() !== 'script') return route.continue()
      blockedChunk ??= route.request().url()
      // Also fail the development loader's automatic retry of the same chunk.
      if (route.request().url() === blockedChunk) {
        blockedRequests++
        return route.abort('failed')
      }
      return route.continue()
    })
    const event = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      approvalId: '',
      rawJson: '{}',
      itemId: 'retry',
      kind: 'assistant-text',
      method: completed ? 'item/completed' : 'item/agentMessage/delta',
    }
    await emitCodexEvent(page, {
      ...event,
      sequence: 1,
      text: diagramChunk
        ? '```mermaid\nsequenceDiagram\nAlice->>Bob: Recovered\n```'
        : completed
          ? '```mermaid\nflowchart LR\nA[Retry] --> B[Recovered]\n```'
          : '```mermaid\nflowchart LR\nA[Retry]\n',
    })
    const response = page.getByRole('article', { name: 'Codex response' }).last()
    await expect(response.getByRole('status')).toContainText('Diagram unavailable')
    expect(blockedRequests).toBeGreaterThan(0)
    await page.unroute(chunkPattern)
    if (!completed) await emitCodexEvent(page, { ...event, sequence: 2, text: 'A --> B[Recovered]\n```' })
    await expect(response.getByRole('img', { name: 'Mermaid diagram', exact: true })).toContainText('Recovered')
    await expect(response.locator('pre')).toHaveCount(0)
  })
}

test('rejects Mermaid image nodes before fetching their URLs', async ({ page }) => {
  const imageRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/mermaid-image-canary')) imageRequests.push(request.url())
  })
  await page.route('**/mermaid-image-canary*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="white"/></svg>',
    }),
  )
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                id: 'image',
                type: 'agentMessage',
                text: '```mermaid\nflowchart LR\nA@{ img: "/mermaid-image-canary", label: "Image" } --> B[Safe]\n```',
              },
            ],
          },
        ],
      },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-1'))
  await page.goto('/')
  const response = page.getByRole('article', { name: 'Codex response' })
  await expect
    .poll(
      async () =>
        (await response.locator('svg').count()) > 0 ||
        (await response.getByRole('status').textContent())?.includes('Diagram unavailable'),
    )
    .toBeTruthy()
  expect(imageRequests).toEqual([])
  await expect(response.locator('svg image')).toHaveCount(0)
  await expect(response.getByRole('status')).toContainText('Diagram unavailable')
  await expect(response.locator('pre code')).toContainText('/mermaid-image-canary')
})

test('rejects Mermaid CSS resource URLs before making requests', async ({ page }) => {
  const sources = [
    'classDiagram\nclass A:::remote\nclass B\nA --> B\nclassDef remote filter:url(/mermaid-css-canary#filter)',
    'classDiagram\nclass A\nstyle A fill:url(https://example.invalid/mermaid-css-canary.svg#paint)',
    'classDiagram\nclass A\nstyle A filter:url("/mermaid-css-canary#filter")',
    String.raw`classDiagram
class A:::remote
classDef remote filter:u\72l(/mermaid-css-canary#filter);
`,
    'block-beta\nA["Resource"]\nstyle A fill:url(/mermaid-css-canary.svg)',
    'sequenceDiagram\nrect url(/mermaid-css-canary.svg)\nAlice->>Bob: Safe\nend',
    'sequenceDiagram\nparticipant Alice\nparticipant Bob\nproperties Alice: {"icon":"/mermaid-css-canary.svg"}\nAlice->>Bob: Safe',
    String.raw`%%{init: {"themeCSS": ".node { filter: \u0075rl(/mermaid-css-canary#filter) }"}}%%
flowchart LR
A[Resource] --> B[Safe]`,
  ]
  const resourceRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('mermaid-css-canary')) resourceRequests.push(request.url())
  })
  await page.route('**/*mermaid-css-canary*', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }),
  )
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            items: sources.map((source, index) => ({
              id: `css-${index}`,
              type: 'agentMessage',
              text: `\`\`\`mermaid\n${source}\n\`\`\``,
            })),
          },
        ],
      },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-1'))
  await page.goto('/')
  const responses = page.getByRole('article', { name: 'Codex response' })
  await expect(responses).toHaveCount(sources.length)
  for (const [index, response] of (await responses.all()).entries()) {
    if (index === sources.length - 1) {
      // Locked themeCSS directives are ignored, so the remaining diagram is safe.
      const diagram = response.getByRole('img', { name: 'Mermaid diagram', exact: true }).locator('svg')
      await expect(diagram).toBeVisible()
      expect(await diagram.evaluate((svg) => svg.outerHTML)).not.toContain('mermaid-css-canary')
      continue
    }
    await expect(response.getByRole('status')).toContainText(
      sources[index].startsWith('block-beta') ? 'Diagram type not supported' : 'Diagram unavailable',
    )
    await expect(response.locator('pre code')).toContainText('/mermaid-css-canary')
    await expect(response.getByRole('img', { name: 'Mermaid diagram', exact: true })).toHaveCount(0)
  }
  await page.waitForTimeout(200)
  expect(resourceRequests).toEqual([])
})

test('preserves Mermaid fragment-only CSS and arrow markers', async ({ page }) => {
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                id: 'local-css',
                type: 'agentMessage',
                text: '```mermaid\nclassDiagram\nclass Start\nclass Finish\nStart --> Finish\nstyle Start filter:url(#local-filter)\n```',
              },
            ],
          },
        ],
      },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-1'))
  await page.goto('/')
  const diagram = page.getByRole('img', { name: 'Mermaid diagram', exact: true }).locator('svg')
  await expect(diagram).toBeVisible()
  await expect(diagram).toContainText('Finish')
  expect(
    await diagram.evaluate(
      (svg) =>
        [...svg.querySelectorAll('style')].some((style) => style.textContent?.includes('#local-filter')) ||
        [...svg.querySelectorAll('[style]')].some((node) => node.getAttribute('style')?.includes('#local-filter')),
    ),
  ).toBe(true)
  const arrows = await diagram.locator('[marker-end]').evaluateAll((elements) =>
    elements.map((element) => {
      const reference = element.getAttribute('marker-end') ?? ''
      const id = reference.match(/^url\(#([\w-]+)\)$/)?.[1]
      return Boolean(id && element.closest('svg')?.querySelector(`[id="${id}"]`))
    }),
  )
  expect(arrows.length).toBeGreaterThan(0)
  expect(arrows.every(Boolean)).toBe(true)
})

test('renders Mermaid labels that name URL, image and src APIs', async ({ page }) => {
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                id: 'api-labels',
                type: 'agentMessage',
                text: '```mermaid\nflowchart LR\nA["Parse URL(value)"] --> B["image(input)"]\n```\n\n```mermaid\nsequenceDiagram\nAlice->>Bob: call src(input)\n```',
              },
            ],
          },
        ],
      },
    }),
  })

  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-1'))
  await page.goto('/')
  const diagrams = page.getByRole('img', { name: 'Mermaid diagram', exact: true })
  await expect(diagrams).toHaveCount(2)
  await expect(diagrams.first()).toContainText('Parse URL(value)')
  await expect(diagrams.first()).toContainText('image(input)')
  await expect(diagrams.last()).toContainText('call src(input)')
})

test('renders verified Mermaid types and preserves source for unaudited formats', async ({ page }) => {
  const sources = [
    'flowchart LR\nA["URL(value)"] --> B["Finish"]',
    'block-beta\nA["Start"] B["Finish"]',
    'pie\n"One": 1',
    'stateDiagram-v2\nStart --> Finish',
  ]
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            items: sources.map((source, index) => ({
              id: `format-${index}`,
              type: 'agentMessage',
              text: `\`\`\`mermaid\n${source}\n\`\`\``,
            })),
          },
        ],
      },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-1'))
  await page.goto('/')
  const responses = page.getByRole('article', { name: 'Codex response' })
  await expect(responses).toHaveCount(4)
  await expect(responses.first().getByRole('img', { name: 'Mermaid diagram', exact: true })).toContainText('URL(value)')
  for (const index of [1, 2, 3]) {
    await expect(responses.nth(index).getByRole('status')).toHaveText('Diagram type not supported; showing source.')
    await expect(responses.nth(index).locator('pre code')).toContainText(sources[index])
    await expect(responses.nth(index).getByRole('button', { name: 'Copy code block' })).toBeVisible()
  }
})

test('keeps Mermaid configuration and markup from enabling active content', async ({ page }) => {
  const text =
    '```mermaid\n%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}, "dompurifyConfig": {"ADD_TAGS": ["script"], "ADD_ATTR": ["onerror"]}}}%%\nflowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B[Safe]\n  click B "javascript:alert(1)"\n```'
  const dialogs: string[] = []
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message())
    await dialog.dismiss()
  })
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: { turns: [{ id: 'turn-1', status: 'completed', items: [{ id: 'unsafe', type: 'agentMessage', text }] }] },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-1'))
  await page.goto('/')
  const response = page.getByRole('article', { name: 'Codex response' })
  const diagram = response.getByRole('img', { name: 'Mermaid diagram', exact: true }).locator('svg')
  await expect(diagram).toBeVisible()
  await expect(response.locator('svg foreignObject, svg script, svg img, svg a')).toHaveCount(0)
  expect(
    await diagram.evaluate((svg) =>
      [...svg.querySelectorAll('*')].some((element) =>
        [...element.attributes].some(
          (attribute) => /^on/i.test(attribute.name) || /javascript:/i.test(attribute.value),
        ),
      ),
    ),
  ).toBe(false)
  expect(dialogs).toEqual([])
})

test('keeps opened tool output stable during streaming and renders copyable structured responses', async ({ page }) => {
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'inProgress',
            items: [
              {
                id: 'user-1',
                type: 'userMessage',
                content: [{ type: 'text', text: 'Inspect the project and run its checks.' }],
              },
              { id: 'output-1', type: 'commandExecution', aggregatedOutput: 'Checking types…\n' },
            ],
          },
        ],
      },
    }),
  })
  await page.addInitScript(() => {
    localStorage.setItem('tengri-thread:microvm-ada', 'thread-1')
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          const fixture = window as typeof window & { copiedCode?: string; failClipboard?: boolean }
          if (fixture.failClipboard) throw new Error('Clipboard denied')
          fixture.copiedCode = text
        },
      },
    })
  })
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const output = chrome.getByRole('article', { name: 'Codex output' })
  await expect(chrome.getByRole('article', { name: 'Your message' })).toContainText(
    'Inspect the project and run its checks.',
  )
  await expect(output.locator('pre')).not.toBeVisible()
  await output.locator('summary').click()
  const event = { threadId: 'thread-1', turnId: 'turn-1', approvalId: '', rawJson: '{}' }
  await emitCodexEvent(page, {
    ...event,
    sequence: 1,
    itemId: 'output-1',
    kind: 'tool-output',
    method: 'item/commandExecution/outputDelta',
    text: 'Typecheck passed.\n',
  })
  await expect(output.locator('pre')).toBeVisible()
  await emitCodexEvent(page, {
    ...event,
    sequence: 2,
    itemId: 'output-1',
    kind: 'tool-output',
    method: 'item/commandExecution/outputDelta',
    text: 'All checks passed.\n',
  })
  await expect(output.locator('pre')).toBeVisible()
  await expect(output.locator('pre')).toHaveText('Checking types…\nTypecheck passed.\nAll checks passed.\n')
  const response =
    'The project checks pass.\n\n### Verification\n\n| Check | Result |\n| --- | --- |\n| Types | Passed |\n| Tests | Passed |\n\n- [x] Read the project\n- [ ] Review the change\n\nRun the checks again with:\n\n```sh\nbun run lint\nbun test\n```'
  await emitCodexEvent(page, {
    ...event,
    sequence: 3,
    itemId: 'answer-1',
    kind: 'assistant-text',
    method: 'item/agentMessage/delta',
    text: response,
  })
  await expect(chrome.getByRole('cell', { name: 'Types', exact: true })).toBeVisible()
  await expect(chrome.getByRole('article', { name: 'Codex response' }).locator('pre code')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(chrome.getByRole('checkbox').first()).toBeChecked()
  await expect(chrome.getByRole('checkbox').last()).not.toBeChecked()
  await emitCodexEvent(page, {
    ...event,
    sequence: 4,
    itemId: 'approval-1',
    kind: 'approval',
    method: 'item/commandExecution/requestApproval',
    approvalId: 'approval-1',
    text: 'Run bun test in /workspace?',
    rawJson: JSON.stringify({ params: { availableDecisions: ['accept', 'decline'] } }),
  })
  await expect(chrome.getByLabel('Agent status')).toHaveText('Approval needed')
  await chrome.getByRole('button', { name: 'Close Chrome' }).hover()
  await expect(chrome).toHaveScreenshot('tengri-agent-response.png')
  await chrome.getByRole('button', { name: 'Copy code block' }).click()
  await expect(chrome.getByRole('button', { name: 'Copy code block' })).toHaveText('Copied')
  expect(await page.evaluate(() => (window as typeof window & { copiedCode?: string }).copiedCode)).toBe(
    'bun run lint\nbun test\n',
  )
  await page.evaluate(() => {
    ;(window as typeof window & { failClipboard?: boolean }).failClipboard = true
  })
  await chrome.getByRole('button', { name: 'Copy code block' }).click()
  await expect(chrome.getByRole('button', { name: 'Copy code block' })).toHaveText('Copy failed')
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Chrome window"]').analyze()
  expect(
    accessibility.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'),
  ).toEqual([])
})

test('keeps streamed output expanded when replay recovery moves it into restored history', async ({ page }) => {
  const text = 'Output before reconnect.\n'
  const mock = await mockTengri(page, {
    resumeThreadEventSequence: 2,
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'inProgress',
            items: [{ id: 'output-1', type: 'commandExecution', aggregatedOutput: text }],
          },
        ],
      },
    }),
  })
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await chrome.getByRole('textbox', { name: 'Message your agent' }).fill('Run the project checks.')
  await chrome.getByRole('button', { name: 'Send message' }).click()
  await expect(chrome.getByRole('button', { name: 'Stop response' })).toBeEnabled()
  await emitCodexEvent(page, {
    sequence: 1,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'output-1',
    approvalId: '',
    rawJson: '{}',
    kind: 'tool-output',
    method: 'item/commandExecution/outputDelta',
    text,
  })
  const output = chrome.getByRole('article', { name: 'Codex output' })
  await output.locator('summary').click()
  await expect(output.locator('pre')).toBeVisible()
  await emitCodexEvent(page, {
    sequence: 2,
    threadId: 'thread-1',
    turnId: '',
    itemId: '',
    approvalId: '',
    rawJson: '{}',
    kind: 'warning',
    method: 'tengri/replayWarning',
    text: 'Replay window exceeded',
  })
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBe(1)
  await expect(chrome.getByRole('textbox', { name: 'Steer the current turn' })).toBeEnabled()
  await expect(output.locator('pre')).toBeVisible()
  await expect(output.locator('pre')).toHaveText(text)
})

test('keeps the composer stable while typing and resizing multiline drafts', async ({ page }) => {
  await mockTengri(page)
  await page.addInitScript(() => {
    const state = { observations: 0 }
    Object.defineProperty(window, '__composerResizeState', { value: state })
    const NativeResizeObserver = window.ResizeObserver
    window.ResizeObserver = class extends NativeResizeObserver {
      observe(target: Element, options?: ResizeObserverOptions) {
        if (target instanceof HTMLTextAreaElement) state.observations += 1
        super.observe(target, options)
      }
    }
  })
  await page.goto('/')
  const prompt = page.getByRole('textbox', { name: 'Message your agent' })
  await expect(prompt).toBeEnabled()
  const observationCount = () =>
    page.evaluate(
      () =>
        (window as typeof window & { __composerResizeState: { observations: number } }).__composerResizeState
          .observations,
    )
  await expect.poll(observationCount).toBeGreaterThan(0)
  const observations = await observationCount()
  await prompt.pressSequentially('A draft that stays in place', { delay: 20 })
  await expect(prompt).toBeFocused()
  await expect(prompt).toHaveValue('A draft that stays in place')
  expect(await observationCount()).toBe(observations)
  await prompt.fill('Line of a long draft\n'.repeat(16))
  await expect(prompt).toHaveCSS('height', '160px')
  await prompt.press('ControlOrMeta+End')
  await prompt.pressSequentially('typing at the bottom', { delay: 20 })
  await expect(prompt).toBeFocused()
  await expect(prompt).toHaveCSS('height', '160px')
  expect(await prompt.evaluate((element: HTMLTextAreaElement) => element.scrollTop)).toBeGreaterThan(0)
  await prompt.fill('Short again')
  await expect(prompt).toHaveCSS('height', '48px')
  await page.setViewportSize({ width: 390, height: 844 })
  await prompt.fill('A wrapped draft '.repeat(20))
  await expect(prompt).toHaveCSS('height', '160px')
  await prompt.pressSequentially(' more', { delay: 20 })
  await expect(prompt).toBeFocused()
  expect(await observationCount()).toBe(observations)
})

test('preserves the reading position while new events arrive and returns to the latest message on request', async ({
  page,
}) => {
  await mockTengri(page, {
    resumeThreadRawJson: JSON.stringify({
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'inProgress',
            items: Array.from({ length: 24 }, (_, index) => ({
              id: `answer-${index}`,
              type: 'agentMessage',
              text: `Workspace finding ${index + 1}. ${'A detailed explanation of the change. '.repeat(12)}`,
            })),
          },
        ],
      },
    }),
  })
  await page.addInitScript(() => localStorage.setItem('tengri-thread:microvm-ada', 'thread-1'))
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  const conversation = chrome.getByTestId('agent-conversation-scroll')
  await expect(chrome.getByRole('article', { name: 'Codex response' })).toHaveCount(24)
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await conversation.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(chrome.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
  await emitCodexEvent(page, {
    sequence: 1,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'answer-new',
    approvalId: '',
    rawJson: '{}',
    kind: 'assistant-text',
    method: 'item/agentMessage/delta',
    text: 'The newest streamed message.',
  })
  await expect(chrome.getByText('The newest streamed message.', { exact: true })).toBeAttached()
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(0)
  await chrome.getByRole('textbox', { name: 'Steer the current turn' }).fill('A long draft\n'.repeat(10))
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(0)
  await chrome.getByRole('button', { name: 'Jump to latest' }).click()
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await expect(chrome.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
  await chrome.getByRole('textbox', { name: 'Steer the current turn' }).fill('A short draft')
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await chrome.getByRole('textbox', { name: 'Steer the current turn' }).fill('A long draft\n'.repeat(10))
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await emitCodexEvent(page, {
    sequence: 2,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'answer-new',
    approvalId: '',
    rawJson: '{}',
    kind: 'assistant-text',
    method: 'item/agentMessage/delta',
    text: '\n\nMore detail.\n'.repeat(12),
  })
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
})

test('makes device login readable and copyable at desktop and narrow widths', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  await mockTengri(page, { codexAuthenticated: false, activeCodexLogin: true })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          ;(window as typeof window & { copiedLoginCode?: string }).copiedLoginCode = text
        },
      },
    })
  })
  await page.goto('/')
  const chrome = page.getByRole('region', { name: 'Chrome window' })
  await expect(chrome.getByRole('heading', { name: 'Connect Codex', exact: true })).toBeVisible()
  await expect(chrome.getByRole('link', { name: 'Open verification' })).toHaveAttribute(
    'href',
    'https://auth.openai.com/device',
  )
  await chrome.getByRole('button', { name: 'Close Chrome' }).hover()
  await expect(chrome).toHaveScreenshot('tengri-agent-login.png')
  await chrome.getByRole('button', { name: 'Copy code', exact: true }).click()
  await expect(chrome.getByRole('button', { name: 'Copy code', exact: true })).toHaveText('Copied')
  expect(await page.evaluate(() => (window as typeof window & { copiedLoginCode?: string }).copiedLoginCode)).toBe(
    'TENG-RI99',
  )
  await chrome.getByRole('button', { name: 'Restart device login' }).click()
  await expect(chrome.getByText('TENG-RI01')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 680 })
  await expect(chrome.getByRole('button', { name: 'Copy code', exact: true })).toBeInViewport()
  await expect(chrome.getByRole('link', { name: 'Open verification' })).toBeInViewport()
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Chrome window"]').analyze()
  expect(
    accessibility.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'),
  ).toEqual([])
})

const clipboardPng =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGOQy3v2nxLMMGrAqAGjBgwXAwBI3HEfWzO/eAAAAABJRU5ErkJggg=='

async function pasteClipboardImage(page: Page, prompt: Locator) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: desktopOrigin })
  await page.bringToFront()
  await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, clipboardPng)
  const expected = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read())[0]
    const bytes = new Uint8Array(await (await item.getType('image/png')).arrayBuffer())
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
  })
  await prompt.focus()
  await prompt.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  return expected
}

test('pastes a real clipboard image, previews it, and sends an image-only message', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')
  const prompt = page.getByRole('textbox', { name: 'Message your agent', exact: true })
  await expect(prompt).toBeEnabled()
  const expected = await pasteClipboardImage(page, prompt)
  const attachments = page.getByRole('list', { name: 'Image attachments' })
  await expect(attachments.getByRole('img')).toHaveCount(1)
  expect((await new AxeBuilder({ page }).include('[aria-label="Message composer"]').analyze()).violations).toEqual([])
  await page.screenshot({ path: 'test-results/composer-image-attachment.png' })
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(() => mock.actions.find((action) => action.action === 'send-turn'))
    .toMatchObject({ text: '', images: [{ mediaType: 'image/png', data: expected }] })
  await expect(attachments).toHaveCount(0)
})

test('retains pasted images and text after a failed send and supports retry', async ({ page }) => {
  const mock = await mockTengri(page, { failSendTurnOnce: true })
  await page.goto('/')
  const prompt = page.getByRole('textbox', { name: 'Message your agent', exact: true })
  await expect(prompt).toBeEnabled()
  await prompt.fill('Inspect this screenshot')
  await pasteClipboardImage(page, prompt)
  await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Chrome window' }).getByRole('alert')).toContainText(
    'Temporary image send failure',
  )
  await expect(prompt).toHaveValue('Inspect this screenshot')
  await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => mock.actions.filter((action) => action.action === 'send-turn').length).toBe(2)
  await expect(page.getByRole('list', { name: 'Image attachments' })).toHaveCount(0)
})

test('steers with a clipboard image and keeps plain text paste native', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')
  const prompt = page.getByRole('textbox', { name: 'Message your agent', exact: true })
  await expect(prompt).toBeEnabled()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: desktopOrigin })
  await page.evaluate(() => navigator.clipboard.writeText('Inspect the workspace'))
  await prompt.focus()
  await prompt.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  await expect(prompt).toHaveValue('Inspect the workspace')
  await prompt.press('Enter')
  const steering = page.getByRole('textbox', { name: 'Steer the current turn', exact: true })
  await expect(steering).toBeEnabled()
  const expected = await pasteClipboardImage(page, steering)
  await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
  await page.getByRole('button', { name: 'Steer turn', exact: true }).click()
  await expect
    .poll(() => mock.actions.find((action) => action.action === 'steer-turn'))
    .toMatchObject({ text: '', images: [{ mediaType: 'image/png', data: expected }] })
})

test('bounds pasted images and removes attachments before sending', async ({ page }) => {
  await mockTengri(page)
  await page.goto('/')
  const prompt = page.getByRole('textbox', { name: 'Message your agent', exact: true })
  await expect(prompt).toBeEnabled()
  for (let count = 1; count <= 4; count += 1) {
    await pasteClipboardImage(page, prompt)
    await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(count)
  }
  await pasteClipboardImage(page, prompt)
  await expect(page.getByRole('region', { name: 'Chrome window' }).getByRole('alert')).toContainText(
    'Attach at most 4 images',
  )
  await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(4)
  for (let count = 4; count > 0; count -= 1) {
    await page
      .getByRole('button', { name: /Remove image/ })
      .first()
      .click()
    await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(count - 1)
  }
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
})
