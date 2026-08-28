import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

const user = {
  id: '424242',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  image: null,
}

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

const rootEntries = [
  { name: 'workspace', path: '/workspace', directory: true, size: 0, modifiedAt: '2026-08-26T12:01:00.000Z' },
]

const workspaceEntries = [
  {
    name: 'README.md',
    path: '/workspace/README.md',
    directory: false,
    size: 418,
    modifiedAt: '2026-08-26T12:02:00.000Z',
  },
  { name: 'src', path: '/workspace/src', directory: true, size: 0, modifiedAt: '2026-08-26T12:03:00.000Z' },
  {
    name: 'package.json',
    path: '/workspace/package.json',
    directory: false,
    size: 221,
    modifiedAt: '2026-08-26T12:04:00.000Z',
  },
]

const sourceEntries = [
  {
    name: 'main.ts',
    path: '/workspace/src/main.ts',
    directory: false,
    size: 128,
    modifiedAt: '2026-08-26T12:05:00.000Z',
  },
]

type MockOptions = {
  authenticated?: boolean
  agent?: typeof readyAgent | null
  extraFiles?: typeof workspaceEntries
  searchDelays?: Record<string, number>
}

async function mockTengri(page: Page, options: MockOptions = {}) {
  let agent = options.agent === undefined ? readyAgent : options.agent
  const authenticated = options.authenticated ?? true
  const actions: Record<string, unknown>[] = []
  let files = [...rootEntries, ...workspaceEntries, ...sourceEntries, ...(options.extraFiles ?? [])]
  const contents = new Map<string, string>([
    ['/workspace/README.md', '# Tengri\n\nA persistent Firecracker workspace.\n'],
    ['/workspace/package.json', '{\n  "name": "tengri-workspace"\n}\n'],
  ])

  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error.stack ?? error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[browser:console] ${message.text()}`)
  })

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    localStorage.clear()
    const NativeEventSource = window.EventSource
    class HealthyEventSource extends EventTarget {
      static readonly CLOSED = 2
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      readonly CLOSED = 2
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly readyState = 1
      readonly url: string
      readonly withCredentials = false
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onopen: ((event: Event) => void) | null = null

      constructor(url: string | URL) {
        super()
        this.url = String(url)
        queueMicrotask(() => this.onopen?.(new Event('open')))
      }

      close() {}
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
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Tengri preview</title><main>Live microVM preview</main>',
    })
  })

  await page.route('**/api/tengri', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          authConfigured: true,
          controlPlaneConfigured: true,
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
        await new Promise((resolve) => setTimeout(resolve, options.searchDelays?.[String(action.query)] ?? 0))
        result = files.filter((entry) => entry.name.toLowerCase().includes(String(action.query).toLowerCase()))
        break
      case 'read-file':
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
        result = {
          id: 'preview-1',
          launchUrl: `${new URL(request.url()).origin}/v1/preview/open#ticket.signature`,
          expiresAt: '2026-08-26T12:34:30.000Z',
        }
        break
      case 'codex-account':
        result = { authenticated: true, email: 'ada@example.test', plan: 'pro' }
        break
      case 'create-thread':
        result = { id: 'thread-1', rawJson: '{}' }
        break
      case 'create-terminal':
        result = {
          id: 'terminal-1',
          cwd: '/workspace',
          createdAt: '2026-08-26T12:34:00.000Z',
          lastActivityAt: '2026-08-26T12:34:00.000Z',
          attached: false,
        }
        break
      case 'terminal-ticket':
        result = {
          ticket: 'ticket.signature',
          websocketUrl: 'ws://127.0.0.1:8080/v1/terminal/ws',
          expiresAt: '2026-08-26T12:34:30.000Z',
        }
        break
      case 'resume-thread':
        result = { id: action.threadId, rawJson: '{"items":[]}' }
        break
      case 'send-turn':
        result = { id: 'turn-1', threadId: action.threadId }
        break
      case 'sleep-agent':
        agent = agent ? { ...agent, phase: 'sleeping' } : agent
        result = agent
        break
      case 'resume-agent':
        agent = agent ? { ...agent, phase: 'ready' } : agent
        result = agent
        break
      case 'delete-agent':
        agent = null
        break
      default:
        result = null
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result }) })
  })

  return { actions, getAgent: () => agent }
}

function parentPath(path: string) {
  const separator = path.lastIndexOf('/')
  return separator <= 0 ? '/' : path.slice(0, separator)
}

async function resizeWindow(
  page: Page,
  frame: Locator,
  edge: 'e' | 'n' | 'ne' | 'nw' | 's' | 'se' | 'sw' | 'w',
  delta: { x: number; y: number },
  expected: { height: number; width: number; x: number; y: number },
) {
  const before = await frame.boundingBox()
  expect(before).not.toBeNull()
  const handle = frame.locator('..').locator(`.cursor-${edge}-resize`)
  const handleBounds = await handle.boundingBox()
  expect(handleBounds).not.toBeNull()
  await expect
    .poll(() =>
      page.evaluate(
        ({ x, y }) => ({
          className: document.elementFromPoint(x, y)?.getAttribute('class'),
          tagName: document.elementFromPoint(x, y)?.tagName,
        }),
        {
          x: handleBounds!.x + handleBounds!.width / 2,
          y: handleBounds!.y + handleBounds!.height / 2,
        },
      ),
    )
    .toMatchObject({ className: expect.stringContaining(`cursor-${edge}-resize`) })

  await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + handleBounds!.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    handleBounds!.x + handleBounds!.width / 2 + delta.x,
    handleBounds!.y + handleBounds!.height / 2 + delta.y,
    { steps: 3 },
  )
  await page.mouse.up()

  for (const property of ['x', 'y', 'width', 'height'] as const) {
    await expect
      .poll(async () => (await frame.boundingBox())?.[property])
      .toBeCloseTo(before![property] + expected[property], 0)
  }
}

test('supports Dock-only launching, Spotlight, menus, Finder Quick Look, and window controls', async ({ page }) => {
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
  await finder.getByRole('button', { name: /^workspace/ }).dblclick()
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
  await spotlight.getByRole('combobox').fill('src')
  await expect(spotlight.getByRole('option', { name: /src/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(finder.getByRole('button', { name: /main\.ts/ })).toBeVisible()
  await expect
    .poll(() => mock.actions.some((action) => action.action === 'list-files' && action.path === '/workspace/src'))
    .toBe(true)
  expect(mock.actions.some((action) => action.action === 'read-file' && action.path === '/workspace/src')).toBe(false)

  const finderFrame = page.locator('section[aria-label="Finder window"]')
  await page.getByRole('button', { name: 'Minimize Finder' }).click()
  await expect(finderFrame).toHaveAttribute('aria-hidden', 'true')
  await expect(finderFrame).toHaveCSS('pointer-events', 'none')
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
})

test('persists real Finder changes into Code and exposes a localhost preview from Chrome', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.goto('/')

  const dock = page.getByRole('navigation', { name: 'Dock' })
  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = page.getByRole('region', { name: 'Finder window' })
  await finder.getByRole('button', { name: /^workspace/ }).dblclick()
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
    .poll(() => mock.actions.some((action) => action.action === 'read-file' && action.path === '/workspace/README.md'))
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
          action.action === 'write-file' &&
          action.path === '/workspace/README.md' &&
          action.content === '# Edited in Tengri',
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
  await chrome.getByLabel('Address').press('Enter')
  const previewFrame = chrome.getByTitle('localhost:4321')
  await expect(previewFrame).toBeVisible()
  await expect(previewFrame.contentFrame().getByText('Live microVM preview')).toBeVisible()
  await expect(chrome.getByText('Connecting to localhost…')).toHaveCount(0)
  await expect
    .poll(() =>
      mock.actions.some(
        (action) => action.action === 'preview-session' && action.port === 4321 && action.path === '/app?mode=dev',
      ),
    )
    .toBe(true)

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
  await expect(external).toHaveURL(/\/v1\/preview\/open#ticket\.signature$/)
  await expect(external.getByText('Live microVM preview')).toBeVisible()
  await external.close()
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

  await dock.getByRole('button', { name: 'Open Settings' }).click()
  await settings.getByRole('button', { name: 'Delete Agent' }).click()
  const deleteDialog = page.getByRole('alertdialog', { name: /Delete “Tengri”/ })
  await expect(deleteDialog).toContainText('persistent workspace')
  await page.keyboard.press('Meta+Space')
  await expect(page.getByRole('dialog', { name: 'Spotlight' })).toHaveCount(0)
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: 'Delete Agent' }).click()
  await expect(page.getByRole('dialog', { name: 'Create your agent' })).toBeVisible()
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
  await mockTengri(page, {
    agent: { ...readyAgent, phase: 'failed', message: 'Guest readiness probe failed without fabricated progress.' },
  })
  await page.reload()
  const failed = page.getByRole('dialog', { name: 'Agent could not start' })
  await expect(failed).toContainText('Guest readiness probe failed without fabricated progress.')
  await failed.getByRole('button', { name: 'Delete Failed Agent' }).click()
  await page
    .getByRole('alertdialog', { name: /Delete “Tengri”/ })
    .getByRole('button', { name: 'Delete Agent' })
    .click()
  await expect(page.getByRole('dialog', { name: 'Create your agent' })).toBeVisible()
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

test('matches the Tahoe desktop at required production viewports', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  await mockTengri(page)
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Dock' })).toBeVisible()
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  await expect(page.getByRole('button', { name: 'Open Next.js Dev Tools' })).toHaveCount(0)

  await expect(page).toHaveScreenshot('tengri-desktop-1440x900.png', {
    fullPage: true,
  })

  await page.setViewportSize({ width: 1728, height: 1117 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Dock' })).toBeVisible()
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  await expect(page).toHaveScreenshot('tengri-desktop-1728x1117.png', {
    fullPage: true,
  })
})
