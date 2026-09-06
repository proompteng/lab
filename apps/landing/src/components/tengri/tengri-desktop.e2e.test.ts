import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

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
  codexAuthenticated?: boolean
  deferSleepReconciliation?: boolean
  extraFiles?: typeof workspaceEntries
  failCodexAccountUntilReleased?: boolean
  failSnapshotAfterAction?: 'delete-agent' | 'sleep-agent'
  holdCodexAccount?: boolean
  holdCodexAccountAfterLogin?: boolean
  holdLifecycleAction?: 'delete-agent' | 'sleep-agent'
  holdReplayResume?: boolean
  resumeThreadDelayMs?: number
  resumeThreadEventSequence?: number
  resumeThreadItemEventSequences?: Record<string, number>
  resumeThreadErrors?: Array<{ status: number; error: string; code?: string }>
  resumeThreadRawJson?: string
  searchDelays?: Record<string, number>
  searchTruncated?: boolean
  terminalStore?: TerminalStore
}

async function mockTengri(page: Page, options: MockOptions = {}) {
  let agent = options.agent === undefined ? readyAgent : options.agent
  let snapshotFailuresRemaining = 0
  let snapshotRequests = 0
  const authenticated = options.authenticated ?? true
  const actions: Record<string, unknown>[] = []
  let resumeThreadRequests = 0
  let resumeThreadResponses = 0
  let codexAccountFailuresReleased = !options.failCodexAccountUntilReleased
  let heldCodexAccountRequest = false
  let searchRequestsInFlight = 0
  let maxConcurrentSearchRequests = 0
  const readFileFailures = new Map<string, number>()
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
  const contents = new Map<string, string>([
    ['/README.md', '# Tengri\n\nA persistent Firecracker workspace.\n'],
    ['/package.json', '{\n  "name": "tengri-workspace"\n}\n'],
  ])

  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error.stack ?? error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[browser:console] ${message.text()}`)
  })

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    try {
      localStorage.clear()
    } catch {
      // Sandboxed preview bootstrap documents can have an opaque origin before navigation.
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
  })
  await page.routeWebSocket('ws://127.0.0.1:8080/**', (socket) => {
    let ready = false
    socket.onMessage(() => {
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
      const previewGatewayOrigin = 'http://localhost:8080'
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
        result = {
          path: action.path,
          content: contents.get(String(action.path)) ?? '',
          contentType: 'text/markdown; charset=utf-8',
        }
        break
      case 'write-file': {
        const path = String(action.path)
        contents.set(path, String(action.content))
        if (!files.some((entry) => entry.path === path)) {
          files.push({
            name: path.slice(path.lastIndexOf('/') + 1),
            path,
            directory: false,
            size: String(action.content).length,
            modifiedAt: '2026-08-26T12:34:00.000Z',
          })
        }
        result = { path }
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
          launchUrl: `http://localhost:8080/v1/preview/open#${ticket}`,
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
    setAgent: (nextAgent: typeof readyAgent | null) => {
      agent = nextAgent
    },
    waitForHeldLifecycleAction: () => heldLifecycleActionStarted,
    waitForHeldCodexAccount: () => heldCodexAccountStarted,
    waitForHeldResume: () => heldResumeStarted,
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
  await finder.getByLabel('Search files').fill('missing')

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

function emitFileEvent(page: Page, directory: string, event: Record<string, unknown>) {
  return page.evaluate(
    ({ directory, event }) => {
      const sources = (
        window as typeof window & {
          __tengriEventSources?: Array<{
            closed: boolean
            onmessage: ((event: MessageEvent) => void) | null
            url: string
          }>
        }
      ).__tengriEventSources?.filter((candidate) => {
        if (candidate.closed || !candidate.onmessage) return false
        const url = new URL(candidate.url, window.location.href)
        return url.pathname === '/api/tengri/files/events' && url.searchParams.get('path') === directory
      })
      if (!sources?.length) throw new Error(`File event stream for ${directory} is unavailable`)
      for (const source of sources) source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }))
    },
    { directory, event },
  )
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
  await expect(fileMenu).toBeFocused()

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
  await expect(terminal.getByText('Connected', { exact: true })).toBeVisible()
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

test('keeps the terminal background continuous through its gutters after resizing', async ({ page }, testInfo) => {
  await mockTengri(page)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Terminal' }).click()

  const terminal = page.getByRole('region', { name: 'Terminal window' })
  await expect(terminal.getByLabel('Interactive Tengri terminal')).toHaveAttribute('data-renderer', 'canvas')
  await expect(terminal.getByText('Connected', { exact: true })).toBeVisible()
  await testInfo.attach('terminal-before-resize', { body: await terminal.screenshot(), contentType: 'image/png' })
  await expect(terminal.locator('.xterm-viewport')).toHaveCSS('background-color', 'rgb(30, 30, 30)')

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
    page.getByRole('region', { name: 'Terminal window' }).getByText('Connected', { exact: true }),
  ).toBeVisible()

  await page.reload()
  await expect(page.getByRole('region', { name: 'Terminal window' })).toHaveCount(1)
  await expect(
    page.getByRole('region', { name: 'Terminal window' }).getByText('Connected', { exact: true }),
  ).toBeVisible()
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
    duplicate.getByRole('region', { name: 'Terminal window' }).getByText('Connected', { exact: true }),
  ).toBeVisible()

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
    page.getByRole('region', { name: 'Terminal window' }).getByText('Connected', { exact: true }),
  ).toBeVisible()
  const desktopId = await page.evaluate((agentId) => sessionStorage.getItem(`tengri:desktop:${agentId}`), readyAgent.id)

  await page.reload()

  await expect(page.getByRole('region', { name: 'Terminal window' })).toHaveCount(1)
  await expect(
    page.getByRole('region', { name: 'Terminal window' }).getByText('Connected', { exact: true }),
  ).toBeVisible()
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

test('persists real Finder changes into Code and exposes a localhost preview from Chrome', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  await finder.getByRole('button', { name: 'New folder' }).click()
  await finder.getByLabel('New folder name').fill('sandbox')
  await finder.getByLabel('New folder name').press('Enter')
  const sandbox = finder.getByRole('button', { name: /sandbox/ })
  await expect(sandbox).toBeVisible()

  await sandbox.click()
  await finder.getByRole('button', { name: 'Rename selected item' }).click()
  await finder.getByLabel('Rename item').fill('workspace-notes')
  await finder.getByLabel('Rename item').press('Enter')
  const renamed = finder.getByRole('button', { name: /workspace-notes/ })
  await expect(renamed).toBeVisible()
  await finder.getByLabel('Search files').fill('workspace-notes')
  await expect(renamed).toBeVisible()
  await finder.getByLabel('Search files').fill('')

  await finder.getByRole('button', { name: /README\.md/ }).click()
  await finder.getByRole('button', { name: 'Open selected file in Code' }).click()
  const code = page.getByRole('region', { name: 'Code window' })
  await expect(code.getByRole('tab', { name: /README\.md/ })).toBeVisible()
  await expect
    .poll(() => mock.actions.some((action) => action.action === 'read-file' && action.path === '/README.md'))
    .toBe(true)
  const editor = code.locator('.monaco-editor')
  await expect(editor).toHaveCount(1)
  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.type('# Edited in Tengri')
  await expect
    .poll(() =>
      mock.actions.some(
        (action) =>
          action.action === 'write-file' && action.path === '/README.md' && action.content === '# Edited in Tengri',
      ),
    )
    .toBe(true)

  await dock.getByRole('button', { name: 'Open Finder' }).click()
  await finder.getByRole('button', { name: /README\.md/ }).click()
  await finder.getByRole('button', { name: 'Quick Look' }).click()
  await expect(page.getByRole('dialog', { name: /README\.md/ })).toContainText('# Edited in Tengri')
  await page.getByRole('button', { name: 'Close Quick Look' }).click()

  await renamed.click()
  await finder.getByRole('button', { name: 'Delete selected item' }).click()
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

test('re-verifies a clean file instead of overwriting it after a watcher read failure', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  await finder.getByRole('button', { name: /README\.md/ }).click()
  await finder.getByRole('button', { name: 'Open selected file in Code' }).click()

  const code = page.getByRole('region', { name: 'Code window' })
  const editor = code.locator('.monaco-editor')
  await expect(editor).toHaveCount(1)
  await editor.click()
  const initialReadCount = mock.actions.filter(
    (action) => action.action === 'read-file' && action.path === '/README.md',
  ).length
  mock.failNextReads('/README.md')
  await emitFileEvent(page, '/', { kind: 'changed', path: '/README.md', sequence: 99 })
  await expect(code.getByRole('alert')).toContainText('Guest filesystem is temporarily unavailable')

  const writeCount = mock.actions.filter(
    (action) => action.action === 'write-file' && action.path === '/README.md',
  ).length
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')

  await expect
    .poll(() => mock.actions.filter((action) => action.action === 'read-file' && action.path === '/README.md').length)
    .toBe(initialReadCount + 2)
  expect(mock.actions.filter((action) => action.action === 'write-file' && action.path === '/README.md')).toHaveLength(
    writeCount,
  )
  await expect(code.getByRole('alert')).toHaveCount(0)
})

test('keeps the application menu and status controls separate on narrow viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockTengri(page)
  await page.goto('/')

  const applicationMenu = page.getByRole('menubar', { name: 'Application menu' })
  const desktopStatus = page.getByLabel('Desktop status')
  await expect(applicationMenu.getByRole('menuitem', { name: 'Tengri menu' })).toBeVisible()
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
    page.getByRole('region', { name: 'Terminal window' }).getByText('Connected', { exact: true }),
  ).toBeVisible()
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
    duplicate.getByRole('region', { name: 'Terminal window' }).getByText('Connected', { exact: true }),
  ).toBeVisible()
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
      text: '7d window: 10% used',
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
      text: '7d window: 12% used',
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
  await expect(page.getByText('7d window: 10% used', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Tokens: 20 input · 6 output', { exact: true })).toHaveCount(1)
  await expect(page.getByText('7d window: 12% used', { exact: true })).toHaveCount(1)
  await expect(page.getByText('One oversized Codex event was omitted', { exact: true })).toHaveCount(1)
  await expect(page.getByText('The turn failed', { exact: true })).toHaveCount(1)
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
  await expect(page.getByRole('article', { name: 'Codex response' }).first()).toHaveText(
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
  const user = chrome.getByRole('article', { name: 'Your message' })
  const response = chrome.getByRole('article', { name: 'Codex response' }).first()
  for (const row of [user, response]) {
    await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(row).toHaveCSS('border-radius', '0px')
    await expect(row).toHaveCSS('padding-top', '0px')
    await expect(row).toHaveCSS('padding-bottom', '0px')
  }
  const [userBounds, responseBounds] = await Promise.all([user.boundingBox(), response.boundingBox()])
  if (!userBounds || !responseBounds) throw new Error('Transcript rows are missing')
  expect(userBounds.x).toBe(responseBounds.x)
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
  await expect(page.getByRole('dialog', { name: 'Sign in to Tengri' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible()

  await page.unrouteAll({ behavior: 'wait' })
  await mockTengri(page, { agent: null })
  await page.reload()
  const create = page.getByRole('dialog', { name: 'Create your agent' })
  await expect(create).toBeVisible()
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
}) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  const code = dock.getByRole('button', { name: 'Open Code' })
  const codeImage = code.locator('img')
  const dockBounds = await dock.boundingBox()
  const codeBounds = await code.boundingBox()
  if (!dockBounds || !codeBounds) throw new Error('Dock geometry is missing')
  await expect.poll(() => codeImage.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)

  const artworkBounds = await codeImage.evaluate((element) => {
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
  expect(Math.abs(artworkCenterY - dockCenterY)).toBeLessThanOrEqual(3)

  const codeTooltip = code.locator('[role="tooltip"]')
  await code.hover({ position: { x: codeBounds.width / 2, y: codeBounds.height / 2 } })
  await expect(codeTooltip).toHaveCSS('opacity', '1')
  await expect
    .poll(async () => {
      const [icon, tooltip] = await Promise.all([codeImage.boundingBox(), codeTooltip.boundingBox()])
      return icon && tooltip ? icon.y - (tooltip.y + tooltip.height) : Number.NEGATIVE_INFINITY
    })
    .toBeGreaterThanOrEqual(6)

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

  await expect(page).toHaveScreenshot('tengri-desktop-1440x900.png', {
    fullPage: true,
  })
  await page.getByRole('navigation', { name: 'Dock' }).screenshot({ path: test.info().outputPath('tengri-dock.png') })

  await page.evaluate(() => sessionStorage.clear())
  await page.setViewportSize({ width: 1728, height: 1117 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Dock' })).toBeVisible()
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  await expect.poll(async () => (await page.getByRole('region', { name: 'Finder window' }).boundingBox())?.x).toBe(356)
  await expect(page).toHaveScreenshot('tengri-desktop-1728x1117.png', {
    fullPage: true,
  })
})

test('renders native Finder and Settings layouts with accessible navigation', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  await mockTengri(page)
  await page.goto('/')
  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  await expect(finder.getByRole('button', { name: 'README.md' })).toBeVisible()
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
