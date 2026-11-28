import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { connectionRequestSchema, type SaveConnection } from '@/lib/tengri/connections'
import { accessRequestMutationSchema, type AccessRequestMutation } from '@/lib/platform/access-requests'
import type { TengriCodexRun } from '@/lib/tengri/codex-run'
import { codexModelFixtures } from './codex-models.fixture'
import { agentMessage, codexEvent, codexHistory, codexParams, completedTurn, runningTurn } from './codex.fixture'
import {
  exactButton,
  codexRun,
  afterPaint,
  composerInput,
  desktopDock,
  desktopOrigin,
  desktopSessionKeys,
  desktopWindow,
  emitCodexEvent,
  mockTengri,
  fileEntry,
  savedChat,
  openDesktopApp,
  openSettings,
  openSettingsPane,
  previewTicket,
  readyAgent,
  replyWithError,
  replyWithResult,
  requestGate,
  expectTerminalConnected,
  expectTengriCall,
  emitCodexEvents,
  mockConnectorCatalog,
  namespaceOperation,
  namespaceTarget,
  routeTengriAction,
  routeTengriPost,
  selectSavedThread,
  user,
  visitDesktop,
  type MockOptions,
  type TerminalStore,
  type ThreadStore,
} from './tengri-desktop.fixture'

test('signs out of the desktop through shared platform authentication', async ({ page }) => {
  await visitDesktop(page)
  const settings = await openSettings(page, 'Privacy & Security')
  await settings.getByText('Sign-in & passkeys', { exact: true }).click()
  const response = page.waitForResponse('**/api/auth/logout')
  await exactButton(settings, 'Sign Out').click()
  const logout = await response
  expect(logout.request().method()).toBe('POST')
  expect(logout.request().headers()['x-platform-operation-id']).toMatch(/^[0-9a-f-]{36}$/)
  await expect(exactButton(page, 'Continue with GitHub')).toBeVisible()
})

test('aborts cold browser startup on close so guest lifecycle actions can proceed', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window)
    const startup = { started: 0, aborted: 0 }
    Object.assign(window, { browserStartup: startup })
    window.fetch = Object.assign(
      (input: RequestInfo | URL, options?: RequestInit) => {
        if (typeof options?.body === 'string' && JSON.parse(options.body).action === 'browser-session') {
          startup.started += 1
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => {
              startup.aborted += 1
              reject(options.signal?.reason)
            }
            if (options.signal?.aborted) abort()
            else options.signal?.addEventListener('abort', abort, { once: true })
          })
        }
        return nativeFetch(input, options)
      },
      { preconnect: window.fetch.preconnect },
    )
  })
  await page.goto('/')
  const chrome = await openDesktopApp(page, 'Chrome')
  await expect(chrome.getByRole('status')).toHaveText('Starting Chrome…')
  const settings = await openSettings(page, 'Power & Sleep')
  const sleep = exactButton(settings, 'Sleep')
  await expect(sleep).toBeDisabled()
  await exactButton(chrome, 'Close Chrome').click()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const startup = (window as typeof window & { browserStartup: { started: number; aborted: number } })
          .browserStartup
        return startup.aborted > 0 && startup.aborted === startup.started
      }),
    )
    .toBe(true)
  await sleep.click()
  await expect.poll(() => mock.calls('sleep-agent').length > 0).toBe(true)
})

test('keeps an initialized Chrome viewer interactive after a clipboard failure', async ({ page }) => {
  await mockTengri(page)
  const sessionId = '7'.repeat(24)
  const previewOrigin = `https://tengri-${sessionId}.proompteng.ai`
  await routeTengriAction(page, 'browser-session', (_request, route) => {
    return replyWithResult(route, {
      id: sessionId,
      launchUrl: `https://tengri.proompteng.ai/v1/preview/open#${previewTicket(1)}`,
      previewOrigin,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    })
  })
  await page.route('https://tengri.proompteng.ai/v1/preview/open**', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<script>location.replace('${previewOrigin}')</script>` }),
  )
  await page.route(`${previewOrigin}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>body{padding:192px 48px;font-size:32px}input,button{font-size:26px}</style><body>
        <label>Retained browser text <input></label>
        <button id="fail">Report clipboard failure</button>
        <button id="continue">Continue using Chrome</button><output role="status"></output>
        <script>
          const notify = (type, error) => parent.postMessage({channel:'tengri-browser-v1', sessionId:'${sessionId}', type, error}, ${JSON.stringify(desktopOrigin)});
          document.querySelector('#fail').onclick = () => notify('error', 'Could not paste into Chrome');
          document.querySelector('#continue').onclick = () => document.querySelector('output').textContent = 'Browser input still works';
          parent.postMessage({channel:'tengri-preview-lease-v1', sessionId:'${sessionId}', type:'renewed', nonce:'', leaseId:'77777777-7777-4777-8777-777777777777', expiresInMs:1800000}, ${JSON.stringify(desktopOrigin)});
          notify('ready');
        </script>`,
    }),
  )
  await page.goto('/')
  const chrome = await openDesktopApp(page, 'Chrome')
  const viewer = chrome.frameLocator('iframe[title="Chrome browser"]')
  await viewer.getByRole('textbox', { name: 'Retained browser text' }).fill('Keep this browser document')
  await exactButton(viewer, 'Report clipboard failure').click()
  await expect(chrome.getByRole('alert')).toHaveText('Could not paste into Chrome')
  await exactButton(viewer, 'Continue using Chrome').click({ timeout: 1500 })
  await expect(viewer.getByRole('status')).toHaveText('Browser input still works')
  await expect(viewer.getByRole('textbox', { name: 'Retained browser text' })).toHaveValue('Keep this browser document')
  await expect(chrome.getByRole('alert')).toHaveText('Could not paste into Chrome')
})

test('resets the previous agent-in-Chrome layout without starting a browser or losing the conversation', async ({
  page,
}) => {
  const mock = await mockTengri(page)
  await page.addInitScript(() => {
    const desktopId = '0123456789abcdef0123456789abcdef'
    const bounds = { x: 300, y: 100, width: 1060, height: 700 }
    sessionStorage.setItem('tengri:desktop:microvm-ada', desktopId)
    sessionStorage.setItem(
      `tengri:windows:microvm-ada:${desktopId}`,
      JSON.stringify({
        activeApp: 'chrome',
        activeWindowId: 'chrome-2',
        nextWindowId: 3,
        nextZ: 3,
        windows: [
          { id: 'chrome-2', app: 'chrome', title: 'Chrome', bounds, restoredBounds: bounds, z: 2, mode: 'normal' },
        ],
      }),
    )
    localStorage.setItem('tengri-thread:microvm-ada', 'saved-thread')
  })
  await page.goto('/')
  await expect(desktopWindow(page, 'Tengri')).toBeVisible()
  await expect(desktopWindow(page, 'Chrome')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeEnabled()
  await expectTengriCall(mock, 'resume-thread', { threadId: 'saved-thread' })
  expect(mock.calls('browser-session')).toHaveLength(0)
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('saved-thread')
})

test('serializes slow Finder refreshes and reports bounded search results', async ({ page }) => {
  const mock = await mockTengri(page, {
    searchDelays: { missing: 2_100 },
    searchTruncated: true,
  })
  await page.goto('/')

  const finder = await openDesktopApp(page, 'Finder')
  await finder.getByRole('button', { name: 'Search files' }).click()
  await finder.getByRole('textbox', { name: 'Search files' }).fill('missing')

  await expect(finder.getByText('Search limit reached · Narrow your search')).toBeVisible({ timeout: 5_000 })
  await expect.poll(() => mock.calls('search-files').length, { timeout: 7_000 }).toBeGreaterThanOrEqual(2)
  expect(mock.getMaxConcurrentSearchRequests()).toBe(1)
})

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

  const dock = desktopDock(page)
  await expect(dock).toBeVisible()
  await expect(dock.getByRole('button')).toHaveCount(6)
  for (const app of ['Finder', 'Chrome', 'Tengri', 'Code', 'Terminal', 'Settings']) {
    await expect(dock.getByRole('button', { name: `Open ${app}` })).toBeVisible()
  }
  await expect(page.getByText('Docs', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Mail', { exact: true })).toHaveCount(0)

  await expect(desktopWindow(page, 'Tengri')).toBeVisible()
  await page.keyboard.press('Meta+Space')
  const spotlight = page.getByRole('dialog', { name: 'Spotlight' })
  await expect(spotlight).toBeVisible()
  await spotlight.getByRole('combobox').fill('Settings')
  await page.keyboard.press('Enter')
  await expect(desktopWindow(page, 'Settings')).toBeVisible()
  await expect(desktopWindow(page, 'Settings')).toBeFocused()

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
  const settingsWindows = desktopWindow(page, 'Settings')
  await expect(settingsWindows).toHaveCount(2)
  await expect(settingsWindows.last()).toBeFocused()

  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = desktopWindow(page, 'Finder')
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
  expect(mock.calls('search-files').at(-1)?.path).toBe('/workspace')
  await spotlight.getByRole('combobox').fill('src')
  await expect(spotlight.getByRole('option', { name: /src/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(finder.getByRole('button', { name: /main\.ts/ })).toBeVisible()
  await expectTengriCall(mock, 'list-files', { path: '/workspace/src' })
  expect(mock.calls('read-file')).not.toContainEqual(expect.objectContaining({ path: '/workspace/src' }))

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

  await page.mouse.move(720, 899)
  await expect.poll(async () => (await dock.boundingBox())?.y ?? 900).toBeLessThan(850)
  await dock.getByRole('button', { name: 'Open Terminal' }).click()
  const terminal = desktopWindow(page, 'Terminal')
  await expect(terminal.getByLabel('Interactive Tengri terminal')).toHaveAttribute('data-renderer', 'webgl')
  await expect(terminal.locator('.xterm canvas')).not.toHaveCount(0)
  await expect.poll(() => mock.calls('create-terminal').length > 0).toBe(true)
  await expect.poll(() => mock.calls('terminal-ticket').length > 0).toBe(true)
  await expect(terminal.getByRole('status').filter({ hasText: /^Connected$/ })).toHaveAttribute(
    'data-connection-state',
    'connected',
  )
  await page.keyboard.press('Meta+Space')
  await spotlight.getByRole('combobox').fill('New Terminal')
  await page.keyboard.press('Enter')
  await expect(desktopWindow(page, 'Terminal')).toHaveCount(2)
  await expect.poll(() => mock.calls('create-terminal').length).toBe(2)
  const terminalCreations = mock.calls('create-terminal')
  expect(new Set(terminalCreations.map((action) => action.creationId)).size).toBe(2)
  expect(terminalCreations.every((action) => action.cwd === '/workspace')).toBe(true)
  const creationIdPattern = new RegExp(`^tengri-${readyAgent.id}-[0-9a-f]{32}-terminal-[0-9]+$`)
  expect(terminalCreations.every((action) => creationIdPattern.test(String(action.creationId)))).toBe(true)
  await page.getByRole('button', { name: 'Close Terminal' }).last().click()
  await expect(desktopWindow(page, 'Terminal')).toHaveCount(1)
  await expect.poll(() => mock.calls('terminate-terminal').length > 0).toBe(true)
  expect(terminalDisposeFailures).toEqual([])
})

test('keeps terminal input blocked through slow admission and reconnect without replay', async ({ page }) => {
  await page.clock.install()
  const mock = await mockTengri(page)
  let ticket = requestGate()
  let attempts = 0
  await routeTengriAction(page, 'terminal-ticket', async (_, route) => {
    attempts += 1
    await ticket.hold()
    await route.fallback()
  })
  await page.goto('/')
  const terminal = await openDesktopApp(page, 'Terminal')
  const input = terminal.getByRole('textbox', { name: 'Terminal input' })
  const connected = terminal.locator('[data-connection-state="connected"]')

  try {
    await ticket.started
    await page.clock.fastForward(31_000)
    await page.clock.runFor(1_000)
    expect(attempts).toBe(1)
    await expect(terminal.locator('[data-connection-state="connecting"]')).toBeAttached()
    await expect(input).toHaveJSProperty('readOnly', true)
    await input.focus()
    await page.keyboard.type('BLOCKED_INITIAL')
    ticket.release()
    await expect(connected).toBeAttached()
    await expect(input).toHaveJSProperty('readOnly', false)
    await input.focus()
    await page.keyboard.type('connected')
    await expect.poll(() => mock.terminalInput.join('')).toBe('connected')

    ticket = requestGate()
    await mock.terminalSockets[0]!.close({ code: 1012, reason: 'Release reconnect test' })
    await expect(terminal.locator('[data-connection-state="reconnecting"]')).toBeAttached()
    await expect(input).toHaveJSProperty('readOnly', true)
    await input.focus()
    await page.keyboard.type('BLOCKED_RECONNECT')
    ticket.release()
    await expect(connected).toBeAttached()
    await expect(input).toHaveJSProperty('readOnly', false)
    await input.focus()
    await page.keyboard.type('resumed')
    await expect.poll(() => mock.terminalInput.join('')).toBe('connectedresumed')
    expect(mock.terminalSockets).toHaveLength(2)
  } finally {
    ticket.release()
  }
})

test('renders Neovim cursors and Nerd Font icons and survives GPU context loss', async ({ page }, testInfo) => {
  const mock = await visitDesktop(page)
  const terminal = await openDesktopApp(page, 'Terminal')
  await expect(terminal.locator('[data-connection-state="connected"]')).toBeAttached()
  await terminal.getByRole('textbox', { name: 'Terminal input' }).focus()
  await terminal.getByRole('textbox', { name: 'Terminal input' }).press('ArrowRight')
  let sequence = 0
  const sendOutput = (text: string) => {
    const payload = Buffer.from(text)
    const frame = Buffer.alloc(5 + payload.length)
    frame[0] = 1
    frame.writeUInt32BE(++sequence, 1)
    payload.copy(frame, 5)
    mock.terminalSockets[0]!.send(frame)
  }
  const cursorSize = async () => {
    const bounds = await terminal.locator('.xterm-screen').boundingBox()
    if (!bounds) throw new Error('Terminal screen is missing')
    const png = await page.screenshot({ clip: { x: bounds.x, y: bounds.y, width: 20, height: 24 } })
    return page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = new OffscreenCanvas(image.width, image.height)
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, image.width, image.height).data
      const xs = new Set<number>()
      const ys = new Set<number>()
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] === 156 && pixels[i + 1] === 207 && pixels[i + 2] === 216) {
          xs.add((i / 4) % image.width)
          ys.add(Math.floor(i / 4 / image.width))
        }
      }
      image.close()
      return { width: xs.size, height: ys.size }
    }, png.toString('base64'))
  }
  sendOutput('\x1b[2J\x1b[H\x1b[2 q\x1b[?25h')
  await expect.poll(async () => (await cursorSize()).width).toBeGreaterThan(3)
  sendOutput('\x1b[6 q')
  await expect.poll(async () => (await cursorSize()).width).toBe(1)
  sendOutput('\x1b[4 q')
  await expect.poll(async () => (await cursorSize()).height).toBe(1)
  sendOutput('\x1b[2 q')
  await expect.poll(async () => (await cursorSize()).height).toBeGreaterThan(10)

  expect(
    await terminal.evaluate((element) => {
      const font = getComputedStyle(element).getPropertyValue('--font-terminal').trim()
      const canvas = new OffscreenCanvas(32, 32)
      const context = canvas.getContext('2d')!
      context.font = `13px ${font}`
      const raster = (text: string) => {
        context.clearRect(0, 0, 32, 32)
        context.fillText(text, 0, 20)
        return [...context.getImageData(0, 0, 32, 32).data].join(',')
      }
      const missing = raster('\u{10ffff}')
      const advance = context.measureText('M').width
      return (
        ['\ue5ff', '\uf115', '\uf1c9', '\u{f031e}'].every(
          (glyph) => raster(glyph) !== missing && Math.abs(context.measureText(glyph).width - advance) < 0.1,
        ) && document.fonts.check('13px "Tengri Nerd Symbols"', '\ue5ff\uf115\u{f031e}')
      )
    }),
  ).toBe(true)
  sendOutput(
    '\x1b[2J\x1b[H\ue5ff ~/workspace\r\n  \uf115 lab\r\n  \uf1c9 Chart.yaml\r\n  \u{f031e} main.js\r\n\x1b[2 q',
  )
  const screenshotPath = testInfo.outputPath('terminal-icons-and-block-cursor.png')
  await terminal.screenshot({ path: screenshotPath })
  await testInfo.attach('terminal-icons-and-block-cursor', { path: screenshotPath, contentType: 'image/png' })

  await terminal.locator('.xterm-screen canvas:not(.xterm-link-layer)').evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Terminal canvas is missing')
    const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
    if (!extension) throw new Error('GPU context loss extension is unavailable')
    extension.loseContext()
  })
  await expect(terminal.getByLabel('Interactive Tengri terminal')).toHaveAttribute('data-renderer', 'dom')
  await expect(terminal.locator('.xterm-cursor-block')).toBeVisible()
  sendOutput('\x1b[6 q')
  await expect(terminal.locator('.xterm-cursor-bar')).toBeVisible()
  await terminal.getByRole('textbox', { name: 'Terminal input' }).pressSequentially('still connected')
  await expect.poll(() => mock.terminalInput.join('')).toMatch(/still connected$/)
  await exactButton(page, 'Close Terminal').click()
  await expect.poll(() => mock.calls('terminate-terminal').length > 0).toBe(true)
})

test('connects while the icon font is stalled and redraws icons when it arrives', async ({ page }) => {
  const mock = await mockTengri(page)
  const { promise: fontGate, resolve: releaseFont } = Promise.withResolvers<void>()
  await page.route('**/SymbolsNerdFontMono-Regular.woff2', async (route) => {
    await fontGate
    await route.continue()
  })
  try {
    await page.goto('/')
    const terminal = await openDesktopApp(page, 'Terminal')
    await expect(terminal.locator('[data-connection-state="connected"]')).toBeAttached()
    await terminal.getByRole('textbox', { name: 'Terminal input' }).pressSequentially('font still loading')
    await expect.poll(() => mock.terminalInput.join('')).toBe('font still loading')
    const client = await page.context().newCDPSession(page)
    const bounds = await terminal.locator('.xterm-screen').boundingBox()
    if (!bounds) throw new Error('Terminal screen is missing')
    const capture = async () =>
      (await client.send('Page.captureScreenshot', { clip: { ...bounds, width: 40, height: 24, scale: 1 } })).data
    const payload = Buffer.from('\x1b[2J\x1b[H\x1b[?25l\ue5ff\uf115\uf1c9\u{f031e}')
    const frame = Buffer.alloc(5 + payload.length)
    frame[0] = 1
    frame.writeUInt32BE(1, 1)
    payload.copy(frame, 5)
    mock.terminalSockets[0]!.send(frame)
    await afterPaint(page)
    const before = await capture()
    releaseFont()
    await expect
      .poll(() => page.evaluate(() => document.fonts.check('13px "Tengri Nerd Symbols"', '\ue5ff\uf115\u{f031e}')))
      .toBe(true)
    await expect.poll(async () => (await capture()) !== before).toBe(true)
    await client.detach()
  } finally {
    releaseFont()
  }
})

test('connects and accepts input while an optional terminal addon chunk is stalled', async ({ page }) => {
  const mock = await mockTengri(page)
  const { promise: addonGate, resolve: releaseAddon } = Promise.withResolvers<void>()
  let blockedAddons = 0
  await page.route('**/_next/static/chunks/**', async (route) => {
    if (route.request().resourceType() !== 'script') return route.continue()
    const response = await route.fetch()
    const source = await response.text()
    if (/(?:"WebglAddon"\s*,|["']?WebglAddon["']?\s*:)\s*\(\)\s*=>/.test(source)) {
      blockedAddons += 1
      await addonGate
    }
    await route.fulfill({ response })
  })
  try {
    await page.goto('/')
    const terminal = await openDesktopApp(page, 'Terminal')
    await expect.poll(() => blockedAddons).toBeGreaterThan(0)
    await expect(terminal.locator('[data-connection-state="connected"]')).toBeAttached()
    await terminal.getByRole('textbox', { name: 'Terminal input' }).pressSequentially('addon still loading')
    await expect.poll(() => mock.terminalInput.join('')).toBe('addon still loading')
  } finally {
    releaseAddon()
  }
})

test('keeps the terminal usable when WebGL and its icon font are unavailable', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      ...descriptor,
      value: function (this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement['getContext']>) {
        if (args[0] === 'webgl2') return null
        return Reflect.apply(descriptor.value, this, args)
      },
    })
  })
  await page.route('**/SymbolsNerdFontMono-Regular.woff2', (route) => route.abort())
  await page.goto('/')
  const terminal = await openDesktopApp(page, 'Terminal')
  await expect(terminal.locator('[data-connection-state="connected"]')).toBeAttached()
  await expect(terminal.getByLabel('Interactive Tengri terminal')).toHaveAttribute('data-renderer', 'dom')
  await terminal.getByRole('textbox', { name: 'Terminal input' }).pressSequentially('font fallback')
  await expect.poll(() => mock.terminalInput.join('')).toBe('font fallback')
})

test('keeps the terminal background continuous through its gutters after resizing', async ({ page }, testInfo) => {
  await visitDesktop(page)
  await desktopDock(page).getByRole('button', { name: 'Open Terminal' }).click()

  const terminal = desktopWindow(page, 'Terminal')
  await expect(terminal.getByLabel('Interactive Tengri terminal')).toHaveAttribute('data-renderer', 'webgl')
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

for (const [name, fallback] of [
  ['preserves terminal identity on reload and BFCache restore while isolating a duplicated desktop tab', false],
  ['restores and isolates desktop sessions without Web Locks or BroadcastChannel', true],
] as const) {
  test(name, async ({ page }) => {
    const seedSession = (target: Page, entries: Array<[string, string]> = []) =>
      target.addInitScript(
        ({ entries, fallback }) => {
          if (fallback) {
            Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
            Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined })
          }
          for (const [key, value] of entries) sessionStorage.setItem(key, value)
        },
        { entries, fallback },
      )
    const desktopId = (target: Page) =>
      target.evaluate((id) => sessionStorage.getItem(`tengri:desktop:${id}`), readyAgent.id)
    await seedSession(page)
    const terminalStore: TerminalStore = { sessions: [] }
    const mock = await visitDesktop(page, { terminalStore })
    await expectTerminalConnected(await openDesktopApp(page, 'Terminal'))
    await expect.poll(() => mock.calls('create-terminal').length).toBe(1)
    const originalCreationId = mock.calls('create-terminal')[0]?.creationId
    const originalDesktopId = await desktopId(page)
    await page.reload()
    await expect(desktopWindow(page, 'Terminal')).toHaveCount(1)
    await expectTerminalConnected(desktopWindow(page, 'Terminal'))
    expect(await desktopId(page)).toBe(originalDesktopId)
    expect(mock.calls('create-terminal')).toHaveLength(1)

    if (!fallback) {
      await page.evaluate(() => {
        globalThis.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
        globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      })
    }

    const duplicate = await page.context().newPage()
    await seedSession(duplicate, await page.evaluate(() => Object.entries(sessionStorage)))
    const duplicateMock = await visitDesktop(duplicate, { terminalStore })
    await expectTerminalConnected(await openDesktopApp(duplicate, 'Terminal'))
    await expect.poll(() => duplicateMock.calls('create-terminal').length).toBe(1)
    expect(duplicateMock.calls('create-terminal')[0]?.creationId).not.toBe(originalCreationId)
    expect(await desktopId(duplicate)).not.toBe(originalDesktopId)
    expect(terminalStore.sessions).toHaveLength(2)
    await duplicate.close()
  })
}

test('reports the desktop window limit for shortcuts, Dock launches, and Spotlight actions', async ({ page }) => {
  await visitDesktop(page)

  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  for (let index = 0; index < 17; index += 1) await page.keyboard.press('Meta+N')
  await expect(desktopWindow(page, 'Settings')).toHaveCount(18)

  await page.keyboard.press('Meta+N')
  const capacityAlert = page.getByRole('alert').filter({ hasText: 'at most 20 open windows' }).first()
  await expect(capacityAlert).toBeVisible()
  await expect(desktopWindow(page, 'Settings')).toHaveCount(18)

  await dock.getByRole('button', { name: 'Open Terminal' }).click()
  await expect(desktopWindow(page, 'Terminal')).toHaveCount(0)
  await expect(capacityAlert).toBeVisible()

  await page.keyboard.press('Meta+Space')
  const spotlight = page.getByRole('dialog', { name: 'Spotlight' })
  await spotlight.getByRole('combobox').fill('New Terminal')
  await page.keyboard.press('Enter')
  await expect(spotlight).toHaveCount(0)
  await expect(desktopWindow(page, 'Terminal')).toHaveCount(0)
  await expect(capacityAlert).toBeVisible()
})

test('keeps a slow VS Code cold start in flight without starting another launch', async ({ page }) => {
  await page.clock.install()
  await mockTengri(page)
  const launch = requestGate()
  let starts = 0
  await routeTengriAction(page, 'editor-session', async (_, route) => {
    starts += 1
    await launch.hold()
    await replyWithError(route, 403, 'Cold start completed')
  })
  await page.goto('/')
  const code = await openDesktopApp(page, 'Code')
  try {
    await launch.started
    await page.clock.fastForward(35_000)
    await page.clock.runFor(1_000)
    expect(starts).toBe(1)
  } finally {
    launch.release()
  }
  await expect(code.getByRole('alert')).toContainText('Cold start completed')
  expect(starts).toBe(1)
})

test('recovers VS Code startup after a temporary control-plane failure using the same window', async ({ page }) => {
  await mockTengri(page)
  const windowIds: string[] = []
  const sessionId = 'e'.repeat(24)
  const previewOrigin = `https://tengri-${sessionId}.proompteng.ai`
  await routeTengriAction(page, 'editor-session', async (action, route) => {
    windowIds.push(action.windowId)
    if (windowIds.length <= 3) {
      return replyWithError(route, 503, 'Tengri control plane is unavailable')
    }
    await replyWithResult(route, {
      id: sessionId,
      launchUrl: `https://tengri.proompteng.ai/v1/preview/open#${previewTicket(1)}`,
      previewOrigin,
      expiresAt: '2026-10-17T12:00:00Z',
    })
  })
  await page.route('https://tengri.proompteng.ai/v1/preview/open*', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<script>location.replace('${previewOrigin}')</script>` }),
  )
  await page.route(`${previewOrigin}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><p>Editor connected</p><script>parent.postMessage({channel:'tengri-vscode-v1',sessionId:'${sessionId}',type:'state',dirty:false},'${desktopOrigin}')</script>`,
    }),
  )
  await page.goto('/')
  const code = await openDesktopApp(page, 'Code')
  await expect.poll(() => windowIds.length, { timeout: 12_000 }).toBe(4)
  expect(new Set(windowIds).size).toBe(1)
  await expect(code.frameLocator('iframe').getByText('Editor connected')).toBeVisible()
  await expect(code.getByRole('status')).toHaveCount(0)
  await expect(code.getByRole('alert')).toHaveCount(0)
})

for (const clockSkewMs of [-300_000, 300_000]) {
  test(`closing Code during renewal revokes both leases despite a ${clockSkewMs}ms client clock skew`, async ({
    page,
  }) => {
    await mockTengri(page)
    let issued = 0
    const revoked: string[] = []
    const sessionId = 'e'.repeat(24)
    const previewOrigin = `https://tengri-${sessionId}.proompteng.ai`
    await routeTengriPost(page, async (action, route) => {
      if (action.action === 'revoke-preview-session') {
        revoked.push(action.revocationToken)
        return replyWithResult(route, null)
      }
      if (action.action !== 'editor-session') return route.fallback()
      issued++
      expect(action.renewal).toBe(issued > 1)
      await replyWithResult(route, {
        id: sessionId,
        previewOrigin,
        launchUrl: `https://tengri.proompteng.ai/v1/preview/open#${previewTicket(issued)}`,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })
    })
    await page.route('https://tengri.proompteng.ai/v1/preview/open*', (route) => {
      const renewal = new URL(route.request().url()).searchParams.get('__tengri_renew')
      return route.fulfill({
        contentType: 'text/html',
        body: `<script>location.replace('${previewOrigin}/?renewal=${Boolean(renewal)}')</script>`,
      })
    })
    await page.route(`${previewOrigin}/**`, (route) => {
      const renewal = new URL(route.request().url()).searchParams.get('renewal') === 'true'
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><p>Editor connected</p><script>
      const send = (message) => parent.postMessage({sessionId:'${sessionId}', ...message}, '${desktopOrigin}');
      send({channel:'tengri-preview-lease-v1', type:'renewed', leaseId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd', nonce:'${renewal ? 'wrong-nonce' : ''}', expiresAt:'${new Date(Date.now() + 60_000).toISOString()}', expiresInMs:60000});
      send({channel:'tengri-vscode-v1', type:'state', dirty:false});
      addEventListener('message', (event) => {
        if (event.data.channel !== 'tengri-vscode-v1') return;
        send({channel:'tengri-vscode-v1', type:event.data.id ? 'result' : 'state', id:event.data.id, dirty:false});
      });
    </script>`,
      })
    })
    await page.goto('/')
    await page.clock.install({ time: new Date(Date.now() + clockSkewMs) })
    const code = await openDesktopApp(page, 'Code')
    await expect(code.getByRole('status')).toHaveCount(0)
    await page.clock.runFor(31_000)
    await expect.poll(() => issued).toBe(2)
    await expect(code.getByTitle('Renew workspace connection')).toHaveCount(1)
    await exactButton(code, 'Close Code').click()
    await expect(code).toHaveCount(0)
    await expect.poll(() => [...new Set(revoked)].sort()).toEqual([previewTicket(1), previewTicket(2)].sort())
    await page.clock.runFor(60_000)
    expect(issued).toBe(2)
  })
}

test('retries transient Code failures, stops on denial, and cancels retry on close', async ({ page }) => {
  await page.clock.install()
  await mockTengri(page)
  let starts = 0
  await routeTengriAction(page, 'editor-session', (_, route) => {
    starts += 1
    const denied = starts === 4
    return replyWithError(
      route,
      denied ? 403 : 503,
      denied ? 'Editor access denied' : 'Temporary control-plane failure',
    )
  })
  await page.goto('/')
  const code = await openDesktopApp(page, 'Code')
  const status = code.getByRole('status')
  const alert = code.getByRole('alert')
  await expect(status).toBeVisible()
  for (const [delay, attempt] of [
    [1_000, 2],
    [2_000, 3],
    [4_000, 4],
  ]) {
    await page.clock.runFor(delay)
    await expect.poll(() => starts).toBe(attempt)
  }
  await expect(alert).toHaveText(/Editor access denied/)
  await page.clock.runFor(5_000)
  expect(starts).toBe(4)

  await exactButton(code, 'Retry VS Code').click()
  await expect.poll(() => starts).toBe(5)
  await expect(status).toBeVisible()
  await exactButton(code, 'Close Code').click()
  await expect(code).toHaveCount(0)
  await page.clock.runFor(10_000)
  expect(starts).toBe(5)
})

test('offers old-editor drafts for download without overwriting guest files or exposing another owner', async ({
  page,
}) => {
  const mock = await visitDesktop(page)
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
  const code = await openDesktopApp(page, 'Code')
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
  expect(mock.calls('write-file')).toHaveLength(0)
  await exactButton(code, 'Close Code').click()
  await expect(code).toHaveCount(0)
})

async function selectOption(page: Page, picker: Locator, label: string) {
  await picker.click()
  await page.getByRole('option', { name: label, exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
}

test('opens composer menus above the picker and supports keyboard selection on desktop and mobile', async ({
  page,
}) => {
  await visitDesktop(page)
  const model = page.getByRole('combobox', { name: 'Model', exact: true })
  await expect(model).toBeEnabled()
  const triggerStyle = (control: Locator) =>
    control.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        background: style.backgroundColor,
        radius: style.borderRadius,
        height: style.height,
        padding: style.padding,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        gap: style.columnGap,
        color: style.color,
        opacity: style.opacity,
        iconColor: getComputedStyle(element.querySelector('svg')!).color,
      }
    })
  const modelStyle = await triggerStyle(model)
  expect(await triggerStyle(page.getByRole('combobox', { name: 'Approvals', exact: true }))).toEqual(modelStyle)
  expect(await triggerStyle(page.getByRole('combobox', { name: 'Reasoning effort', exact: true }))).toEqual(modelStyle)
  await model.focus()
  await model.press('ArrowUp')
  const menu = page.getByRole('listbox')
  await expect(menu).toBeVisible()
  await expect(page.getByRole('option', { name: 'GPT-6.2 Sol', exact: true })).toHaveAttribute('aria-selected', 'true')
  const triggerBounds = (await model.boundingBox())!
  const menuBounds = (await menu.boundingBox())!
  expect(menuBounds.y + menuBounds.height).toBeLessThan(triggerBounds.y)

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
  await expect(reasoning.locator('[data-slot="select-value"]')).toHaveText('Low')
  await page.setViewportSize({ width: 390, height: 680 })
  await reasoning.click()
  await expect(menu).toBeVisible()
  const mobileBounds = (await menu.boundingBox())!
  expect(mobileBounds.x).toBeGreaterThanOrEqual(0)
  expect(mobileBounds.x + mobileBounds.width).toBeLessThanOrEqual(390)

  await page.getByRole('option', { name: 'Medium', exact: true }).click()
  await expect(reasoning.locator('[data-slot="select-value"]')).toHaveText('Medium')
  await expect(reasoning).toBeFocused()
})

test('keeps composer menus clickable after repeated desktop window switches', async ({ page }) => {
  await visitDesktop(page)
  const model = page.getByRole('combobox', { name: 'Model', exact: true })
  await expect(model).toBeEnabled()
  for (let switchIndex = 0; switchIndex < 28; switchIndex += 1) {
    await exactButton(page, 'Open Terminal').click()
    await exactButton(page, 'Open Tengri').click()
  }
  const tengri = desktopWindow(page, 'Tengri')
  expect(Number(await tengri.locator('..').evaluate((element) => getComputedStyle(element).zIndex))).toBeGreaterThan(50)
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
  const mock = await visitDesktop(page, { preserveDraftStorageOnReload: true, paginateCodexModels: true })
  const tengri = desktopWindow(page, 'Tengri')
  const model = tengri.getByRole('combobox', { name: 'Model', exact: true })
  const reasoning = tengri.getByRole('combobox', { name: 'Reasoning effort' })
  await expect(model.locator('[data-slot="select-value"]')).toHaveText('GPT-6.2 Sol')
  await expect(model).toBeEnabled()
  await expect(reasoning.locator('[data-slot="select-value"]')).toHaveText('High')
  await tengri.getByRole('textbox', { name: 'Message your agent' }).fill('Read the workspace')
  await tengri.getByRole('button', { name: 'Send message' }).click()
  await expect
    .poll(() => mock.calls('send-turn')[0])
    .toMatchObject({
      model: 'gpt-6.2-sol',
      reasoningEffort: 'high',
      text: 'Read the workspace',
    })
  expect(mock.calls('create-thread')[0]).toMatchObject({
    model: 'gpt-6.2-sol',
    reasoningEffort: 'high',
  })
  await expect(model).toBeDisabled()
  await expect(reasoning).toBeDisabled()
  const approvals = tengri.getByRole('combobox', { name: 'Approvals', exact: true })
  await expect(approvals).toBeEnabled()
  const approvalColor = await approvals.evaluate((element) => getComputedStyle(element).color)
  for (const picker of [approvals, model, reasoning]) {
    await expect(picker).toHaveCSS('opacity', '1')
    await expect(picker).toHaveCSS('color', approvalColor)
    await expect(picker.locator('svg')).toHaveCSS('color', approvalColor)
  }

  await emitCodexEvent(page, {
    kind: 'thread-state',
    method: 'turn/completed',
    rawJson: '{"params":{"turn":{"id":"turn-1","status":"completed"}}}',
  })
  await expect(model).toBeEnabled()
  await page.reload()
  await expect(reasoning.locator('[data-slot="select-value"]')).toHaveText('High')
  await expect(reasoning).toBeEnabled()
  await expect
    .poll(() => mock.calls('resume-thread').at(-1))
    .toEqual({ action: 'resume-thread', agentId: 'microvm-ada', threadId: 'thread-1' })
  await selectOption(page, model, 'GPT-5.6 Luna')
  await expect(reasoning.locator('[data-slot="select-value"]')).toHaveText('Low')
  await reasoning.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect(page.getByRole('option', { name: 'High', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await tengri.getByRole('textbox', { name: 'Message your agent' }).fill('Use the selected model')
  await tengri.getByRole('button', { name: 'Send message' }).click()
  await expect
    .poll(() => mock.calls('send-turn').at(-1))
    .toMatchObject({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      text: 'Use the selected model',
    })
})

for (const savedThread of [false, true]) {
  for (const catalogFailure of [
    { name: 'catalog outage', status: 503 },
    { name: 'retired capability response', status: 412, code: 'model_selection_unavailable' },
  ]) {
    test(`blocks new turns in ${savedThread ? 'saved' : 'new'} conversations after a ${catalogFailure.name}`, async ({
      page,
    }) => {
      const options: MockOptions = {
        codexModelsError: { ...catalogFailure, error: 'Codex model catalog unavailable' },
      }
      const mock = await mockTengri(page, options)
      if (savedThread) {
        await selectSavedThread(page, 'thread-existing')
      }
      await page.goto('/')
      const tengri = desktopWindow(page, 'Tengri')
      await expect(tengri.getByRole('alert')).toContainText('Codex model catalog unavailable')
      await expect(tengri.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled()
      if (savedThread) {
        await expect.poll(() => mock.calls('resume-thread').length > 0).toBe(true)
      }
      const composer = tengri.getByRole('textbox', { name: 'Message your agent' })
      await composer.fill('Use the selected settings')
      await expect(tengri.getByRole('button', { name: 'Send message' })).toBeDisabled()
      await composer.press('Enter')
      expect(mock.calls('create-thread', 'send-turn')).toHaveLength(0)
      options.codexModelsError = undefined
      await tengri.getByRole('button', { name: 'Retry models' }).click()
      await expect(tengri.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled()
      await selectOption(page, tengri.getByRole('combobox', { name: 'Reasoning effort' }), 'High')
      await tengri.getByRole('button', { name: 'Send message' }).click()
      await expect
        .poll(() => mock.calls('send-turn').at(-1))
        .toMatchObject({ model: 'gpt-6.2-sol', reasoningEffort: 'high', text: 'Use the selected settings' })
      expect(mock.calls('create-thread').length > 0).toBe(!savedThread)
    })
  }
}

test('recovers a temporary model outage without discarding the draft or retrying a turn', async ({ page }) => {
  const options: MockOptions = {
    codexModelsError: { status: 503, error: 'Tengri control plane is unavailable' },
  }
  const mock = await mockTengri(page, options)
  await selectSavedThread(page, 'thread-existing')
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('alert')).toContainText('Tengri control plane is unavailable')
  const composer = tengri.getByRole('textbox', { name: 'Message your agent' })
  await composer.fill('Keep this unsent draft')
  await expect(tengri.getByRole('button', { name: 'Send message' })).toBeDisabled()
  options.codexModelsError = undefined
  await expect(tengri.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled()
  await expect(tengri.getByRole('button', { name: 'Retry models' })).toHaveCount(0)
  await expect(composer).toHaveValue('Keep this unsent draft')
  await expect(tengri.getByRole('button', { name: 'Send message' })).toBeEnabled()
  expect(mock.calls('create-thread', 'send-turn')).toHaveLength(0)
})

for (const failure of [
  { status: 403, error: 'Model catalog access denied' },
  { status: 502, error: 'The guest returned an invalid Codex model catalog', code: 'model_catalog_invalid' },
]) {
  test(`does not automatically retry a model catalog failure with status ${failure.status}`, async ({ page }) => {
    await page.clock.install()
    const mock = await mockTengri(page, {
      codexModelsError: failure,
    })
    await page.goto('/')
    const tengri = desktopWindow(page, 'Tengri')
    await expect(tengri.getByRole('alert')).toContainText(failure.error)
    await page.clock.runFor(31_000)
    expect(mock.calls('codex-models')).toHaveLength(1)
    await expect(tengri.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled()
  })
}

test('cancels a pending model catalog retry when the chat window closes', async ({ page }) => {
  await page.clock.install()
  const options: MockOptions = {
    codexModelsError: { status: 503, error: 'Tengri control plane is unavailable' },
  }
  const mock = await mockTengri(page, options)
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('alert')).toContainText('Tengri control plane is unavailable')
  await exactButton(tengri, 'Close Tengri').click()
  await expect(tengri).toHaveCount(0)
  options.codexModelsError = undefined
  await page.clock.runFor(31_000)
  expect(mock.calls('codex-models')).toHaveLength(1)
})

test('ignores an old conversation failure after switching to a successfully loaded conversation', async ({ page }) => {
  const mock = await mockTengri(page, {
    threadStore: {
      threads: [savedChat('thread-alpha', 'Alpha', 2), savedChat('thread-beta', 'Beta', 1)],
    },
  })
  const pending = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  await routeTengriAction(page, 'resume-thread', async (action, route) => {
    if (action.threadId !== 'thread-alpha') return route.fallback()

    requested.resolve()
    await pending.promise
    await replyWithError(route, 403, 'Retired conversation failure').catch(() => {})
    settled.resolve()
  })
  await selectSavedThread(page, 'thread-alpha')
  await page.goto('/')
  await requested.promise
  const tengri = desktopWindow(page, 'Tengri')
  await tengri.locator('[data-conversation-id="thread-beta"]').click()
  try {
    await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  } finally {
    pending.resolve()
  }
  await settled.promise
  await afterPaint(page)
  await expectTengriCall(mock, 'resume-thread', { threadId: 'thread-beta' })
  await expect(exactButton(tengri, 'Retry')).toHaveCount(0)
  await expect(tengri.getByRole('alert')).toHaveCount(0)
  await expect(tengri.locator('[data-conversation-id="thread-beta"]')).toHaveAttribute('aria-current', 'true')
})

test('keeps a restored native chat selected when archive notifications replay', async ({ page }) => {
  await mockTengri(page, {
    preserveDraftStorageOnReload: true,
    threadStore: { threads: [savedChat('thread-restored', 'Restored chat', 2)] },
    resumeThreadRawJson: codexHistory([
      completedTurn('turn-restored', [agentMessage('reply-restored', 'Retained native reply.')]),
    ]),
  })
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('restored-selected-once')) {
      localStorage.setItem('tengri-thread:microvm-ada', 'thread-restored')
      sessionStorage.setItem('restored-selected-once', 'true')
    }
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const row = chat.locator('[data-conversation-id="thread-restored"]')
  await expect(chat.getByText('Retained native reply.', { exact: true })).toBeVisible()
  for (const [sequence, method] of [
    [1, 'thread/archived'],
    [2, 'thread/unarchived'],
  ] as const) {
    await emitCodexEvent(page, {
      sequence,
      method,
      kind: 'thread-state',
      threadId: 'thread-restored',
      turnId: '',
      rawJson: JSON.stringify({ method, params: { threadId: 'thread-restored' } }),
    })
  }
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(chat.getByText('Retained native reply.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-restored')
  await page.reload()
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(chat.getByText('Retained native reply.', { exact: true })).toBeVisible()
})

for (const width of [1440, 390]) {
  test(`shows a conversation skeleton while saved history loads at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const mock = await mockTengri(page, {
      holdInitialResume: true,
      resumeThreadRawJson: codexHistory(
        [completedTurn('turn-existing', [agentMessage('reply-existing', 'Restored conversation content')])],
        { id: 'thread-existing' },
      ),
    })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await selectSavedThread(page, 'thread-existing')
    await page.goto('/')
    await mock.waitForHeldResume()
    const tengri = desktopWindow(page, 'Tengri')
    const loading = tengri.getByRole('status', { name: 'Loading conversation', exact: true })
    const conversation = tengri.getByRole('log', { name: 'Conversation', exact: true })
    await expect(loading).toBeVisible()
    await expect(composerInput(tengri)).toBeDisabled()
    await expect(exactButton(tengri, 'Retry')).toHaveCount(0)
    await expect(conversation).toHaveAttribute('aria-busy', 'true')
    await expect(exactButton(tengri, 'Explore the project')).toHaveCount(0)
    const placeholder = loading.locator('[data-slot="skeleton"]').first()
    await expect(placeholder).toHaveCSS('animation-name', 'pulse')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(placeholder).toHaveCSS('animation-name', 'none')
    mock.releaseHeldResume()
    await expect(conversation.getByText('Restored conversation content', { exact: true })).toBeVisible()
    await expect(loading).toHaveCount(0)
    await expect(conversation).toHaveAttribute('aria-busy', 'false')
    await expect(exactButton(tengri, 'Retry')).toHaveCount(0)
    await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  })
}

for (const failure of [
  { name: 'temporary control-plane failure', status: 504, error: 'Tengri control plane is unavailable' },
  { name: 'resume conflict', status: 503, error: 'The conversation changed while loading. Reconnecting…' },
  { name: 'cleanly truncated history stream' },
]) {
  test(`automatically recovers a saved conversation after a ${failure.name}`, async ({ page }) => {
    await page.clock.install()
    const mock = await visitDesktop(page, {
      savedThread: 'thread-existing',
      resumeThreadErrors: failure.status !== undefined ? [failure] : undefined,
      resumeThreadTruncatedOnce: failure.status === undefined,
      resumeThreadRawJson: codexHistory([
        completedTurn('turn-existing', [agentMessage('reply-existing', 'Restored conversation content')]),
      ]),
    })
    const chat = desktopWindow(page, 'Tengri')
    await expect(chat.getByRole('status', { name: 'Loading conversation', exact: true })).toBeVisible()
    if (failure.error) await expect(chat.getByText(failure.error, { exact: true })).toHaveCount(0)
    await expect(chat.getByText('Tengri resource already exists', { exact: true })).toHaveCount(0)
    await page.clock.runFor(1_000)
    await expect(chat.getByText('Restored conversation content', { exact: true })).toBeVisible()
    await expect(composerInput(chat)).toBeEnabled()
    await expect(exactButton(chat, 'Retry')).toHaveCount(0)
    await expect(chat.getByRole('alert')).toHaveCount(0)
    await page.clock.runFor(31_000)
    expect(mock.calls('resume-thread')).toHaveLength(2)
    expect(mock.calls('create-thread')).toHaveLength(0)
    expect(mock.calls('send-turn')).toHaveLength(0)
  })
}

for (const { status, close } of [
  { status: 503, close: false },
  { status: 403, close: false },
  { status: 503, close: true },
]) {
  const name = close
    ? 'cancels a replay-history retry when the chat window closes'
    : `recovers a replay-history failure with status ${status} without sending another turn`
  test(name, async ({ page }) => {
    await page.clock.install()
    const mock = await mockTengri(page)
    await selectSavedThread(page, 'thread-existing')
    let attempts = 0
    let failNext = false
    await routeTengriAction(page, 'resume-thread', async (_request, route) => {
      attempts++
      if (failNext) {
        failNext = false
        return replyWithError(route, status, 'History recovery failed')
      }
      return route.fallback()
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const composer = composerInput(chat)
    await composer.fill('Keep my draft through recovery')
    await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
    failNext = true
    await emitCodexEvent(page, {
      kind: 'warning',
      method: 'tengri/replayWarning',
      threadId: 'thread-existing',
      turnId: '',
      text: 'Event replay needs a fresh snapshot',
    })
    await expect.poll(() => attempts).toBe(2)
    if (close) {
      await expect(chat.getByRole('status', { name: 'Loading conversation', exact: true })).toBeVisible()
      await exactButton(chat, 'Close Tengri').click()
      await page.clock.runFor(31_000)
      expect(attempts).toBe(2)
      return
    }
    if (status === 503) {
      await expect(chat.getByRole('status', { name: 'Loading conversation', exact: true })).toBeVisible()
      await expect(chat.getByText('History recovery failed', { exact: true })).toHaveCount(0)
      await page.clock.runFor(1_000)
    } else {
      await expect(chat.getByRole('alert')).toHaveText('History recovery failed')
      await page.clock.runFor(31_000)
      expect(attempts).toBe(2)
      await exactButton(chat, 'Retry').click()
    }
    await expect(composer).toBeEditable()
    await expect(composer).toHaveValue('Keep my draft through recovery')
    await expect(chat.getByRole('alert')).toHaveCount(0)
    await expect(exactButton(chat, 'Retry')).toHaveCount(0)
    expect(attempts).toBe(3)
    expect(mock.calls('create-thread', 'send-turn')).toHaveLength(0)
  })
}

test('cancels a pending conversation recovery retry when the chat window closes', async ({ page }) => {
  await page.clock.install()
  const mock = await visitDesktop(page, {
    savedThread: 'thread-existing',
    resumeThreadErrors: [{ status: 504, error: 'Tengri control plane is unavailable' }],
  })
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('status', { name: 'Loading conversation', exact: true })).toBeVisible()
  await expect(tengri.getByText('Tengri control plane is unavailable', { exact: true })).toHaveCount(0)
  await exactButton(tengri, 'Close Tengri').click()
  await page.clock.runFor(31_000)
  expect(mock.calls('resume-thread')).toHaveLength(1)
})

for (const failure of [
  { status: 403, error: 'Conversation access denied' },
  { status: 404, error: 'Conversation access denied' },
  { status: 502, error: 'Invalid conversation history', code: 'conversation_history_invalid' },
]) {
  test(`does not automatically retry a permanent conversation recovery failure with status ${failure.status}`, async ({
    page,
  }) => {
    await page.clock.install()
    const mock = await visitDesktop(page, {
      savedThread: 'thread-existing',
      resumeThreadErrors: [failure],
    })
    const tengri = desktopWindow(page, 'Tengri')
    await expect(tengri.getByText(failure.error, { exact: true })).toBeVisible()
    await page.clock.runFor(31_000)
    expect(mock.calls('resume-thread')).toHaveLength(1)
  })
}

for (const unavailable of ['model', 'effort']) {
  test(`loads history with a saved unavailable ${unavailable} and requires valid settings to send`, async ({
    page,
  }) => {
    const mock = await mockTengri(page)
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
    const tengri = desktopWindow(page, 'Tengri')
    await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
    await expect
      .poll(() => mock.calls('resume-thread').at(-1))
      .toEqual({
        action: 'resume-thread',
        agentId: 'microvm-ada',
        threadId: 'thread-existing',
      })
    await tengri.getByRole('textbox', { name: 'Message your agent' }).fill('Continue this conversation')
    await expect(tengri.getByRole('button', { name: 'Send message' })).toBeDisabled()
    const model = tengri.getByRole('combobox', { name: 'Model', exact: true })
    await expect(model).toBeEnabled()
    if (unavailable === 'model') await selectOption(page, model, 'GPT-6.2 Sol')
    const reasoning = tengri.getByRole('combobox', { name: 'Reasoning effort' })
    await expect(reasoning).toBeEnabled()
    await selectOption(page, reasoning, 'Low')
    expect(mock.calls('create-thread')).toHaveLength(0)
    await tengri.getByRole('button', { name: 'Send message' }).click()
    await expect
      .poll(() => mock.calls('send-turn')[0])
      .toMatchObject({
        model: unavailable === 'model' ? 'gpt-6.2-sol' : 'gpt-5.6-luna',
        reasoningEffort: 'low',
      })
  })
}

test('keeps an unavailable default visible until the user selects an available model', async ({ page }) => {
  await visitDesktop(page, { codexModels: codexModelFixtures.slice(1) })
  const tengri = desktopWindow(page, 'Tengri')
  const model = tengri.getByRole('combobox', { name: 'Model', exact: true })
  await expect(tengri.getByRole('alert')).toContainText('This model is unavailable')
  await expect(model.locator('[data-slot="select-value"]')).toHaveText('gpt-6.2-sol (unavailable)')
  await tengri.getByRole('textbox', { name: 'Message your agent' }).fill('Read the workspace')
  await expect(tengri.getByRole('button', { name: 'Send message' })).toBeDisabled()
  await selectOption(page, model, 'GPT-5.6 Luna')
  await expect(tengri.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await expect(tengri.getByRole('alert')).toHaveCount(0)
})

test('persists Finder changes', async ({ page }) => {
  await visitDesktop(page)

  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = desktopWindow(page, 'Finder')
  await finder.getByRole('button', { name: 'Finder actions' }).click()
  await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click()
  await expect(finder.getByLabel('New folder name')).toBeFocused()
  await finder.getByLabel('New folder name').fill('sandbox')
  await finder.getByLabel('New folder name').press('Enter')
  const sandbox = finder.getByRole('button', { name: /sandbox/ })
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
  await exactButton(deleteDialog, 'Delete').click()
  await expect(finder.getByRole('button', { name: /workspace-notes/ })).toHaveCount(0)
})

test('keeps the application menu and status controls separate on narrow viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await visitDesktop(page)

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
  await expect(applicationMenu.getByRole('menuitem', { name: 'Tengri', exact: true })).toBeVisible()
  await expect(applicationMenu.getByRole('menuitem', { name: 'File', exact: true, includeHidden: true })).toBeHidden()
  await expect(applicationMenu.getByRole('menuitem', { name: 'Help', exact: true, includeHidden: true })).toBeHidden()
  await expect(desktopStatus).toBeVisible()

  const menuBounds = await applicationMenu.boundingBox()
  const statusBounds = await desktopStatus.boundingBox()
  expect(menuBounds).not.toBeNull()
  expect(statusBounds).not.toBeNull()
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(statusBounds!.x)
})

test('shows the submitted message and Thinking immediately, then restores a rejected draft', async ({ page }) => {
  await mockTengri(page)
  const { promise: heldSend, resolve: releaseSend } = Promise.withResolvers<void>()
  await page.route('**/api/tengri', async (route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'send-turn') {
      await heldSend
      await replyWithError(route, 503, 'Send was rejected')
    } else await route.fallback()
  })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  const composer = tengri.getByRole('textbox', { name: 'Message your agent' })
  await composer.fill('Show this immediately.')
  await exactButton(tengri, 'Send message').click()
  try {
    await expect(tengri.getByRole('article', { name: 'Your message' })).toHaveText('Show this immediately.', {
      timeout: 1_000,
    })
    await expect(composer).toHaveValue('')
    await expect(tengri.getByLabel('Agent status', { exact: true })).toHaveText('Sending')
    await expect(tengri.getByRole('status', { name: 'Agent activity' })).toHaveText('Thinking', { timeout: 1_000 })
  } finally {
    releaseSend()
  }
  await expect(tengri.getByText('Send was rejected', { exact: true })).toBeVisible()
  await expect(composer).toHaveValue('Show this immediately.')
  await expect(tengri.getByRole('article', { name: 'Your message' })).toHaveCount(0)
  await expect(tengri.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
})

for (const outcome of ['accepted', 'rejected'] as const) {
  test(`keeps navigation and another draft usable while a send is ${outcome}`, async ({ page }) => {
    const mock = await mockTengri(page, {
      threadStore: {
        threads: [savedChat('thread-alpha', 'Alpha', 2), savedChat('thread-beta', 'Beta', 1)],
      },
    })
    await selectSavedThread(page, 'thread-alpha')
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    let sentRunId = ''
    await routeTengriAction(page, 'send-turn', async (request, route) => {
      sentRunId = String(request.operationId)
      await held
      if (outcome === 'rejected') return replyWithError(route, 503, 'Original send failed')
      return route.fallback()
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const sidebar = chat.getByTestId('agent-conversation-sidebar')
    const composer = composerInput(chat)
    await composer.fill('Send from Alpha')
    await exactButton(chat, 'Send message').click()
    try {
      await expect.poll(() => sentRunId).not.toBe('')
      await expect(exactButton(sidebar, 'New conversation')).toBeEnabled()
      await sidebar.locator('[data-conversation-id="thread-beta"]').click()
      await composer.fill('Beta stays unsent')
    } finally {
      release()
    }
    await expect(composer).toBeEnabled()
    await expect(composer).toHaveValue('Beta stays unsent')
    await expect(sidebar.locator('[data-conversation-id="thread-beta"]')).toHaveAttribute('aria-current', 'true')
    await expect(chat.getByText('Original send failed', { exact: true })).toHaveCount(0)
    await expect.poll(() => mock.calls('send-turn').length).toBe(outcome === 'accepted' ? 1 : 0)
    await sidebar.locator('[data-conversation-id="thread-alpha"]').click()
    if (outcome === 'accepted') {
      await exactButton(chat, 'Stop response').click()
      await expect.poll(() => mock.calls('interrupt-turn')[0]?.runId).toBe(sentRunId)
    } else await expect(composer).toHaveValue('Send from Alpha')
  })
}

for (const submit of ['keyboard', 'button'] as const) {
  test(`keeps the composer focused and editable through a ${submit} send`, async ({ page }) => {
    const mock = await mockTengri(page)
    let sending = false
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    await routeTengriAction(page, 'send-turn', async (_request, route) => {
      sending = true
      await held
      return route.fallback()
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const composer = composerInput(chat)
    await composer.fill('Send this message')
    await expect(exactButton(chat, 'Send message')).toBeEnabled()
    if (submit === 'keyboard') await composer.press('Enter')
    else await exactButton(chat, 'Send message').click()
    try {
      await expect.poll(() => sending).toBe(true)
      await expect(composer).toBeFocused()
      await expect(composer).toBeEditable()
      await expect(exactButton(chat, 'Send message').locator('svg.animate-spin')).toHaveCount(0)
      await composer.fill('Keep this next draft')
      if (submit === 'button') {
        await pasteClipboardImage(page, composer)
        const attachments = chat.getByRole('list', { name: 'Image attachments' })
        await expect(attachments.getByRole('img')).toHaveCount(1)
        await attachments.getByRole('button', { name: /^Remove image/ }).click()
        await expect(attachments).toHaveCount(0)
        await pasteClipboardImage(page, composer)
        await expect(attachments.getByRole('img')).toHaveCount(1)
      }
    } finally {
      release()
    }
    await expect.poll(() => mock.calls('send-turn').length).toBe(1)
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue('Keep this next draft')
    await expect(composer).toBeEditable()
    if (submit === 'button') {
      await expect(chat.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
      expect(mock.calls('send-turn')[0]?.images).toEqual([])
      expect((await new AxeBuilder({ page }).include('[aria-label="Message composer"]').analyze()).violations).toEqual(
        [],
      )
    }
  })
}

test('preserves a newer draft when the preceding message fails', async ({ page }) => {
  await mockTengri(page)
  let sending = false
  const { promise: held, resolve: release } = Promise.withResolvers<void>()
  await routeTengriAction(page, 'send-turn', async (_request, route) => {
    sending = true
    await held
    return replyWithError(route, 403, 'This message was not permitted')
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const composer = composerInput(chat)
  await composer.fill('The original message')
  await expect(exactButton(chat, 'Send message')).toBeEnabled()
  await composer.press('Enter')
  try {
    await expect.poll(() => sending).toBe(true)
    await composer.fill('My newer draft')
  } finally {
    release()
  }
  await expect(chat.getByRole('alert')).toHaveText('This message was not permitted')
  await expect(composer).toHaveValue('My newer draft')
  await expect(chat.getByRole('article', { name: 'Your message' })).toHaveText('The original message')
})

for (const { phase, confirmationThread } of [
  { phase: 'running', confirmationThread: 'thread-1' },
  { phase: 'succeeded', confirmationThread: 'thread-1' },
  { phase: 'running', confirmationThread: 'another-thread' },
] as const) {
  const name =
    confirmationThread === 'thread-1'
      ? `recovers a ${phase} message after its submission response is lost`
      : 'rejects a message confirmation from a different conversation'
  test(name, async ({ page }) => {
    await mockTengri(page)
    let operationId = ''
    let sends = 0
    await routeTengriPost(page, async (action, route) => {
      if (action.action === 'send-turn') {
        sends++
        operationId = String(action.operationId)
        return replyWithError(route, 503, 'Tengri control plane is unavailable')
      }
      if (action.action === 'codex-run' && operationId) {
        expect(action.runId).toBe(operationId)
        return replyWithResult(route, codexRun(operationId, confirmationThread, { phase, turnId: 'turn-recovered' }))
      }
      return route.fallback()
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const composer = composerInput(chat)
    await composer.fill('Keep the accepted operation')
    await expect(exactButton(chat, 'Send message')).toBeEnabled()
    await composer.press('Enter')
    await expect.poll(() => sends).toBe(1)
    if (confirmationThread !== 'thread-1') {
      await expect(chat.getByRole('alert')).toHaveText('Message confirmation returned a different conversation')
      await expect(composer).toHaveValue('Keep the accepted operation')
      await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Ready')
      expect(sends).toBe(1)
      return
    }
    await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText(phase === 'running' ? 'Working' : 'Ready')
    await expect(composer).toHaveValue('')
    await expect(composer).toBeFocused()
    await expect(chat.getByRole('alert')).toHaveCount(0)
    expect(sends).toBe(1)
  })
}

for (const destination of ['selected', 'existing', 'new'] as const) {
  test(`preserves drafts after thread creation rejects while ${destination}`, async ({ page }) => {
    await mockTengri(page, {
      threadStore: {
        threads: [savedChat('thread-existing', 'Existing', 1)],
      },
    })

    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    let creating = false
    let rejectCreation = true
    await routeTengriAction(page, 'create-thread', async (_request, route) => {
      if (!rejectCreation) return route.fallback()

      creating = true
      await held
      return replyWithError(route, 503, 'Creation failed for this test')
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const sidebar = chat.getByTestId('agent-conversation-sidebar')
    const composer = composerInput(chat)
    await composer.fill('Original unsent message')
    await exactButton(chat, 'Send message').click()
    try {
      await expect.poll(() => creating).toBe(true)
      if (destination !== 'selected') {
        await composer.fill('Next pending draft')
        await sidebar.locator('[data-conversation-id="thread-existing"]').click()
        await expect(composer).toBeEnabled()
        if (destination === 'new') await exactButton(sidebar, 'New conversation').click()
        await composer.fill('Unrelated draft')
      }
    } finally {
      release()
    }
    if (destination === 'selected') {
      await expect(composer).toHaveValue('Original unsent message')
      await sidebar.locator('[data-conversation-id="thread-existing"]').click()
      await exactButton(sidebar, 'New conversation').click()
      await expect(composer).toHaveValue('Original unsent message')
    } else {
      await expect(exactButton(chat, 'Recover unsent draft 1')).toBeEnabled()
      await expect(composer).toHaveValue('Unrelated draft')
      await exactButton(chat, 'Recover unsent draft 1').click()
      await expect(composer).toHaveValue('Original unsent message')
      await exactButton(chat, 'Recover unsent draft 1').click()
      await expect(composer).toHaveValue('Next pending draft')
      if (destination === 'existing') {
        await sidebar.locator('[data-conversation-id="thread-existing"]').click()
        await expect(composer).toHaveValue('Unrelated draft')
        await exactButton(sidebar, 'New conversation').click()
        await expect(composer).toHaveValue('Next pending draft')
      } else {
        await exactButton(chat, 'Recover unsent draft 1').click()
        await expect(composer).toHaveValue('Unrelated draft')
      }
    }
    rejectCreation = false
    await exactButton(chat, 'Send message').click()
    await expect(sidebar.locator('[data-conversation-id="thread-1"]')).toBeVisible()
  })
}

for (const outcome of ['completed', 'uncertain'] as const) {
  test(`handles a ${outcome} follow-up without losing or duplicating the message`, async ({ page }) => {
    const run: TengriCodexRun = codexRun('33333333-3333-4333-8333-333333333333', 'thread-active', {
      phase: 'running',
      turnId: 'turn-active',
    })
    const mock = await mockTengri(page, {
      durableRun: run,
      resumeThreadRawJson: codexHistory([runningTurn('turn-active')], { id: 'thread-active' }),
    })
    await selectSavedThread(page, 'thread-active')
    const controls: string[] = []
    let completionReads = 0
    await routeTengriPost(page, async (action, route) => {
      if (action.action === 'codex-run' && controls.length && outcome === 'completed' && ++completionReads >= 2)
        run.state = { phase: 'succeeded', turnId: 'turn-active' }
      if (action.action !== 'steer-turn') return route.fallback()
      controls.push(String(action.operationId))
      return route.fulfill({
        status: outcome === 'completed' ? 409 : 503,
        json: {
          error: 'The turn changed before this control was delivered. Try again.',
          ...(outcome === 'completed' ? { code: 'control_not_dispatched' } : {}),
        },
      })
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const composer = composerInput(chat)
    await composer.fill('Keep this follow-up')
    await exactButton(chat, 'Steer turn').click()
    if (outcome === 'completed') {
      await expect.poll(() => mock.calls('send-turn').length).toBe(1)
      const sent = mock.calls('send-turn')[0]
      expect(sent).toMatchObject({ text: 'Keep this follow-up', threadId: 'thread-active' })
      expect(sent?.operationId).not.toBe(controls[0])
      await expect(chat.getByRole('alert')).toHaveCount(0)
      await expect(chat.getByRole('article', { name: 'Your message' })).toHaveText('Keep this follow-up')
    } else {
      await expect(composer).toHaveValue('Keep this follow-up')
      await expect(composer).toBeEnabled()
      await exactButton(chat, 'Steer turn').click()
      await expect.poll(() => controls.length).toBe(2)
      expect(controls[1]).toBe(controls[0])
      expect(mock.calls('send-turn')).toHaveLength(0)
    }
  })
}

test('keeps the chat connection and models when another desktop window takes focus', async ({ page }) => {
  const mock = await visitDesktop(page)
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByLabel('Model', { exact: true })).toBeEnabled()
  const before = mock.actions.filter(
    (action) => action.action === 'codex-models' || action.action === 'codex-account',
  ).length
  const streamCount = () =>
    page.evaluate(
      () =>
        Reflect.get(window, '__tengriEventSources').filter((source: { url: string }) =>
          source.url.includes('/api/tengri/events?'),
        ).length,
    )
  const beforeStreams = await streamCount()
  const dock = desktopDock(page)
  await exactButton(dock, 'Open Finder').click()
  await emitCodexEvent(page, {
    threadId: '',
    turnId: '',
    itemId: 'background-answer',
    text: 'Arrived while Finder was focused.',
  })
  await expect(tengri.getByText('Arrived while Finder was focused.', { exact: true })).toBeAttached()
  await exactButton(dock, 'Open Tengri').click()
  await expect(tengri.getByLabel('Model', { exact: true })).toBeEnabled()
  expect(
    mock.actions.filter((action) => action.action === 'codex-models' || action.action === 'codex-account').length,
  ).toBe(before)
  expect(await streamCount()).toBe(beforeStreams)
})

test('clears restart notices when the runtime recovers before starting another turn', async ({ page }) => {
  const mock = await visitDesktop(page)
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByLabel('Model', { exact: true })).toBeEnabled()
  for (const sequence of [1, 2])
    await emitCodexEvent(page, {
      sequence,
      kind: 'error',
      method: 'error',
      threadId: '',
      turnId: '',
      text: 'Codex app-server is restarting',
    })
  await expect(tengri.getByText('Codex app-server is restarting', { exact: true })).toHaveCount(1)
  await emitCodexEvent(page, {
    sequence: 3,
    kind: 'thread-state',
    method: 'tengri/runtimeReady',
    threadId: '',
    turnId: '',
  })
  await expect(tengri.getByText('Codex app-server is restarting', { exact: true })).toHaveCount(0)
  await exactButton(tengri, 'New conversation').click()
  await expect(tengri.getByText('Codex app-server is restarting', { exact: true })).toHaveCount(0)
  expect(mock.calls('create-thread', 'send-turn')).toHaveLength(0)
})

test('sends a real agent turn and executes sleep, resume, and confirmed deletion', async ({ page }) => {
  const mock = await visitDesktop(page)

  const prompt = page.getByLabel('Message your agent')
  await prompt.fill('Inspect the workspace and summarize it.')
  await prompt.press('Enter')
  await expect.poll(() => mock.calls('create-thread').length > 0).toBe(true)
  await expectTengriCall(mock, 'send-turn', { text: 'Inspect the workspace and summarize it.' })

  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = desktopWindow(page, 'Settings')
  await openSettingsPane(settings, 'Power & Sleep')
  await exactButton(settings, 'Sleep').click()
  await expect.poll(() => mock.calls('sleep-agent').length > 0).toBe(true)
  const sleeping = page.getByRole('dialog', { name: 'Tengri is sleeping' })
  await expect(sleeping).toBeVisible()
  await sleeping.getByRole('button', { name: 'Resume Agent' }).click()
  await expect(dock).toBeVisible()
  await expect.poll(() => mock.getAgent()?.phase).toBe('ready')

  await dock.getByRole('button', { name: 'Open Terminal' }).click()
  await expect(
    desktopWindow(page, 'Terminal')
      .getByRole('status')
      .filter({ hasText: /^Connected$/ }),
  ).toHaveAttribute('data-connection-state', 'connected')
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  await openSettingsPane(settings, 'About')
  await settings.getByRole('button', { name: 'Delete Agent' }).click()
  const deleteDialog = page.getByRole('alertdialog', { name: /Delete “Tengri”/ })
  await expect(deleteDialog).toContainText('persistent workspace')
  await page.keyboard.press('Meta+Space')
  await expect(page.getByRole('dialog', { name: 'Spotlight' })).toHaveCount(0)
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: 'Delete Agent' }).click()
  const create = page.getByRole('dialog', { name: 'Create your agent' })
  await expect(create).toBeVisible()
  expect(await desktopSessionKeys(page)).toEqual([])

  await create.getByLabel('Agent name').fill('Replacement')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(desktopDock(page)).toBeVisible()
  await expect(desktopWindow(page, 'Terminal')).toHaveCount(0)
})

test('renders one chat bubble per item lifecycle and preserves repeated prompts', async ({ page }) => {
  const mock = await visitDesktop(page)
  const text = 'Inspect the workspace again.'
  const log = page.getByRole('log')

  for (const index of [0, 1]) {
    const prompt = page.getByLabel('Message your agent')
    await prompt.fill(text)
    await prompt.press('Enter')
    await expect.poll(() => mock.calls('send-turn').length).toBe(index + 1)
    await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
    await expect(log.getByText(text, { exact: true })).toHaveCount(index + 1)
    const item = {
      kind: 'user-message' as const,
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

test('keeps identical pending prompts separate when their echoes arrive one at a time', async ({ page }) => {
  const mock = await visitDesktop(page)
  const text = 'Inspect the workspace again.'
  const log = page.getByRole('log')
  await page.getByLabel('Message your agent').fill(text)
  await exactButton(page, 'Send message').click()
  await page.getByLabel('Steer the current turn').fill(text)
  await exactButton(page, 'Steer turn').click()
  await expect.poll(() => mock.calls('steer-turn').length).toBe(1)
  await expect(log.getByText(text, { exact: true })).toHaveCount(2)
  const item = codexEvent({ kind: 'user-message', itemId: 'first-user', text })
  await emitCodexEvent(page, { ...item, sequence: 1 })
  await emitCodexEvent(page, {
    ...item,
    sequence: 2,
    itemId: 'response',
    kind: 'assistant-text',
    text: 'Reading the workspace.',
  })
  await expect(log.getByRole('article', { name: 'Codex response' })).toHaveText('Reading the workspace.')
  await expect(log.getByText(text, { exact: true })).toHaveCount(2)
  await emitCodexEvent(page, { ...item, sequence: 3, itemId: 'second-user' })
  await expect(log.getByText(text, { exact: true })).toHaveCount(2)
})

test('keeps the transcript visible when a turn finishes before its prompt echo', async ({ page }) => {
  await visitDesktop(page)
  await page.getByLabel('Message your agent').fill('Inspect the workspace.')
  await exactButton(page, 'Send message').click()
  await expect(exactButton(page, 'Stop response')).toBeVisible()
  await emitCodexEvent(page, { kind: 'thread-state', method: 'turn/completed' })
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  await expect(page.getByRole('article', { name: 'Your message' })).toHaveText('Inspect the workspace.')
  await expect(exactButton(page, 'Explore the project')).toHaveCount(0)
  await exactButton(page, 'New conversation').click()
  await expect(page.getByRole('article', { name: 'Your message' })).toHaveCount(0)
  await expect(exactButton(page, 'Explore the project')).toBeVisible()
})

test('maximizes and restores windows by double-clicking the title bar', async ({ page }, testInfo) => {
  await visitDesktop(page)
  for (const app of ['Tengri', 'Chrome']) {
    await exactButton(page, `Open ${app}`).click()
    const frame = page.getByRole('region', { name: `${app} window` })
    const normalBounds = await frame.boundingBox()
    const titleBar = frame.locator(':scope > header')
    await titleBar.dblclick({ position: { x: 140, y: 18 } })
    await expect(frame.getByRole('button', { name: `Restore ${app}` })).toBeVisible()
    await expect.poll(() => frame.boundingBox()).toEqual({ x: 0, y: 30, width: 1440, height: 870 })
    if (app === 'Tengri') {
      const path = testInfo.outputPath('tengri-titlebar-maximized.png')
      await frame.screenshot({ path })
      await testInfo.attach('tengri-titlebar-maximized', { path, contentType: 'image/png' })
    }
    await titleBar.dblclick()
    await expect(frame.getByRole('button', { name: `Maximize ${app}` })).toBeVisible()
    await expect.poll(() => frame.boundingBox()).toEqual(normalBounds)
    await frame.getByRole('button', { name: `Maximize ${app}` }).click()
    await frame.getByRole('button', { name: `Restore ${app}` }).click()
    await expect.poll(() => frame.boundingBox()).toEqual(normalBounds)
  }
})

test('keeps Code content flush with the bottom and right window edges', async ({ page }, testInfo) => {
  await visitDesktop(page)
  const frame = await openDesktopApp(page, 'Code')
  await expect(frame.getByText('VS Code is unavailable in this guest.')).toBeVisible()
  const path = testInfo.outputPath('code-window-edges.png')
  const png = await frame.screenshot({ path })
  const edgeBrightness = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
    context.drawImage(image, 0, 0)
    const brightness = (x: number, y: number) => Math.max(...context.getImageData(x, y, 1, 1).data.slice(0, 3))
    const right = brightness(image.width - 1, image.height / 2) - brightness(image.width - 3, image.height / 2)
    const bottom = brightness(image.width / 2, image.height - 1) - brightness(image.width / 2, image.height - 3)
    image.close()
    return { right, bottom }
  }, png.toString('base64'))
  expect(edgeBrightness.right).toBeLessThanOrEqual(2)
  expect(edgeBrightness.bottom).toBeLessThanOrEqual(2)
  await testInfo.attach('code-window-edges', { path, contentType: 'image/png' })
})

test('keeps normal windows above the Dock and fills fullscreen without gaps', async ({ page }) => {
  await visitDesktop(page)
  const dock = desktopDock(page)
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  const dockBounds = await dock.boundingBox()
  expect(dockBounds).not.toBeNull()
  for (const region of await page.getByRole('region', { name: /window$/ }).all()) {
    const bounds = await region.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.y + bounds!.height).toBeLessThan(dockBounds!.y)
  }
  for (const app of ['Tengri', 'Chrome']) {
    await exactButton(page, `Open ${app}`).click()
    const frame = page.getByRole('region', { name: `${app} window` })
    const normalBounds = await frame.boundingBox()
    await frame.getByRole('button', { name: `Maximize ${app}` }).click()
    await frame.focus()
    await page.mouse.move(100, 200)
    await expect.poll(() => frame.boundingBox()).toEqual({ x: 0, y: 30, width: 1440, height: 870 })
    await expect(frame).toHaveCSS('border-radius', '0px')
    await expect.poll(async () => (await dock.boundingBox())?.y ?? 0).toBeGreaterThan(890)
    await page.mouse.move(720, 899)
    await expect.poll(async () => (await dock.boundingBox())?.y ?? 900).toBeLessThan(850)
    await expect(dock.locator('..')).toHaveCSS('translate', /^0px(?: 0px)?$/)
    await dock.getByRole('button', { name: 'Open Settings' }).focus()
    await page.mouse.move(100, 200)
    await expect.poll(async () => (await dock.boundingBox())?.y ?? 900).toBeLessThan(850)
    await frame.getByRole('button', { name: `Restore ${app}` }).click()
    await expect.poll(() => frame.boundingBox()).toEqual(normalBounds)
  }
  await page.setViewportSize({ width: 390, height: 760 })
  await desktopWindow(page, 'Chrome').getByRole('button', { name: 'Maximize Chrome' }).click()
  await expect
    .poll(() => desktopWindow(page, 'Chrome').boundingBox())
    .toEqual({
      x: 0,
      y: 30,
      width: 390,
      height: 730,
    })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Restore Chrome' })).toBeVisible()
  await expect
    .poll(() => desktopWindow(page, 'Chrome').boundingBox())
    .toEqual({
      x: 0,
      y: 30,
      width: 390,
      height: 730,
    })
})

test('refits persisted windows above the Dock after reload and browser resize', async ({ page }) => {
  await mockTengri(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const dock = desktopDock(page)
  const tengri = page.locator('section[aria-label="Tengri window"]')
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  const desktopId = await page.evaluate((agentId) => sessionStorage.getItem(`tengri:desktop:${agentId}`), readyAgent.id)
  expect(desktopId).toMatch(/^[0-9a-f]{32}$/)

  const oldBounds = { x: 300, y: 149, width: 1060, height: 700 }
  await page.evaluate(
    ({ agentId, desktopId, oldBounds }) => {
      if (!desktopId) throw new Error('desktop identity was not persisted')
      const key = `tengri:windows:${agentId}:${desktopId}:v2`
      const state = JSON.parse(sessionStorage.getItem(key) ?? 'null') as {
        windows?: Array<{ app?: string; bounds?: object; restoredBounds?: object; mode?: string }>
      }
      const tengri = state.windows?.find((window) => window.app === 'tengri')
      if (!tengri) throw new Error('persisted Tengri window was not found')
      tengri.bounds = oldBounds
      tengri.restoredBounds = oldBounds
      tengri.mode = 'normal'
      sessionStorage.setItem(key, JSON.stringify(state))
    },
    { agentId: readyAgent.id, desktopId, oldBounds },
  )

  await page.reload()
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  await expect(tengri).toBeVisible()

  const expectTengriAboveDock = async () => {
    const [tengriBounds, dockBounds] = await Promise.all([tengri.boundingBox(), dock.boundingBox()])
    return tengriBounds && dockBounds ? tengriBounds.y + tengriBounds.height - dockBounds.y : Number.POSITIVE_INFINITY
  }
  await expect.poll(expectTengriAboveDock).toBeLessThanOrEqual(0)

  await page.setViewportSize({ width: 1440, height: 774 })
  await expect.poll(expectTengriAboveDock).toBeLessThanOrEqual(0)

  await tengri.getByRole('button', { name: 'Minimize Tengri' }).click()
  await expect(tengri).toHaveAttribute('aria-hidden', 'true')
  await dock.getByRole('button', { name: 'Open Tengri' }).click()
  await expect(tengri).not.toHaveAttribute('aria-hidden', 'true')
  await expect.poll(expectTengriAboveDock).toBeLessThanOrEqual(0)

  await tengri.getByRole('button', { name: 'Maximize Tengri' }).click()
  await expect(tengri.getByRole('button', { name: 'Restore Tengri' })).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.setViewportSize({ width: 1440, height: 774 })
  await tengri.getByRole('button', { name: 'Restore Tengri' }).click()
  await expect(tengri.getByRole('button', { name: 'Maximize Tengri' })).toBeVisible()
  await expect.poll(expectTengriAboveDock).toBeLessThanOrEqual(0)
})

test('propagates deletion cleanup to every open desktop tab', async ({ page }) => {
  const terminalStore: TerminalStore = { sessions: [] }
  await visitDesktop(page, { terminalStore })

  const duplicate = await page.context().newPage()
  await visitDesktop(duplicate, { terminalStore })
  await duplicate.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Terminal' }).click()
  await expect(
    desktopWindow(duplicate, 'Terminal')
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

  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = desktopWindow(page, 'Settings')
  await openSettingsPane(settings, 'About')
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
  await visitDesktop(page, { agent: failedAgent })

  const duplicate = await page.context().newPage()
  const duplicateMock = await visitDesktop(duplicate, { agent: failedAgent })
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

test('can sleep and cancel a hanging model catalog without closing chat', async ({ page }) => {
  const mock = await visitDesktop(page, { holdCodexModels: true })
  await mock.heldCodexModelsStarted
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: (request) => request.method() === 'POST' && request.postDataJSON()?.action === 'codex-models',
  })
  try {
    const settings = await openDesktopApp(page, 'Settings')
    await openSettingsPane(settings, 'Power & Sleep')
    await exactButton(settings, 'Sleep').click()
    await cancelled
    await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
  } finally {
    mock.releaseHeldCodexModels()
  }
})

test('recovers the model catalog after a rejected lifecycle transition cancels its request', async ({ page }) => {
  await page.clock.install()
  const options: MockOptions = { holdCodexModels: true }
  const mock = await mockTengri(page, options)
  const sleepStarted = Promise.withResolvers<void>()
  const releaseSleep = Promise.withResolvers<void>()
  await page.route('**/api/tengri', async (route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'sleep-agent') {
      sleepStarted.resolve()
      await releaseSleep.promise
      await replyWithError(route, 503, 'Sleep is temporarily unavailable')
    } else await route.fallback()
  })
  try {
    await page.goto('/')
    await mock.heldCodexModelsStarted
    const settings = await openDesktopApp(page, 'Settings')
    await openSettingsPane(settings, 'Power & Sleep')
    await exactButton(settings, 'Sleep').click()
    await sleepStarted.promise
    options.holdCodexModels = false
    mock.releaseHeldCodexModels()
    await page.clock.runFor(1_100)
    expect(mock.calls('codex-models')).toHaveLength(1)
    releaseSleep.resolve()
    await expect(exactButton(settings, 'Sleep')).toBeEnabled()
    await page.clock.runFor(2_100)
    const tengri = desktopWindow(page, 'Tengri')
    await expect(tengri.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled()
    expect(mock.calls('codex-models')).toHaveLength(2)
  } finally {
    releaseSleep.resolve()
    mock.releaseHeldCodexModels()
  }
})

test('blocks lifecycle changes while Settings has a guest request in flight', async ({ page }) => {
  const mock = await visitDesktop(page, { holdCodexAccount: true })

  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = desktopWindow(page, 'Settings')
  await openSettingsPane(settings, 'Power & Sleep')
  const lifecycleButtons = exactButton(settings, 'Sleep')
  await openSettingsPane(settings, 'Codex')
  await expect.poll(() => mock.calls('codex-account').length).toBeGreaterThan(1)
  await openSettingsPane(settings, 'Power & Sleep')
  await expect(lifecycleButtons).toHaveCount(1)
  for (const button of await lifecycleButtons.all()) await expect(button).toBeDisabled()
  expect(mock.calls('sleep-agent')).toHaveLength(0)

  mock.releaseHeldCodexAccount()
  await exactButton(settings, 'Sleep').click()
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
})

test('blocks lifecycle changes while Tengri has a device-login refresh in flight', async ({ page }) => {
  const mock = await visitDesktop(page, { codexAuthenticated: false, holdCodexAccountAfterLogin: true })

  const tengri = desktopWindow(page, 'Tengri')
  await tengri.getByRole('button', { name: 'Start device login' }).click()
  await tengri.getByRole('button', { name: 'I’ve completed login' }).click()
  await mock.waitForHeldCodexAccount()

  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = desktopWindow(page, 'Settings')
  await openSettingsPane(settings, 'Power & Sleep')
  await openSettingsPane(settings, 'Codex')
  await expect.poll(() => mock.calls('codex-account').length).toBeGreaterThan(2)
  await openSettingsPane(settings, 'Power & Sleep')
  await expect(exactButton(settings, 'Sleep')).toBeDisabled()

  mock.releaseHeldCodexAccount()
  await exactButton(settings, 'Sleep').click()
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
})

test('restores an active Codex device login without replacing its code', async ({ page }) => {
  const mock = await mockTengri(page, {
    activeCodexLogin: true,
    codexAuthenticated: false,
  })
  await page.goto('/')

  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByText('TENG-RI99')).toBeVisible()
  expect(mock.calls('codex-login-status')).toHaveLength(1)
  expect(mock.calls('codex-login')).toHaveLength(0)
})

test('restores an active Codex device login after retrying a failed account check', async ({ page }) => {
  const mock = await mockTengri(page, {
    activeCodexLogin: true,
    codexAuthenticated: false,
    failCodexAccountUntilReleased: true,
  })
  await page.goto('/')

  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('button', { name: 'Retry' })).toBeVisible()
  mock.releaseCodexAccountFailures()
  await tengri.getByRole('button', { name: 'Retry' }).click()
  await expect(tengri.getByText('TENG-RI99')).toBeVisible()
  expect(mock.calls('codex-login-status')).toHaveLength(1)
  expect(mock.calls('codex-login')).toHaveLength(0)
})

test('does not refresh the guest account after sleep starts', async ({ page }) => {
  const mock = await visitDesktop(page, { holdLifecycleAction: 'sleep-agent' })

  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = desktopWindow(page, 'Settings')
  await openSettingsPane(settings, 'Power & Sleep')
  await exactButton(settings, 'Sleep').click()
  await mock.waitForHeldLifecycleAction()
  const accountRequestCount = mock.calls('codex-account').length

  await dock.getByRole('button', { name: 'Open Finder' }).click()
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  await page.waitForTimeout(100)
  expect(mock.calls('codex-account')).toHaveLength(accountRequestCount)

  mock.releaseHeldLifecycleAction()
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
})

test('keeps the desktop active after superseded sleep and allocates a fresh operation on retry', async ({ page }) => {
  const mock = await visitDesktop(page, { supersedeSleepOnce: true })
  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  const settings = desktopWindow(page, 'Settings')
  await openSettingsPane(settings, 'Power & Sleep')
  await exactButton(settings, 'Sleep').click()
  await expect(page.getByText('A newer workspace transition replaced this request.')).toBeVisible()
  await expect(dock).toBeVisible()
  await exactButton(settings, 'Sleep').click()
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
  const sleeps = mock.calls('sleep-agent')
  expect(sleeps).toHaveLength(2)
  expect(sleeps[1].operationId).not.toBe(sleeps[0].operationId)
})

test('keeps a committed delete transition gated when snapshot refresh fails', async ({ page }) => {
  await visitDesktop(page, { failSnapshotAfterAction: 'delete-agent' })

  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Settings' }).click()
  await openSettingsPane(desktopWindow(page, 'Settings'), 'About')
  await desktopWindow(page, 'Settings').getByRole('button', { name: 'Delete Agent' }).click()
  await page
    .getByRole('alertdialog', { name: /Delete “Tengri”/ })
    .getByRole('button', { name: 'Delete Agent' })
    .click()

  await expect(page.getByRole('heading', { name: 'Deleting Tengri' })).toBeVisible()
  await expect(page.getByText('Waiting for controller state')).toBeVisible()
  await expect(desktopDock(page)).toHaveCount(0)
})

test('shows one quiet missing-conversation state and keeps new chat in the sidebar', async ({ page }) => {
  const failure = { status: 404, error: 'Codex conversation could not be found', code: 'conversation_not_found' }
  const mock = await mockTengri(page, { resumeThreadErrors: [failure, failure] })
  await selectSavedThread(page, 'thread-missing')
  await page.goto('/')

  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('alert')).toHaveCount(0)
  await expect(tengri.getByText('This conversation is unavailable.', { exact: true })).toBeVisible()
  await expect(exactButton(tengri, 'Retry')).toHaveCount(1)
  await expect(tengri.getByRole('form', { name: 'Message composer' })).toHaveCount(0)
  expect((await new AxeBuilder({ page }).include('[aria-label="Tengri window"]').analyze()).violations).toEqual([])

  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-missing')

  await exactButton(tengri, 'Retry').click()
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBe(2)
  await expect(exactButton(tengri, 'Retry')).toHaveCount(1)
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-missing')
  expect(mock.calls('create-thread')).toHaveLength(0)

  await exactButton(tengri.getByTestId('agent-conversation-sidebar'), 'New conversation').click()
  const prompt = tengri.getByRole('textbox', { name: 'Message your agent' })
  await expect(prompt).toBeEnabled()
  await expect(prompt).toBeFocused()
  await expect(tengri.getByRole('alert')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBeNull()
  await prompt.fill('Continue in this workspace.')
  await prompt.press('Enter')
  await expectTengriCall(mock, 'send-turn', { threadId: 'thread-1' })
  expect(mock.calls('create-thread')).toHaveLength(1)
  expect(mock.calls('create-agent', 'delete-agent', 'sleep-agent', 'resume-agent')).toHaveLength(0)
})

test('retries a temporary conversation failure without replacing the saved thread', async ({ page }) => {
  await page.clock.install()
  const mock = await mockTengri(page, {
    resumeThreadErrors: [{ status: 503, error: 'Tengri control plane is unavailable' }],
  })
  await selectSavedThread(page, 'thread-recoverable')
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('alert')).toHaveCount(0)
  await expect(tengri.getByRole('status', { name: 'Loading conversation', exact: true })).toBeVisible()
  await expect(exactButton(tengri, 'Start a new conversation')).toHaveCount(0)
  await page.clock.runFor(1_000)
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await expect(tengri.getByRole('alert')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-recoverable')
  expect(mock.calls('create-thread')).toHaveLength(0)
  await page.clock.runFor(31_000)
  await expect(exactButton(tengri, 'Retry')).toHaveCount(0)
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  expect(mock.calls('resume-thread')).toHaveLength(2)
})

test('clears an unavailable sidebar marker after successful conversation recovery', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:00:00.000Z'))
  await visitDesktop(page, {
    savedThread: 'thread-recoverable',
    threadStore: {
      threads: [savedChat('thread-recoverable', 'Recoverable', 1)],
    },
    resumeThreadErrors: [{ status: 404, error: 'Conversation unavailable', code: 'conversation_not_found' }],
  })
  const tengri = desktopWindow(page, 'Tengri')
  const row = tengri.locator('[data-conversation-id="thread-recoverable"]')
  await expect(row.getByText('Unavailable', { exact: true })).toBeVisible()
  await exactButton(tengri, 'Retry').click()
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await expect(row.getByText('Unavailable', { exact: true })).toHaveCount(0)
  await expect(row).toContainText('Recoverable')
})

test('ignores obsolete browser registry entries when recovering a native session', async ({ page }) => {
  const now = Date.parse('2026-08-26T12:00:00.000Z')
  await page.clock.setFixedTime(new Date(now))
  await visitDesktop(page, {
    savedThread: 'thread-recoverable',
    threadStore: {
      threads: [savedChat('thread-recoverable', 'Recoverable', 1)],
    },
  })
  const tengri = desktopWindow(page, 'Tengri')
  const sidebar = tengri.getByTestId('agent-conversation-sidebar')
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await sidebar.getByRole('button', { name: 'New conversation' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBeNull()
  await page.evaluate((updatedAt) => {
    localStorage.setItem(
      'tengri-conversations:microvm-ada',
      JSON.stringify([{ id: 'thread-recoverable', title: 'Recoverable', updatedAt, unavailable: true }]),
    )
  }, now + 100)
  const row = sidebar.locator('[data-conversation-id="thread-recoverable"]')
  await expect(row.getByText('Unavailable', { exact: true })).toHaveCount(0)
  await row.click()
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await expect(row.getByText('Unavailable', { exact: true })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tengri-conversations:microvm-ada') ?? '[]')))
    .toEqual([{ id: 'thread-recoverable', title: 'Recoverable', updatedAt: now + 100, unavailable: true }])
})

test('keeps sending, steering, and stopping in the composer', async ({ page }) => {
  const mock = await visitDesktop(page)
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
  expect(mock.calls('interrupt-turn')).toHaveLength(0)
  await prompt.fill('Only inspect the current directory.')
  await expect(action).toHaveCount(1)
  await expect(exactButton(composer, 'Stop response')).toHaveCount(0)
  let steeringPending = false
  let releaseSteering!: () => void
  const steeringResponse = new Promise<void>((resolve) => {
    releaseSteering = resolve
  })
  await page.route('**/api/tengri', async (route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'steer-turn') {
      steeringPending = true
      await steeringResponse
    }
    return route.fallback()
  })
  await exactButton(composer, 'Steer turn').click()
  try {
    await expect.poll(() => steeringPending).toBe(true)
    await prompt.fill('Keep this next steering draft.')
    await expect(action).toHaveCount(1)
    await expect(action).toHaveAccessibleName('Steer turn')
    await expect(action).toBeDisabled()
    await expect(exactButton(composer, 'Stop response')).toHaveCount(0)
  } finally {
    releaseSteering()
  }
  await expectTengriCall(mock, 'steer-turn', { turnId: 'turn-1' })
  await expect(action).toBeEnabled()
  await expect(prompt).toHaveValue('Keep this next steering draft.')
  await prompt.fill('')
  await expect(action).toHaveAccessibleName('Stop response')
  await action.click()
  await expectTengriCall(mock, 'interrupt-turn', {
    runId: mock.calls('send-turn')[0]?.operationId,
    operationId: expect.any(String),
  })
  await emitCodexEvent(page, { kind: 'thread-state', method: 'turn/completed' })
  await expect(action).toHaveAccessibleName('Send message')
  await expect(action).toHaveCount(1)
  await expect(action).toBeDisabled()
})

for (const phase of ['running', 'accepted'] as const) {
  test(`ends ${phase} response activity while durable finalization is delayed`, async ({ page }) => {
    const run: TengriCodexRun = codexRun(
      '55555555-5555-4555-8555-555555555555',
      'thread-finishing',
      phase === 'accepted' ? { phase } : { phase, turnId: 'turn-finishing' },
    )
    await mockTengri(page, {
      durableRun: structuredClone(run),
      resumeThreadRawJson: codexHistory([runningTurn('turn-finishing')]),
    })
    let polls = 0
    await routeTengriAction(page, 'codex-run', async (_request, route) => {
      polls += 1
      return replyWithResult(route, run)
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const activity = chat.getByRole('status', { name: 'Agent activity' })
    await expect(activity).toHaveText('Thinking')
    await emitCodexEvent(page, {
      kind: 'user-message',
      method: 'item/started',
      threadId: run.threadId,
      turnId: 'turn-finishing',
      itemId: 'user-finishing',
      text: 'The accepted message',
      rawJson: codexParams({
        item: {
          id: 'user-finishing',
          type: 'userMessage',
          clientId: run.runId,
          content: [{ type: 'text', text: 'The accepted message' }],
        },
      }),
    })
    await emitCodexEvent(page, {
      sequence: 2,
      kind: 'thread-state',
      method: 'turn/completed',
      threadId: run.threadId,
      turnId: 'turn-older',
    })
    await expect(activity).toHaveText('Thinking')
    await emitCodexEvent(page, {
      sequence: 3,
      kind: 'thread-state',
      method: 'turn/completed',
      threadId: run.threadId,
      turnId: 'turn-finishing',
    })
    await expect(activity).toHaveCount(0)
    await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Ready')
    await expect(exactButton(chat, 'Stop response')).toBeEnabled()
    const prompt = chat.getByRole('textbox', { name: 'Message your agent' })
    await prompt.fill('The next draft stays editable.')
    const send = exactButton(chat, 'Send message')
    await expect(send).toBeDisabled()
    const previousPolls = polls
    await expect.poll(() => polls).toBeGreaterThan(previousPolls)
    await expect(activity).toHaveCount(0)
    run.state = { phase: 'succeeded', turnId: 'turn-finishing' }
    await expect(send).toBeEnabled()
    await expect(exactButton(chat, 'Stop response')).toHaveCount(0)
    await expect(prompt).toHaveValue('The next draft stays editable.')
  })
}

test('ends activity before a delayed send acknowledgement without losing the next draft', async ({ page }) => {
  await mockTengri(page)
  const posted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let operationId = ''
  let threadId = ''
  await routeTengriPost(page, async (action, route) => {
    if (action.action === 'send-turn') {
      operationId = action.operationId
      threadId = action.threadId
      posted.resolve()
      await release.promise
      return replyWithResult(route, codexRun(operationId, threadId, { phase: 'accepted' }))
    }
    if (action.action === 'codex-run' && action.runId === operationId)
      return replyWithResult(route, codexRun(operationId, threadId, { phase: 'succeeded', turnId: 'turn-fast' }))
    return route.fallback()
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const prompt = composerInput(chat)
  await prompt.fill('A fast response')
  await exactButton(chat, 'Send message').click()
  await posted.promise
  try {
    await emitCodexEvent(page, { kind: 'thread-state', method: 'turn/started', threadId, turnId: 'turn-fast' })
    await emitCodexEvent(page, {
      sequence: 2,
      kind: 'user-message',
      method: 'item/started',
      threadId,
      turnId: 'turn-fast',
      itemId: 'user-fast',
      text: 'A fast response',
      rawJson: codexParams({
        item: {
          type: 'userMessage',
          clientId: operationId,
          id: 'user-fast',
          content: [{ type: 'text', text: 'A fast response' }],
        },
      }),
    })
    await prompt.fill('Keep the next draft.')
    await emitCodexEvent(page, {
      sequence: 3,
      kind: 'thread-state',
      method: 'turn/completed',
      threadId,
      turnId: 'turn-fast',
    })
    await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
    await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Ready')
    await expect(prompt).toHaveValue('Keep the next draft.')
  } finally {
    release.resolve()
  }
  await expect(exactButton(chat, 'Send message')).toBeEnabled()
  await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
  await expect(prompt).toHaveValue('Keep the next draft.')
})

for (const phase of ['running', 'accepted'] as const) {
  for (const status of ['completed', 'failed', 'interrupted']) {
    test(`keeps restored ${status} turns idle while durable ${phase} status is stale`, async ({ page }) => {
      await page.clock.install()
      const mock = await mockTengri(page, {
        durableRun: codexRun(
          '66666666-6666-4666-8666-666666666666',
          'thread-restored',
          phase === 'accepted' ? { phase } : { phase, turnId: 'turn-restored' },
        ),
        resumeThreadRawJson: codexHistory([
          {
            id: 'turn-restored',
            status,
            items: [
              {
                id: 'user-restored',
                type: 'userMessage',
                clientId: '66666666-6666-4666-8666-666666666666',
                content: [],
              },
            ],
          },
        ]),
      })
      await page.goto('/')
      const chat = desktopWindow(page, 'Tengri')
      await expect(chat.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
      await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
      await page.clock.runFor(2_100)
      await expect.poll(() => mock.calls('active-codex-runs').length).toBeGreaterThan(1)
      await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
      await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Ready')
      await expect(exactButton(chat, 'Stop response')).toBeEnabled()
    })
  }
}

test('retire a turn completed in recovered history after its live start arrived during loading', async ({ page }) => {
  const runId = '99999999-9999-4999-8999-999999999999'
  const mock = await mockTengri(page, {
    durableRun: codexRun(runId, 'thread-snapshot-race', { phase: 'accepted' }),
    holdInitialResume: true,
    resumeThreadEventSequence: 20,
    resumeThreadRawJson: codexHistory([
      completedTurn('turn-snapshot-race', [{ id: 'user-snapshot', type: 'userMessage', clientId: runId, content: [] }]),
    ]),
  })
  await page.goto('/')
  await mock.waitForHeldResume()
  try {
    await emitCodexEvent(page, {
      sequence: 10,
      method: 'turn/started',
      kind: 'thread-state',
      threadId: 'thread-snapshot-race',
      turnId: 'turn-snapshot-race',
    })
    mock.releaseHeldResume()
    const chat = desktopWindow(page, 'Tengri')
    await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
    await expect(chat.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
    await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Ready')
  } finally {
    mock.releaseHeldResume()
  }
})

test('uses the current session to recover the accepted run without another send', async ({ page }) => {
  const run: TengriCodexRun = codexRun('88888888-8888-4888-8888-888888888888', 'thread-recovery', {
    phase: 'authorization_required',
    turnId: 'turn-recovery',
    reason: 'Use your current session.',
  })
  const mock = await mockTengri(page, {
    durableRun: run,
    threadStore: {
      threads: [savedChat(run.threadId, 'Conversation awaiting reconnect', 1)],
    },
    resumeThreadRawJson: codexHistory([runningTurn('turn-recovery')]),
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Status unavailable')
  await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
  const row = exactButton(chat, 'Conversation awaiting reconnect')
  await expect(row).toHaveAttribute('aria-description', 'Needs you')
  await expect(row.locator('..').locator('.animate-spin')).toHaveCount(0)
  await exactButton(chat, 'Reconnect').click()
  await expect.poll(() => mock.calls('recover-run').length).toBe(1)
  const recovery = mock.calls('recover-run')[0]
  expect(recovery).toMatchObject({ runId: run.runId, agentId: run.agentId })
  expect(recovery?.operationId).toMatch(/^[a-f0-9-]{36}$/)
  expect(mock.calls('send-turn')).toHaveLength(0)
})

for (const phase of ['cancelling', 'needs_reconciliation'] as const) {
  test(`keeps ${phase} visible until the durable cleanup outcome is confirmed`, async ({ page }) => {
    const run: TengriCodexRun = codexRun(
      '88888888-8888-4888-8888-888888888888',
      'thread-cleanup',
      phase === 'cancelling'
        ? { phase, turnId: 'turn-cleanup', reason: 'Waiting for process cleanup' }
        : { phase, turnId: 'turn-cleanup', reason: 'The last action could not be confirmed' },
    )
    await mockTengri(page, {
      durableRun: run,
      resumeThreadRawJson: codexHistory([
        {
          id: 'turn-cleanup',
          status: 'interrupted',
          items: [{ id: 'user-cleanup', type: 'userMessage', clientId: run.runId, content: [] }],
        },
      ]),
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const status = chat.getByLabel('Agent status', { exact: true })
    await expect(status).toHaveText(phase === 'cancelling' ? 'Stopping' : 'Response unconfirmed')
    await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
    await expect(exactButton(chat, 'Check again')).toHaveCount(0)
    run.state = { phase: 'cancelled', turnId: 'turn-cleanup' }
    await expect(status).toHaveText('Ready')
  })
}

test('reopens the composer after an interrupted run without replaying the accepted message', async ({ page }) => {
  const run: TengriCodexRun = codexRun('88888888-8888-4888-8888-888888888888', 'thread-fenced', {
    phase: 'needs_reconciliation',
    turnId: null,
    reason: 'The last action could not be confirmed',
  })
  const mock = await visitDesktop(page, { durableRun: run })
  const chat = desktopWindow(page, 'Tengri')
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Response unconfirmed')

  run.state = {
    phase: 'unconfirmed',
    turnId: null,
    reason: 'The workspace restarted. Earlier actions may have taken effect.',
  }
  await expect(chat.getByRole('log').getByText('Response interrupted.', { exact: true })).toBeVisible()
  await expect(chat.getByRole('button', { name: 'Stop response' })).toHaveCount(0)
  await chat.getByRole('textbox', { name: 'Message your agent' }).fill('Show the current workspace state')
  await expect(chat.getByRole('button', { name: 'Send message' })).toBeEnabled()
  expect(mock.calls('send-turn')).toHaveLength(0)
})

test('shows a text highlight while thinking and keeps reduced-motion status readable', async ({ page }, testInfo) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  const thinking = tengri.getByRole('status', { name: 'Agent activity' })
  await expect(thinking).toHaveCount(0)
  await tengri.getByRole('textbox', { name: 'Message your agent' }).fill('Inspect the workspace.')
  await tengri.getByRole('button', { name: 'Send message' }).click()
  await expect(thinking).toHaveText('Thinking')
  await expect(thinking.locator('svg')).toHaveCount(0)
  await expect(tengri.getByText('Codex is working…', { exact: true })).toHaveCount(0)
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
    kind: 'approval',
    method: 'item/commandExecution/requestApproval',
    itemId: 'approval-thinking',
    approvalId: 'approval-thinking',
    text: 'Run the workspace checks?',
    rawJson: '{"params":{"availableDecisions":["accept","decline"]}}',
  })
  await expect(exactButton(tengri, 'Deny')).toBeVisible()
  await expect(thinking).toHaveCount(0)
  await exactButton(tengri, 'Deny').click()
  await expect(thinking).toBeVisible()
  await emitCodexEvent(page, {
    sequence: 2,
    kind: 'thread-state',
    method: 'turn/completed',
    rawJson: '{"params":{"turn":{"id":"turn-1","status":"completed"}}}',
  })
  await expect(thinking).toHaveCount(0)
  await expect(tengri.getByRole('button', { name: 'Send message' })).toBeDisabled()
})

test('steers a recovered in-progress turn when sending during thread resume', async ({ page }) => {
  const mock = await mockTengri(page, {
    resumeThreadDelayMs: 400,
    resumeThreadRawJson: codexHistory([runningTurn('turn-active')]),
  })
  await selectSavedThread(page, 'thread-active')
  await page.goto('/')

  const prompt = page.getByRole('textbox', { name: /Message your agent|Steer the current turn/ })
  await prompt.fill('Continue with the current turn.')
  await prompt.press('Enter')

  await expectTengriCall(mock, 'steer-turn', {
    threadId: 'thread-active',
    turnId: 'turn-active',
    text: 'Continue with the current turn.',
  })
  expect(mock.calls('send-turn')).toHaveLength(0)
})

test('does not duplicate snapshot-covered Codex messages when event replay races thread resume', async ({ page }) => {
  const promptText = 'Create the live proof file.'
  const progressText = 'Creating the file now.'
  const finalText = '/workspace/tengri-codex-live-proof.txt'
  const mock = await visitDesktop(page, {
    savedThread: 'thread-complete',
    resumeThreadDelayMs: 1_000,
    resumeThreadEventSequence: 53,
    resumeThreadRawJson: codexHistory([
      completedTurn('turn-complete', [
        { id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: promptText }] },
        agentMessage('item-2', progressText),
        agentMessage('item-3', finalText),
      ]),
    ]),
  })
  await expect.poll(() => mock.calls('resume-thread').length).toBe(1)

  for (const replayedEvent of [
    {
      sequence: 9,
      kind: 'user-message' as const,
      method: 'item/completed',
      itemId: 'msg-user-live',
      text: promptText,
    },
    {
      sequence: 13,
      kind: 'assistant-text' as const,
      method: 'item/completed',
      itemId: 'msg-agent-live',
      text: progressText,
    },
    {
      sequence: 42,
      kind: 'assistant-text' as const,
      method: 'item/completed',
      itemId: 'msg-agent-final-live',
      text: finalText,
    },
    {
      sequence: 41,
      kind: 'usage' as const,
      method: 'thread/tokenUsage/updated',
      itemId: '',
      text: 'Tokens: 10 input · 4 output',
    },
    {
      sequence: 42,
      kind: 'usage' as const,
      method: 'account/rateLimits/updated',
      itemId: '',
      text: 'Weekly 90% left · Credits: 62,307',
    },
    {
      sequence: 43,
      kind: 'usage' as const,
      method: 'thread/tokenUsage/updated',
      itemId: '',
      text: 'Tokens: 20 input · 6 output',
    },
    {
      sequence: 44,
      kind: 'usage' as const,
      method: 'account/rateLimits/updated',
      itemId: '',
      text: 'Weekly 88% left · Credits: 62,307',
    },
    {
      sequence: 45,
      kind: 'warning' as const,
      method: 'tengri/eventOmitted',
      itemId: '',
      text: 'One oversized Codex event was omitted',
    },
    {
      sequence: 46,
      kind: 'warning' as const,
      method: 'deprecationNotice',
      itemId: '',
      text: 'Full-history hydration is deprecated for paginated threads',
    },
    {
      sequence: 47,
      kind: 'error' as const,
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

  const transcript = page.getByRole('log', { name: 'Conversation', exact: true })
  await expect(transcript.getByText(promptText, { exact: true })).toHaveCount(1)
  await expect(transcript.getByText(progressText, { exact: true })).toHaveCount(1)
  await expect(transcript.getByText(finalText, { exact: true })).toHaveCount(1)
  await expect(page.getByText('Tokens: 10 input · 4 output', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Weekly 90% left · Credits: 62,307', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Tokens: 20 input · 6 output', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Weekly 88% left · Credits: 62,307', { exact: true })).toHaveCount(0)
  await expect(
    page.getByText('Full-history hydration is deprecated for paginated threads', { exact: true }),
  ).toHaveCount(0)
  await expect(page.getByText('One oversized Codex event was omitted', { exact: true })).toHaveCount(1)
  await expect(page.getByText('The turn failed', { exact: true })).toHaveCount(1)
})

test('keeps capped history items from returning through delayed replay', async ({ page }) => {
  const items = Array.from({ length: 501 }, (_, index) => agentMessage(`answer-${index}`, `Restored answer ${index}`))
  const mock = await visitDesktop(page, {
    savedThread: 'thread-capped',
    resumeThreadDelayMs: 500,
    resumeThreadEventSequence: 10,
    resumeThreadItemEventSequences: Object.fromEntries(items.map((item) => [item.id, 30])),
    resumeThreadRawJson: codexHistory([completedTurn('turn-capped', items)]),
  })
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  const staleDelta = codexEvent({
    sequence: 20,
    itemId: 'answer-0',
    text: 'Stale omitted fragment',
    method: 'item/agentMessage/delta',
    threadId: 'thread-capped',
    turnId: 'turn-capped',
  })
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

test('shows compact browser approvals with inspectable details and exact session scope', async ({ page }) => {
  const mock = await visitDesktop(page)
  await page.getByLabel('Message your agent').fill('Open a browser tab.')
  await exactButton(page, 'Send message').click()
  await expect(exactButton(page, 'Stop response')).toBeVisible()
  await emitCodexEvent(page, {
    kind: 'approval',
    method: 'mcpServer/elicitation/request',
    itemId: 'browser-approval',
    approvalId: 'browser-approval',
    text: 'Allow the tengri_browser MCP server to run tool "computer"?',
    rawJson: codexParams({
      serverName: 'tengri_browser',
      message: 'Allow the tengri_browser MCP server to run tool "computer"?',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_description: 'Operate the browser in the Tengri desktop.',
        tool_params: { action: 'key', key: 'ctrl+t' },
        persist: 'session',
      },
    }),
  })
  const approval = page.getByRole('article', { name: 'Codex approval request', exact: true })
  await expect(approval.getByRole('heading', { name: 'Allow browser control?' })).toBeVisible()
  await expect(approval.locator('pre')).not.toBeVisible()
  for (const button of await approval.getByRole('button').all()) {
    expect((await button.boundingBox())?.height).toBe(24)
    await expect(button).toHaveCSS('font-size', '12px')
  }

  await approval.locator('summary').click()
  await expect(approval.locator('pre')).toContainText('ctrl+t')
  await expect(approval.locator('pre')).toContainText('Session approval applies to this tool')
  await exactButton(approval, 'Approve for session').click()
  await expectTengriCall(mock, 'resolve-approval', { approvalId: 'browser-approval', decision: 'approve-session' })
})

test('reconciles paginated item snapshots while keeping the transcript compact and approvals usable', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  const mock = await visitDesktop(page, {
    savedThread: 'thread-paged',
    threadStore: {
      threads: [savedChat('thread-paged', 'Inspect the desktop and verify the fixes locally.', 1)],
    },
    resumeThreadDelayMs: 500,
    resumeThreadEventSequence: 10,
    resumeThreadItemEventSequences: { 'answer-one': 20, 'answer-two': 30 },
    resumeThreadRawJson: codexHistory([
      runningTurn('turn-one', [
        {
          id: 'user-one',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Inspect the desktop and verify the fixes locally.' }],
        },
        agentMessage('answer-one', 'The terminal background is continuous.'),
        {
          id: 'output-one',
          type: 'commandExecution',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: '✓ Terminal resize\n✓ Window drag\n✓ Dock alignment',
        },
        agentMessage('answer-two', 'The browser checks pass.'),
      ]),
    ]),
  })
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
    rawJson: codexParams({ availableDecisions: ['accept', 'decline'] }),
  })
  const tengri = desktopWindow(page, 'Tengri')
  await expect(exactButton(tengri, 'Approve once')).toBeVisible()
  await expect(exactButton(tengri, 'Approve for session')).toHaveCount(0)
  await exactButton(tengri, 'Ran commands').first().click()
  await tengri.getByRole('article', { name: 'Codex output' }).locator('summary').click()
  const outputCharacterWidths = await tengri
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
  const user = tengri.getByRole('article', { name: 'Your message' })
  const response = tengri.getByRole('article', { name: 'Codex response' }).first()
  const conversation = tengri.getByRole('log', { name: 'Conversation' })
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
  await tengri.getByRole('button', { name: 'Close Tengri' }).hover()
  await expect.soft(tengri).toHaveScreenshot('tengri-compact-chat.png')
  await exactButton(tengri, 'Approve once').click()
  await expectTengriCall(mock, 'resolve-approval', { approvalId: 'approval-one', decision: 'approve-once' })
  await expect(exactButton(tengri, 'Approve once')).toHaveCount(0)
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
  const conversationScroll = tengri.getByTestId('agent-conversation-scroll')
  // Approval controls and resizing can preserve a different reading position.
  // Compare the same transcript viewport without changing its layout or tolerance.
  await conversationScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect
    .poll(() =>
      conversationScroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThan(2)
  await expect(tengri.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
  await page.mouse.move(0, 0)
  await expect.soft(tengri).toHaveScreenshot('tengri-compact-chat-narrow.png')
})

test('does not resurrect a turn completed while replay recovery is in flight', async ({ page }) => {
  const mock = await visitDesktop(page, {
    savedThread: 'thread-active',
    holdReplayResume: true,
    resumeThreadRawJson: codexHistory([runningTurn('turn-active')]),
  })
  await expect(page.getByLabel('Steer the current turn')).toBeVisible()
  const initialResumeResponses = mock.getResumeThreadResponseCount()

  await emitCodexEvent(page, {
    sequence: 10,
    kind: 'warning',
    method: 'tengri/replayWarning',
    threadId: 'thread-active',
    turnId: '',
    text: 'Replay window exceeded',
  })
  await mock.waitForHeldResume()
  await emitCodexEvent(page, {
    sequence: 11,
    kind: 'thread-state',
    method: 'turn/completed',
    threadId: 'thread-active',
    turnId: 'turn-active',
  })
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  mock.releaseHeldResume()
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBeGreaterThan(initialResumeResponses)
  await expect(page.getByLabel('Message your agent')).toBeVisible()

  const prompt = page.getByLabel('Message your agent')
  await prompt.fill('Start the next turn.')
  await prompt.press('Enter')
  await expectTengriCall(mock, 'send-turn', { text: 'Start the next turn.' })
  expect(mock.calls('steer-turn')).toHaveLength(0)
})

test('resizes across all visible corners while keeping window controls clickable', async ({ page }) => {
  await visitDesktop(page)
  const frame = desktopWindow(page, 'Tengri')
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

  for (const name of ['Close Tengri', 'Minimize Tengri', 'Maximize Tengri']) {
    const button = exactButton(frame, name)
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
  await exactButton(frame, 'Maximize Tengri').click()
  await exactButton(frame, 'Restore Tengri').click()
  await exactButton(frame, 'Minimize Tengri').click()
  await expect(frame).toHaveCount(0)
  await exactButton(desktopDock(page), 'Open Tengri').click()
  await exactButton(frame, 'Close Tengri').click()
  await expect(frame).toHaveCount(0)
})

test('magnifies the Dock without relayout and minimizes with native transform animation', async ({
  page,
}, testInfo) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const dock = desktopDock(page)
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

  const tengri = page.getByRole('region', { name: 'Tengri window', includeHidden: true })
  const wrapper = tengri.locator('..')
  const normalBounds = await tengri.boundingBox()
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
  await exactButton(tengri, 'Minimize Tengri').click()
  await expect(wrapper).toHaveCSS('visibility', 'hidden')
  const nativeTransform = await nativeTransforms.evaluate((transforms) => transforms.flat())
  expect(nativeTransform.length).toBeGreaterThanOrEqual(2)
  expect(nativeTransform[0]?.transform).toBe('translate(0px, 0px) scale(1)')
  expect(nativeTransform.at(-1)?.transform).toMatch(/scale\(0\./)
  await dock.getByRole('button', { name: 'Open Tengri' }).click()
  await expect(wrapper).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
  await expect.poll(() => tengri.boundingBox()).toEqual(normalBounds)
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await nativeTransforms.dispose()
  await client.detach()
})

test('tracks the pointer during dragging without repeated desktop layout reads or release snapback', async ({
  page,
}) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const frame = desktopWindow(page, 'Tengri')
  await expect(frame).toBeVisible()
  const before = await frame.boundingBox()
  const header = await frame.locator(':scope > header').boundingBox()
  if (!before || !header) throw new Error('Tengri window is missing')
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
  await exactButton(frame, 'Minimize Tengri').click()
  await expect(frame).toHaveCount(0)
  await exactButton(desktopDock(page), 'Open Tengri').click()
  await expect.poll(async () => (await frame.boundingBox())?.x).toBeCloseTo(before.x + 60, 0)
  await expect.poll(async () => (await frame.boundingBox())?.y).toBeCloseTo(before.y - 15, 0)
})

test('keeps window dimensions within the desktop when the browser shrinks during a resize', async ({ page }) => {
  await visitDesktop(page)
  const frame = desktopWindow(page, 'Tengri')
  const handle = frame.locator('..').locator('.cursor-e-resize')
  const bounds = await handle.boundingBox()
  if (!bounds) throw new Error('Tengri resize handle is missing')
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
  await visitDesktop(page)

  const tengriWindows = desktopWindow(page, 'Tengri')
  const tengriFrames = page.locator('section[aria-label="Tengri window"]')
  await expect(tengriWindows).toHaveCount(1)
  await tengriWindows.getByRole('textbox', { name: 'Message your agent' }).fill('First window draft')
  await page.keyboard.press('Meta+n')
  await expect(tengriWindows).toHaveCount(2)
  await expect(tengriWindows.first().getByRole('textbox', { name: 'Message your agent' })).toHaveValue(
    'First window draft',
  )
  await expect(tengriWindows.last().getByRole('textbox', { name: 'Message your agent' })).toHaveValue('')
  await tengriWindows.last().getByRole('textbox', { name: 'Message your agent' }).focus()
  await page.keyboard.press('Meta+o')
  await expect(page.getByRole('dialog', { name: 'Spotlight' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Spotlight' })).toHaveCount(0)

  const frontmost = tengriWindows.last()
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

  await exactButton(frontmost, 'Minimize Tengri').focus()
  await page.keyboard.press('Meta+Backquote')
  await expect
    .poll(async () => {
      const firstZ = Number(
        await tengriWindows
          .first()
          .locator('..')
          .evaluate((element) => getComputedStyle(element).zIndex),
      )
      const lastZ = Number(
        await tengriWindows
          .last()
          .locator('..')
          .evaluate((element) => getComputedStyle(element).zIndex),
      )
      return firstZ > lastZ
    })
    .toBe(true)
  await expect(page.locator('[data-tengri-modal="true"][aria-modal="true"]')).toHaveCount(0)
  await page.keyboard.press('Meta+m')
  const minimizedTengri = page.locator('section[aria-label="Tengri window"][aria-hidden="true"]')
  await expect(minimizedTengri).toHaveCount(1)
  await expect(minimizedTengri).toHaveCSS('pointer-events', 'none')
  await page.keyboard.press('Meta+w')
  await expect(tengriFrames).toHaveCount(1)
})

for (const recovery of ['automatic', 'refresh'] as const) {
  test(`recovers a temporary authorization pause through ${recovery} observation without a resume command`, async ({
    page,
  }) => {
    await page.clock.install()
    const fixture = await mockTengri(page, {
      agent: {
        ...readyAgent,
        phase: 'sleeping',
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'AuthorizationPaused',
            message: 'Authorization is recovering',
            lastTransitionAt: '2026-08-26T00:01:00Z',
          },
        ],
      },
    })
    await page.goto('/')
    const paused = page.getByRole('dialog', { name: 'Tengri is temporarily paused' })
    await expect(paused).toContainText('Tengri will reconnect automatically.')
    await expect(paused.getByRole('button', { name: 'Resume Agent' })).toHaveCount(0)
    fixture.setAgent({ ...readyAgent })
    if (recovery === 'automatic') await page.clock.fastForward(2_000)
    else await paused.getByRole('button', { name: 'Try Again' }).click()
    await expect(exactButton(page, 'Open Settings')).toBeVisible()
    expect(fixture.calls('resume-agent')).toEqual([])
  })
}

test('renders truthful booting, sleeping, and failed lifecycle states', async ({ page }) => {
  await visitDesktop(page, { agent: { ...readyAgent, phase: 'sleeping' } })
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
      localStorage.setItem(
        `tengri-conversations:${agentId}`,
        JSON.stringify([{ id: 'stale-thread', title: 'Stale', updatedAt: 1 }]),
      )
      localStorage.setItem(`tengri:spotlight:${agentId}:recents`, '["app:tengri"]')
      localStorage.setItem('tengri-thread:other-agent', 'other-thread')
      localStorage.setItem(
        'tengri-conversations:other-agent',
        JSON.stringify([{ id: 'other-thread', title: 'Other', updatedAt: 1 }]),
      )
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
  expect(await desktopSessionKeys(page)).toEqual([])
  expect(
    await page.evaluate(
      (agentId) => ({
        deletedThread: localStorage.getItem(`tengri-thread:${agentId}`),
        deletedConversations: localStorage.getItem(`tengri-conversations:${agentId}`),
        deletedRecents: localStorage.getItem(`tengri:spotlight:${agentId}:recents`),
        otherThread: localStorage.getItem('tengri-thread:other-agent'),
        otherConversations: localStorage.getItem('tengri-conversations:other-agent'),
        otherRecents: localStorage.getItem('tengri:spotlight:other-agent:recents'),
      }),
      readyAgent.id,
    ),
  ).toEqual({
    deletedThread: null,
    deletedConversations: null,
    deletedRecents: null,
    otherThread: 'other-thread',
    otherConversations: JSON.stringify([{ id: 'other-thread', title: 'Other', updatedAt: 1 }]),
    otherRecents: '["app:finder"]',
  })

  const create = page.getByRole('dialog', { name: 'Create your agent' })
  await create.getByLabel('Agent name').fill('Recreated Tengri')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(desktopDock(page)).toBeVisible()
  await expect(page.getByLabel('Message your agent')).toBeVisible()
  expect(mock.calls('resume-thread')).toHaveLength(0)
})

test('refreshes a failed agent without requesting unsupported recovery or deleting its workspace', async ({ page }) => {
  const failedAgent = {
    ...readyAgent,
    phase: 'failed',
    message: 'No proven Firecracker node can schedule this agent.',
  }
  const mock = await visitDesktop(page, { agent: failedAgent })

  const failed = page.getByRole('dialog', { name: 'Agent could not start' })
  await expect(failed.getByRole('button', { name: 'Sleep and Keep Workspace' })).toHaveCount(0)
  const snapshotsBeforeRefresh = mock.getSnapshotRequestCount()
  await failed.getByRole('button', { name: 'Refresh Status' }).click()
  await expect.poll(() => mock.getSnapshotRequestCount()).toBeGreaterThan(snapshotsBeforeRefresh)
  await expect(failed).toBeVisible()
  expect(mock.calls('sleep-agent')).toHaveLength(0)
  expect(mock.calls('delete-agent')).toHaveLength(0)
  await expect(failed.getByRole('button', { name: 'Delete Failed Agent' })).toBeVisible()
})

test('backs off failed snapshot polls after the cached idle deadline', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-26T12:34:00.000Z') })
  const mock = await visitDesktop(page, { agent: { ...readyAgent, idleDeadline: '2026-08-26T12:33:00.000Z' } })
  await expect(desktopDock(page)).toBeVisible()
  const initialRequests = mock.getSnapshotRequestCount()
  mock.failNextSnapshots(2)

  await page.clock.fastForward(1_100)
  await expect.poll(() => mock.getSnapshotRequestCount()).toBe(initialRequests + 1)
  await expect(page.getByText('Connection interrupted. Using the last confirmed agent state.')).toBeVisible()
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = await page.evaluate(() => Date.now())
    await page.clock.runFor(5_000)
    expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(before + 5_000)
    expect(mock.getSnapshotRequestCount()).toBe(initialRequests + attempt)
    if (attempt === 2) mock.setAgent({ ...readyAgent, phase: 'sleeping' })
    await page.clock.fastForward(26_000)
    await expect.poll(() => mock.getSnapshotRequestCount()).toBe(initialRequests + attempt + 1)
  }
  await expect(page.getByRole('dialog', { name: 'Tengri is sleeping' })).toBeVisible()
})

for (const recoveredState of ['sleeping', 'signed out'] as const) {
  test(`recovers a desktop after repeated identical snapshot failures to ${recoveredState}`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-26T12:34:00.000Z') })
    const mock = await visitDesktop(page)
    await expect(desktopDock(page)).toBeVisible()
    const initialRequests = mock.getSnapshotRequestCount()
    mock.failNextSnapshots(2)

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await page.clock.fastForward(31_000)
      await expect.poll(() => mock.getSnapshotRequestCount()).toBe(initialRequests + attempt)
      await expect(page.getByText('Connection interrupted. Using the last confirmed agent state.')).toBeVisible()
    }

    if (recoveredState === 'sleeping') mock.setAgent({ ...readyAgent, phase: 'sleeping' })
    else mock.setAuthenticated(false)
    await page.clock.fastForward(31_000)
    await expect.poll(() => mock.getSnapshotRequestCount()).toBe(initialRequests + 3)
    await expect(
      page.getByRole('dialog', { name: recoveredState === 'sleeping' ? 'Tengri is sleeping' : 'Sign in to Tengri' }),
    ).toBeVisible()
    expect(mock.calls('delete-agent')).toHaveLength(0)
  })
}

test('adds another passkey from Settings and retries a failed start', async ({ page }) => {
  await mockTengri(page)
  let attempts = 0
  await page.route('**/api/auth/add-passkey', async (route) => {
    expect(route.request().method()).toBe('POST')
    attempts += 1
    await route.fulfill({
      status: attempts === 1 ? 503 : 200,
      json:
        attempts === 1
          ? { error: 'Passkey setup is unavailable' }
          : { url: 'https://auth.proompteng.ai/passkey-fixture' },
    })
  })
  await page.route('https://auth.proompteng.ai/passkey-fixture', (route) => route.fulfill({ body: 'Passkey setup' }))
  await page.goto('/')
  await exactButton(page, 'Open Settings').click()
  await exactButton(page, 'Privacy & Security').click()
  await page.getByText('Sign-in & passkeys', { exact: true }).click()
  await expect(exactButton(page, 'Add another passkey')).toBeInViewport()

  await exactButton(page, 'Add another passkey').click()
  await expect(page.getByRole('alert').filter({ hasText: 'Passkey setup is unavailable' })).toBeVisible()
  await exactButton(page, 'Add another passkey').click()
  await page.waitForURL('https://auth.proompteng.ai/passkey-fixture')
  expect(attempts).toBe(2)
})

test('shows native-feeling unauthenticated and create-agent states', async ({ page }) => {
  await visitDesktop(page, { authenticated: false })
  const signIn = page.getByRole('dialog', { name: 'Sign in to Tengri' })
  await expect(signIn).toBeVisible()
  const signInControls = signIn.getByRole('group', { name: 'Window controls' }).getByRole('button')
  await expect(signInControls).toHaveCount(3)
  for (const button of await signInControls.all()) await expect(button).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible()
  await expect(signIn).toContainText('Then use your saved passkey')
  await expect(page.getByRole('button', { name: /Add.*passkey/ })).toHaveCount(0)

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
  await expect(desktopDock(page)).toBeVisible()
})

for (const timing of ['concurrently', 'after the first response'] as const) {
  test(`shares one creation operation across two empty desktop tabs submitting ${timing}`, async ({
    page,
    context,
  }) => {
    const other = await context.newPage()
    const first = await mockTengri(page, { agent: null })
    const second = await mockTengri(other, { agent: null })
    await Promise.all([page.goto('/'), other.goto('/')])
    const firstForm = page.getByRole('dialog', { name: 'Create your agent' })
    const secondForm = other.getByRole('dialog', { name: 'Create your agent' })
    await Promise.all([
      firstForm.getByLabel('Agent name').fill('Shared workspace'),
      secondForm.getByLabel('Agent name').fill('Shared workspace'),
    ])
    if (timing === 'concurrently') {
      await Promise.all([
        firstForm.getByRole('button', { name: 'Create Agent' }).click(),
        secondForm.getByRole('button', { name: 'Create Agent' }).click(),
      ])
    } else {
      await firstForm.getByRole('button', { name: 'Create Agent' }).click()
      await expect(desktopDock(page)).toBeVisible()
      await secondForm.getByRole('button', { name: 'Create Agent' }).click()
    }
    await expect(desktopDock(page)).toBeVisible()
    await expect(other.getByRole('navigation', { name: 'Dock' })).toBeVisible()
    const firstCreates = first.calls('create-agent')
    const secondCreates = second.calls('create-agent')
    expect(firstCreates).toHaveLength(1)
    expect(secondCreates).toHaveLength(1)
    expect(firstCreates[0].operationId).toBeTruthy()
    expect(secondCreates[0].operationId).toBe(firstCreates[0].operationId)
  })
}

test('creates with a new name after its workspace is deleted on another device', async ({ page }) => {
  const first = await visitDesktop(page, { agent: null, preserveDraftStorageOnReload: true })
  const create = page.getByRole('dialog', { name: 'Create your agent' })
  await create.getByLabel('Agent name').fill('Original workspace')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(desktopDock(page)).toBeVisible()
  const creationId = String(first.calls('create-agent')[0]?.operationId)
  await page.unrouteAll({ behavior: 'wait' })
  const replacement = await mockTengri(page, {
    agent: null,
    supersededCreationId: creationId,
    preserveDraftStorageOnReload: true,
  })
  await page.reload()
  await create.getByLabel('Agent name').fill('Replacement workspace')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(desktopDock(page)).toBeVisible()
  const creates = replacement.calls('create-agent')
  expect(creates.map((action) => action.displayName)).toEqual(['Original workspace', 'Replacement workspace'])
  expect(creates[0].operationId).toBe(creationId)
  expect(creates[1].operationId).not.toBe(creationId)
})

test('creates with a new name after deleting a workspace whose creation reply was lost', async ({ page }) => {
  const mock = await visitDesktop(page, { agent: null, failCreateOnce: true, commitFailedCreate: true })
  const create = page.getByRole('dialog', { name: 'Create your agent' })
  await create.getByLabel('Agent name').fill('Original workspace')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(page.getByText('Creation response is uncertain')).toBeVisible()
  await page.reload()
  await exactButton(page, 'Open Settings').click()
  await openSettingsPane(desktopWindow(page, 'Settings'), 'About')
  await desktopWindow(page, 'Settings').getByRole('button', { name: 'Delete Agent' }).click()
  await page
    .getByRole('alertdialog', { name: /Delete “Original workspace”/ })
    .getByRole('button', { name: 'Delete Agent' })
    .click()
  await expect(create).toBeVisible()
  await create.getByLabel('Agent name').fill('Different workspace')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(desktopDock(page)).toBeVisible()
  const creates = mock.calls('create-agent')
  expect(creates).toHaveLength(2)
  expect(creates[1].operationId).not.toBe(creates[0].operationId)
})

test('creates after an uncertain request from a previous account in the same tab', async ({ page }) => {
  const first = await visitDesktop(page, { agent: null, failCreateOnce: true })
  const create = page.getByRole('dialog', { name: 'Create your agent' })
  await create.getByLabel('Agent name').fill('Original')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(page.getByText('Creation response is uncertain')).toBeVisible()
  const originalId = first.calls('create-agent')[0]?.operationId
  expect(originalId).toBeTruthy()

  await page.unrouteAll({ behavior: 'wait' })
  const second = await mockTengri(page, { agent: null, userId: 'second-human' })
  await page.reload()
  await create.getByLabel('Agent name').fill('Different')
  await create.getByRole('button', { name: 'Create Agent' }).click()
  await expect(desktopDock(page)).toBeVisible()
  const replacementId = second.calls('create-agent')[0]?.operationId
  expect(replacementId).toBeTruthy()
  expect(replacementId).not.toBe(originalId)
})

test('preserves a menu focus choice made before a pending window activation frame', async ({ page }) => {
  await visitDesktop(page)
  await expect(desktopWindow(page, 'Tengri')).toBeVisible()
  await page.clock.install({ time: new Date('2026-09-08T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-08T12:00:01Z'))

  await page.keyboard.press('Meta+Space')
  const spotlight = page.getByRole('dialog', { name: 'Spotlight' })
  await spotlight.getByRole('combobox').fill('Settings')
  await page.clock.runFor(500)
  await page.keyboard.press('Enter')
  await expect(desktopWindow(page, 'Settings')).toBeFocused()

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
  await visitDesktop(page)
  const prompt = page.getByRole('textbox', { name: 'Message your agent' })
  await expect(prompt).toBeFocused()
  await prompt.fill('Keep this draft')
  await exactButton(page, 'Open Terminal').click()
  const terminal = page.getByRole('textbox', { name: 'Terminal input' })
  await expect(terminal).toBeFocused()
  await exactButton(page, 'Open Tengri').click()
  await expect(prompt).toBeFocused()
  await expect(prompt).toHaveValue('Keep this draft')
  await page.keyboard.press('Meta+m')
  await expect(terminal).toBeFocused()
  await exactButton(page, 'Open Tengri').click()
  await expect(prompt).toBeFocused()
  await exactButton(page, 'Open Spotlight').click()
  await expect(page.getByRole('dialog', { name: 'Spotlight' }).getByRole('combobox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Spotlight' })).toHaveCount(0)
})

test('preserves zoom across minimize and window switching and lists individual windows', async ({ page }) => {
  await visitDesktop(page)
  const tengri = desktopWindow(page, 'Tengri')
  const normalBounds = await tengri.boundingBox()
  await tengri.getByRole('button', { name: 'Maximize Tengri' }).click()
  const zoomedBounds = await tengri.boundingBox()
  await tengri.getByRole('button', { name: 'Minimize Tengri' }).click()
  await exactButton(page, 'Open Tengri').click()
  await expect(tengri.getByRole('button', { name: 'Restore Tengri' })).toBeVisible()
  await expect.poll(() => tengri.boundingBox()).toEqual(zoomedBounds)
  await page.getByRole('menuitem', { name: 'View', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Restore Window', exact: false })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+n')
  await expect(tengri).toHaveCount(2)
  await page.getByRole('menuitem', { name: 'Window', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Window', exact: true })
  await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(2)
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Tengri 2', exact: true })).toBeChecked()
  await menu.getByRole('menuitemcheckbox', { name: 'Tengri 1', exact: true }).click()
  await expect(tengri.first()).toHaveAttribute('data-active', 'true')
  await tengri.first().getByRole('button', { name: 'Restore Tengri' }).click()
  await expect.poll(() => tengri.first().boundingBox()).toEqual(normalBounds)
})

test('opens Dock apps from the raised top of magnified artwork', async ({ page }) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const code = desktopDock(page).getByRole('button', { name: 'Open Code' })
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
  await expect(desktopWindow(page, 'Code')).toBeVisible()
})

test('magnified Dock icons keep separate hit targets at desktop and narrow widths', async ({ page }) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const dock = desktopDock(page)
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    for (const name of ['Open Finder', 'Open Tengri', 'Open Code', 'Open Settings']) {
      await exactButton(dock, name).hover()
      await expect(exactButton(dock, name).locator('[role="tooltip"]')).toHaveCSS('opacity', '1')
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

test('uses functional close controls and disables unavailable actions in confirmation windows', async ({ page }) => {
  const mock = await visitDesktop(page, { holdLifecycleAction: 'delete-agent' })
  const settings = await openSettings(page, 'About')
  await settings.getByRole('button', { name: 'Delete Agent' }).click()
  const dialog = page.getByRole('alertdialog', { name: /Delete “Tengri”/ })
  const controls = dialog.getByRole('group', { name: 'Window controls' })
  await expect(controls.getByRole('button', { name: 'Minimize Tengri' })).toBeDisabled()
  await expect(controls.getByRole('button', { name: 'Maximize Tengri' })).toBeDisabled()

  await controls.getByRole('button', { name: 'Close Tengri' }).click()
  await expect(dialog).toHaveCount(0)
  expect(mock.calls('delete-agent')).toHaveLength(0)
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
    await visitDesktop(page)
    const tengri = desktopWindow(page, 'Tengri')
    await tengri.focus()
    await page.mouse.move(0, 0)
    const controls = tengri.getByRole('group', { name: 'Window controls' })
    await expect.soft(controls).toHaveScreenshot('tengri-window-controls-idle.png', {
      maxDiffPixels: 0,
      threshold: 0.05,
      scale: 'device',
    })
    await controls.getByRole('button', { name: 'Minimize Tengri' }).hover()
    await expect.soft(controls).toHaveScreenshot('tengri-window-controls-hover.png', {
      maxDiffPixels: 0,
      threshold: 0.05,
      scale: 'device',
    })
    await controls.getByRole('button', { name: 'Maximize Tengri' }).click()
    await controls.getByRole('button', { name: 'Restore Tengri' }).hover()
    await expect.soft(controls).toHaveScreenshot('tengri-window-controls-restore.png', {
      maxDiffPixels: 0,
      threshold: 0.05,
      scale: 'device',
    })
  })
})

for (const app of ['Finder', 'Chrome', 'Tengri', 'Code', 'Terminal', 'Settings']) {
  test(`keeps native window control states and actions correct in ${app}`, async ({ page }, testInfo) => {
    await visitDesktop(page)
    const dock = desktopDock(page)
    await exactButton(dock, `Open ${app}`).click()
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
    await exactButton(dock, `Open ${app}`).click()
    await expect(frame).toHaveAttribute('aria-hidden', 'false')
    await expect.poll(() => frame.boundingBox()).toEqual(bounds)

    await exactButton(dock, `Open ${app === 'Tengri' ? 'Finder' : 'Tengri'}`).click()
    await page.mouse.move(0, 0)
    await expect(frame).toHaveAttribute('data-active', 'false')
    const inactiveColors = await buttons
      .locator(':scope > span')
      .evaluateAll((elements) => elements.map((light) => getComputedStyle(light).backgroundColor))
    expect(new Set(inactiveColors).size).toBe(1)
    expect(colors).not.toContain(inactiveColors[0])
    await exactButton(dock, `Open ${app}`).click()
    await controls.getByRole('button', { name: `Close ${app}` }).press('Enter')
    await expect(frame).toHaveCount(0)
  })
}

test('aligns native window controls with app toolbars and keeps narrow layouts usable', async ({ page }) => {
  await visitDesktop(page)
  const dock = desktopDock(page)
  const tengri = desktopWindow(page, 'Tengri')
  const controls = await tengri.getByRole('button', { name: 'Close Tengri' }).boundingBox()
  const title = await tengri.locator(':scope > header').getByText('Tengri', { exact: true }).boundingBox()
  if (!controls || !title) throw new Error('Tengri title bar is missing')
  expect(Math.abs(controls.y + controls.height / 2 - title.y - title.height / 2)).toBeLessThan(5)
  expect(title.x).toBeGreaterThan(controls.x + 72)

  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = desktopWindow(page, 'Finder')
  const close = await finder.getByRole('button', { name: 'Close Finder' }).boundingBox()
  const back = await exactButton(finder, 'Back').boundingBox()
  if (!close || !back) throw new Error('Finder toolbar is missing')
  expect(Math.abs(close.y + close.height / 2 - back.y - back.height / 2)).toBeLessThan(1)

  await finder.getByRole('button', { name: 'Maximize Finder' }).click()
  await page.mouse.move(720, 899)
  await expect.poll(async () => (await dock.boundingBox())?.y ?? 900).toBeLessThan(850)
  await dock.getByRole('button', { name: 'Open Tengri' }).click()
  await expect(finder).toHaveAttribute('data-active', 'false')
  await finder.locator('aside [data-window-drag-region]').click({ position: { x: 140, y: 26 } })
  await expect(finder).toHaveAttribute('data-active', 'true')
  await finder.getByRole('button', { name: 'Restore Finder' }).click()

  await page.setViewportSize({ width: 390, height: 680 })
  await finder.getByRole('button', { name: 'Maximize Finder' }).click()
  const narrowControls = await finder.getByRole('button', { name: 'Close Finder' }).boundingBox()
  const narrowBack = await exactButton(finder, 'Back').boundingBox()
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
  const dock = desktopDock(page)
  const code = dock.getByRole('button', { name: 'Open Code' })
  const tengri = dock.getByRole('button', { name: 'Open Tengri' })
  const before = await code.locator('img').boundingBox()
  const button = await code.boundingBox()
  if (!before || !button) throw new Error('Dock geometry is missing')
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2)
  await expect.poll(async () => (await code.locator('img').boundingBox())!.width).toBeGreaterThan(before.width * 1.3)
  await expect.poll(async () => (await tengri.locator('img').boundingBox())!.width).toBeGreaterThan(before.width * 1.1)
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
  await expect(desktopWindow(page, 'Tengri')).toHaveCount(2)
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
  await expect(desktopWindow(page, 'Code')).toBeVisible()

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

  const dock = desktopDock(page)
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

test('keeps a wide focused Dock tooltip within the viewport while neighbouring icons magnify', async ({ page }) => {
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 640, height: 680 })
  await page.goto('/')
  await page.addStyleTag({ content: '[data-tengri-dock] [role="tooltip"] { min-width: 350px; }' })

  const dock = desktopDock(page)
  const finder = dock.getByRole('button', { name: 'Open Finder' })
  const tooltip = finder.locator('[role="tooltip"]')
  await finder.focus()
  await expect(tooltip).toHaveCSS('opacity', '1')
  await expect.poll(async () => (await tooltip.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0)

  const code = dock.getByRole('button', { name: 'Open Code' })
  await code.hover()
  await expect.poll(async () => (await code.locator('img').boundingBox())?.width ?? 0).toBeGreaterThan(70)
  await expect(finder).toBeFocused()
  await expect(tooltip).toHaveCSS('opacity', '1')
  const bounds = await tooltip.boundingBox()
  if (!bounds) throw new Error('Focused Dock tooltip is missing')
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(640)
})

test('keeps the desktop viewport fixed when Dock focus would scroll clipped content', async ({ page }) => {
  await visitDesktop(page)
  await page.setViewportSize({ width: 320, height: 680 })
  await page.addStyleTag({ content: '[data-tengri-dock] [role="tooltip"] { min-width: 350px; }' })

  const desktop = page.getByRole('main')
  await desktop.evaluate((element) => {
    element.scrollLeft = 12
  })
  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Settings' }).focus()
  await dock.getByRole('button', { name: 'Open Finder' }).focus()
  expect(await desktop.evaluate((element) => element.scrollLeft)).toBe(0)
  const bounds = await desktop.boundingBox()
  if (!bounds) throw new Error('Desktop viewport is missing')
  expect(bounds.x).toBe(0)
  expect(bounds.width).toBe(320)
})

test('minimizes to the app icon and leaves hidden window geometry idle during clock and menu updates', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-08-26T12:34:00.000Z') })
  await mockTengri(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const tengri = page.locator('[data-app="tengri"]')
  const outer = tengri.locator('..')
  await tengri.getByRole('button', { name: 'Minimize Tengri' }).click()
  await expect(outer).toHaveCSS('visibility', 'hidden')
  const target = await page.locator('#tengri-dock-tengri').boundingBox()
  const minimized = await outer.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  })
  if (!target) throw new Error('Minimize target is missing')
  expect(minimized.x + minimized.width / 2).toBeCloseTo(target.x + target.width / 2, 0)
  expect(minimized.y + minimized.height / 2).toBeCloseTo(target.y + target.height / 2, 0)

  await tengri.evaluate((element) => {
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
  expect(await tengri.evaluate((element) => element.parentElement?.parentElement?.dataset.layoutReads)).toBe('0')
  await page.keyboard.press('Escape')
  await page.locator('#tengri-dock-tengri').click()
  await expect(outer).toHaveCSS('visibility', 'visible')
  await expect(desktopWindow(page, 'Tengri')).toBeVisible()
})

test('matches the macOS desktop at required production viewports', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  await visitDesktop(page)
  await expect(desktopDock(page)).toBeVisible()
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  await expect(page.getByRole('button', { name: 'Open Next.js Dev Tools' })).toHaveCount(0)
  const dockIcons = desktopDock(page).locator('img')
  await expect(dockIcons).toHaveCount(6)
  for (const icon of await dockIcons.all()) {
    await expect.poll(() => icon.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expect(icon).toHaveAttribute('draggable', 'false')
  }
  await expect.poll(async () => (await desktopWindow(page, 'Finder').boundingBox())?.x).toBe(212)

  await expect.soft(page).toHaveScreenshot('tengri-desktop-1440x900.png', {
    fullPage: true,
  })

  await page.evaluate(() => sessionStorage.clear())
  await page.setViewportSize({ width: 1728, height: 1117 })
  await page.goto('/')
  await expect(desktopDock(page)).toBeVisible()
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  await expect.poll(async () => (await desktopWindow(page, 'Finder').boundingBox())?.x).toBe(356)
  await expect.soft(page).toHaveScreenshot('tengri-desktop-1728x1117.png', {
    fullPage: true,
  })
})

test('navigates Finder with sortable columns, breadcrumbs, Go to Folder, and file artwork', async ({ page }) => {
  await visitDesktop(page)
  const finder = await openDesktopApp(page, 'Finder')
  const files = finder.locator('[data-file-entry]')
  const names = () => files.evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))
  await expect(files).toHaveCount(3)
  await expect.poll(names).toEqual(['package.json', 'README.md', 'src'])
  await exactButton(finder, 'Sort by Size').click()
  await expect.poll(names).toEqual(['src', 'package.json', 'README.md'])
  await exactButton(finder, 'Sort by Size').click()
  await expect.poll(names).toEqual(['README.md', 'package.json', 'src'])
  await files.first().click()
  await files.last().click({ modifiers: ['Shift'] })
  await expect(finder.getByRole('status', { name: 'Folder status' })).toHaveText('3 of 3 selected')
  await exactButton(finder, 'src').dblclick()
  await expect(exactButton(finder, 'main.ts')).toBeVisible()
  const path = finder.getByRole('navigation', { name: 'Folder path' })
  await expect(path.getByRole('button')).toHaveCount(2)
  await exactButton(path, 'Workspace').click()
  await expect(files).toHaveCount(3)
  await exactButton(finder, 'Back').click()
  await expect(exactButton(finder, 'main.ts')).toBeVisible()

  await exactButton(finder, 'Go to folder').click()
  const location = page.getByRole('dialog', { name: 'Go to Folder', exact: true })
  await location.getByRole('textbox', { name: 'Folder location' }).fill('/../../outside')
  await exactButton(location, 'Go').click()
  await expect(location.getByRole('alert')).toHaveText('Enter an absolute path inside the workspace')
  await location.getByRole('textbox', { name: 'Folder location' }).fill('/workspace')
  await location.getByRole('textbox', { name: 'Folder location' }).press('Enter')
  await expect(location).toHaveCount(0)
  await expect(files).toHaveCount(3)
  await finder.getByRole('button', { name: 'Icon view' }).click()
  const folder = exactButton(finder, 'src')
  await expect(folder.locator('img')).toHaveAttribute('src', '/tengri/icons/folder.png')
  await expect(exactButton(finder, 'README.md').locator('img')).toHaveAttribute('src', '/tengri/icons/document.png')
  await expect
    .poll(() =>
      folder
        .locator('img')
        .evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
    )
    .toBe(true)
  await page.mouse.move(0, 0)
  await expect.soft(finder).toHaveScreenshot('tengri-finder-icons.png')
  await finder.getByRole('button', { name: 'Finder actions' }).click()
  await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click()
  await finder.getByRole('textbox', { name: 'New folder name' }).fill('empty')
  await finder.getByRole('textbox', { name: 'New folder name' }).press('Enter')
  await exactButton(finder, 'empty').dblclick()
  await finder.getByRole('button', { name: 'List view' }).click()
  await expect(exactButton(finder, 'Sort by Name')).toBeVisible()
  await expect(finder.getByRole('status', { name: 'Folder status' })).toHaveText('0 items')
  await expect(files).toHaveCount(0)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(
    accessibility.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'),
  ).toEqual([])
})

test('renders the native Finder layout with accessible navigation', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  await visitDesktop(page)
  const dock = desktopDock(page)
  await dock.getByRole('button', { name: 'Open Finder' }).click()
  const finder = desktopWindow(page, 'Finder')
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
  await expect.soft(finder).toHaveScreenshot('tengri-finder.png')
})

test('renders focused macOS settings panes with accessible navigation', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  const fixture = await visitDesktop(page)
  const settings = await openDesktopApp(page, 'Settings')
  await expect(settings.getByRole('heading', { name: 'General', exact: true }).first()).toBeVisible()
  await expect(settings.getByLabel('Sleep when inactive')).toHaveCount(0)
  const accountRequests = fixture.calls('codex-account').length
  await page.mouse.move(0, 0)
  await expect.soft(settings).toHaveScreenshot('tengri-settings.png')
  await openSettingsPane(settings, 'About')
  await expect(settings.getByText('Firecracker')).toBeVisible()
  await expect(settings.getByLabel('Sleep when inactive')).toHaveCount(0)
  await openSettingsPane(settings, 'Power & Sleep')
  await expect(settings.getByLabel('Sleep when inactive').locator('[data-slot="select-value"]')).toHaveText(
    'After 1 hour',
  )
  expect(fixture.calls('codex-account')).toHaveLength(accountRequests)
  await settings.getByRole('button', { name: 'Back to General' }).click()
  await expect(exactButton(settings, 'Open About')).toBeVisible()
  await settings.getByRole('textbox', { name: 'Search Settings' }).fill('sleep')
  await expect(settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button')).toHaveCount(1)
  await openSettingsPane(settings, 'Power & Sleep')
  await page.setViewportSize({ width: 390, height: 680 })
  await settings.getByRole('button', { name: 'Maximize Settings' }).click()
  await expect(settings.getByLabel('Sleep when inactive')).toBeVisible()
  await settings.getByRole('button', { name: 'Back to General' }).click()
  await exactButton(settings, 'Open About').click()
  await expect(settings.getByText('Firecracker')).toBeVisible()

  const results = await new AxeBuilder({ page }).analyze()
  expect(
    results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'),
  ).toEqual([])
})

test('saves the sleep timeout immediately and reads it back after reload', async ({ page }) => {
  const fixture = await visitDesktop(page)
  const settings = await openSettings(page, 'Power & Sleep')
  const timeout = settings.getByLabel('Sleep when inactive')
  await timeout.focus()
  await selectOption(page, timeout, 'After 1 minute')
  await expect.poll(() => fixture.getAgent()?.power.idleTimeoutMinutes).toBe(1)
  await expect(timeout).toBeEnabled()
  await expect(timeout).toBeFocused()
  await page.reload()
  await exactButton(page, 'Open Settings').click()
  await openSettingsPane(settings, 'Power & Sleep')
  await expect(timeout.locator('[data-slot="select-value"]')).toHaveText('After 1 minute')
  await selectOption(page, timeout, 'Never')
  await expect.poll(() => fixture.getAgent()?.power.idleTimeoutMinutes).toBe(0)
  await expect(timeout).toBeEnabled()
  await selectOption(page, timeout, 'After 1 hour')
  await expect.poll(() => fixture.getAgent()?.power.idleTimeoutMinutes).toBe(60)
  expect(fixture.calls('update-power-settings').map((action) => action.power)).toEqual([
    { idleTimeoutMinutes: 1 },
    { idleTimeoutMinutes: 0 },
    { idleTimeoutMinutes: 60 },
  ])
})

test('keeps a failed sleep preference visible and retries the same value', async ({ page }) => {
  const fixture = await mockTengri(page)
  let fail = true
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.route('**/api/tengri', async (route) => {
    if (
      route.request().method() === 'POST' &&
      route.request().postDataJSON()?.action === 'update-power-settings' &&
      fail
    ) {
      fail = false
      started.resolve()
      await release.promise
      await replyWithError(route, 503, 'Sleep settings could not be saved')
    } else await route.fallback()
  })
  await page.goto('/')
  const settings = await openSettings(page, 'Power & Sleep')
  const timeout = settings.getByLabel('Sleep when inactive')
  await selectOption(page, timeout, 'After 5 minutes')
  await started.promise
  await openSettingsPane(settings, 'About')
  release.resolve()
  await expect(timeout).toBeEnabled()
  await expect(exactButton(settings.getByRole('navigation', { name: 'Settings sections' }), 'About')).toBeFocused()
  await openSettingsPane(settings, 'Power & Sleep')
  await expect(settings.getByRole('alert')).toContainText('Sleep settings could not be saved')
  await expect(timeout.locator('[data-slot="select-value"]')).toHaveText('After 5 minutes')
  expect(fixture.getAgent()?.power.idleTimeoutMinutes).toBe(60)
  await settings.getByRole('button', { name: 'Try Again' }).click()
  await expect.poll(() => fixture.getAgent()?.power.idleTimeoutMinutes).toBe(5)
  await expect(settings.getByRole('alert')).toHaveCount(0)
})

test('cancels an obsolete workspace access refresh when another settings pane is selected', async ({ page }) => {
  await mockTengri(page)
  const refreshStarted = Promise.withResolvers<void>()
  const releaseRefresh = Promise.withResolvers<void>()
  let delayRefresh = false
  await page.route('**/api/tengri/access?**', async (route) => {
    const view = new URL(route.request().url()).searchParams.get('view')
    if (view === 'workspace' && delayRefresh) {
      refreshStarted.resolve()
      await releaseRefresh.promise
    }
    await route.fulfill({
      json: {
        version: '1',
        entries: [{ subjectId: `${view}-identity`, displayName: `${view}-identity`, githubId: '123', role: 'viewer' }],
      },
    })
  })
  await page.goto('/')
  const settings = await openSettings(page, 'Privacy & Security')
  const access = settings.getByRole('region', { name: 'Access administration' })
  await expect(access.getByText('workspace-identity', { exact: true })).toBeVisible()
  delayRefresh = true
  await exactButton(access, 'Refresh').click()
  await refreshStarted.promise
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: (request) => new URL(request.url()).searchParams.get('view') === 'workspace',
  })
  await openSettingsPane(settings, 'General')
  await cancelled
  releaseRefresh.resolve()
  await expect(settings.getByRole('region', { name: 'General', exact: true })).toBeVisible()
  await expect(access).toBeHidden()
  await expect(settings.getByText('workspace-identity', { exact: true })).toBeHidden()
})

for (const outcome of ['success', 'uncertain'] as const) {
  test(`retains access operations and one-time credentials across settings panes: ${outcome}`, async ({ page }) => {
    await mockTengri(page)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const operations: string[] = []
    await page.route('**/api/tengri/access?**', (route) =>
      route.fulfill({ json: { version: '1', workspaceState: 'active' } }),
    )
    await page.route('**/api/tengri/access', async (route) => {
      const command = route.request().postDataJSON()
      operations.push(command.operationId)
      started.resolve()
      await release.promise
      if (outcome === 'uncertain' && operations.length === 1) {
        await replyWithError(route, 503, 'The result could not be confirmed')
      } else
        await route.fulfill({
          json: {
            receipt: {
              operationId: command.operationId,
              version: '2',
              auditReceiptId: 'fixture-audit',
              agentCredential: 'fixture-only-not-a-real-credential',
            },
          },
        })
    })
    await page.goto('/')
    const settings = await openSettings(page, 'Privacy & Security')
    await settings.getByText('Advanced access & recovery', { exact: true }).click()
    await exactButton(settings, 'Create diagnostic grant').click()
    await settings.getByLabel('Diagnostic agent UUID').fill('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
    await settings.getByLabel('Proof key thumbprint').fill('a'.repeat(43))
    await settings.getByLabel('Reason', { exact: true }).fill('Settings navigation regression fixture')
    await exactButton(settings, 'Save changes').click()
    await started.promise
    await openSettingsPane(settings, 'General')
    release.resolve()
    await openSettingsPane(settings, 'Privacy & Security')
    if (outcome === 'uncertain') {
      await settings.getByRole('button', { name: 'Retry pending change' }).click()
      await expect.poll(() => operations.length).toBe(2)
      expect(operations[1]).toBe(operations[0])
    }
    await expect(settings.getByLabel('New diagnostic credential')).toHaveValue('fixture-only-not-a-real-credential')
    await openSettingsPane(settings, 'About')
    await openSettingsPane(settings, 'Privacy & Security')
    await expect(settings.getByLabel('New diagnostic credential')).toHaveValue('fixture-only-not-a-real-credential')
  })
}

test('prepares suggested prompts and grows multiline drafts without sending them', async ({ page }) => {
  const mock = await visitDesktop(page)
  const tengri = desktopWindow(page, 'Tengri')
  const prompt = tengri.getByRole('textbox', { name: 'Message your agent' })
  await exactButton(tengri, 'Explore the project').click()
  await expect(prompt).toBeFocused()
  await expect(prompt).toHaveValue('Explore this workspace and explain how the project is organized.')
  expect(mock.calls('create-thread', 'send-turn')).toHaveLength(0)
  const initialHeight = (await prompt.boundingBox())!.height
  await prompt.press('Shift+Enter')
  await expect(prompt).toHaveValue('Explore this workspace and explain how the project is organized.\n')
  await prompt.press('End')
  await prompt.fill(Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1}`).join('\n'))
  await expect.poll(async () => (await prompt.boundingBox())!.height).toBeGreaterThan(initialHeight)
  expect((await prompt.boundingBox())!.height).toBeLessThanOrEqual(160)
  expect(mock.calls('send-turn')).toHaveLength(0)
  await selectOption(page, tengri.getByRole('combobox', { name: 'Model', exact: true }), 'GPT-5.6 Luna')
  await selectOption(page, tengri.getByRole('combobox', { name: 'Reasoning effort' }), 'Medium')
  await page.setViewportSize({ width: 390, height: 680 })
  await expect(tengri.getByRole('combobox', { name: 'Model', exact: true })).toBeInViewport()
  await expect(tengri.getByRole('combobox', { name: 'Reasoning effort' })).toBeInViewport()
  await expect(tengri.getByRole('button', { name: 'Send message' })).toBeInViewport()
  expect(await tengri.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await prompt.press('Enter')
  await expect
    .poll(() => mock.calls('send-turn')[0])
    .toMatchObject({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      text: Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1}`).join('\n'),
    })
  await expect(tengri.getByRole('heading', { name: 'Let’s build' })).toHaveCount(0)
  await expect(tengri.getByRole('button', { name: 'Stop response' })).toBeEnabled()
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
    resumeThreadRawJson: codexHistory([runningTurn('turn-1', [agentMessage('restored', restored)])]),
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
  const tengri = desktopWindow(page, 'Tengri')
  const response = tengri.getByRole('article', { name: 'Codex response' }).first()
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

  const event = codexEvent({ itemId: 'streamed', method: 'item/agentMessage/delta' })
  await emitCodexEvent(page, { ...event, sequence: 1, text: '```mermaid\nflowchart LR\n  X[' })
  const streamed = tengri.getByRole('article', { name: 'Codex response' }).last()
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
  const invalid = tengri.getByRole('article', { name: 'Codex response' }).last()
  await expect(invalid.getByRole('status')).toContainText('Diagram unavailable')
  await expect(invalid.locator('pre code')).toHaveText('not a diagram\n')
  await expect(tengri.getByRole('img', { name: 'Mermaid diagram', exact: true })).toHaveCount(3)
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
    resumeThreadRawJson: codexHistory([
      runningTurn('turn-1', [agentMessage('warm', '```mermaid\nflowchart LR\nA --> B\n```')]),
    ]),
  })
  await selectSavedThread(page, 'thread-1')
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
  const event = codexEvent({ itemId: 'burst', method: 'item/agentMessage/delta' })
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
    await visitDesktop(page, {
      savedThread: 'thread-1',
      resumeThreadRawJson: codexHistory([
        runningTurn('turn-1', [
          agentMessage(
            'warm',
            diagramChunk ? '```mermaid\nflowchart LR\nA[Warm] --> B[Ready]\n```' : 'Ready to stream.',
          ),
        ]),
      ]),
    })
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
    const event = codexEvent({ itemId: 'retry', method: completed ? 'item/completed' : 'item/agentMessage/delta' })
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
  await visitDesktop(page, {
    savedThread: 'thread-1',
    resumeThreadRawJson: codexHistory([
      completedTurn('turn-1', [
        agentMessage(
          'image',
          '```mermaid\nflowchart LR\nA@{ img: "/mermaid-image-canary", label: "Image" } --> B[Safe]\n```',
        ),
      ]),
    ]),
  })
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
  await visitDesktop(page, {
    savedThread: 'thread-1',
    resumeThreadRawJson: codexHistory([
      completedTurn(
        'turn-1',
        sources.map((source, index) => agentMessage(`css-${index}`, `\`\`\`mermaid\n${source}\n\`\`\``)),
      ),
    ]),
  })
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
  await visitDesktop(page, {
    savedThread: 'thread-1',
    resumeThreadRawJson: codexHistory([
      completedTurn('turn-1', [
        agentMessage(
          'local-css',
          '```mermaid\nclassDiagram\nclass Start\nclass Finish\nStart --> Finish\nstyle Start filter:url(#local-filter)\n```',
        ),
      ]),
    ]),
  })
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
    resumeThreadRawJson: codexHistory([
      completedTurn('turn-1', [
        agentMessage(
          'api-labels',
          '```mermaid\nflowchart LR\nA["Parse URL(value)"] --> B["image(input)"]\n```\n\n```mermaid\nsequenceDiagram\nAlice->>Bob: call src(input)\n```',
        ),
      ]),
    ]),
  })

  await selectSavedThread(page, 'thread-1')
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
    resumeThreadRawJson: codexHistory([
      completedTurn(
        'turn-1',
        sources.map((source, index) => agentMessage(`format-${index}`, `\`\`\`mermaid\n${source}\n\`\`\``)),
      ),
    ]),
  })
  await selectSavedThread(page, 'thread-1')
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
  await visitDesktop(page, {
    savedThread: 'thread-1',
    resumeThreadRawJson: codexHistory([completedTurn('turn-1', [agentMessage('unsafe', text)])]),
  })
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

test('lists native sessions in the sidebar and switches or starts a new one', async ({ page }) => {
  const mock = await visitDesktop(page, {
    savedThread: 'thread-alpha',
    threadStore: {
      threads: [
        savedChat('thread-alpha', 'Alpha conversation prompt', 2),
        savedChat('thread-beta', 'Beta conversation prompt', 1),
      ],
    },
    resumeThreadRawJson: codexHistory([
      completedTurn('turn-alpha', [
        {
          id: 'user-alpha',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Alpha conversation prompt' }],
        },
        agentMessage('answer-alpha', 'Alpha reply from the saved thread.'),
      ]),
    ]),
  })
  const tengri = desktopWindow(page, 'Tengri')
  const sidebar = tengri.getByTestId('agent-conversation-sidebar')
  await expect(sidebar).toBeVisible()
  await expect(sidebar.locator('[data-conversation-id="thread-alpha"]')).toBeVisible()
  await expect(sidebar.locator('[data-conversation-id="thread-beta"]')).toBeVisible()
  await expect(tengri.getByRole('article', { name: 'Your message' })).toContainText('Alpha conversation prompt')

  const beta = sidebar.locator('[data-conversation-id="thread-beta"]')
  await beta.click()
  await expectTengriCall(mock, 'resume-thread', { threadId: 'thread-beta' })
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-beta')
  await expect(beta).toHaveAttribute('aria-current', 'true')
  await page.mouse.move(0, 0)
  const selectedBackground = await beta.evaluate((row) => getComputedStyle(row).backgroundColor)
  await beta.hover()
  await expect(beta).toHaveCSS('background-color', selectedBackground)

  await sidebar.getByRole('button', { name: 'New conversation' }).click()
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBeNull()
  await expect(sidebar.locator('[data-conversation-id="thread-alpha"]')).toBeVisible()
  await expect(sidebar.locator('[data-conversation-id="thread-beta"]')).toBeVisible()
  await expect(tengri.getByRole('article', { name: 'Your message' })).toHaveCount(0)
  await tengri.getByRole('button', { name: 'Close Tengri' }).hover()
  await expect.soft(tengri).toHaveScreenshot('tengri-agent-conversations.png')
})

for (const width of [1440, 390]) {
  test(`archives native sessions and restores their drafts at ${width}px`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: 900 })
    const store: ThreadStore = {
      threads: [savedChat('thread-alpha', 'Alpha', 2), savedChat('thread-beta', 'Beta', 1)],
    }
    await mockTengri(page, { threadStore: store, preserveDraftStorageOnReload: true })
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('selected-once')) {
        localStorage.setItem('tengri-thread:microvm-ada', 'thread-alpha')
        sessionStorage.setItem('selected-once', 'true')
      }
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const sidebar = chat.getByTestId('agent-conversation-sidebar')
    const prompt = chat.getByRole('textbox', { name: 'Message your agent' })
    const openSidebar = async () => {
      if (width === 390 && !(await sidebar.isVisible())) await exactButton(chat, 'Show conversations').click()
    }
    await prompt.fill('Keep this unsent Alpha draft.')
    await openSidebar()
    await expect(sidebar.getByText('Conversations', { exact: true })).toHaveCount(0)
    const archive = exactButton(sidebar, 'Archive Alpha')
    await sidebar.locator('[data-conversation-id="thread-alpha"]').hover()
    await expect(archive).toHaveText('')
    await expect(archive).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toHaveCount(0)
    await sidebar.screenshot({ path: test.info().outputPath(`archive-icon-${width}.png`) })
    await archive.click()
    await expect.poll(() => store.threads.find((thread) => thread.id === 'thread-alpha')?.archived).toBe(true)
    await expect(sidebar.locator('[data-conversation-id="thread-alpha"]')).toHaveCount(0)
    if (width === 390 && (await sidebar.isVisible())) await page.keyboard.press('Escape')
    await expect(prompt).toHaveValue('')
    await openSidebar()
    await exactButton(sidebar, 'Archived chats').click()
    const restore = exactButton(sidebar, 'Restore Alpha')
    if (width === 1440) {
      await page.mouse.move(0, 0)
      await exactButton(sidebar, 'Back to chats').focus()
      await page.keyboard.press('Shift+Tab')
      await expect(restore).toBeFocused()
      await expect(restore).toHaveCSS('opacity', '1')
      await restore.press('Enter')
    } else {
      await exactButton(sidebar, 'Alpha').locator('..').hover()
      await restore.click()
    }
    await expect.poll(() => store.threads.find((thread) => thread.id === 'thread-alpha')?.archived).toBe(false)
    await sidebar.locator('[data-conversation-id="thread-alpha"]').click()
    await expect(prompt).toHaveValue('Keep this unsent Alpha draft.')
    await expect(prompt).toBeFocused()
    await openSidebar()
    await exactButton(sidebar, 'Beta').hover()
    await exactButton(sidebar, 'Archive Beta').click()
    await expect(sidebar.locator('[data-conversation-id="thread-beta"]')).toHaveCount(0)
    const otherContext = await browser.newContext()
    try {
      const other = await otherContext.newPage()
      await visitDesktop(other, { threadStore: store })
      const otherSidebar = other.getByTestId('agent-conversation-sidebar')
      await expect(otherSidebar.locator('[data-conversation-id="thread-alpha"]')).toBeVisible()
      await expect(otherSidebar.locator('[data-conversation-id="thread-beta"]')).toHaveCount(0)
      await exactButton(otherSidebar, 'Archived chats').click()
      await expect(otherSidebar.locator('[data-conversation-id="thread-beta"]')).toBeVisible()
    } finally {
      await otherContext.close()
    }
    await page.reload()
    await openSidebar()
    await expect(sidebar.locator('[data-conversation-id="thread-beta"]')).toHaveCount(0)
    await chat.screenshot({ path: test.info().outputPath(`session-archive-${width}.png`) })
  })
}

for (const failure of ['service unavailable', 'network'] as const) {
  test(`recovers native chat index after transient ${failure}`, async ({ page }) => {
    const store: ThreadStore = {
      threads: [savedChat('thread-retained', 'Retained chat', 1)],
    }
    await mockTengri(page, { threadStore: store })
    let unavailable = false
    let reads = 0
    let failedReads = 0
    await routeTengriAction(page, 'list-threads', (_request, route) => {
      reads += 1
      if (!unavailable) return route.fallback()
      failedReads += 1
      return failure === 'network'
        ? route.abort('failed')
        : replyWithError(route, 503, 'Tengri control plane is unavailable')
    })
    await page.goto('/')
    const sidebar = page.getByTestId('agent-conversation-sidebar')
    await expect(exactButton(sidebar, 'Retained chat')).toBeVisible()
    const composer = page.getByRole('textbox', { name: 'Message your agent', exact: true })
    await composer.fill('Keep this draft while chats reconnect')
    unavailable = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => failedReads).toBeGreaterThanOrEqual(2)
    await expect(exactButton(sidebar, 'Retained chat')).toBeEnabled()
    await expect(composer).toHaveValue('Keep this draft while chats reconnect')
    store.threads[0].title = 'Recovered chat'
    unavailable = false
    await expect(exactButton(sidebar, 'Recovered chat')).toBeVisible({ timeout: 10_000 })
    await expect(sidebar.getByRole('alert')).toHaveCount(0)
    await expect(exactButton(sidebar, 'Retry chats')).toHaveCount(0)
    await expect(composer).toHaveValue('Keep this draft while chats reconnect')
    const recoveredReads = reads
    await page.waitForTimeout(2500)
    expect(reads).toBe(recoveredReads)
  })
}

for (const failure of [
  { name: 'denied', status: 403, body: { error: 'Chat access denied' } },
  {
    name: 'malformed',
    status: 502,
    body: { error: 'The agent returned an invalid chat index', code: 'chat_index_invalid' },
  },
]) {
  test(`keeps ${failure.name} native chat index reads explicit without automatic retries`, async ({ page }) => {
    await mockTengri(page, {
      threadStore: { threads: [savedChat('thread-readable', 'Readable chat', 1)] },
    })
    let denied = true
    let reads = 0
    await routeTengriAction(page, 'list-threads', (_request, route) => {
      reads += 1
      return denied ? route.fulfill({ status: failure.status, json: failure.body }) : route.fallback()
    })
    await page.goto('/')
    const sidebar = page.getByTestId('agent-conversation-sidebar')
    await expect(sidebar.getByRole('alert')).toHaveText(failure.body.error)
    const deniedReads = reads
    await page.waitForTimeout(2500)
    expect(reads).toBe(deniedReads)
    denied = false
    await exactButton(sidebar, 'Retry chats').click()
    await expect(exactButton(sidebar, 'Readable chat')).toBeVisible()
    await expect(sidebar.getByRole('alert')).toHaveCount(0)
  })
}

test('retries the same native chat index page without dropping loaded chats', async ({ page }) => {
  await mockTengri(page, {
    threadStore: {
      threads: Array.from({ length: 55 }, (_, index) =>
        savedChat(`thread-page-${index}`, `Paged chat ${index}`, 100 - index),
      ),
    },
  })
  const cursors: string[] = []
  await routeTengriAction(page, 'list-threads', (action, route) => {
    if (!action.cursor) return route.fallback()

    cursors.push(action.cursor)
    return cursors.length === 1 ? replyWithError(route, 503, 'Chat page is temporarily unavailable') : route.fallback()
  })
  await page.goto('/')
  const sidebar = page.getByTestId('agent-conversation-sidebar')
  await expect(sidebar.locator('[data-conversation-id]')).toHaveCount(50)
  await exactButton(sidebar, 'Load older chats').click()
  await expect.poll(() => cursors.length).toBeGreaterThan(0)
  await expect(sidebar.locator('[data-conversation-id]')).toHaveCount(50)
  await expect(sidebar.locator('[data-conversation-id]')).toHaveCount(55, { timeout: 10_000 })
  expect(cursors).toEqual(['page:50', 'page:50'])
})

test('cancels native chat index retry when switching to archived chats', async ({ page }) => {
  await mockTengri(page, {
    threadStore: { threads: [savedChat('thread-archived-retry', 'Archived result', 1, true)] },
  })
  let activeReads = 0
  await routeTengriAction(page, 'list-threads', (action, route) => {
    if (action.archived) return route.fallback()

    activeReads += 1
    return replyWithError(route, 503, 'Active chats are temporarily unavailable')
  })
  await page.goto('/')
  const sidebar = page.getByTestId('agent-conversation-sidebar')
  await expect.poll(() => activeReads).toBeGreaterThan(0)
  await exactButton(sidebar, 'Archived chats').click()
  await expect(exactButton(sidebar, 'Archived result')).toBeVisible()
  const readsBeforeWaiting = activeReads
  await page.waitForTimeout(2500)
  expect(activeReads).toBe(readsBeforeWaiting)
  await expect(exactButton(sidebar, 'Archived result')).toBeVisible()
})

test('pauses native chat index recovery while an archive outcome is unconfirmed', async ({ page }) => {
  const store: ThreadStore = {
    threads: [savedChat('thread-writing-retry', 'Keep archive receipt', 1)],
  }
  await mockTengri(page, { threadStore: store })
  let unavailable = false
  let reads = 0
  let writes = 0
  let releaseArchive!: () => void
  const archiveResponse = new Promise<void>((resolve) => {
    releaseArchive = resolve
  })
  await routeTengriPost(page, async (action, route) => {
    if (action.action === 'list-threads') {
      reads += 1
      return unavailable ? replyWithError(route, 503, 'Chats are temporarily unavailable') : route.fallback()
    }
    if (action.action !== 'set-thread-archived') return route.fallback()
    writes += 1
    store.threads[0].archived = true
    await archiveResponse
    return replyWithError(route, 503, 'Archive confirmation was interrupted')
  })
  await page.goto('/')
  const sidebar = page.getByTestId('agent-conversation-sidebar')
  await expect(exactButton(sidebar, 'Keep archive receipt')).toBeVisible()
  unavailable = true
  const beforeFailure = reads
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => reads).toBeGreaterThan(beforeFailure)
  await exactButton(sidebar, 'Keep archive receipt').hover()
  await exactButton(sidebar, 'Archive Keep archive receipt').click()
  await expect.poll(() => writes).toBe(1)
  try {
    const readsDuringArchive = reads
    await page.waitForTimeout(2500)
    expect(reads).toBe(readsDuringArchive)
  } finally {
    releaseArchive()
  }
  await expect(sidebar.getByRole('alert')).toHaveText('Archive confirmation was interrupted')
  unavailable = false
  await exactButton(sidebar, 'Retry chats').click()
  await expect(sidebar.locator('[data-conversation-id="thread-writing-retry"]')).toHaveCount(0)
  expect(writes).toBe(1)
})

test('retains native sessions after archive failure and pages through older chats', async ({ page }) => {
  const store: ThreadStore = {
    threads: Array.from({ length: 55 }, (_, index) => savedChat(`thread-${index}`, `Chat ${index}`, 100 - index)),
  }
  const mock = await mockTengri(page, { threadStore: store })
  let fail = true
  await page.route('**/api/tengri', (route) =>
    route.request().method() === 'POST' && route.request().postDataJSON().action === 'set-thread-archived' && fail
      ? replyWithError(route, 503, 'Archive is temporarily unavailable')
      : route.fallback(),
  )
  await page.goto('/')
  const sidebar = page.getByTestId('agent-conversation-sidebar')
  await expect(sidebar.locator('[data-conversation-id]')).toHaveCount(50)
  await exactButton(sidebar, 'Load older chats').click()
  await expect(sidebar.locator('[data-conversation-id]')).toHaveCount(55)
  expect(mock.calls('list-threads')).toContainEqual(expect.objectContaining({ cursor: 'page:50' }))
  await exactButton(sidebar, 'Chat 0').hover()
  await exactButton(sidebar, 'Archive Chat 0').click()
  await expect(sidebar.getByRole('alert')).toHaveText('Archive is temporarily unavailable')
  await expect(sidebar.locator('[data-conversation-id="thread-0"]')).toBeVisible()
  expect(store.threads[0].archived).toBe(false)
  fail = false
  await exactButton(sidebar, 'Chat 0').hover()
  await exactButton(sidebar, 'Archive Chat 0').click()
  await expect(sidebar.locator('[data-conversation-id="thread-0"]')).toHaveCount(0)
  await expect(sidebar.getByRole('alert')).toHaveCount(0)
})

test('reconciles a lost archive response by reading the native index without resending', async ({ page }) => {
  const store: ThreadStore = {
    threads: [savedChat('thread-archiving', 'Archive me', 1)],
  }
  await mockTengri(page, { threadStore: store })
  let writes = 0
  await routeTengriAction(page, 'set-thread-archived', (_request, route) => {
    writes += 1
    store.threads[0].archived = true
    return replyWithError(route, 503, 'Archive confirmation was interrupted')
  })
  await page.goto('/')
  const sidebar = page.getByTestId('agent-conversation-sidebar')
  await exactButton(sidebar, 'Archive me').hover()
  await exactButton(sidebar, 'Archive Archive me').click()
  await expect(sidebar.getByRole('alert')).toHaveText('Archive confirmation was interrupted')
  await exactButton(sidebar, 'Retry chats').click()
  await expect(sidebar.locator('[data-conversation-id="thread-archiving"]')).toHaveCount(0)
  await exactButton(sidebar, 'Archived chats').click()
  await expect(sidebar.locator('[data-conversation-id="thread-archiving"]')).toBeVisible()
  expect(writes).toBe(1)
})

test('stops idle chat polling while retaining minute-level connection checks', async ({ page }) => {
  await page.clock.install()
  const mock = await visitDesktop(page)
  await page.getByRole('textbox', { name: 'Message your agent' }).fill('An unsent draft')
  // Wait for the initial chat recovery before advancing its timers.
  await expect(exactButton(page, 'Send message')).toBeEnabled()
  expect(mock.calls('active-codex-runs')).toHaveLength(1)
  await page.clock.runFor(30_000)
  expect(mock.calls('active-codex-runs')).toHaveLength(1)
  // ReadyDesktop independently checks all conversations once per minute before
  // renewing platform connections, including when chat windows are closed.
  await page.clock.runFor(31_000)
  await expect.poll(() => mock.calls('active-codex-runs').length).toBe(2)
  await page.clock.runFor(60_000)
  await expect.poll(() => mock.calls('active-codex-runs').length).toBe(3)
})

test('runs another conversation while keeping each active response unarchivable', async ({ page }) => {
  const mock = await mockTengri(page, {
    threadStore: {
      threads: [savedChat('thread-working', 'Working', 2), savedChat('thread-other', 'Other', 1)],
    },
    durableRun: codexRun('77777777-7777-4777-8777-777777777777', 'thread-working', {
      phase: 'running',
      turnId: 'turn-working',
    }),
  })
  await page.goto('/')
  const sidebar = page.getByTestId('agent-conversation-sidebar')
  const working = sidebar.locator('[data-conversation-id="thread-working"]').locator('..')
  const progress = working.locator('span[aria-hidden="true"]')
  const archive = exactButton(sidebar, 'Archive Working')
  await page.mouse.move(0, 0)
  await expect(progress).toHaveCSS('opacity', '1')
  await expect(archive.locator('..')).toHaveCSS('opacity', '0')
  await exactButton(sidebar, 'Working').hover()
  await expect(progress).toHaveCSS('opacity', '0')
  await expect(archive.locator('..')).toHaveCSS('opacity', '1')
  const progressBounds = await progress.boundingBox()
  const archiveBounds = await archive.boundingBox()
  expect(progressBounds).toEqual(archiveBounds)
  await expect(exactButton(sidebar, 'Archive Working')).toBeDisabled()
  await sidebar.locator('[data-conversation-id="thread-other"]').click()
  await expect(page.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await expect(exactButton(sidebar, 'New conversation')).toBeEnabled()
  await page.getByRole('textbox', { name: 'Message your agent' }).fill('Work in the second conversation')
  await exactButton(page, 'Send message').click()
  await expect.poll(() => mock.calls('send-turn').length).toBe(1)
  expect(mock.calls('send-turn')[0]?.threadId).toBe('thread-other')
  expect(mock.calls('interrupt-turn')).toHaveLength(0)
  await expect(page.getByText('Another conversation has an active run.', { exact: false })).toHaveCount(0)
  for (const title of ['Working', 'Other']) {
    await exactButton(sidebar, title).hover()
    await expect(exactButton(sidebar, `Archive ${title}`)).toBeDisabled()
  }
  await page.reload()
  await expect(exactButton(page, 'Stop response')).toBeEnabled()
  await sidebar.locator('[data-conversation-id="thread-working"]').click()
  await exactButton(page, 'Stop response').click()
  await expect.poll(() => mock.calls('interrupt-turn')[0]?.runId).toBe('77777777-7777-4777-8777-777777777777')
  await sidebar.locator('[data-conversation-id="thread-other"]').click()
  await expect(exactButton(page, 'Stop response')).toBeEnabled()
})

test('clears unsent text and images when starting another new conversation', async ({ page }) => {
  const mock = await visitDesktop(page)
  const tengri = desktopWindow(page, 'Tengri')
  const composer = composerInput(tengri)
  await composer.fill('Discard this unsent draft')
  await pasteClipboardImage(page, composer)
  await expect(tengri.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
  await tengri.getByTestId('agent-conversation-sidebar').getByLabel('New conversation', { exact: true }).click()
  await expect(composer).toHaveValue('')
  await expect(tengri.getByRole('list', { name: 'Image attachments' })).toHaveCount(0)
  await expect(composer).toBeFocused()
  expect(mock.calls('create-thread', 'send-turn')).toHaveLength(0)
})

test('recovers a run started in an already open conversation before steering it', async ({ page }) => {
  const run: TengriCodexRun = codexRun('77777777-7777-4777-8777-777777777777', 'thread-shared', {
    phase: 'succeeded',
    turnId: 'turn-previous',
  })
  const mock = await mockTengri(page, {
    durableRun: run,
    threadStore: { threads: [savedChat(run.threadId, 'Shared conversation', 1)] },
    resumeThreadRawJson: codexHistory([]),
  })
  await selectSavedThread(page, 'thread-shared')
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const composer = composerInput(chat)
  await composer.fill('Keep this draft')
  await expect(exactButton(chat, 'Send message')).toBeEnabled()
  run.state = { phase: 'running', turnId: 'turn-shared' }
  await emitCodexEvent(page, {
    kind: 'thread-state',
    method: 'turn/started',
    threadId: run.threadId,
    turnId: 'turn-shared',
  })
  await expect(composer).toHaveValue('Keep this draft')
  await expect(exactButton(chat, 'Steer turn')).toBeEnabled()
  await composer.fill('')
  await expect(exactButton(chat, 'Stop response')).toBeEnabled()
  await composer.fill('Continue the current work')
  await exactButton(chat, 'Steer turn').click()
  await expect
    .poll(() => mock.calls('steer-turn')[0])
    .toMatchObject({ runId: run.runId, threadId: run.threadId, turnId: 'turn-shared' })
  expect(mock.calls('send-turn')).toHaveLength(0)
  await expect(composer).toBeFocused()
})

test('runs conversations concurrently while retaining each conversation draft and accepted prompt', async ({
  page,
}) => {
  const activeThread = codexHistory([runningTurn('turn-1')])
  const mock = await visitDesktop(page, { resumeThreadRawJson: activeThread })
  const tengri = desktopWindow(page, 'Tengri')
  const sidebar = tengri.getByTestId('agent-conversation-sidebar')
  const composer = composerInput(tengri)
  const newConversation = sidebar.getByLabel('New conversation', { exact: true })
  await composer.fill('Keep the first conversation running.')
  await exactButton(tengri, 'Send message').click()
  await newConversation.click()
  await expect(composer).toHaveValue('')
  await expect(composer).toBeFocused()
  await expect(tengri.getByRole('article', { name: 'Your message' })).toHaveCount(0)
  await composer.fill('Work on the second conversation.')
  await expect(exactButton(tengri, 'Send message')).toBeEnabled()
  await expect(tengri.getByText('Another conversation has an active run.', { exact: false })).toHaveCount(0)
  await exactButton(tengri, 'Send message').click()
  await expect.poll(() => mock.calls('create-thread').length).toBe(2)
  await expect.poll(() => mock.calls('send-turn').map((action) => action.threadId)).toEqual(['thread-1', 'thread-2'])
  await sidebar.locator('[data-conversation-id="thread-1"]').click()
  await expect(composer).toBeEnabled()
  await expect(composer).toBeFocused()
  await expect(tengri.getByRole('article', { name: 'Your message' })).toHaveText('Keep the first conversation running.')
  await composer.fill('First draft')
  await pasteClipboardImage(page, composer)
  await expect(tengri.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
  await sidebar.locator('[data-conversation-id="thread-2"]').click()
  await expect(composer).toBeEnabled()
  await expect(composer).toHaveValue('')
  await expect(tengri.getByRole('list', { name: 'Image attachments' })).toHaveCount(0)
  await expect(tengri.getByRole('article', { name: 'Your message' })).toHaveText('Work on the second conversation.')
  await composer.fill('Second draft')
  await sidebar.locator('[data-conversation-id="thread-1"]').click()
  await expect(composer).toHaveValue('First draft')
  await expect(tengri.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
  await newConversation.click()
  await expect(composer).toHaveValue('')
  await expect(tengri.getByRole('article', { name: 'Your message' })).toHaveCount(0)
  await sidebar.locator('[data-conversation-id="thread-2"]').click()
  await expect(composer).toHaveValue('Second draft')
  await expect(tengri.getByRole('list', { name: 'Image attachments' })).toHaveCount(0)
  expect(mock.calls('interrupt-turn')).toHaveLength(0)
})

test('retains draft conversation notices after assigning its first server thread identifier', async ({ page }) => {
  await visitDesktop(page)
  const tengri = desktopWindow(page, 'Tengri')
  const sidebar = tengri.getByTestId('agent-conversation-sidebar')
  const composer = composerInput(tengri)
  await expect(composer).toBeEnabled()
  for (const [index, kind] of (['warning', 'error'] as const).entries()) {
    await emitCodexEvent(page, {
      sequence: index + 1,
      threadId: '',
      turnId: '',
      kind,
      method: 'tengri/eventOmitted',
      text: `Draft conversation ${kind}`,
    })
    await expect(tengri.getByText(`Draft conversation ${kind}`, { exact: true })).toHaveCount(1)
  }
  await composer.fill('Start the first conversation')
  await exactButton(tengri, 'Send message').click()
  await expect(sidebar.locator('[data-conversation-id="thread-1"]')).toBeVisible()
  await sidebar.getByLabel('New conversation', { exact: true }).click()
  for (const kind of ['warning', 'error'] as const) {
    await expect(tengri.getByText(`Draft conversation ${kind}`, { exact: true })).toHaveCount(0)
  }
  await emitCodexEvent(page, { sequence: 3, method: 'turn/completed', kind: 'thread-state' })
  await composer.fill('Start the second conversation')
  await exactButton(tengri, 'Send message').click()
  await expect(sidebar.locator('[data-conversation-id="thread-2"]')).toBeVisible()
  for (const kind of ['warning', 'error'] as const) {
    await expect(tengri.getByText(`Draft conversation ${kind}`, { exact: true })).toHaveCount(0)
  }
  await sidebar.locator('[data-conversation-id="thread-1"]').click()
  await expect(composer).toBeEnabled()
  for (const kind of ['warning', 'error'] as const) {
    await expect(tengri.getByText(`Draft conversation ${kind}`, { exact: true })).toHaveCount(1)
  }
})

test('keeps queued warnings and errors with their arrival conversation across navigation', async ({ page }) => {
  await visitDesktop(page, {
    savedThread: 'thread-alpha',
    threadStore: {
      threads: [savedChat('thread-alpha', 'Alpha', 2), savedChat('thread-beta', 'Beta', 1)],
    },
  })
  const tengri = desktopWindow(page, 'Tengri')
  const sidebar = tengri.getByTestId('agent-conversation-sidebar')
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await page.evaluate(() => {
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
    const requestFrame = window.requestAnimationFrame
    const frames: FrameRequestCallback[] = []
    window.requestAnimationFrame = (callback) => {
      frames.push(callback)
      return 1_000_000 + frames.length
    }
    try {
      for (const event of [
        { sequence: 1, kind: 'warning' as const, threadId: 'thread-alpha', text: 'Alpha warning before a frame' },
        { sequence: 2, kind: 'error' as const, threadId: '', text: 'Alpha error without a thread identifier' },
      ]) {
        source.onmessage(
          new MessageEvent('message', {
            data: JSON.stringify({
              ...event,
              method: 'tengri/eventOmitted',
              turnId: '',
              itemId: '',
              approvalId: '',
              rawJson: '{}',
            }),
          }),
        )
      }
    } finally {
      window.requestAnimationFrame = requestFrame
    }
    Object.assign(window, { releaseQueuedCodexFrames: () => frames.forEach((frame) => frame(performance.now())) })
  })
  await sidebar.locator('[data-conversation-id="thread-beta"]').click()
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await page.evaluate(() => {
    const release = (window as typeof window & { releaseQueuedCodexFrames?: () => void }).releaseQueuedCodexFrames
    if (!release) throw new Error('Queued Codex frames are unavailable')
    release()
  })
  await expect(tengri.getByText('Alpha warning before a frame', { exact: true })).toHaveCount(0)
  await expect(tengri.getByText('Alpha error without a thread identifier', { exact: true })).toHaveCount(0)
  await sidebar.locator('[data-conversation-id="thread-alpha"]').click()
  await expect(tengri.getByText('Alpha warning before a frame', { exact: true })).toHaveCount(1)
  await expect(tengri.getByText('Alpha error without a thread identifier', { exact: true })).toHaveCount(1)
})

test('retains approvals across navigation and reconciles background approval outcomes', async ({ page }) => {
  const history = (status: string, turnId: string) => codexHistory([{ id: turnId, status, items: [] }])
  const histories = {
    'thread-alpha': history('inProgress', 'turn-alpha'),
    'thread-beta': history('inProgress', 'turn-beta'),
  }
  const mock = await visitDesktop(page, {
    savedThread: 'thread-alpha',
    threadStore: {
      threads: [savedChat('thread-alpha', 'Alpha', 2), savedChat('thread-beta', 'Beta', 1)],
    },
    resumeThreadRawJsonById: histories,
  })
  const tengri = desktopWindow(page, 'Tengri')
  const sidebar = tengri.getByTestId('agent-conversation-sidebar')
  const approval = tengri.getByRole('article', { name: 'Codex approval' })
  const approve = exactButton(tengri, 'Approve once')
  const event = codexEvent({
    threadId: 'thread-alpha',
    turnId: 'turn-alpha',
    kind: 'approval',
    method: 'item/commandExecution/requestApproval',
    itemId: 'approval-alpha-one',
    approvalId: '101',
    text: 'Run the first Alpha check?',
    rawJson: codexParams({ availableDecisions: ['accept', 'decline'] }),
  })
  await expect(tengri.getByRole('textbox', { name: 'Steer the current turn' })).toBeEnabled()
  await emitCodexEvent(page, { ...event, sequence: 1 })
  await expect(approve).toBeVisible()
  await sidebar.getByLabel('New conversation', { exact: true }).click()
  await expect(approval).toHaveCount(0)
  await sidebar.locator('[data-conversation-id="thread-alpha"]').click()
  await expect(approval).toHaveText(/Run the first Alpha check\?/)
  await expect(approve).toBeVisible()
  await sidebar.locator('[data-conversation-id="thread-beta"]').click()
  await expect(approval).toHaveCount(0)
  await emitCodexEvent(page, {
    ...event,
    sequence: 2,
    itemId: 'approval-alpha-two',
    approvalId: '102',
    text: 'Run the second Alpha check?',
  })
  await emitCodexEvent(page, {
    ...event,
    sequence: 3,
    kind: 'thread-state',
    method: 'serverRequest/resolved',
    itemId: '',
    approvalId: '',
    text: '',
    rawJson: codexParams({ threadId: 'thread-alpha', requestId: 101 }),
  })
  await expect(approval).toHaveCount(0)
  await sidebar.locator('[data-conversation-id="thread-alpha"]').click()
  await expect(approval).toHaveCount(1)
  await expect(approval).toHaveText(/Run the second Alpha check\?/)
  await approve.click()
  await expect
    .poll(() => mock.calls('resolve-approval'))
    .toMatchObject([{ approvalId: '102', decision: 'approve-once' }])
  await expect(approval).toHaveCount(0)
  await sidebar.locator('[data-conversation-id="thread-beta"]').click()
  await sidebar.locator('[data-conversation-id="thread-alpha"]').click()
  await expect(approval).toHaveCount(0)
  await emitCodexEvent(page, { ...event, sequence: 4, itemId: 'approval-alpha-three', approvalId: '103' })
  await expect(approve).toBeVisible()
  await sidebar.locator('[data-conversation-id="thread-beta"]').click()
  histories['thread-alpha'] = history('completed', 'turn-alpha')
  await emitCodexEvent(page, {
    ...event,
    sequence: 5,
    kind: 'thread-state',
    method: 'turn/completed',
    itemId: '',
    approvalId: '',
    text: '',
    rawJson: '{}',
  })
  await sidebar.locator('[data-conversation-id="thread-alpha"]').click()
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await expect(approval).toHaveCount(0)
  await emitCodexEvent(page, {
    ...event,
    sequence: 6,
    turnId: 'turn-alpha-next',
    kind: 'thread-state',
    method: 'turn/started',
    approvalId: '',
    itemId: '',
    text: '',
    rawJson: '{}',
  })
  await emitCodexEvent(page, {
    ...event,
    sequence: 7,
    turnId: 'turn-alpha-next',
    approvalId: '104',
    itemId: 'approval-alpha-next',
  })
  await expect(approve).toBeVisible()
  await emitCodexEvent(page, {
    ...event,
    sequence: 8,
    turnId: 'turn-alpha-next',
    kind: 'thread-state',
    method: 'turn/completed',
    approvalId: '',
    itemId: '',
    text: '',
    rawJson: '{}',
  })
  await expect(approval).toHaveCount(0)
  await expect(tengri.getByLabel('Agent status', { exact: true })).toHaveText('Ready')
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
})

test('keeps the latest sidebar selection when an earlier history request finishes later', async ({ page }) => {
  const history = (name: string) =>
    codexHistory([completedTurn(`turn-${name}`, [agentMessage(`answer-${name}`, `${name} history`)])])
  const mock = await visitDesktop(page, {
    savedThread: 'thread-alpha',
    threadStore: {
      threads: [
        savedChat('thread-alpha', 'Alpha', 3),
        savedChat('thread-beta', 'Beta', 2),
        savedChat('thread-gamma', 'Gamma', 1),
      ],
    },
    holdReplayResume: true,
    resumeThreadRawJsonById: {
      'thread-alpha': history('Alpha'),
      'thread-beta': history('Beta'),
      'thread-gamma': history('Gamma'),
    },
  })
  const tengri = desktopWindow(page, 'Tengri')
  const sidebar = tengri.getByTestId('agent-conversation-sidebar')
  await expect(tengri.getByRole('article', { name: 'Codex response' })).toHaveText('Alpha history')
  await sidebar.locator('[data-conversation-id="thread-beta"]').click()
  await mock.waitForHeldResume()
  await sidebar.locator('[data-conversation-id="thread-gamma"]').click()
  await expect(tengri.getByRole('article', { name: 'Codex response' })).toHaveText('Gamma history')
  mock.releaseHeldResume()
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBe(3)
  await expect(tengri.getByRole('article', { name: 'Codex response' })).toHaveText('Gamma history')
  await expect(sidebar.locator('[data-conversation-id="thread-gamma"]')).toHaveAttribute('aria-current', 'true')
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-gamma')
  expect(
    await sidebar
      .locator('[data-conversation-id]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-conversation-id'))),
  ).toEqual(['thread-alpha', 'thread-beta', 'thread-gamma'])
})

test('uses consistent fonts and body typography in chat, portal menus, diagrams, and the terminal', async ({
  page,
}) => {
  await mockTengri(page, {
    threadStore: { threads: [savedChat('thread-1', 'Inspect the workspace.', 1)] },
    resumeThreadRawJson: codexHistory([
      completedTurn('turn-1', [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Inspect the workspace.' }] },
        agentMessage(
          'answer-1',
          'Reading the workspace.\n\n```ts\nconst ready = true\n```\n\n```mermaid\nflowchart LR\nA[Start] --> B[Done]\n```',
        ),
        { id: 'output-1', type: 'commandExecution', aggregatedOutput: 'Workspace ready' },
      ]),
    ]),
  })
  await page.addInitScript(() => {
    localStorage.setItem('tengri-thread:microvm-ada', 'thread-1')
    const fonts = new Set<string>()
    Object.defineProperty(window, '__terminalFonts', { value: fonts })
    // oxlint-disable-next-line typescript/unbound-method -- Applied to the measured canvas context below.
    const measureText = OffscreenCanvasRenderingContext2D.prototype.measureText
    OffscreenCanvasRenderingContext2D.prototype.measureText = function (
      this: OffscreenCanvasRenderingContext2D,
      text: string,
    ) {
      if (this.font.includes('13px')) fonts.add(this.font)
      return measureText.call(this, text)
    }
  })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  const user = tengri.getByRole('article', { name: 'Your message' })
  const response = tengri.getByRole('article', { name: 'Codex response' })
  const prompt = tengri.getByRole('textbox', { name: 'Message your agent' })
  const systemFont = await prompt.evaluate((element) => getComputedStyle(element).fontFamily)
  expect(systemFont).toMatch(/geist.*sans/i)
  for (const text of [user, response, prompt]) {
    await expect(text).toHaveCSS('font-family', systemFont)
    await expect(text).toHaveCSS('font-size', '14px')
    await expect(text).toHaveCSS('line-height', '20px')
    await expect(text).toHaveCSS('font-weight', '400')
  }
  await expect(tengri.getByLabel('Agent status')).toHaveCSS('font-size', '12px')
  await expect(tengri.getByLabel('Agent status')).toHaveCSS('line-height', '16px')
  await expect(
    tengri.getByTestId('agent-conversation-sidebar').locator('[data-conversation-id] span').first(),
  ).toHaveCSS('font-size', '14px')
  await expect(
    response.getByRole('img', { name: 'Mermaid diagram', exact: true }).locator('svg text').first(),
  ).toHaveCSS('font-family', systemFont)
  await exactButton(tengri, 'Ran commands').first().click()
  await tengri.getByRole('article', { name: 'Codex output' }).locator('summary').click()
  const output = tengri.getByRole('article', { name: 'Codex output' }).locator('pre')
  const monoFont = await output.evaluate((element) => getComputedStyle(element).fontFamily)
  expect(monoFont).toMatch(/geist.*mono/i)
  await expect(response.locator('pre')).toHaveCSS('font-family', monoFont)
  await expect(response.locator('pre')).toHaveCSS('font-size', '13px')
  await expect(response.locator('pre')).toHaveCSS('line-height', '18px')
  await tengri.getByRole('combobox', { name: 'Model', exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCSS('font-family', systemFont)
  await page.keyboard.press('Escape')
  await exactButton(page, 'Open Terminal').click()
  await expect(
    desktopWindow(page, 'Terminal')
      .getByRole('status')
      .filter({ hasText: /^Connected$/ }),
  ).toBeVisible()
  const measuredFonts = await page.evaluate(() => [
    ...(window as typeof window & { __terminalFonts: Set<string> }).__terminalFonts,
  ])
  const normalize = (font: string) => font.replace(/["'\s]/g, '').toLowerCase()
  expect(
    measuredFonts.some((font) => normalize(font).includes(normalize(monoFont)) && font.includes('Tengri Nerd Symbols')),
  ).toBe(true)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...document.fonts].filter(
            (font) => font.status === 'loaded' && /geist/i.test(font.family) && !/fallback/i.test(font.family),
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(2)
})

test('keeps opened tool output stable during streaming and renders copyable structured responses', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T12:34:00.000Z'))
  await mockTengri(page, {
    threadStore: {
      threads: [savedChat('thread-1', 'Inspect the project and run its checks.', 1)],
    },
    resumeThreadRawJson: codexHistory([
      runningTurn('turn-1', [
        {
          id: 'user-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Inspect the project and run its checks.' }],
        },
        { id: 'output-1', type: 'commandExecution', aggregatedOutput: 'Checking types…\n' },
      ]),
    ]),
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
  const tengri = desktopWindow(page, 'Tengri')
  const commands = exactButton(tengri, 'Ran commands')
  await expect(commands).toHaveCount(1)
  await expect(commands).toHaveAttribute('aria-expanded', 'false')
  await commands.click()
  const output = tengri.getByRole('article', { name: 'Codex output' })
  await expect(tengri.getByRole('article', { name: 'Your message' })).toContainText(
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
  await expect(tengri.getByRole('cell', { name: 'Types', exact: true })).toBeVisible()
  await expect(tengri.getByRole('article', { name: 'Codex response' }).locator('pre code')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(tengri.getByRole('checkbox').first()).toBeChecked()
  await expect(tengri.getByRole('checkbox').last()).not.toBeChecked()
  await emitCodexEvent(page, {
    ...event,
    sequence: 4,
    itemId: 'approval-1',
    kind: 'approval',
    method: 'item/commandExecution/requestApproval',
    approvalId: 'approval-1',
    text: 'Run bun test in /workspace?',
    rawJson: codexParams({ availableDecisions: ['accept', 'decline'] }),
  })
  await expect(tengri.getByLabel('Agent status')).toHaveText('Approval needed')
  await expect
    .poll(() =>
      tengri
        .getByTestId('agent-conversation-scroll')
        .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
    )
    .toBeLessThan(2)
  await tengri.getByRole('button', { name: 'Close Tengri' }).hover()
  await expect.soft(tengri).toHaveScreenshot('tengri-agent-response.png')
  await tengri.getByRole('button', { name: 'Copy code block' }).click()
  await expect(tengri.getByRole('button', { name: 'Copy code block' })).toHaveText('Copied')
  expect(await page.evaluate(() => (window as typeof window & { copiedCode?: string }).copiedCode)).toBe(
    'bun run lint\nbun test\n',
  )
  await page.evaluate(() => {
    ;(window as typeof window & { failClipboard?: boolean }).failClipboard = true
  })
  await tengri.getByRole('button', { name: 'Copy code block' }).click()
  await expect(tengri.getByRole('button', { name: 'Copy code block' })).toHaveText('Copy failed')
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Tengri window"]').analyze()
  expect(
    accessibility.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'),
  ).toEqual([])
})

test('keeps streamed output expanded when replay recovery moves it into restored history', async ({ page }) => {
  const text = 'Output before reconnect.\n'
  const mock = await mockTengri(page, {
    resumeThreadEventSequence: 2,
    resumeThreadRawJson: codexHistory([
      runningTurn('turn-1', [{ id: 'output-1', type: 'commandExecution', aggregatedOutput: text }]),
    ]),
  })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await tengri.getByRole('textbox', { name: 'Message your agent' }).fill('Run the project checks.')
  await tengri.getByRole('button', { name: 'Send message' }).click()
  await expect(tengri.getByRole('button', { name: 'Stop response' })).toBeEnabled()
  await emitCodexEvent(page, {
    itemId: 'output-1',
    kind: 'tool-output',
    method: 'item/commandExecution/outputDelta',
    text,
  })
  await exactButton(tengri, 'Ran commands').first().click()
  const output = tengri.getByRole('article', { name: 'Codex output' })
  await output.locator('summary').click()
  await expect(output.locator('pre')).toBeVisible()
  await emitCodexEvent(page, {
    sequence: 2,
    turnId: '',
    kind: 'warning',
    method: 'tengri/replayWarning',
    text: 'Replay window exceeded',
  })
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBe(1)
  await expect(tengri.getByRole('textbox', { name: 'Steer the current turn' })).toBeEnabled()
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
  await prompt.fill('A wrapped draft '.repeat(40))
  await expect.poll(() => prompt.evaluate((element) => element.scrollHeight)).toBeGreaterThan(160)
  await expect(prompt).toHaveCSS('height', '160px')
  await prompt.pressSequentially(' more', { delay: 20 })
  await expect(prompt).toBeFocused()
  expect(await observationCount()).toBe(observations)
})

test('batches streamed updates without rebuilding scroll observers', async ({ page }, testInfo) => {
  await mockTengri(page, {
    resumeThreadRawJson: codexHistory([
      runningTurn(
        'turn-1',
        Array.from({ length: 60 }, (_, index) =>
          agentMessage(
            `answer-${index}`,
            `## Finding ${index + 1}\n${'Review the **workspace** and its files. '.repeat(10)}`,
          ),
        ),
      ),
    ]),
  })
  await page.addInitScript(() => {
    localStorage.setItem('tengri-thread:microvm-ada', 'thread-1')
    const state = { observations: 0 }
    Object.defineProperty(window, '__streamResizeState', { value: state })
    const NativeResizeObserver = window.ResizeObserver
    window.ResizeObserver = class extends NativeResizeObserver {
      observe(target: Element, options?: ResizeObserverOptions) {
        if (target.getAttribute('data-testid') === 'agent-conversation-scroll') state.observations += 1
        super.observe(target, options)
      }
    }
  })
  await page.goto('/')
  await expect(page.getByRole('article', { name: 'Codex response' })).toHaveCount(60)
  await expect(page.getByTestId('agent-event-stream')).toHaveAttribute('data-state', 'connected')
  const observations = () =>
    page.evaluate(
      () =>
        (window as typeof window & { __streamResizeState: { observations: number } }).__streamResizeState.observations,
    )
  const before = await observations()
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  const metricsBefore = await session.send('Performance.getMetrics')
  await page.evaluate(async () => {
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
    for (let index = 0; index < 100; index += 1) {
      source.onmessage(
        new MessageEvent('message', {
          data: JSON.stringify({
            sequence: index + 1,
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'streamed-answer',
            approvalId: '',
            rawJson: '{}',
            kind: 'assistant-text' as const,
            method: 'item/agentMessage/delta',
            text: `${index} `,
          }),
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
  })
  await expect(page.getByRole('article', { name: 'Codex response' }).last()).toHaveText(
    Array.from({ length: 100 }, (_, index) => `${index}`).join(' '),
  )
  const metricsAfter = await session.send('Performance.getMetrics')
  const durations = ['ScriptDuration', 'LayoutDuration'].map((name) => ({
    name,
    milliseconds:
      1_000 *
      ((metricsAfter.metrics.find((metric) => metric.name === name)?.value ?? 0) -
        (metricsBefore.metrics.find((metric) => metric.name === name)?.value ?? 0)),
  }))
  await testInfo.attach('streaming-metrics', {
    body: JSON.stringify({ durations, observationsBefore: before, observationsAfter: await observations() }),
    contentType: 'application/json',
  })
  expect(await observations()).toBe(before)
})

test('keeps following when a delayed scroll event arrives after streamed content grows', async ({ page }) => {
  await mockTengri(page, {
    resumeThreadRawJson: codexHistory([
      runningTurn('turn-1', [agentMessage('answer-1', 'Workspace finding.\n\n'.repeat(40))]),
    ]),
  })
  await selectSavedThread(page, 'thread-1')
  await page.goto('/')
  const conversation = page.getByTestId('agent-conversation-scroll')
  await expect(page.getByRole('article', { name: 'Codex response' })).toHaveCount(1)
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await conversation.evaluate((element) => {
    const content = element.querySelector('[role="log"]')
    if (!content) throw new Error('Conversation content is unavailable')
    const observer = new MutationObserver(() => {
      observer.disconnect()
      element.dispatchEvent(new Event('scroll'))
    })
    observer.observe(content, { childList: true, subtree: true, characterData: true })
  })
  await emitCodexEvent(page, {
    itemId: 'answer-new',
    method: 'item/agentMessage/delta',
    text: 'More streamed detail.\n\n'.repeat(12),
  })
  await expect(page.getByRole('article', { name: 'Codex response' })).toHaveCount(2)
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
})

test('recovery follows the latest restored message and stays at the bottom after an image loads', async ({ page }) => {
  const items = Array.from({ length: 30 }, (_, index) =>
    agentMessage(`answer-${index}`, `Workspace finding ${index + 1}. ${'A detailed explanation. '.repeat(12)}`),
  )
  const options: MockOptions = {
    holdReplayResume: true,
    resumeThreadRawJson: codexHistory([completedTurn('turn-1', items)]),
  }
  const mock = await mockTengri(page, options)
  await selectSavedThread(page, 'thread-1')
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  const conversation = tengri.getByTestId('agent-conversation-scroll')
  const distanceFromBottom = () =>
    conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
  await expect(tengri.getByRole('article', { name: 'Codex response' })).toHaveCount(30)
  await expect.poll(distanceFromBottom).toBeLessThan(2)
  await tengri.getByRole('textbox', { name: 'Message your agent' }).fill('Keep my recovery draft')
  await conversation.evaluate((element) => {
    element.scrollTop = 0
  })
  const jumpToLatest = tengri.getByRole('button', { name: 'Jump to latest' })
  await expect(jumpToLatest).toBeVisible()
  await expect(jumpToLatest).toHaveText('')
  await expect(jumpToLatest.getByTestId('jump-to-latest-dots')).toBeVisible()
  await expect(jumpToLatest.getByTestId('jump-to-latest-arrow')).not.toBeVisible()

  await jumpToLatest.hover()
  await expect(jumpToLatest.getByTestId('jump-to-latest-dots')).not.toBeVisible()
  await expect(jumpToLatest.getByTestId('jump-to-latest-arrow')).toBeVisible()

  await page.mouse.move(0, 0)
  await page.keyboard.press('Tab')
  await jumpToLatest.focus()
  await expect(jumpToLatest.getByTestId('jump-to-latest-arrow')).toBeVisible()
  await jumpToLatest.evaluate((button) => button.blur())
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 480
    const context = canvas.getContext('2d')!
    context.fillStyle = '#18181b'
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const imageResponse = Promise.withResolvers<void>()
  await page.route('**/api/tengri/attachments?*', async (route) => {
    await imageResponse.promise
    await route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') })
  })
  await emitCodexEvent(page, {
    kind: 'warning',
    method: 'tengri/replayWarning',
    turnId: '',
    text: 'Recovering a gap in the event stream.',
  })
  await mock.waitForHeldResume()
  options.resumeThreadRawJson = codexHistory([
    completedTurn('turn-1', [
      ...items,
      agentMessage(
        'latest-restored',
        'The latest restored reply.\n\n![Recovered diagram](/workspace/recovered-diagram.png)',
      ),
    ]),
  ])
  mock.releaseHeldResume()
  try {
    await expect(tengri.getByRole('article', { name: 'Codex response' })).toHaveCount(31)
    await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
    await expect(exactButton(tengri, 'Retry')).toHaveCount(0)
    await expect.poll(distanceFromBottom).toBeLessThan(2)
  } finally {
    imageResponse.resolve()
  }
  const image = tengri.getByRole('img', { name: 'Recovered diagram', exact: true })
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(640)
  await expect.poll(distanceFromBottom).toBeLessThan(2)
  await expect(tengri.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toHaveValue('Keep my recovery draft')
})

test('groups tool activity into a quiet readable transcript with working disclosure controls', async ({ page }) => {
  await visitDesktop(page, {
    savedThread: 'thread-1',
    resumeThreadRawJson: codexHistory([
      runningTurn('turn-1', [
        agentMessage('intro', 'I’ll inspect the workspace and trace the conversation state before making changes.'),
        { id: 'read', type: 'commandExecution', command: 'cat /workspace/AGENTS.md', status: 'completed' },
        {
          id: 'search',
          type: 'commandExecution',
          command: 'rg -n recovery services/tengri',
          status: 'completed',
        },
        {
          id: 'result',
          type: 'commandExecution',
          aggregatedOutput:
            'Found the recovery state and its callers.\nThe composer waits for the selected conversation.',
          status: 'completed',
          exitCode: 0,
        },
        agentMessage(
          'explanation',
          'The conversation loads normally. I’m checking how late responses are discarded and how the view follows the latest message.\n\nThe existing draft stays with its conversation while these checks run.',
        ),
        { id: 'status', type: 'commandExecution', command: 'git status --short', status: 'inProgress' },
        {
          id: 'github',
          type: 'mcpToolCall',
          server: 'codex_apps',
          tool: 'github.create_branch',
          arguments: { repository_full_name: 'proompteng/lab', branch_name: 'codex/chat-polish' },
        },
        {
          id: 'github-result',
          type: 'mcpToolCall',
          server: 'codex_apps',
          tool: 'github.create_branch',
          arguments: { repository_full_name: 'proompteng/lab', branch_name: 'codex/chat-polish' },
          result: {
            content: [{ type: 'text', text: 'Action completed.' }],
            structuredContent: { branch: 'codex/chat-polish', sha: 'abc123' },
          },
        },
      ]),
    ]),
  })
  const tengri = desktopWindow(page, 'Tengri')
  await exactButton(tengri, 'Maximize Tengri').click()
  const groups = exactButton(tengri, 'Ran commands')
  const group = groups.first()
  await expect(groups).toHaveCount(2)
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(tengri.getByText('Read AGENTS.md', { exact: true })).toBeHidden()

  await group.focus()
  await group.press('Enter')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await expect(tengri.getByText('Read AGENTS.md', { exact: true })).toBeVisible()
  await expect(tengri.getByText('Searched rg -n recovery services/tengri', { exact: true })).toBeVisible()
  const output = tengri.getByRole('article', { name: 'Codex output' }).filter({ hasText: 'Found the recovery state' })
  await output.locator('summary').click()
  await expect(output.locator('pre')).toBeVisible()
  await expect(output.locator('pre')).not.toContainText('[2m')
  await group.focus()
  await group.press('Enter')
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(output).toBeHidden()
  await expect(tengri.getByText(/The conversation loads normally/)).toBeVisible()
  await group.press('Enter')
  await expect(output.locator('pre')).toBeVisible()
  await output.locator('summary').click()
  await groups.nth(1).click()
  const github = tengri.getByRole('article', { name: 'Codex activity' }).filter({ hasText: 'GitHub · Create branch' })
  await expect(github.locator('summary')).toHaveText('GitHub · Create branch · codex/chat-polish')
  await github.locator('summary').click()
  await expect(github.locator('pre')).toContainText('codex/chat-polish')
  await github.locator('summary').click()
  const githubResult = tengri
    .getByRole('article', { name: 'Codex output' })
    .filter({ hasText: 'GitHub · Create branch' })
  await githubResult.locator('summary').click()
  await expect(githubResult.locator('pre')).toContainText('"sha": "abc123"')

  await githubResult.locator('summary').click()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(group).toBeVisible()
  const conversation = tengri.getByTestId('agent-conversation-scroll')
  expect(await conversation.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)

  expect((await new AxeBuilder({ page }).include('[aria-label="Tengri window"]').analyze()).violations).toEqual([])
})

test('preserves the reading position while new events arrive and returns to the latest message on request', async ({
  page,
}) => {
  await visitDesktop(page, {
    savedThread: 'thread-1',
    resumeThreadRawJson: codexHistory([
      runningTurn(
        'turn-1',
        Array.from({ length: 24 }, (_, index) =>
          agentMessage(
            `answer-${index}`,
            `Workspace finding ${index + 1}. ${'A detailed explanation of the change. '.repeat(12)}`,
          ),
        ),
      ),
    ]),
  })
  const tengri = desktopWindow(page, 'Tengri')
  const conversation = tengri.getByTestId('agent-conversation-scroll')
  await expect(tengri.getByRole('article', { name: 'Codex response' })).toHaveCount(24)
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await conversation.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(tengri.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
  await emitCodexEvent(page, {
    itemId: 'answer-new',
    method: 'item/agentMessage/delta',
    text: 'The newest streamed message.',
  })
  await expect(tengri.getByText('The newest streamed message.', { exact: true })).toBeAttached()
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(0)

  await tengri.getByRole('textbox', { name: 'Steer the current turn' }).fill('A long draft\n'.repeat(10))
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(0)
  await tengri.getByRole('button', { name: 'Jump to latest' }).click()
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await expect(tengri.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
  await tengri.getByRole('textbox', { name: 'Steer the current turn' }).fill('A short draft')
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await tengri.getByRole('textbox', { name: 'Steer the current turn' }).fill('A long draft\n'.repeat(10))
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(2)
  await emitCodexEvent(page, {
    sequence: 2,
    itemId: 'answer-new',
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
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('heading', { name: 'Connect Codex', exact: true })).toBeVisible()
  await expect(tengri.getByRole('link', { name: 'Open verification' })).toHaveAttribute(
    'href',
    'https://auth.openai.com/device',
  )
  await tengri.getByRole('button', { name: 'Close Tengri' }).hover()
  await expect.soft(tengri).toHaveScreenshot('tengri-agent-login.png')
  await exactButton(tengri, 'Copy code').click()
  await expect(exactButton(tengri, 'Copy code')).toHaveText('Copied')
  expect(await page.evaluate(() => (window as typeof window & { copiedLoginCode?: string }).copiedLoginCode)).toBe(
    'TENG-RI99',
  )
  await tengri.getByRole('button', { name: 'Restart device login' }).click()
  await expect(tengri.getByText('TENG-RI01')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 680 })
  await expect(exactButton(tengri, 'Copy code')).toBeInViewport()
  await expect(tengri.getByRole('link', { name: 'Open verification' })).toBeInViewport()
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Tengri window"]').analyze()
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
  const mock = await visitDesktop(page)
  const prompt = page.getByRole('textbox', { name: 'Message your agent', exact: true })
  await expect(prompt).toBeEnabled()
  const expected = await pasteClipboardImage(page, prompt)
  const attachments = page.getByRole('list', { name: 'Image attachments' })
  await expect(attachments.getByRole('img')).toHaveCount(1)
  expect((await new AxeBuilder({ page }).include('[aria-label="Message composer"]').analyze()).violations).toEqual([])

  await exactButton(page, 'Send message').click()
  await expect
    .poll(() => mock.calls('send-turn')[0])
    .toMatchObject({ text: '', images: [{ mediaType: 'image/png', data: expected }] })
  await expect(attachments).toHaveCount(0)
  const message = page.getByRole('article', { name: 'Your message' })
  await expect(message.getByRole('img', { name: 'Attached image 1' })).toBeVisible()
  await expect(message.getByRole('img')).toHaveAttribute('src', `data:image/png;base64,${expected}`)
  const attachmentPath = '/workspace/.tengri-attachments/11111111-1111-4111-8111-111111111111.png'
  await page.route('**/api/tengri/attachments?*', (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(expected, 'base64') }),
  )
  await emitCodexEvent(page, {
    kind: 'user-message',
    itemId: 'image-user-message',
    text: `[Local image: ${attachmentPath}]`,
  })
  await expect(message).toHaveCount(1)
  await expect(message.getByRole('img')).toHaveAttribute('src', /api\/tengri\/attachments\?/)
  await expect(message.getByRole('img')).toBeVisible()
})

test('keeps one attachment prompt per submission through live echoes and restored history', async ({ page }) => {
  const histories: Record<string, string> = {}
  const mock = await visitDesktop(page, { resumeThreadRawJsonById: histories, preserveDraftStorageOnReload: true })
  const text = 'Inspect these screenshots.'
  const messages = page.getByRole('article', { name: 'Your message' })
  const items = []
  for (const index of [0, 1]) {
    const prompt = page.getByRole('textbox', {
      name: index === 0 ? 'Message your agent' : 'Steer the current turn',
      exact: true,
    })
    await prompt.fill(text)
    const png = await pasteClipboardImage(page, prompt)
    await pasteClipboardImage(page, prompt)
    await page.route('**/api/tengri/attachments?*', (route) =>
      route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }),
    )
    await exactButton(page, index === 0 ? 'Send message' : 'Steer turn').click()
    await expect
      .poll(() => mock.actions.filter((action) => action.action === (index === 0 ? 'send-turn' : 'steer-turn')).length)
      .toBe(1)
    await expect(messages).toHaveCount(index + 1)
    const input = {
      id: `image-user-${index}`,
      type: 'userMessage',
      content: [
        { type: 'text', text },
        ...[0, 1].map((image) => ({
          type: 'localImage',
          path: `/workspace/.tengri-attachments/11111111-1111-4111-8111-${String(index * 2 + image).padStart(12, '0')}.png`,
        })),
      ],
    }
    items.push(input)
    for (const [phase, method] of ['item/started', 'item/completed'].entries()) {
      await emitCodexEvent(page, {
        sequence: index * 2 + phase + 1,
        kind: 'user-message',
        method,
        itemId: input.id,
        text,
        rawJson: codexParams({ item: input }),
      })
      await expect(messages).toHaveCount(index + 1)
      await expect(messages.last()).toHaveText(text)
      await expect(messages.last().getByRole('img')).toHaveCount(2)
      await expect(messages.last().getByRole('img').first()).toHaveAttribute('src', /api\/tengri\/attachments\?/)
    }
  }
  histories['thread-1'] = codexHistory([completedTurn('turn-1', items)])
  await page.reload()
  await expect(messages).toHaveCount(2)
  await expect(messages.getByRole('img')).toHaveCount(4)
})

test('retains pasted images and text after a failed send and supports retry', async ({ page }) => {
  const mock = await visitDesktop(page, { failSendTurnOnce: true })
  const prompt = page.getByRole('textbox', { name: 'Message your agent', exact: true })
  await prompt.fill('Inspect this screenshot')
  await pasteClipboardImage(page, prompt)
  await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
  await exactButton(page, 'Send message').click()
  await expect(desktopWindow(page, 'Tengri').getByRole('alert')).toContainText('Temporary image send failure')
  await expect(prompt).toHaveValue('Inspect this screenshot')
  await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
  const original = mock.calls('send-turn')[0]
  await selectOption(page, page.getByRole('combobox', { name: 'Reasoning effort' }), 'Medium')
  await exactButton(page, 'Send message').click()
  await expect.poll(() => mock.calls('send-turn').length).toBe(2)
  const retry = mock.calls('send-turn')[1]
  expect(retry.operationId).toBe(original?.operationId)
  expect(retry.model).toBe(original?.model)
  expect(retry.reasoningEffort).toBe(original?.reasoningEffort)
  await expect(page.getByText('This retry uses the original message model and reasoning settings.')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Image attachments' })).toHaveCount(0)
})

test('steers with a clipboard image and keeps plain text paste native', async ({ page }) => {
  const mock = await visitDesktop(page)
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
  await exactButton(page, 'Steer turn').click()
  await expect
    .poll(() => mock.calls('steer-turn')[0])
    .toMatchObject({ text: '', images: [{ mediaType: 'image/png', data: expected }] })
})

test('bounds pasted images and removes attachments before sending', async ({ page }) => {
  await visitDesktop(page)
  const prompt = page.getByRole('textbox', { name: 'Message your agent', exact: true })
  await expect(prompt).toBeEnabled()
  for (let count = 1; count <= 4; count += 1) {
    await pasteClipboardImage(page, prompt)
    await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(count)
  }
  await pasteClipboardImage(page, prompt)
  await expect(desktopWindow(page, 'Tengri').getByRole('alert')).toContainText('Attach at most 4 images')
  await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(4)
  for (let count = 4; count > 0; count -= 1) {
    await page
      .getByRole('button', { name: /Remove image/ })
      .first()
      .click()
    await expect(page.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(count - 1)
  }
  await expect(exactButton(page, 'Send message')).toBeDisabled()
})

test('restores the existing conversation when paginated history exceeds the unary message limit', async ({ page }) => {
  const output = 'x'.repeat(6 * 1024 * 1024)
  const mock = await visitDesktop(page, {
    savedThread: 'existing-large-thread',
    resumeThreadEventSequence: 10,
    resumeThreadRawJson: codexHistory([
      completedTurn('large-turn', [
        {
          id: 'large-output-one',
          type: 'commandExecution',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: output,
        },
        agentMessage('answer-one', 'Earlier history was restored.'),
        {
          id: 'large-output-two',
          type: 'commandExecution',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: output,
        },
        agentMessage('answer-two', 'Latest history was restored.'),
      ]),
    ]),
  })
  await expect(page.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  await expect(page.getByText('Earlier history was restored.', { exact: true })).toBeVisible()
  await expect(page.getByText('Latest history was restored.', { exact: true })).toBeVisible()
  expect(mock.calls('create-thread')).toHaveLength(0)
  expect(await page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('existing-large-thread')
})

test('reopens terminally closed chat and Finder streams without reloading the desktop', async ({ page }) => {
  const mock = await visitDesktop(page)
  const chat = desktopWindow(page, 'Tengri')
  await expect(chat.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  const finder = await openDesktopApp(page, 'Finder')
  await expect(finder).toBeVisible()
  await expect(finder.getByText('README.md', { exact: true })).toBeVisible()
  await emitCodexEvent(page, {
    sequence: 73,
    kind: 'thread-state',
    method: 'turn/completed',
    threadId: 'fixture-thread',
    turnId: 'fixture-turn',
  })
  const previousLoads = mock.calls('list-files').length
  await page.clock.install()
  const closed = await page.evaluate(() => {
    const values: unknown = Reflect.get(window, '__tengriEventSources')
    if (!Array.isArray(values)) throw new Error('Fixture event streams are unavailable')
    let closed = 0
    for (const value of values) {
      const source: unknown = value
      if (
        typeof source !== 'object' ||
        source === null ||
        !('closed' in source) ||
        source.closed ||
        !('onerror' in source) ||
        typeof source.onerror !== 'function'
      )
        continue
      Object.defineProperty(source, 'readyState', { value: EventSource.CLOSED })
      Reflect.apply(source.onerror, source, [new Event('error')])
      closed++
    }
    return closed
  })
  expect(closed).toBe(2)
  await expect(chat.getByText('Reconnecting to your agent…', { exact: true })).toHaveCount(0)
  await page.clock.runFor(1_200)
  await expect(chat.getByText('Reconnecting to your agent…', { exact: true })).toHaveCount(0)
  await expect(finder.getByText(/Reconnecting/)).toHaveCount(0)
  await expect.poll(() => mock.calls('list-files').length).toBeGreaterThan(previousLoads)
  const activeUrls = await page.evaluate(() => {
    const values: unknown = Reflect.get(window, '__tengriEventSources')
    if (!Array.isArray(values)) throw new Error('Fixture event streams are unavailable')
    return values.flatMap((value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'closed' in value &&
      !value.closed &&
      'url' in value &&
      typeof value.url === 'string'
        ? [value.url]
        : [],
    )
  })
  expect(activeUrls).toHaveLength(2)
  expect(activeUrls.some((url) => url.includes('/api/tengri/events?') && url.endsWith('&after=73'))).toBe(true)
})

for (const width of [1440, 390]) {
  test(`restores resource tabs and reopens pinned files without background reads at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const mock = await mockTengri(page, { preserveDraftStorageOnReload: true })
    await page.addInitScript(() => {
      if (sessionStorage.getItem('resource-test-initialized')) return
      sessionStorage.setItem('resource-test-initialized', 'true')
      sessionStorage.setItem(
        'tengri-resources:microvm-ada',
        JSON.stringify({
          tabs: [{ path: '/workspace/README.md', line: 2 }, { path: '/workspace/src/main.ts' }],
          activePath: '/workspace/README.md',
        }),
      )
      localStorage.setItem(
        'tengri-resource-pins:microvm-ada',
        JSON.stringify([{ path: '/workspace/README.md', line: 2 }]),
      )
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const sidebar = chat.getByTestId('agent-conversation-sidebar')
    const readmeTab = chat.getByRole('tab', { name: 'README.md', exact: true })
    await expect(readmeTab).toHaveAttribute('aria-selected', 'true')
    const preview = chat.getByRole('region', { name: 'File preview' })
    await expect(preview.getByRole('heading', { name: '/workspace/README.md:2', exact: true })).toBeVisible()
    await expect(preview.getByText('A persistent Firecracker workspace.', { exact: true })).toBeVisible()
    expect(mock.calls('read-file').map((action) => action.path)).toEqual(['/workspace/README.md'])
    await exactButton(chat, 'Close /workspace/README.md').click()
    await chat.getByRole('textbox', { name: 'Message your agent', exact: true }).fill('Keep my resource draft')
    if (width === 390) await exactButton(chat, 'Show conversations').click()
    const pins = sidebar.getByRole('navigation', { name: 'Pinned resources', exact: true })
    await exactButton(pins, 'Open /workspace/README.md').click()
    if (width === 390) await expect(sidebar).toBeHidden()
    await expect(readmeTab).toHaveAttribute('aria-selected', 'true')
    await expect(preview.getByRole('heading', { name: '/workspace/README.md:2', exact: true })).toBeVisible()
    await chat.getByRole('tab', { name: 'Chat', exact: true }).click()
    await expect(chat.getByRole('textbox', { name: 'Message your agent', exact: true })).toHaveValue(
      'Keep my resource draft',
    )
    await readmeTab.click()
    await page.reload()
    await expect(readmeTab).toHaveAttribute('aria-selected', 'true')
    await expect(preview.getByText('A persistent Firecracker workspace.', { exact: true })).toBeVisible()
    expect(
      mock.actions.filter((action) => action.action === 'read-file' && action.path === '/workspace/src/main.ts'),
    ).toHaveLength(0)
    await exactButton(preview, 'Unpin /workspace/README.md').click()
    await expect(readmeTab).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tengri-resource-pins:microvm-ada'))).toBe('[]')
    await exactButton(preview, 'Pin /workspace/README.md').click()
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tengri-resource-pins:microvm-ada') ?? '[]')))
      .toEqual([{ path: '/workspace/README.md', line: 2 }])
    expect((await new AxeBuilder({ page }).include('[aria-label="Tengri window"]').analyze()).violations).toEqual([])
    await chat.screenshot({ path: test.info().outputPath(`workspace-resources-${width}.png`) })
  })
}

test('opens folder resources as directories and preserves pins across reloads', async ({ page }) => {
  const mock = await mockTengri(page, {
    preserveDraftStorageOnReload: true,
    extraFiles: [fileEntry('/workspace/src/empty.md', 0, '', true)],
  })
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('tengri-resources:microvm-ada'))
      sessionStorage.setItem(
        'tengri-resources:microvm-ada',
        JSON.stringify({ tabs: [{ path: '/workspace/src' }], activePath: '/workspace/src' }),
      )
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const folder = chat.getByRole('region', { name: 'Folder preview' })
  await expect(exactButton(folder, 'Open /workspace/src/main.ts')).toBeVisible()
  expect(mock.calls('read-file')).not.toContainEqual(expect.objectContaining({ path: '/workspace/src' }))
  await exactButton(folder, 'Pin /workspace/src').click()
  await exactButton(folder, 'Open /workspace/src/empty.md').click()
  await expect(folder.getByText('This folder is empty.', { exact: true })).toBeVisible()
  await expect(folder.getByRole('group', { name: 'Markdown view' })).toHaveCount(0)
  await exactButton(folder, 'Parent folder').click()
  await exactButton(folder, 'Open /workspace/src/main.ts').click()
  await expect(chat.getByRole('region', { name: 'File preview' })).toContainText('export const main = true')
  await page.reload()
  await exactButton(
    chat.getByRole('navigation', { name: 'Pinned resources', exact: true }),
    'Open /workspace/src',
  ).click()
  await expect(exactButton(folder, 'Open /workspace/src/main.ts')).toBeVisible()
  await expect(folder.getByRole('alert')).toHaveCount(0)
  expect(mock.calls('read-file')).not.toContainEqual(expect.objectContaining({ path: '/workspace/src/empty.md' }))
})

test('opens a readable resource without requiring its oversized parent listing', async ({ page }) => {
  const mock = await mockTengri(page)
  await routeTengriAction(page, 'list-files', async (action, route) => {
    if (action.path !== '/workspace') return route.fallback()

    await replyWithError(route, 413, 'Directory contains too many entries', 'resource_too_large')
  })
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'tengri-resources:microvm-ada',
      JSON.stringify({ tabs: [{ path: '/workspace/README.md' }], activePath: '/workspace/README.md' }),
    ),
  )
  await page.goto('/')
  const preview = desktopWindow(page, 'Tengri').getByRole('region', { name: 'File preview' })
  await expect(preview).toContainText('A persistent Firecracker workspace.')
  expect(mock.calls('stat-file')).toContainEqual(expect.objectContaining({ path: '/workspace/README.md' }))
  expect(mock.calls('read-file')).toContainEqual(expect.objectContaining({ path: '/workspace/README.md' }))
})

test('shares resource pins across windows while keeping tab selection independent', async ({ page }) => {
  await mockTengri(page, { preserveDraftStorageOnReload: true })
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'tengri-resources:microvm-ada',
      JSON.stringify({ tabs: [{ path: '/workspace/README.md' }], activePath: '/workspace/README.md' }),
    ),
  )
  await page.goto('/')
  const other = await page.context().newPage()
  try {
    await visitDesktop(other, { preserveDraftStorageOnReload: true })
    const chat = desktopWindow(page, 'Tengri')
    const otherChat = other.getByRole('region', { name: 'Tengri window' })
    await expect(chat.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(otherChat.getByRole('tablist', { name: 'Agent views' })).toHaveCount(0)
    await exactButton(chat, 'Pin /workspace/README.md').click()
    const otherPins = otherChat.getByRole('navigation', { name: 'Pinned resources', exact: true })
    await exactButton(otherPins, 'Open /workspace/README.md').click()
    await expect(otherChat.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await otherChat.getByRole('tab', { name: 'Chat', exact: true }).click()
    await expect(chat.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await exactButton(chat, 'Unpin /workspace/README.md').click()
    await expect(otherPins).toHaveCount(0)
    await expect(otherChat.getByRole('tab', { name: 'README.md', exact: true })).toHaveCount(1)
    await expect(otherChat.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute('aria-selected', 'true')
  } finally {
    await other.close()
  }
})

test('ignores invalid persisted resources without reading their paths', async ({ page }) => {
  const mock = await mockTengri(page)
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'tengri-resources:microvm-ada',
      JSON.stringify({
        tabs: [{ path: '/etc/passwd' }],
        activePath: '/etc/passwd',
      }),
    )
    localStorage.setItem('tengri-resource-pins:microvm-ada', JSON.stringify([{ path: '/workspace/../outside' }]))
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  await expect(chat.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeEnabled()
  await expect(chat.getByRole('tablist', { name: 'Agent views' })).toHaveCount(0)
  await expect(chat.getByRole('navigation', { name: 'Pinned resources', exact: true })).toHaveCount(0)
  expect(mock.calls('read-file')).toHaveLength(0)
})

test('opens local file references as rendered agent tabs and preserves the chat draft', async ({ page }) => {
  const mock = await mockTengri(page)
  const reads = new Map<string, number>()
  await routeTengriAction(page, 'read-file', async (action, route) => {
    if (!['/workspace/README.md', '/workspace/notes.md'].includes(action.path)) return route.fallback()

    reads.set(action.path, (reads.get(action.path) ?? 0) + 1)
    return replyWithResult(route, {
      path: action.path,
      content: '# Tengri\n\nA persistent workspace.\n',
      contentType: 'text/markdown',
    })
  })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByLabel('Model', { exact: true })).toBeEnabled()
  const composer = tengri.getByRole('textbox', { name: /message/i })
  await composer.fill('Keep this draft')
  await emitCodexEvent(page, {
    threadId: '',
    turnId: '',
    itemId: 'file-reference',
    text: '[Project file](/workspace/README.md:2), [Notes](/workspace/notes.md), and [Missing file](/workspace/missing.md)',
  })
  await exactButton(tengri, 'Project file').click()
  await expect(tengri.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  const preview = tengri.getByRole('region', { name: 'File preview' })
  await expect(preview.getByRole('heading', { name: 'Tengri', exact: true })).toBeVisible()

  await expect(preview).toContainText('A persistent workspace.')
  expect(mock.calls('editor-session')).toHaveLength(0)
  const markdownView = preview.getByRole('group', { name: 'Markdown view' })
  await expect(exactButton(markdownView, 'Preview')).toHaveAttribute('aria-pressed', 'true')
  await expect(exactButton(markdownView, 'Source')).toHaveAttribute('aria-pressed', 'false')
  await exactButton(preview, 'Source').click()
  await expect(exactButton(markdownView, 'Preview')).toHaveAttribute('aria-pressed', 'false')
  await expect(exactButton(markdownView, 'Source')).toHaveAttribute('aria-pressed', 'true')
  await expect(preview.locator('[data-selected="true"]')).toContainText('2')
  await tengri.getByRole('tab', { name: 'Chat', exact: true }).click()
  await expect(composer).toHaveValue('Keep this draft')
  await exactButton(tengri, 'Notes').click()
  await expect(tengri.getByRole('tab', { name: 'notes.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  await tengri.getByRole('tab', { name: 'Chat', exact: true }).click()
  await exactButton(tengri, 'Project file').click()
  await expect(exactButton(markdownView, 'Source')).toHaveAttribute('aria-pressed', 'true')
  expect(reads.get('/workspace/README.md')).toBe(1)
  await expect.poll(() => reads.get('/workspace/notes.md')).toBe(1)
  await expect(tengri.getByRole('tab')).toHaveText(['Chat', 'README.md', 'notes.md'])
  const tabs = tengri.getByRole('tablist', { name: 'Agent views' })
  const tabWidths = await tabs
    .getByRole('tab')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width))
  for (const width of tabWidths) expect(width).toBeCloseTo(tabWidths[0], 0)
  const readmeTab = tabs.getByRole('tab', { name: 'README.md', exact: true })
  const closeReadme = exactButton(tengri, 'Close /workspace/README.md')
  await expect(readmeTab).toHaveAccessibleDescription('Press Delete to close this tab.')
  await exactButton(preview, 'Source').focus()
  await page.mouse.move(0, 0)
  await expect(closeReadme).toHaveCSS('opacity', '0')
  await readmeTab.hover()
  await expect(closeReadme).toHaveCSS('opacity', '1')
  await page.mouse.move(0, 0)
  await readmeTab.focus()
  await expect(closeReadme).toHaveCSS('opacity', '1')
  await readmeTab.press('Tab')
  await expect(closeReadme).toBeFocused()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(async () => {
    const widths = await tabs
      .getByRole('tab')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width))
    for (const width of widths) expect(width).toBeCloseTo(widths[0], 0)
  }).toPass({ timeout: 5_000 })

  await page.setViewportSize({ width: 1440, height: 900 })
  await tengri.getByRole('tab', { name: 'README.md', exact: true }).press('ArrowRight')
  await expect(tengri.getByRole('tab', { name: 'notes.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  await tengri.getByRole('tab', { name: 'notes.md', exact: true }).press('Home')
  await expect(composer).toHaveValue('Keep this draft')
  expect((await new AxeBuilder({ page }).include('[aria-label="Tengri window"]').analyze()).violations).toEqual([])
  await exactButton(tengri, 'Missing file').click()
  await expect(tengri.getByRole('alert')).toContainText('File not found')
  await expect(tengri.getByRole('button', { name: 'Retry file preview' })).toBeVisible()
  await exactButton(tengri, 'Close /workspace/missing.md').click()
  await expect(composer).toHaveValue('Keep this draft')
  await readmeTab.click()
  await readmeTab.press('Delete')
  await expect(readmeTab).toHaveCount(0)
  await expect(tabs.getByRole('tab', { name: 'Chat', exact: true })).toBeFocused()
  await expect(composer).toHaveValue('Keep this draft')
  expect(new URL(page.url()).pathname).toBe('/')
  expect(page.context().pages()).toHaveLength(1)
})

test('previews Rust file links with XML media types at the requested line', async ({ page }) => {
  await mockTengri(page)
  const path = '/workspace/lab/services/relay/src/service.rs'
  const content = Array.from({ length: 110 }, (_, index) =>
    index === 106 ? 'fn relay_execution() {}' : `// source line ${index + 1}`,
  ).join('\n')
  const paths: string[] = []
  await routeTengriPost(page, async (action, route) => {
    if ((action.action !== 'stat-file' && action.action !== 'read-file') || !action.path?.startsWith(path))
      return route.fallback()
    paths.push(action.path)
    return replyWithResult(
      route,
      action.action === 'stat-file'
        ? { path, name: 'service.rs', directory: false, size: content.length, modifiedAt: '' }
        : { path, content, contentType: 'application/rls-services+xml' },
    )
  })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeEnabled()
  await emitCodexEvent(page, {
    threadId: '',
    turnId: '',
    itemId: 'rust-file-reference',
    text: `[Relay source](${path}:107)`,
  })
  await exactButton(tengri, 'Relay source').click()
  const preview = tengri.getByRole('region', { name: 'File preview' })
  await expect(preview.locator('[data-selected="true"]')).toContainText('fn relay_execution() {}')
  await expect(preview.locator('[data-selected="true"]')).toBeInViewport({ ratio: 1 })
  await expect(preview.getByRole('heading')).toHaveText(`${path}:107`)
  await expect(preview.getByRole('alert')).toHaveCount(0)
  expect(paths).toEqual([path, path])
})

test.describe('touch file previews', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('exposes accessible close buttons and clearly selected Markdown views on touch', async ({ page }) => {
    await mockTengri(page)
    await routeTengriPost(page, async (request, route) => {
      if (request.action !== 'read-file') return route.fallback()
      return replyWithResult(route, {
        path: '/workspace/README.md',
        content: '# Project\n\nA formatted preview.',
        contentType: 'text/markdown',
      })
    })
    await page.goto('/')
    const tengri = desktopWindow(page, 'Tengri')
    const composer = tengri.getByRole('textbox', { name: 'Message your agent', exact: true })
    await composer.fill('Keep this touch draft')
    await emitCodexEvent(page, {
      threadId: '',
      turnId: '',
      itemId: 'touch-file',
      text: '[Project file](/workspace/README.md)',
    })
    await exactButton(tengri, 'Project file').tap()
    const preview = tengri.getByRole('region', { name: 'File preview' })
    const view = preview.getByRole('group', { name: 'Markdown view' })
    await expect(exactButton(view, 'Preview')).toHaveAttribute('aria-pressed', 'true')
    await expect(preview.getByRole('heading', { name: 'Project', exact: true })).toBeVisible()
    await exactButton(view, 'Source').tap()
    await expect(exactButton(view, 'Source')).toHaveAttribute('aria-pressed', 'true')
    await expect(preview.locator('pre')).toContainText('# Project')
    await exactButton(view, 'Preview').tap()
    await expect(exactButton(view, 'Preview')).toHaveAttribute('aria-pressed', 'true')
    await expect(preview.locator('pre')).toHaveCount(0)
    const close = exactButton(tengri, 'Close /workspace/README.md')
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
    await expect(close).toHaveCSS('opacity', '1')
    expect((await new AxeBuilder({ page }).include('[aria-label="Tengri window"]').analyze()).violations).toEqual([])

    await close.tap()
    await expect(tengri.getByRole('tab', { name: 'README.md', exact: true })).toHaveCount(0)
    await expect(tengri.getByRole('tablist', { name: 'Agent views' })).toHaveCount(0)
    await expect(tengri.getByRole('region', { name: 'Chat', exact: true })).toBeFocused()
    await expect(composer).toHaveValue('Keep this touch draft')
  })
})

test('keeps image examples in command output as text without requesting missing previews', async ({ page }) => {
  await mockTengri(page)
  const imageReads: string[] = []
  await page.route('**/api/tengri/attachments?*', (route) => {
    imageReads.push(route.request().url())
    return replyWithError(route, 404, 'File not found')
  })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  const text = `for (const failure of [
  const text = '![Recovered diagram](/workspace/recovered-diagram.png)'
]`
  await emitCodexEvent(page, { kind: 'tool-output', threadId: '', turnId: '', itemId: 'printed-source', text })
  await exactButton(tengri, 'Ran commands').first().click()
  const output = tengri.getByRole('article', { name: 'Codex output' })
  await expect(output).toHaveCount(1)
  await output.locator('summary').click()
  await expect(output.locator('pre')).toHaveText(text)
  await expect(output.getByRole('img')).toHaveCount(0)
  await expect(tengri.getByRole('button', { name: 'Retry image' })).toHaveCount(0)
  expect(imageReads).toEqual([])
})

test('keeps replayed logging diagnostics out of chat while retaining ordinary warnings and failures', async ({
  page,
}) => {
  await mockTengri(page, { resumeThreadRawJson: codexHistory([], { id: 'thread-cat' }) })
  await selectSavedThread(page, 'thread-cat')
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  await expect(chat.getByLabel('Model', { exact: true })).toBeEnabled()
  const message =
    "Codex couldn't save diagnostic logs to its local database. Use /feedback with logs included before closing Codex, or run `codex doctor` for diagnostics."
  await emitCodexEvent(page, {
    kind: 'warning',
    method: 'warning',
    threadId: '',
    turnId: '',
    text: message,
    rawJson: JSON.stringify({ emittedAtMs: 1794122949761, method: 'warning', params: { message, threadId: null } }),
  })
  await expect(chat.getByText(message, { exact: true })).toHaveCount(0)
  await emitCodexEvent(page, {
    sequence: 2,
    kind: 'warning',
    method: 'warning',
    threadId: '',
    turnId: '',
    text: 'Provider connection interrupted',
  })
  await expect(chat.getByText('Provider connection interrupted', { exact: true })).toBeVisible()
  await page.reload()
  await expect(chat.getByLabel('Model', { exact: true })).toBeEnabled()
  await expect(chat.getByText(message, { exact: true })).toHaveCount(0)
  await emitCodexEvent(page, {
    sequence: 3,
    kind: 'error',
    method: 'turn/failed',
    threadId: '',
    turnId: '',
    text: 'This turn failed',
  })
  await expect(chat.getByRole('alert')).toContainText('This turn failed')
})

test('shows native image generation live and restores its inline preview and link', async ({ page }) => {
  const path = '/home/nanoagent/.codex/generated_images/thread-cat/exec-cat.png'
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  )
  const options: MockOptions = { resumeThreadRawJson: codexHistory([], { id: 'thread-cat' }) }
  const mock = await mockTengri(page, options)
  const reads: string[] = []
  let failNext = true
  await page.route('**/api/tengri/generated-images?*', (route) => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('agentId')).toBe('microvm-ada')
    reads.push(url.searchParams.get('path') ?? '')
    if (failNext) {
      failNext = false
      return replyWithError(route, 503, 'Temporary image read failure')
    }
    return route.fulfill({ contentType: 'image/png', body: png })
  })
  await selectSavedThread(page, 'thread-cat')
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  await expect(chat.getByRole('textbox', { name: 'Message your agent' })).toBeEnabled()
  const item = { type: 'imageGeneration', id: 'exec-cat', status: 'in_progress', result: '', savedPath: null }
  await emitCodexEvent(page, {
    kind: 'tool-call',
    method: 'item/started',
    threadId: 'thread-cat',
    turnId: 'turn-cat',
    itemId: 'exec-cat',
    text: 'Generate image',
    rawJson: codexParams({ item }),
  })
  await expect(chat.getByRole('status').filter({ hasText: 'Generating image…' })).toBeVisible()
  expect(reads).toEqual([])
  const completed = { ...item, status: 'completed', savedPath: path, result: '[Image output]' }
  await emitCodexEvent(page, {
    sequence: 2,
    kind: 'tool-output',
    threadId: 'thread-cat',
    turnId: 'turn-cat',
    itemId: 'exec-cat',
    text: path,
    rawJson: codexParams({ item: completed }),
  })
  await expect(exactButton(chat, 'Retry image')).toBeVisible()
  await expect(chat.getByText('Generating image…', { exact: true })).toHaveCount(0)
  await exactButton(chat, 'Retry image').click()
  const image = chat.getByRole('img', { name: 'Generated image', exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
  await expect(chat.getByRole('button', { name: 'Ran commands' })).toHaveCount(0)
  await emitCodexEvent(page, {
    sequence: 3,
    threadId: 'thread-cat',
    turnId: 'turn-cat',
    itemId: 'reply-cat',
    text: `[Preview the cat image](${path})`,
  })
  await expect(chat.getByRole('link', { name: 'Preview the cat image' })).toHaveAttribute(
    'href',
    `/api/tengri/generated-images?${new URLSearchParams({ agentId: 'microvm-ada', path })}`,
  )
  options.resumeThreadEventSequence = 3
  options.resumeThreadRawJson = codexHistory(
    [
      completedTurn('turn-cat', [
        { ...completed, result: png.toString('base64') },
        agentMessage('reply-cat', `[Preview the cat image](${path})`),
      ]),
    ],
    { id: 'thread-cat' },
  )
  await page.reload()
  await expect(image).toBeVisible()
  await expect(image).toHaveCount(1)
  await expect(chat.getByRole('link', { name: 'Preview the cat image' })).toBeVisible()
  expect(reads.every((value) => value === path)).toBe(true)
  expect(mock.calls('read-file', 'send-turn')).toHaveLength(0)
})

test('renders workspace images sent by the agent inline and in file tabs', async ({ page }) => {
  const mock = await mockTengri(page)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  )
  let failNextImage = true
  await page.route('**/api/tengri/attachments?*', (route) => {
    if (failNextImage) {
      failNextImage = false
      return replyWithError(route, 503, 'Temporary image read failure')
    }
    return route.fulfill({ contentType: 'image/png', body: png })
  })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByLabel('Model', { exact: true })).toBeEnabled()
  await emitCodexEvent(page, {
    threadId: '',
    turnId: '',
    itemId: 'generated-chart',
    text: 'Here is your chart.\n\n![Generated chart](/workspace/chart.png)\n\n[Open chart](/workspace/chart.png)',
  })
  await expect(tengri.getByRole('status').filter({ hasText: 'Image unavailable: Generated chart' })).toBeVisible()
  await exactButton(tengri, 'Retry image').click()
  const image = tengri.getByRole('img', { name: 'Generated chart', exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
  await exactButton(tengri, 'Open chart').click()
  await expect(tengri.getByRole('tab', { name: 'chart.png', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(
    tengri.getByRole('region', { name: 'File preview' }).getByRole('img', { name: 'chart.png', exact: true }),
  ).toBeVisible()
  await tengri.getByRole('tab', { name: 'Chat', exact: true }).click()
  await emitCodexEvent(page, {
    sequence: 2,
    kind: 'tool-output',
    threadId: '',
    turnId: '',
    itemId: 'generated-output',
    text: '/workspace/generated.png',
  })
  await expect(tengri.getByRole('img', { name: 'generated.png', exact: true })).toBeVisible()
  expect(mock.calls('editor-session')).toHaveLength(0)
})

test('shows a branded missing-page screen with a route back to Tengri', async ({ page }) => {
  await mockTengri(page)
  const response = await page.goto('/this-tengri-page-does-not-exist')
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Nothing at this address.', exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])

  await page.getByRole('link', { name: 'Back to Tengri', exact: true }).click()
  await expect(desktopWindow(page, 'Tengri')).toBeVisible()
})

test('retains accepted steering messages when replay recovery has not persisted their echo', async ({ page }) => {
  const options: MockOptions = {
    resumeThreadEventSequence: 0,
    resumeThreadRawJson: codexHistory([runningTurn('turn-active')]),
  }
  const mock = await mockTengri(page, options)
  await selectSavedThread(page, 'thread-active')
  await page.goto('/')
  const prompt = page.getByRole('textbox', { name: 'Steer the current turn', exact: true })
  await prompt.fill('Also include the deployment notes.')
  await exactButton(page, 'Steer turn').click()
  await expect.poll(() => mock.calls('steer-turn').length).toBe(1)
  await emitCodexEvent(page, {
    kind: 'user-message',
    threadId: 'thread-active',
    turnId: 'turn-active',
    itemId: 'steering-user',
    text: 'Also include the deployment notes.',
  })
  const message = page.getByRole('article', { name: 'Your message' })
  await expect(message).toHaveText('Also include the deployment notes.')
  options.resumeThreadEventSequence = 100
  await emitCodexEvent(page, {
    sequence: 101,
    kind: 'warning',
    method: 'tengri/replayWarning',
    threadId: 'thread-active',
    turnId: '',
    text: 'Replay window exceeded',
  })
  await expect.poll(() => mock.getResumeThreadResponseCount()).toBe(2)
  await expect(prompt).toBeEnabled()
  await expect(message).toHaveText('Also include the deployment notes.')
  await expect(message).toHaveCount(1)
})

for (const width of [1440, 390]) {
  test(`restores async questions and submits desktop-compatible answers without clearing drafts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const item = {
      id: 'async-call',
      type: 'agentMessage',
      text: width === 1440 ? 'The rollout is waiting for your environment choice.' : '',
      delivery: 'async',
      questions: [{ title: 'Which environment?', options: ['Staging', 'Production'] }, { title: 'Any notes?' }],
    }
    const items: Record<string, unknown>[] = [item]
    const options: MockOptions = {
      preserveDraftStorageOnReload: true,
      threadStore: { threads: [savedChat('thread-active', 'Async questions', 1)] },
      resumeThreadRawJson: codexHistory([completedTurn('turn-previous', items)]),
    }
    const mock = await mockTengri(page, options)
    await selectSavedThread(page, 'thread-active')
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const prompt = chat.getByRole('textbox', { name: /^(Message your agent|Steer the current turn)$/ })
    const question = chat.getByRole('article', { name: 'Agent question', exact: true })
    await expect(question).toContainText('Which environment?')
    const bounds = await question.boundingBox()
    expect(bounds!.width).toBeLessThanOrEqual(576)
    expect(bounds!.height).toBeLessThanOrEqual(360)
    if (item.text) await expect(chat.getByRole('article', { name: 'Codex response' })).toContainText(item.text)
    await question.screenshot({ path: test.info().outputPath(`async-question-${width}.png`) })
    await expect(question.getByRole('radio', { name: 'Staging', exact: true })).toBeChecked()
    await expect(question.getByRole('textbox', { name: 'Other answer: Which environment?', exact: true })).toHaveValue(
      '',
    )
    expect(mock.calls('send-turn', 'answer-questions')).toHaveLength(0)
    await page.reload()
    await expect(question).toContainText('Any notes?')
    await prompt.fill('Keep my newer draft.')
    await question.getByRole('radio', { name: 'Production', exact: true }).check()
    await question.getByRole('textbox', { name: 'Any notes?', exact: true }).fill('Preserve the files.')
    await exactButton(question, 'Submit answers').click()
    await expect(question).toHaveCount(0)
    if (item.text) await expect(chat.getByRole('article', { name: 'Codex response' })).toContainText(item.text)
    await expect(prompt).toHaveValue('Keep my newer draft.')
    const sends = mock.calls('send-turn')
    expect(sends).toHaveLength(1)
    const text = String(sends[0].text)
    expect(
      JSON.parse(
        text.slice('<send_user_message_question_reply>'.length, -'</send_user_message_question_reply>'.length),
      ),
    ).toEqual([
      {
        questionItemId: '["request_user_input_async","async-call",0]',
        question: 'Which environment?',
        answer: 'Production',
      },
      {
        questionItemId: '["request_user_input_async","async-call",1]',
        question: 'Any notes?',
        answer: 'Preserve the files.',
      },
    ])
    expect(mock.calls('answer-questions', 'resolve-approval')).toHaveLength(0)
    await expect(chat.getByRole('article', { name: 'Your message' })).toContainText('Preserve the files.')
    await expect(chat.getByRole('article', { name: 'Your message' })).not.toContainText(
      'send_user_message_question_reply',
    )
    items.push({ id: 'answer-1', type: 'userMessage', content: [{ type: 'text', text }] })
    options.resumeThreadRawJson = codexHistory([completedTurn('turn-previous', items)])
    await page.reload()
    await expect(chat.getByRole('article', { name: 'Your message' })).toContainText('Preserve the files.')
    await expect(question).toHaveCount(0)
    if (item.text) await expect(chat.getByRole('article', { name: 'Codex response' })).toContainText(item.text)
    expect(mock.calls('send-turn')).toHaveLength(1)
  })
}

test('renders live async questions and retries their exact steering operation after an interrupted answer', async ({
  page,
}) => {
  const mock = await mockTengri(page, {
    resumeThreadRawJson: codexHistory([runningTurn('turn-active')]),
  })
  await page.addInitScript(() => {
    localStorage.setItem('tengri-thread:microvm-ada', 'thread-active')
    localStorage.setItem('tengri-approval-mode:microvm-ada', 'auto')
  })
  const attempts: Record<string, unknown>[] = []
  await routeTengriAction(page, 'steer-turn', async (action, route) => {
    attempts.push(action)
    if (attempts.length === 1) return replyWithError(route, 503, 'Answer delivery was interrupted')
    return route.fallback()
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const prompt = chat.getByRole('textbox', { name: /^(Message your agent|Steer the current turn)$/ })
  await expect(prompt).toBeEnabled()
  const item = {
    id: 'live-question',
    type: 'agentMessage',
    text: 'I can keep investigating while you choose a target.',
    delivery: 'async',
    questions: [{ title: 'Which target?', options: ['Default'] }],
  }
  for (const [sequence, method] of [
    [1, 'item/started'],
    [2, 'item/completed'],
  ] as const)
    await emitCodexEvent(page, {
      sequence,
      method,
      threadId: 'thread-active',
      turnId: 'turn-active',
      itemId: item.id,
      text: item.text,
      rawJson: codexParams({ item }),
    })
  const question = chat.getByRole('article', { name: 'Agent question', exact: true })
  await expect(question).toHaveCount(1)
  await expect(chat.getByRole('article', { name: 'Codex response' })).toContainText(item.text)
  await question
    .getByRole('textbox', { name: 'Other answer: Which target?', exact: true })
    .pressSequentially('Default with a canary')
  await expect(question.getByRole('textbox')).toHaveValue('Default with a canary')
  await emitCodexEvents(
    page,
    Array.from({ length: 501 }, (_, index) => ({
      sequence: index + 3,
      kind: 'tool-output',
      method: 'item/completed',
      threadId: 'thread-active',
      turnId: 'turn-active',
      itemId: `activity-${index + 3}`,
      text: 'Still working',
    })),
  )
  await expect(question).toHaveCount(1)
  await expect(question.getByRole('textbox')).toHaveValue('Default with a canary')
  await prompt.fill('Do not replace this draft.')
  await exactButton(question, 'Submit answers').click()
  await expect(question.getByRole('alert')).toHaveText('Answer delivery was interrupted')
  await expect(question.getByRole('textbox')).toHaveValue('Default with a canary')
  await expect(prompt).toHaveValue('Do not replace this draft.')
  await exactButton(question, 'Submit answers').click()
  await expect(question).toHaveCount(0)
  await expect(chat.getByRole('article', { name: 'Codex response' })).toContainText(item.text)
  expect(attempts).toHaveLength(2)
  expect(attempts[0].operationId).toBe(attempts[1].operationId)
  expect(attempts[0].text).toBe(attempts[1].text)
  expect(attempts[1]).toMatchObject({ action: 'steer-turn', threadId: 'thread-active', turnId: 'turn-active' })
  expect(mock.calls('answer-questions', 'resolve-approval')).toHaveLength(0)
})

test('retires an async question when its answer arrives before the steering response', async ({ page }) => {
  const item = {
    id: 'pending-question',
    type: 'agentMessage',
    text: '',
    questions: [{ title: 'Which environment?', options: ['Staging', 'Production'] }],
  }
  const mock = await mockTengri(page, {
    resumeThreadRawJson: codexHistory([runningTurn('turn-active', [item])]),
  })
  await selectSavedThread(page, 'thread-active')
  const response = Promise.withResolvers<void>()
  const sent = Promise.withResolvers<Record<string, unknown>>()
  await routeTengriAction(page, 'steer-turn', async (action, route) => {
    sent.resolve(action)
    await response.promise
    await replyWithError(route, 503, 'The steering response was lost')
  })
  try {
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const question = chat.getByRole('article', { name: 'Agent question', exact: true })
    const prompt = chat.getByRole('textbox', { name: /^(Message your agent|Steer the current turn)$/ })
    await expect(exactButton(question, 'Submit answers')).toBeEnabled()
    await prompt.fill('Preserve my draft.')
    await exactButton(question, 'Submit answers').click()
    const action = await sent.promise
    await emitCodexEvent(page, {
      kind: 'user-message',
      threadId: 'thread-active',
      turnId: 'turn-active',
      itemId: 'confirmed-answer',
      rawJson: codexParams({
        item: { id: 'confirmed-answer', type: 'userMessage', content: [{ type: 'text', text: action.text }] },
      }),
    })
    await expect(question).toHaveCount(0)
    response.resolve()
    await expect(prompt).toHaveValue('Preserve my draft.')
    await expect(chat.getByRole('alert')).toHaveCount(0)
    expect(mock.calls('send-turn')).toHaveLength(0)
  } finally {
    response.resolve()
  }
})

test('keeps async question dismissal scoped to its conversation', async ({ page }) => {
  const rawJson = codexHistory([
    completedTurn('turn-old', [
      {
        id: 'shared-history-item',
        type: 'agentMessage',
        text: '',
        questions: [{ title: 'Continue?', options: ['Yes', 'No'] }],
      },
    ]),
  ])
  const mock = await mockTengri(page, {
    threadStore: {
      threads: [savedChat('thread-alpha', 'Alpha', 2), savedChat('thread-beta', 'Beta', 1)],
    },
    resumeThreadRawJsonById: { 'thread-alpha': rawJson, 'thread-beta': rawJson },
  })
  await selectSavedThread(page, 'thread-alpha')
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const question = chat.getByRole('article', { name: 'Agent question', exact: true })
  await exactButton(question, 'Dismiss for now').click()
  await expect(question).toHaveCount(0)
  expect(
    mock.actions.some((action) => ['send-turn', 'steer-turn', 'answer-questions'].includes(String(action.action))),
  ).toBe(false)
  await chat.locator('[data-conversation-id="thread-beta"]').click()
  await expect(question).toContainText('Continue?')
  await chat.locator('[data-conversation-id="thread-alpha"]').click()
  await expect(chat.locator('[data-conversation-id="thread-alpha"]')).toHaveAttribute('aria-current', 'true')
  await expect(question).toHaveCount(0)
  await chat.locator('[data-conversation-id="thread-beta"]').click()
  await expect(question).toContainText('Continue?')
  const prompt = chat.getByRole('textbox', { name: 'Message your agent', exact: true })
  await prompt.fill('Use the current setup instead.')
  await prompt.press('Enter')
  await expect(question).toHaveCount(0)
  await expect.poll(() => mock.calls('send-turn').length).toBe(1)
})

test('auto-approves actions while keeping questions and elicitation forms manual', async ({ page }) => {
  const mock = await visitDesktop(page, {
    savedThread: 'thread-active',
    resumeThreadRawJson: codexHistory([runningTurn('turn-active')]),
  })
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('combobox', { name: 'Approvals', exact: true })).toBeVisible()
  await selectOption(page, tengri.getByRole('combobox', { name: 'Approvals', exact: true }), 'Auto approve')
  const base = {
    kind: 'approval' as const,
    threadId: 'thread-active',
    turnId: 'turn-active',
    itemId: '',
    text: '',
    rawJson: '{}',
  }
  await emitCodexEvent(page, {
    ...base,
    sequence: 1,
    method: 'item/commandExecution/requestApproval',
    approvalId: 'command-1',
    rawJson: codexParams({ availableDecisions: ['accept', 'decline'] }),
  })
  await expect
    .poll(() => mock.calls('resolve-approval'))
    .toMatchObject([{ approvalId: 'command-1', decision: 'approve-once' }])
  await emitCodexEvent(page, {
    ...base,
    sequence: 2,
    method: 'mcpServer/elicitation/request',
    approvalId: 'github-1',
    rawJson: codexParams({
      mode: 'form',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call' },
    }),
  })
  await expect.poll(() => mock.calls('resolve-approval').length).toBe(2)
  await emitCodexEvent(page, {
    ...base,
    sequence: 3,
    method: 'item/tool/requestUserInput',
    approvalId: 'question-1',
    rawJson: codexParams({
      questions: [
        {
          id: 'environment',
          question: 'Which environment?',
          isOther: true,
          options: [
            { label: 'Staging', description: 'Preview only' },
            { label: 'Production', description: 'Live environment' },
          ],
        },
      ],
    }),
  })
  const question = tengri.getByRole('article', { name: 'Agent question' })
  await expect(question).toContainText('Which environment?')

  expect(mock.actions.some((action) => action.approvalId === 'question-1')).toBe(false)
  await question.getByRole('radio', { name: /Staging/ }).check()
  await exactButton(question, 'Submit answers').click()
  await expect
    .poll(() => mock.actions.find((action) => action.approvalId === 'question-1'))
    .toMatchObject({ action: 'answer-questions', response: { answers: { environment: { answers: ['Staging'] } } } })
  await expect(question).toHaveCount(0)
  await emitCodexEvent(page, {
    ...base,
    sequence: 4,
    method: 'mcpServer/elicitation/request',
    approvalId: 'form-1',
    rawJson: codexParams({
      mode: 'form',
      message: 'Name the release',
      requestedSchema: {
        type: 'object',
        properties: { name: { type: 'string', title: 'Release name' } },
        required: ['name'],
      },
    }),
  })
  await expect(question.getByRole('textbox', { name: 'Release name', exact: true })).toBeVisible()
  expect(mock.actions.some((action) => action.approvalId === 'form-1')).toBe(false)
  await question.getByRole('textbox', { name: 'Release name', exact: true }).fill('Preview')
  await exactButton(question, 'Submit answers').click()
  await expect
    .poll(() => mock.actions.find((action) => action.approvalId === 'form-1'))
    .toMatchObject({ action: 'answer-questions', response: { action: 'accept', content: { name: 'Preview' } } })
  await expect(question).toHaveCount(0)
  await expect(tengri.getByRole('combobox', { name: 'Approvals', exact: true })).toContainText('Auto approve')
  expect(await page.evaluate(() => localStorage.getItem('tengri-approval-mode:microvm-ada'))).toBe('auto')
  await selectOption(page, tengri.getByRole('combobox', { name: 'Approvals', exact: true }), 'Ask first')
  await emitCodexEvent(page, {
    ...base,
    sequence: 5,
    method: 'item/commandExecution/requestApproval',
    approvalId: 'manual-command',
    text: 'Run the tests?',
  })
  await expect(exactButton(tengri, 'Approve once')).toBeVisible()
  expect(mock.actions.some((action) => action.approvalId === 'manual-command')).toBe(false)
})

test('keeps failed question answers editable and requires explicit URL completion in auto mode', async ({ page }) => {
  const mock = await mockTengri(page, {
    resumeThreadRawJson: codexHistory([runningTurn('turn-active')]),
  })
  await page.addInitScript(() => {
    localStorage.setItem('tengri-thread:microvm-ada', 'thread-active')
    localStorage.setItem('tengri-approval-mode:microvm-ada', 'auto')
  })
  let attempts = 0
  await routeTengriAction(page, 'answer-questions', async (_request, route) => {
    if (++attempts === 1) return replyWithError(route, 503, 'The answer service is temporarily unavailable')
    return route.fallback()
  })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('combobox', { name: 'Approvals', exact: true })).toContainText('Auto approve')
  const base = { kind: 'approval' as const, threadId: 'thread-active', turnId: 'turn-active', itemId: '', text: '' }
  await emitCodexEvent(page, {
    ...base,
    sequence: 1,
    method: 'item/tool/requestUserInput',
    approvalId: 'question-retry',
    rawJson: codexParams({ questions: [{ id: 'notes', question: 'Any deployment notes?' }] }),
  })
  const question = tengri.getByRole('article', { name: 'Agent question' })
  await question.getByRole('textbox', { name: 'Any deployment notes?', exact: true }).fill('Keep the retained files')
  await exactButton(question, 'Submit answers').click()
  await expect(question.getByRole('alert')).toContainText('The answer service is temporarily unavailable')
  await expect(question.getByRole('textbox')).toHaveValue('Keep the retained files')
  await exactButton(question, 'Submit answers').click()
  await expect(question).toHaveCount(0)
  await emitCodexEvent(page, {
    ...base,
    sequence: 2,
    method: 'mcpServer/elicitation/request',
    approvalId: 'url-1',
    rawJson: codexParams({ mode: 'url', message: 'Connect the account', url: 'https://example.test/authorize' }),
  })
  await expect(question.getByRole('link', { name: 'Open request', exact: true })).toHaveAttribute(
    'href',
    'https://example.test/authorize',
  )
  expect(mock.actions.some((action) => action.approvalId === 'url-1')).toBe(false)
  expect((await new AxeBuilder({ page }).include('[aria-label="Agent question"]').analyze()).violations).toEqual([])
  await exactButton(question, 'Done').click()
  await expect
    .poll(() => mock.actions.find((action) => action.approvalId === 'url-1'))
    .toMatchObject({ action: 'answer-questions', response: { action: 'accept' } })
})

test('shows failed auto-approvals for manual retry without repeatedly submitting them', async ({ page }) => {
  const mock = await mockTengri(page, {
    resumeThreadRawJson: codexHistory([runningTurn('turn-active')]),
  })
  await page.addInitScript(() => {
    localStorage.setItem('tengri-thread:microvm-ada', 'thread-active')
    localStorage.setItem('tengri-approval-mode:microvm-ada', 'auto')
  })
  let attempts = 0
  await routeTengriAction(page, 'resolve-approval', async (_request, route) => {
    attempts += 1
    return replyWithError(route, 503, 'Approval service unavailable')
  })
  await page.goto('/')
  const tengri = desktopWindow(page, 'Tengri')
  await expect(tengri.getByRole('combobox', { name: 'Approvals', exact: true })).toContainText('Auto approve')
  const approval = codexEvent({
    kind: 'approval',
    method: 'item/commandExecution/requestApproval',
    threadId: 'thread-active',
    turnId: 'turn-active',
    itemId: 'command',
    text: 'Run the check?',
    approvalId: 'retry-approval',
  })
  await emitCodexEvent(page, { ...approval, sequence: 1 })
  await expect(tengri.getByText('Approval service unavailable', { exact: true })).toBeVisible()
  await expect(exactButton(tengri, 'Approve once')).toBeVisible()
  await emitCodexEvent(page, { ...approval, sequence: 2 })
  await expect(exactButton(tengri, 'Approve once')).toBeVisible()
  expect(attempts).toBe(1)
  expect(mock.calls('resolve-approval')).toHaveLength(0)
})

for (const resolution of ['local response', 'server event'] as const) {
  for (const mode of ['manual', 'automatic'] as const) {
    test(`does not restore a resolved approval from stale run polling after ${resolution} in ${mode} mode`, async ({
      page,
    }) => {
      const approval = {
        approvalId: 'process-identity:17',
        raw: {
          id: 17,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'thread-alpha', turnId: 'turn-alpha', command: 'echo once', cwd: '/workspace' },
        },
      }
      const run: TengriCodexRun = codexRun('33333333-3333-4333-8333-333333333333', 'thread-alpha', {
        phase: 'waiting_for_approval',
        turnId: 'turn-alpha',
        approvals: [approval],
      })
      const mock = await visitDesktop(page, {
        savedThread: 'thread-alpha',
        threadStore: {
          threads: [savedChat('thread-alpha', 'Alpha', 2), savedChat('thread-beta', 'Beta', 1)],
        },
        durableRun: run,
      })
      const chat = desktopWindow(page, 'Tengri')
      const card = chat.getByRole('article', { name: 'Codex approval' })
      await expect(card).toBeVisible()
      if (resolution === 'server event') {
        await emitCodexEvent(page, {
          kind: 'thread-state',
          method: 'serverRequest/resolved',
          threadId: 'thread-alpha',
          turnId: 'turn-alpha',
          rawJson: codexParams({ threadId: 'thread-alpha', requestId: approval.approvalId }),
        })
      } else if (mode === 'manual') {
        await exactButton(card, 'Approve once').click()
      }
      if (mode === 'automatic')
        await selectOption(page, chat.getByRole('combobox', { name: 'Approvals', exact: true }), 'Auto approve')
      const expectedControls = resolution === 'local response' ? 1 : 0
      await expect.poll(() => mock.calls('resolve-approval').length).toBe(expectedControls)
      await expect(card).toHaveCount(0)
      const polls = mock.calls('active-codex-runs').length
      await expect.poll(() => mock.calls('active-codex-runs').length).toBeGreaterThan(polls)
      const sidebar = chat.getByTestId('agent-conversation-sidebar')
      await sidebar.locator('[data-conversation-id="thread-beta"]').click()
      await sidebar.locator('[data-conversation-id="thread-alpha"]').click()
      await expect(chat.getByRole('textbox', { name: 'Steer the current turn' })).toBeEnabled()
      await expect(card).toHaveCount(0)
      expect(mock.calls('resolve-approval')).toHaveLength(expectedControls)
      run.state = {
        phase: 'waiting_for_approval',
        turnId: 'turn-alpha',
        approvals: [{ ...approval, approvalId: 'process-identity:18', raw: { ...approval.raw, id: 18 } }],
      }
      if (mode === 'manual') {
        await expect(card).toBeVisible()
        await exactButton(card, 'Approve once').click()
      }
      await expect.poll(() => mock.calls('resolve-approval').length).toBe(expectedControls + 1)
      await expect(card).toHaveCount(0)
    })
  }
}

test('recovers the exact durable run and pending approval with empty browser storage', async ({ page }) => {
  const runId = '33333333-3333-4333-8333-333333333333'
  const mock = await mockTengri(page, {
    durableRun: codexRun(runId, 'thread-recovered', {
      phase: 'waiting_for_approval',
      turnId: 'turn-recovered',
      approvals: [
        {
          approvalId: 'process-identity:17',
          raw: {
            id: 17,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-recovered',
              turnId: 'turn-recovered',
              command: 'echo durable',
              cwd: '/workspace',
            },
          },
        },
      ],
    }),
  })
  await page.goto('/')
  const approval = page.getByRole('article', { name: 'Codex approval' })
  await expect(approval).toBeVisible()
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(approval).toBeVisible()
  await exactButton(approval, 'Approve once').click()
  await expect.poll(() => mock.calls('resolve-approval')[0]?.runId).toBe(runId)
  const action = mock.calls('resolve-approval')[0]
  expect(action?.approvalId).toBe('process-identity:17')
  expect(action?.operationId).toMatch(/^[0-9a-f-]{36}$/)
})

test('reuses active-run snapshots without duplicate status polling and fetches the final result', async ({ page }) => {
  const run: TengriCodexRun = codexRun('55555555-5555-4555-8555-555555555555', 'thread-recovered', {
    phase: 'running',
    turnId: 'turn-recovered',
  })
  const mock = await visitDesktop(page, { durableRun: run })
  const chat = desktopWindow(page, 'Tengri')
  await expect(exactButton(chat, 'Stop response')).toBeEnabled()
  // Initial conversation selection may legitimately need fallback recovery.
  // Measure steady-state polling after the workspace owns the selected run.
  await expect.poll(() => mock.calls('active-codex-runs').length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3)
  const readsBefore = mock.calls('codex-run').length
  const activeBefore = mock.calls('active-codex-runs').length
  await expect
    .poll(() => mock.calls('active-codex-runs').length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(activeBefore + 3)
  expect(mock.calls('codex-run')).toHaveLength(readsBefore)
  run.state = { phase: 'succeeded', turnId: 'turn-recovered' }
  await expect.poll(() => mock.calls('codex-run').length, { timeout: 10_000 }).toBeGreaterThan(readsBefore)
  await expect(exactButton(chat, 'Stop response')).toHaveCount(0)
  const finalReads = mock.calls('codex-run').length
  await page.clock.install()
  await page.clock.runFor(6_100)
  expect(mock.calls('codex-run')).toHaveLength(finalReads)
  expect(mock.calls('send-turn')).toHaveLength(0)
})

for (const phase of ['succeeded', 'failed', 'cancelled', 'rejected'] as const) {
  test(`processes a ${phase} workspace snapshot before a completion event arrives`, async ({ page }) => {
    const run: TengriCodexRun = codexRun('99999999-9999-4999-8999-999999999999', 'thread-recovered', {
      phase: 'running',
      turnId: 'turn-recovered',
    })
    const mock = await mockTengri(page, { durableRun: run })
    let terminal: TengriCodexRun | undefined
    await page.route('**/api/tengri', async (route) => {
      if (
        terminal &&
        route.request().method() === 'POST' &&
        route.request().postDataJSON().action === 'active-codex-runs'
      ) {
        // The backend took its claim list before this run finished. Its subsequent
        // snapshot read legitimately includes a terminal result in that list.
        return replyWithResult(route, [terminal])
      }
      return route.fallback()
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    await expect(exactButton(chat, 'Stop response')).toBeEnabled()
    terminal = {
      ...run,
      state:
        phase === 'rejected'
          ? { phase, reason: 'The recovered run was rejected' }
          : phase === 'failed'
            ? { phase, turnId: 'turn-recovered', reason: 'The recovered run failed' }
            : { phase, turnId: 'turn-recovered' },
    }
    await expect(exactButton(chat, 'Stop response')).toHaveCount(0)
    await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
    if ('reason' in terminal.state) await expect(chat.getByRole('alert')).toContainText(terminal.state.reason)
    await chat.getByRole('textbox', { name: 'Message your agent' }).fill('A next task')
    await expect(exactButton(chat, 'Send message')).toBeEnabled()
    expect(mock.calls('send-turn')).toHaveLength(0)
  })
}

test('clears an individual recovery error after both status endpoints recover', async ({ page }) => {
  const run: TengriCodexRun = codexRun('66666666-6666-4666-8666-666666666666', 'thread-recovered', {
    phase: 'running',
    turnId: 'turn-recovered',
  })
  const mock = await mockTengri(page, { durableRun: run })
  let unavailable = false
  let individualFailures = 0
  let workspaceFailures = 0
  await routeTengriPost(page, async (request, route) => {
    const { action } = request

    if (unavailable && (action === 'codex-run' || action === 'active-codex-runs')) {
      if (action === 'codex-run') individualFailures += 1
      else workspaceFailures += 1
      return replyWithError(route, 503, 'Temporary status outage')
    }
    return route.fallback()
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  await expect(exactButton(chat, 'Stop response')).toBeEnabled()
  unavailable = true
  await expect.poll(() => workspaceFailures).toBeGreaterThan(0)
  await expect.poll(() => individualFailures, { timeout: 10_000 }).toBeGreaterThan(0)
  await expect(chat.getByRole('alert')).toContainText('Reconnecting')
  unavailable = false
  await expect(chat.getByRole('alert')).toHaveCount(0, { timeout: 10_000 })
  await expect(exactButton(chat, 'Stop response')).toBeEnabled()
  expect(mock.calls('send-turn')).toHaveLength(0)
})

test('lets a slow final status complete without polling unrelated conversations', async ({ page }) => {
  await page.clock.install()
  const run: TengriCodexRun = codexRun('77777777-7777-4777-8777-777777777777', 'thread-recovered', {
    phase: 'running',
    turnId: 'turn-recovered',
  })
  const other: TengriCodexRun = {
    runId: '88888888-8888-4888-8888-888888888888',
    agentId: run.agentId,
    threadId: 'thread-other',
    state: { phase: 'running', turnId: 'turn-other' },
  }
  await mockTengri(page, { durableRun: run })
  let completed = false
  let finalRequests = 0
  let workspaceReads = 0
  const { promise: finalResponse, resolve: releaseFinal } = Promise.withResolvers<void>()
  await routeTengriPost(page, async (action, route) => {
    if (action.action === 'active-codex-runs') {
      workspaceReads += 1
      return replyWithResult(route, completed ? [other] : [run, other])
    }
    if (action.action === 'codex-run' && action.runId === run.runId && completed) {
      finalRequests += 1
      await finalResponse
      return replyWithResult(route, { ...run, state: { phase: 'succeeded', turnId: 'turn-recovered' } })
    }
    return route.fallback()
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  await expect(exactButton(chat, 'Stop response')).toBeEnabled()
  completed = true
  await expect.poll(() => finalRequests, { timeout: 10_000 }).toBe(1)
  const readsAtRequest = workspaceReads
  await page.clock.runFor(6_100)
  expect(workspaceReads).toBe(readsAtRequest)
  expect(finalRequests).toBe(1)
  releaseFinal()
  await expect(exactButton(chat, 'Stop response')).toHaveCount(0)
  await chat.getByRole('textbox', { name: 'Message your agent' }).fill('Next task')
  await expect(exactButton(chat, 'Send message')).toBeEnabled()
})

test('clears a recovered active-run outage when the turn finishes before its retry', async ({ page }) => {
  await page.clock.install()
  const run: TengriCodexRun = codexRun('33333333-3333-4333-8333-333333333333', 'thread-recovered', {
    phase: 'running',
    turnId: 'turn-recovered',
  })
  const mock = await mockTengri(page, { durableRun: run })
  let unavailable = false
  let failedReads = 0
  let recoveredReads = 0
  await routeTengriAction(page, 'active-codex-runs', async (_request, route) => {
    if (unavailable) {
      failedReads += 1
      return replyWithError(route, 503, 'Temporary run recovery outage')
    }
    recoveredReads += 1
    return route.fallback()
  })
  await selectSavedThread(page, 'thread-recovered')
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  await expect(exactButton(chat, 'Stop response')).toBeEnabled()
  const composer = chat.getByRole('textbox', { name: /^(Message your agent|Steer the current turn)$/ })
  await expect(composer).toHaveAccessibleName('Steer the current turn')
  await composer.fill('Keep this unsent follow-up')
  unavailable = true
  await page.clock.runFor(2_100)
  await expect.poll(() => failedReads).toBeGreaterThan(0)
  await page.clock.runFor(3_100)
  await expect(chat.getByRole('alert')).toHaveText('Reconnecting to your agent…')
  const readsBeforeCompletion = recoveredReads
  unavailable = false
  await emitCodexEvent(page, {
    sequence: 10,
    kind: 'thread-state',
    method: 'turn/completed',
    threadId: 'thread-recovered',
    turnId: 'turn-recovered',
    rawJson: '{"params":{"turn":{"id":"turn-recovered","status":"completed"}}}',
  })
  await expect.poll(() => recoveredReads).toBeGreaterThan(readsBeforeCompletion)
  await expect(exactButton(chat, 'Send message')).toBeEnabled()
  await expect(chat.getByText('Agent returned an invalid event', { exact: true })).toHaveCount(0)
  await expect(chat.getByRole('alert')).toHaveCount(0)
  await expect(composer).toHaveAccessibleName('Message your agent')
  await expect(composer).toHaveValue('Keep this unsent follow-up')
  expect(mock.calls('create-thread', 'send-turn')).toHaveLength(0)
})

for (const recoveryAction of ['active-codex-runs', 'codex-run'] as const) {
  test(`clears a recovered ${recoveryAction} outage without sending another turn`, async ({ page }) => {
    await page.clock.install()
    const mock = await mockTengri(page, {
      durableRun:
        recoveryAction === 'codex-run'
          ? codexRun('33333333-3333-4333-8333-333333333333', 'thread-recovered', {
              phase: 'running',
              turnId: 'turn-recovered',
            })
          : undefined,
    })
    let unavailable = true
    let activeReads = 0
    let failedReads = 0
    await page.route('**/api/tengri', async (route) => {
      if (
        recoveryAction === 'codex-run' &&
        route.request().method() === 'POST' &&
        route.request().postDataJSON().action === 'active-codex-runs'
      ) {
        activeReads += 1
        // Once the run leaves the active set, the UI must recover its final status
        // through the individual endpoint even when that endpoint is unavailable.
        if (activeReads > 1) return replyWithResult(route, [])
      }
      if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== recoveryAction)
        return route.fallback()
      if (unavailable) {
        failedReads += 1
        return replyWithError(route, 503, 'Temporary run recovery outage')
      }
      return route.fallback()
    })
    await page.goto('/')
    const tengri = desktopWindow(page, 'Tengri')
    await expect(tengri.getByRole('alert')).toHaveCount(0)
    await page.clock.runFor(3_100)
    await expect.poll(() => failedReads).toBeGreaterThan(0)
    await page.clock.runFor(3_100)
    await expect(tengri.getByRole('alert')).toHaveText('Reconnecting to your agent…')
    await expect(tengri.getByText('Temporary run recovery outage', { exact: true })).toHaveCount(0)
    unavailable = false
    await page.clock.runFor(3_100)
    await expect(tengri.getByRole('alert')).toHaveCount(0)
    if (recoveryAction === 'codex-run') {
      await expect(exactButton(tengri, 'Stop response')).toBeEnabled()
    } else {
      await tengri.getByRole('textbox', { name: 'Message your agent' }).fill('Unsent draft')
      await expect(exactButton(tengri, 'Send message')).toBeEnabled()
    }
    expect(mock.calls('create-thread', 'send-turn')).toHaveLength(0)
  })
}

test('shows concise response activity and keeps detailed waiting reasons collapsed', async ({ page }) => {
  const run: TengriCodexRun = codexRun('44444444-4444-4444-8444-444444444444', 'thread-waiting', { phase: 'accepted' })
  const mock = await visitDesktop(page, { durableRun: run })
  const chat = desktopWindow(page, 'Tengri')
  await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveText('Thinking')
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Sending')
  await expect(chat.getByText('Ask Codex to explore, change, or run something in this workspace.')).toHaveCount(0)

  await expect(chat.getByText('Run accepted. Waiting for the agent.', { exact: true })).toHaveCount(0)
  run.state = { phase: 'waiting_for_guest', reason: 'waiting to protect the active run from automatic sleep' }
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Connecting')
  await expect(chat.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
  await expect(chat.getByText(run.state.reason, { exact: true })).not.toBeVisible()
  run.state = { phase: 'recovering', turnId: 'turn-current', reason: 'waiting for the authorized guest' }
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Reconnecting')
  await expect(chat.getByText(run.state.reason, { exact: true })).not.toBeVisible()
  run.state = { phase: 'cancelling', turnId: 'turn-current', reason: 'waiting for command cleanup receipt' }
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Stopping')
  await expect(exactButton(chat, 'Stop response')).toBeEnabled()
  expect(mock.calls('create-thread', 'send-turn')).toHaveLength(0)
})

for (const phase of ['accepted', 'waiting_for_guest'] as const) {
  test(`keeps a newly ${phase} run observable after idle workspace polling stopped`, async ({ page }) => {
    const mock = await mockTengri(page, {
      threadStore: { threads: [savedChat('thread-idle', 'Idle conversation', 1)] },
    })
    await selectSavedThread(page, 'thread-idle')
    let run: TengriCodexRun | undefined
    let workspaceReadsAfterSend = 0
    let sends = 0
    await routeTengriPost(page, async (action, route) => {
      if (action.action === 'send-turn') {
        sends += 1
        run = {
          runId: action.operationId,
          agentId: action.agentId,
          threadId: action.threadId,
          state: phase === 'accepted' ? { phase } : { phase, reason: 'Waiting for the guest' },
        }
        return replyWithResult(route, run)
      }
      if (action.action === 'active-codex-runs' && run) {
        workspaceReadsAfterSend += 1
        return replyWithResult(route, run.state.phase === 'rejected' ? [] : [run])
      }
      if (action.action === 'codex-run' && run) return replyWithResult(route, run)
      return route.fallback()
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const prompt = chat.getByRole('textbox', { name: 'Message your agent' })
    await expect.poll(() => mock.calls('active-codex-runs').length).toBeGreaterThan(0)
    await prompt.fill('Start a run without a native turn event')
    await exactButton(chat, 'Send message').click()
    await expect.poll(() => workspaceReadsAfterSend).toBeGreaterThan(1)
    expect(run).toBeDefined()
    run!.state = { phase: 'rejected', reason: 'Guest unavailable' }
    await expect(chat.getByRole('alert')).toContainText('Guest unavailable')
    await prompt.fill('A next message')
    await expect(exactButton(chat, 'Send message')).toBeEnabled()
    expect(sends).toBe(1)
  })
}

test('records Stop for an accepted run before a native turn exists', async ({ page }) => {
  const runId = '44444444-4444-4444-8444-444444444444'
  const mock = await mockTengri(page, {
    durableRun: codexRun(runId, 'thread-waiting', {
      phase: 'waiting_for_guest',
      reason: 'Waiting for the authorized guest',
    }),
  })
  await page.goto('/')
  const stop = exactButton(page, 'Stop response')
  await stop.click()
  await expect.poll(() => mock.calls('interrupt-turn')[0]?.runId).toBe(runId)
  const action = mock.calls('interrupt-turn')[0]
  expect(action).not.toHaveProperty('turnId')
  expect(action?.operationId).toMatch(/^[0-9a-f-]{36}$/)
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`tengri-stop:${id}`), runId)).toBeNull()
  await stop.click()
  await expect.poll(() => mock.calls('interrupt-turn').length).toBe(2)
  const refreshed = mock.calls('interrupt-turn')[1]
  expect(refreshed.operationId).not.toBe(action?.operationId)
})

test.describe('durable control retries', () => {
  for (const acknowledgement of ['before response', 'after response'] as const) {
    test(`clears an approval delivery error confirmed ${acknowledgement}`, async ({ page }) => {
      const runId = '33333333-3333-4333-8333-333333333333'
      const approvalId = 'process-identity:17'
      const mock = await mockTengri(page, {
        durableRun: codexRun(runId, 'thread-recovered', { phase: 'running', turnId: 'turn-recovered' }),
      })
      const { promise: responseGate, resolve: releaseResponse } = Promise.withResolvers<void>()
      let controls = 0
      await routeTengriAction(page, 'resolve-approval', async (_request, route) => {
        controls++
        await responseGate
        await replyWithError(route, 503, 'The approval response was unavailable')
      })
      await page.goto('/')
      const chat = desktopWindow(page, 'Tengri')
      await expect(exactButton(chat, 'Stop response')).toBeEnabled()
      const base = { threadId: 'thread-recovered', turnId: 'turn-recovered', itemId: '', text: '' }
      await emitCodexEvent(page, {
        ...base,
        sequence: 1,
        kind: 'approval',
        method: 'item/commandExecution/requestApproval',
        approvalId,
        rawJson: '{}',
      })
      const card = chat.getByRole('article', { name: 'Codex approval' })
      await exactButton(card, 'Approve once').click()
      await expect.poll(() => controls).toBe(1)
      if (acknowledgement === 'after response') {
        releaseResponse()
        await expect(chat.getByRole('alert')).toHaveText('The approval response was unavailable')
        await emitCodexEvent(page, {
          ...base,
          sequence: 2,
          kind: 'thread-state',
          method: 'serverRequest/resolved',
          approvalId: '',
          rawJson: codexParams({ requestId: 'another-approval' }),
        })
        await expect(chat.getByRole('alert')).toHaveText('The approval response was unavailable')
      }
      await emitCodexEvent(page, {
        ...base,
        sequence: 3,
        kind: 'thread-state',
        method: 'serverRequest/resolved',
        approvalId: '',
        rawJson: codexParams({ requestId: approvalId }),
      })
      await expect(card).toHaveCount(0)
      if (acknowledgement === 'before response') {
        releaseResponse()
        await expect
          .poll(() => page.evaluate((key) => localStorage.getItem(key), `tengri-control:${runId}:${approvalId}`))
          .toBeNull()
      }
      await expect(chat.getByRole('alert')).toHaveCount(0)
      expect(controls).toBe(1)
      expect(mock.calls('send-turn')).toHaveLength(0)
    })
  }

  test('retires an expired approval after its run completes without approving another turn', async ({ page }) => {
    const run: TengriCodexRun = codexRun('33333333-3333-4333-8333-333333333333', 'thread-active', {
      phase: 'running',
      turnId: 'turn-active',
    })
    const mock = await mockTengri(page, { durableRun: run })
    let controls = 0
    await routeTengriAction(page, 'resolve-approval', async (_request, route) => {
      controls++
      run.state = { phase: 'succeeded', turnId: 'turn-active' }
      return replyWithError(
        route,
        409,
        'The turn changed before this control was delivered. Try again.',
        'control_not_dispatched',
      )
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    await expect(exactButton(chat, 'Stop response')).toBeEnabled()
    await emitCodexEvent(page, {
      kind: 'approval',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-active',
      turnId: 'turn-active',
      approvalId: 'expired-approval',
      text: 'An action that already ended',
    })
    const card = chat.getByRole('article', { name: 'Codex approval' })
    await exactButton(card, 'Approve once').click()
    await expect(card).toHaveCount(0)
    await expect(chat.getByRole('alert')).toHaveCount(0)
    expect(controls).toBe(1)
    expect(mock.calls('send-turn')).toHaveLength(0)
  })

  for (const control of ['approval', 'question'] as const) {
    for (const outcome of ['not dispatched', 'unknown'] as const) {
      const behavior =
        outcome === 'not dispatched'
          ? 'replaces a rejected operation on retry'
          : 'retains an uncertain operation on retry'
      test(`${control} ${behavior}`, async ({ page }) => {
        const mock = await mockTengri(page, {
          resumeThreadRawJson: codexHistory([runningTurn('turn-active')]),
        })
        await selectSavedThread(page, 'thread-active')
        const operationIds: string[] = []
        const actionName = control === 'approval' ? 'resolve-approval' : 'answer-questions'
        await routeTengriPost(page, async (action, route) => {
          if (action.action !== actionName) return route.fallback()
          operationIds.push(String(action.operationId))
          if (operationIds.length === 1 || (outcome === 'not dispatched' && action.operationId === operationIds[0]))
            return route.fulfill({
              status: outcome === 'not dispatched' ? 409 : 503,
              json: {
                error: 'The control response failed',
                ...(outcome === 'not dispatched' ? { code: 'control_not_dispatched' } : {}),
              },
            })
          return route.fallback()
        })
        await page.goto('/')
        const tengri = desktopWindow(page, 'Tengri')
        await expect.poll(() => mock.calls('active-codex-runs').length).toBeGreaterThan(0)
        await emitCodexEvent(page, {
          kind: 'approval',
          method: control === 'approval' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput',
          threadId: 'thread-active',
          turnId: 'turn-active',
          approvalId: 'control-retry',
          text: 'Confirm the check',
          rawJson:
            control === 'question'
              ? JSON.stringify({ params: { questions: [{ id: 'notes', question: 'Any notes?' }] } })
              : '{}',
        })
        const card = tengri.getByRole('article', { name: control === 'approval' ? 'Codex approval' : 'Agent question' })
        if (control === 'question')
          await card.getByRole('textbox', { name: 'Any notes?', exact: true }).fill('Keep the files')
        const button = exactButton(card, control === 'approval' ? 'Approve once' : 'Submit answers')
        await button.click()
        await expect(tengri.getByText('The control response failed', { exact: true })).toBeVisible()
        await button.click()
        await expect.poll(() => operationIds.length).toBe(2)
        expect(operationIds[0]).toMatch(/^[0-9a-f-]{36}$/)
        if (outcome === 'not dispatched') expect(operationIds[1]).not.toBe(operationIds[0])
        else expect(operationIds[1]).toBe(operationIds[0])
        await expect(card).toHaveCount(0)
      })
    }
  }

  test('auto-approval waits for the durable native turn', async ({ page }) => {
    const run: TengriCodexRun = codexRun('44444444-4444-4444-8444-444444444444', 'thread-active', { phase: 'accepted' })
    const mock = await mockTengri(page, {
      durableRun: run,
      resumeThreadRawJson: codexHistory([runningTurn('turn-active')]),
    })
    await page.addInitScript(() => {
      localStorage.setItem('tengri-thread:microvm-ada', 'thread-active')
      localStorage.setItem('tengri-approval-mode:microvm-ada', 'auto')
    })
    await page.goto('/')
    await expect.poll(() => mock.calls('active-codex-runs').length).toBeGreaterThan(0)
    const before = mock.calls('active-codex-runs').length
    await emitCodexEvent(page, {
      kind: 'approval',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-active',
      turnId: 'turn-active',
      approvalId: 'early-approval',
      text: 'Run the check?',
    })
    await expect.poll(() => mock.calls('active-codex-runs').length).toBeGreaterThan(before)
    expect(mock.calls('resolve-approval')).toHaveLength(0)
    run.state = { phase: 'running', turnId: 'turn-active' }
    await expect.poll(() => mock.calls('resolve-approval').length).toBe(1)
  })
})

for (const anotherDraft of [false, true]) {
  test(`moves a pending new conversation draft to its assigned thread with another draft ${anotherDraft}`, async ({
    page,
  }) => {
    await mockTengri(page, {
      threadStore: {
        threads: [savedChat('thread-existing', 'Existing', 1)],
      },
    })

    const creation = requestGate()
    await routeTengriAction(page, 'create-thread', async (_request, route) => {
      await creation.hold()
      return route.fallback()
    })
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const sidebar = chat.getByTestId('agent-conversation-sidebar')
    const composer = composerInput(chat)
    await composer.fill('Create this conversation')
    await exactButton(chat, 'Send message').click()
    try {
      await creation.started
      await composer.fill('Follow up in the pending conversation')
      await pasteClipboardImage(page, composer)
      await expect(chat.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
      await sidebar.locator('[data-conversation-id="thread-existing"]').click()
      await composer.fill('Keep the existing conversation draft')
      if (anotherDraft) {
        await exactButton(sidebar, 'New conversation').click()
        await expect(composer).toHaveValue('')
        await expect(chat.getByRole('list', { name: 'Image attachments' })).toHaveCount(0)
        await expect(chat.getByRole('article', { name: 'Your message' })).toHaveCount(0)
        await composer.fill('A separate new draft')
      }
    } finally {
      creation.release()
    }
    await expect(sidebar.locator('[data-conversation-id="thread-1"]')).toBeVisible()
    if (!anotherDraft) {
      await expect(sidebar.locator('[data-conversation-id="thread-existing"]')).toHaveAttribute('aria-current', 'true')
    }
    await expect(chat.getByRole('article', { name: 'Your message' })).toHaveCount(0)
    await expect(composer).toHaveValue(anotherDraft ? 'A separate new draft' : 'Keep the existing conversation draft')
    await sidebar.locator('[data-conversation-id="thread-1"]').click()
    await expect(composer).toHaveValue('Follow up in the pending conversation')
    await expect(chat.getByRole('list', { name: 'Image attachments' }).getByRole('img')).toHaveCount(1)
    if (anotherDraft) {
      await sidebar.locator('[data-conversation-id="thread-existing"]').click()
      await expect(composer).toHaveValue('Keep the existing conversation draft')
      await exactButton(sidebar, 'New conversation').click()
      await expect(composer).toHaveValue('A separate new draft')
    }
  })
}

async function verifyConnectionRecovery(page: Page, refreshDisconnect: boolean) {
  await mockTengri(page)
  const connectionId = '33333333-3333-4333-8333-333333333333'
  const saves: Record<string, unknown>[] = []
  const disconnections: Record<string, unknown>[] = []
  let connections: Record<string, unknown>[] = []
  let lostResponse = true
  let lostDisconnect = true
  let targetId = 'galactic/immutable-namespace-uid'
  await mockConnectorCatalog(page, () => [
    namespaceOperation(
      'pod_status',
      'Read pod status',
      [namespaceTarget('production', targetId), namespaceTarget('staging', 'galactic/staging-uid')],
      'kubernetes.status.read',
    ),
    {
      connectorId: 'galactic',
      name: 'pod_exec',
      action: 'kubernetes.exec',
      description: 'Execute a command',
      readOnly: false,
      targets: [],
    },
  ])
  await page.route('**/api/tengri/connections**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = connectionRequestSchema.parse(route.request().postDataJSON())
      if (body.kind === 'save') {
        saves.push(body)
        connections = [
          {
            id: body.connectionId,
            clientService: 'tengri-web',
            clientReference: readyAgent.uid + '/galactic',
            actions: ['kubernetes.status.read'],
            resources: [{ kind: 'kubernetes.namespace', id: 'galactic/immutable-namespace-uid', target: 'production' }],
            binding: { service: 'tengri', id: readyAgent.uid },
            version: '1',
            enabled: true,
            delegationId: connectionId,
            credentialBinding: { service: 'tengri', id: readyAgent.uid, generation: readyAgent.runtimeEpoch },
            proofKeyThumbprint: 'a'.repeat(43),
            expiresAtUnixMs: String(Date.now() + 900_000),
            credentialActive: true,
            credentialGeneration: '5',
            recoveryGeneration: '1',
          },
        ]
        if (lostResponse) {
          lostResponse = false
          await replyWithError(route, 503, 'Guest acknowledgement is unavailable. Retry the same change.')
          return
        }
      }
    } else if (route.request().method() === 'DELETE') {
      disconnections.push(route.request().postDataJSON())
      expect(route.request().postDataJSON()).toMatchObject({
        connectionId: saves[0]?.connectionId,
        agentId: readyAgent.id,
      })
      connections = connections.map((connection) => ({
        ...connection,
        enabled: false,
        credentialActive: false,
        version: '2',
        credentialGeneration: '6',
      }))
      if (lostDisconnect) {
        lostDisconnect = false
        await replyWithError(route, 503, 'The disconnection response could not be confirmed.')
        return
      }
      await route.fulfill({ json: { revoked: true, cleanupPending: true } })
      return
    }
    await route.fulfill({ json: { connections, recoveryGeneration: '1' } })
  })
  await page.goto('/')
  const settings = await openSettings(page, 'Connections')
  const panel = settings.getByRole('region', { name: 'Connections', exact: true })
  await expect(panel.getByRole('list', { name: 'Available services' })).toBeVisible()
  await expect(panel.locator('form')).toHaveCount(0)
  await expect(panel.getByText('pod_exec', { exact: true })).toHaveCount(0)
  await exactButton(panel, 'Connect').click()
  await expect(panel.getByRole('heading', { name: 'Connect Kubernetes' })).toBeFocused()
  await expect(panel.getByRole('button', { name: 'Customize access' })).toHaveAttribute('aria-expanded', 'false')
  await exactButton(panel, 'Connect').click()
  await expect(panel.getByRole('alert')).toContainText('Choose at least one resource.')
  await expect(panel.getByRole('checkbox', { name: 'production', exact: true })).toHaveAccessibleDescription(
    'Choose at least one resource.',
  )
  await panel.getByRole('checkbox', { name: 'production', exact: true }).check()
  await exactButton(panel, 'Connect').click()
  await expect(panel.getByRole('alert')).toContainText('Guest acknowledgement is unavailable')
  await openSettingsPane(settings, 'General')
  await openSettingsPane(settings, 'Connections')
  await expect(panel.getByRole('alert')).toContainText('Guest acknowledgement is unavailable')
  await exactButton(panel, 'Try again').click()
  await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
  await expect(exactButton(panel, 'Manage')).toBeFocused()
  await expect(panel.locator('form')).toHaveCount(0)

  expect(saves).toHaveLength(2)
  expect(saves[1]).toEqual(saves[0])
  expect(saves[0]).toMatchObject({
    expectedVersion: '0',
    operations: ['pod_status'],
    targets: [{ kind: 'kubernetes.namespace', id: 'galactic/immutable-namespace-uid' }],
  })
  await exactButton(panel, 'Manage').click()
  await panel.getByRole('checkbox', { name: 'staging', exact: true }).check()
  lostResponse = true
  await exactButton(panel, 'Save changes').click()
  await expect(panel.getByRole('alert')).toContainText('Guest acknowledgement is unavailable')
  await exactButton(panel, 'Disconnect').click()
  await expect(panel.getByRole('alert')).toHaveText('The disconnection response could not be confirmed.')
  if (refreshDisconnect) {
    await openSettingsPane(settings, 'General')
    await openSettingsPane(settings, 'Connections')
    await expect(exactButton(panel, 'Reconnect')).toBeEnabled()
    await expect(exactButton(panel, 'Try again')).toHaveCount(0)
    await expect(exactButton(panel, 'Retry disconnect')).toHaveCount(0)
    await expect(panel.getByRole('checkbox', { name: 'production', exact: true })).toBeEnabled()
    expect(disconnections).toHaveLength(1)
    await exactButton(panel, 'Back to connections').click()
  } else {
    await exactButton(panel, 'Retry disconnect').click()
    expect(disconnections).toHaveLength(2)
    expect(disconnections[1]).toEqual(disconnections[0])
  }
  await expect(panel.getByRole('status')).toContainText('Access is revoked')
  await expect(panel.getByText('Not connected', { exact: true })).toBeVisible()
  targetId = 'galactic/recreated-namespace-uid'
  await page.reload()
  const restored = await openSettings(page, 'Connections')
  await expect(exactButton(restored, 'Try again')).toHaveCount(0)
  await expect(restored.getByText('Not connected', { exact: true })).toBeVisible()
  await exactButton(restored, 'Connect').click()
  const unavailable = restored.getByRole('checkbox', { name: 'Unavailable saved resource.', exact: false })
  await expect(unavailable).toBeChecked()
  await expect(restored.getByRole('checkbox', { name: 'production', exact: true })).not.toBeChecked()
  await unavailable.focus()
  await unavailable.press('Space')
  await expect(unavailable).toHaveCount(0)
  expect(saves).toHaveLength(3)
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Connections"]').analyze()
  expect(accessibility.violations).toEqual([])

  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() => restored.locator('form').evaluate((form) => form.scrollWidth - form.clientWidth))
    .toBeLessThanOrEqual(1)
  await expect(restored.getByRole('checkbox', { name: 'production', exact: true })).not.toBeChecked()
}

for (const refreshDisconnect of [false, true]) {
  test(`saves scoped platform connections, retries the exact change, and retains disconnection after reload: refresh ${refreshDisconnect}`, async ({
    page,
  }) => {
    await verifyConnectionRecovery(page, refreshDisconnect)
  })
}

test('requests integration access without admin controls and recovers the exact intent on a phone', async ({
  page,
}) => {
  await mockTengri(page)
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const scope = {
    workspaceId,
    workspaceName: 'Lab',
    resource: { kind: 'kubernetes.namespace', id: 'galactic/namespace-uid' },
    resourceName: 'Production',
    actions: ['kubernetes.status.read'],
  }
  const writes: AccessRequestMutation[] = []
  let requestId = ''
  let approved = false
  let loseReply = true
  await mockConnectorCatalog(page, () =>
    approved
      ? [
          namespaceOperation(
            'pod_status',
            'Read pod status',
            [{ name: 'Production', resource: scope.resource }],
            'kubernetes.status.read',
          ),
        ]
      : [],
  )
  await page.route('**/api/tengri/connections**', (route) =>
    route.fulfill({
      json: {
        connections: [],
        recoveryGeneration: '1',
        availableScopes: approved ? [scope] : [],
        requestableScopes: [scope],
        accessRequests: requestId
          ? [
              {
                id: requestId,
                requesterHumanId: 'a'.repeat(64),
                clientService: 'tengri-web',
                scope,
                reason: 'Investigate production health',
                state: approved ? 'PLATFORM_ACCESS_REQUEST_STATE_APPROVED' : 'PLATFORM_ACCESS_REQUEST_STATE_PENDING',
                createdAtUnixMs: '1793510000000',
                updatedAtUnixMs: '1793510000000',
              },
            ]
          : [],
      },
    }),
  )
  await page.route('**/api/platform/access-requests', (route) => {
    const body = accessRequestMutationSchema.parse(route.request().postDataJSON())
    writes.push(body)
    if (body.kind !== 'create') throw new Error('Expected a member request')
    requestId = body.operationId
    if (loseReply) {
      loseReply = false
      return replyWithError(route, 503, 'The request response was lost.')
    }
    return route.fulfill({
      json: { requestId, decision: { allowed: true, auditReceiptId: '22222222-2222-4222-8222-222222222222' } },
    })
  })
  await page.goto('/')
  let settings = await openSettings(page, 'Connections')
  await page.setViewportSize({ width: 390, height: 844 })
  await exactButton(settings, 'Request access').click()
  const reason = settings.getByLabel('Why do you need access?', { exact: true })
  await reason.fill('Investigate production health')
  expect(
    await reason.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16)

  await exactButton(settings, 'Send request').click()
  await expect(settings.getByRole('alert')).toHaveText('The request response was lost.')
  await page.reload()
  await exactButton(page, 'Open Settings').click()
  settings = desktopWindow(page, 'Settings')
  await openSettingsPane(settings, 'Connections')
  await exactButton(settings, 'Retry saved request').click()
  await expect(settings.getByText('Pending approval', { exact: true })).toBeVisible()
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  await expect(settings.getByText('Service policies', { exact: true })).toHaveCount(0)
  await expect(exactButton(settings, 'Verify passkey')).toHaveCount(0)
  approved = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(exactButton(settings, 'Connect')).toBeVisible()
  await expect(exactButton(settings, 'Request access')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('keeps an oversized resource selection editable without saving a pending request', async ({ page }) => {
  await mockTengri(page)
  const saves: SaveConnection[] = []
  await mockConnectorCatalog(page, () => [
    namespaceOperation(
      'status',
      'Read pod status',
      Array.from({ length: 17 }, (_, index) => namespaceTarget('namespace-' + index, 'galactic/' + index)),
    ),
  ])
  await page.route('**/api/tengri/connections**', (route) => {
    if (route.request().method() === 'POST') {
      const request = connectionRequestSchema.parse(route.request().postDataJSON())
      if (request.kind === 'save') {
        saves.push(request)
        return replyWithError(route, 403, 'Review access.', 'connection_access_denied')
      }
    }
    return route.fulfill({ json: { connections: [], recoveryGeneration: '1' } })
  })
  await page.goto('/')
  const settings = await openSettings(page, 'Connections')
  await exactButton(settings, 'Connect').click()
  for (let index = 0; index < 17; index += 1)
    await settings.getByRole('checkbox', { name: 'namespace-' + index, exact: true }).check()
  await exactButton(settings, 'Connect').click()
  await expect(settings.getByRole('alert')).toHaveText('Choose up to 16 resources.')
  expect(saves).toHaveLength(0)
  await settings.getByRole('checkbox', { name: 'namespace-0', exact: true }).uncheck()
  await exactButton(settings, 'Connect').click()
  await expect(settings.getByRole('alert')).toHaveText('Review access.')
  expect(saves).toHaveLength(1)
  expect(saves[0]?.targets).toHaveLength(16)
})

for (const [status, code] of [
  [403, 'connection_access_denied'],
  [409, 'connection_scope_changed'],
] as const) {
  test(`allows correcting connection scope after a definite rejection: ${status}`, async ({ page }) => {
    await mockTengri(page)
    const saves: SaveConnection[] = []
    await mockConnectorCatalog(page, () => [
      namespaceOperation(
        'status',
        'Read pod status',
        ['production', 'staging'].map((name) => namespaceTarget(name)),
      ),
    ])
    await page.route('**/api/tengri/connections**', (route) => {
      if (route.request().method() === 'POST') {
        const request = connectionRequestSchema.parse(route.request().postDataJSON())
        if (request.kind === 'save') {
          saves.push(request)
          return replyWithError(route, status, 'Review the selected access.', code)
        }
      }
      return route.fulfill({ json: { connections: [], recoveryGeneration: '1' } })
    })
    await page.goto('/')
    const settings = await openSettings(page, 'Connections')
    await exactButton(settings, 'Connect').click()
    await settings.getByRole('checkbox', { name: 'production', exact: true }).check()
    await exactButton(settings, 'Connect').click()
    await expect(settings.getByRole('alert')).toHaveText('Review the selected access.')
    await settings.getByRole('checkbox', { name: 'production', exact: true }).uncheck()
    await settings.getByRole('checkbox', { name: 'staging', exact: true }).check()
    await exactButton(settings, 'Connect').click()
    await expect.poll(() => saves.length).toBe(2)
    expect(saves[1]?.operationId).not.toBe(saves[0]?.operationId)
    expect(saves[1]).toMatchObject({ targets: [{ kind: 'kubernetes.namespace', id: 'galactic/staging' }] })
  })
}

for (const { verificationStatus, failedStart } of [
  { verificationStatus: 200, failedStart: false },
  { verificationStatus: 401, failedStart: false },
  { verificationStatus: 428, failedStart: false },
  { verificationStatus: 401, failedStart: true },
]) {
  test(`connects approved tools in one action and only resumes an expired sign-in: ${verificationStatus}, failed start ${failedStart}`, async ({
    page,
  }) => {
    await mockTengri(page)
    const saves: SaveConnection[] = []
    let verifications = 0
    let signInStarts = 0
    let connections: Record<string, unknown>[] = []
    await mockConnectorCatalog(page, () =>
      [
        ['status', 'Read pod status'],
        ['logs', 'Read bounded pod logs'],
        ['events', 'Read namespace events'],
      ].map(([name, description]) =>
        namespaceOperation(
          name,
          description,
          [namespaceTarget('production', 'galactic/immutable-uid')],
          'kubernetes.' + name + '.read',
        ),
      ),
    )
    await page.route('**/api/auth/' + (verificationStatus === 401 ? 'login' : 'step-up'), (route) => {
      signInStarts += 1
      if (failedStart && signInStarts === 1)
        return replyWithError(route, 503, 'Verification is temporarily unavailable.')
      verifications += 1
      return route.fulfill({ json: { url: desktopOrigin + '/?verified=1' } })
    })
    await page.route('**/api/tengri/connections**', async (route) => {
      if (route.request().method() === 'POST') {
        const request = connectionRequestSchema.parse(route.request().postDataJSON())
        if (request.kind === 'save') {
          saves.push(request)
          if (verifications === 0 && verificationStatus !== 200) {
            await replyWithError(route, verificationStatus, 'Verify before connecting.')
            return
          }
          connections = [
            {
              id: request.connectionId,
              clientService: 'tengri-web',
              clientReference: readyAgent.uid + '/galactic',
              actions: request.operations.map((name) => 'kubernetes.' + name + '.read'),
              resources: request.targets,
              binding: { service: 'tengri', id: readyAgent.uid },
              enabled: true,
              version: '1',
              credentialActive: true,
              credentialGeneration: '5',
              recoveryGeneration: '1',
              delegationId: '33333333-3333-4333-8333-333333333333',
              proofKeyThumbprint: 'a'.repeat(43),
              credentialBinding: { service: 'tengri', id: readyAgent.uid, generation: readyAgent.runtimeEpoch },
              expiresAtUnixMs: String(Date.now() + 900_000),
            },
          ]
        }
      }
      await route.fulfill({ json: { connections, recoveryGeneration: '1' } })
    })
    await page.goto('/')
    const settings = await openSettings(page, 'Connections')
    await expect(settings.getByText('production', { exact: false }).first()).toBeVisible()
    await exactButton(settings, 'Connect').click()
    if (verificationStatus === 428) {
      await expect(settings.getByRole('alert')).toHaveText('Verify before connecting.')
      expect(signInStarts).toBe(0)
      expect(verifications).toBe(0)
      expect(saves).toHaveLength(1)
      await exactButton(settings, 'Finish setup').click()
      await expect(settings.getByRole('checkbox', { name: 'production', exact: true })).toBeChecked()
      return
    }
    if (failedStart) {
      await expect(settings.getByRole('alert')).toHaveText(
        'Sign-in could not start. Your choices are saved. Try again when you’re ready.',
      )
      await exactButton(settings, 'Finish setup').click()
      await expect(settings.getByRole('checkbox', { name: 'production', exact: true })).toBeChecked()
      await exactButton(settings, 'Try again').click()
    }
    await expect(page).toHaveURL(verificationStatus === 200 ? desktopOrigin + '/' : desktopOrigin + '/?verified=1')
    await expect(settings.getByText('Connected', { exact: true })).toBeVisible()
    await expect(exactButton(settings, 'Manage')).toBeEnabled()
    await expect(settings.locator('[aria-label="Connections"] form')).toHaveCount(0)
    expect(verifications).toBe(verificationStatus === 200 ? 0 : 1)
    expect(signInStarts).toBe(verificationStatus === 200 ? 0 : failedStart ? 2 : 1)
    expect(saves).toHaveLength(verificationStatus === 200 ? 1 : failedStart ? 3 : 2)
    for (const request of saves) expect(request).toEqual(saves[0])
    const accessibility = await new AxeBuilder({ page }).include('[aria-label="Connections"]').analyze()
    expect(accessibility.violations).toEqual([])

    if (verificationStatus === 200) {
      expect(saves[0]?.operations).toEqual(['status', 'logs', 'events'])
      connections = connections.map((connection) => ({ ...connection, credentialActive: false }))
      await openSettingsPane(settings, 'General')
      await openSettingsPane(settings, 'Connections')
      await expect(settings.getByText('Needs attention', { exact: true })).toBeVisible()
      await expect(settings.getByText('Connected', { exact: true })).toHaveCount(0)
      await exactButton(settings, 'Manage').click()
      await expect(exactButton(settings, 'Reconnect')).toBeEnabled()
    }
  })
}

test('uses only common approved operations and keeps each connection in one workspace', async ({ page }) => {
  await mockTengri(page)
  const saves: SaveConnection[] = []
  const target = (name: string) => namespaceTarget(name)
  const alpha = target('alpha')
  const beta = target('beta')
  await mockConnectorCatalog(page, () => [
    namespaceOperation('status', 'Read pod status', [alpha, beta]),
    namespaceOperation('logs', 'Read bounded pod logs', [alpha]),
  ])
  await page.route('**/api/tengri/connections**', (route) => {
    if (route.request().method() === 'POST') {
      const request = connectionRequestSchema.parse(route.request().postDataJSON())
      if (request.kind === 'save') saves.push(request)
      return replyWithError(route, 403, 'Recorded the selected access.', 'connection_access_denied')
    }
    return route.fulfill({
      json: {
        connections: [],
        recoveryGeneration: '1',
        availableScopes: [
          {
            workspaceId: '11111111-1111-4111-8111-111111111111',
            workspaceName: 'First workspace',
            resource: alpha.resource,
            resourceName: alpha.name,
            actions: ['kubernetes.status.read', 'kubernetes.logs.read'],
          },
          {
            workspaceId: '22222222-2222-4222-8222-222222222222',
            workspaceName: 'Second workspace',
            resource: beta.resource,
            resourceName: beta.name,
            actions: ['kubernetes.status.read'],
          },
        ],
      },
    })
  })
  await page.goto('/')
  const settings = await openSettings(page, 'Connections')
  await exactButton(settings, 'Connect').click()
  await settings.getByRole('checkbox', { name: 'alpha', exact: true }).check()
  await expect(settings.getByText('First workspace', { exact: true })).toBeVisible()
  await expect(settings.getByText('Read bounded pod logs', { exact: true })).toBeVisible()
  await settings.getByRole('checkbox', { name: 'beta', exact: true }).check()
  await expect(settings.getByText('Read bounded pod logs', { exact: true })).toHaveCount(0)
  await exactButton(settings, 'Connect').click()
  await expect(settings.getByRole('alert')).toHaveText('Choose resources from one workspace.')
  expect(saves).toHaveLength(0)
  await settings.getByRole('checkbox', { name: 'alpha', exact: true }).uncheck()
  await exactButton(settings, 'Connect').click()
  await expect(settings.getByRole('alert')).toHaveText('Recorded the selected access.')
  expect(saves).toHaveLength(1)
  expect(saves[0]?.operations).toEqual(['status'])
  expect(saves[0]?.targets).toEqual([beta.resource])
})

test('managing a Viewer preserves their exact saved scope and identifies diagnostic agents', async ({ page }) => {
  await mockTengri(page)
  const writes: Record<string, unknown>[] = []
  const scope = {
    fileRoots: ['/workspace/approved '],
    threadIds: ['saved-thread'],
    terminalIds: ['saved-terminal'],
    browserScreenshot: true,
    maxBytes: 4096,
    maxItems: 20,
  }
  const agent = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  await page.route('**/api/tengri/access**', async (route) => {
    if (route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON())
      await route.fulfill({
        json: {
          receipt: {
            operationId: route.request().postDataJSON().operationId,
            version: '21',
            auditReceiptId: 'fixture-audit',
          },
        },
      })
      return
    }
    await route.fulfill({
      json: {
        version: '20',
        workspaceState: 'active',
        entries: [
          { subjectId: 'viewer-person', githubId: '123', displayName: 'Alex Chen', role: 'viewer', scope },
          { subjectId: agent, role: 'diagnostic', grantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', scope },
        ],
      },
    })
  })
  await page.goto('/')
  const settings = await openSettings(page, 'Privacy & Security')
  const access = settings.getByRole('region', { name: 'Access administration', exact: true })
  const diagnostic = access.locator('[data-slot="item"]').filter({ hasText: 'Diagnostic agent' })
  await diagnostic.getByText('Access details', { exact: true }).click()
  await expect(diagnostic.getByText('Agent ' + agent, { exact: true })).toBeVisible()
  await expect(diagnostic).not.toContainText('Browser status')
  await exactButton(access, 'Manage Alex Chen viewer').click()
  await expect(
    access.getByRole('checkbox', { name: 'Approve bounded Viewer content access', exact: true }),
  ).toBeChecked()
  await expect(access.getByLabel('File roots under /workspace', { exact: true })).toHaveValue('/workspace/approved ')
  await expect(access.getByLabel('Codex thread IDs', { exact: true })).toHaveValue('saved-thread')
  await expect(access.getByLabel('Terminal IDs', { exact: true })).toHaveValue('saved-terminal')
  await expect(access.getByRole('checkbox', { name: 'Allow browser screenshots', exact: true })).toBeChecked()
  await expect(access.getByLabel('Maximum bytes', { exact: true })).toHaveValue('4096')
  await expect(access.getByLabel('Maximum items', { exact: true })).toHaveValue('20')
  await access.getByLabel('Reason', { exact: true }).fill('Keep this existing Viewer scope unchanged')
  await exactButton(access, 'Save changes').click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ action: 'collaborator', recipient: { kind: 'github-id', githubId: '123' }, scope })
  await expect(access.getByRole('status').filter({ hasText: 'Access updated.' })).toBeVisible()
  await selectOption(page, access.getByLabel('Role', { exact: true }), 'Developer')
  await selectOption(page, access.getByLabel('Role', { exact: true }), 'Viewer')
  await expect(
    access.getByRole('checkbox', { name: 'Approve bounded Viewer content access', exact: true }),
  ).not.toBeChecked()
  await exactButton(access, 'Cancel').click()
  await exactButton(access, 'Add collaborator').click()
  await access.getByLabel('GitHub username', { exact: true }).fill('another-person')
  await expect(
    access.getByRole('checkbox', { name: 'Approve bounded Viewer content access', exact: true }),
  ).not.toBeChecked()
  await access.getByRole('checkbox', { name: 'Approve bounded Viewer content access', exact: true }).check()
  await expect(access.getByLabel('File roots under /workspace', { exact: true })).toHaveValue('/workspace/project')
  await access.getByLabel('GitHub username', { exact: true }).fill('different-person')
  await expect(
    access.getByRole('checkbox', { name: 'Approve bounded Viewer content access', exact: true }),
  ).not.toBeChecked()
})

test('returns from phone layout without shrinking saved desktop windows', async ({ page }) => {
  await mockTengri(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const chat = page.locator('section[aria-label="Tengri window"]')
  await expect(chat.getByRole('textbox', { name: 'Message your agent', exact: true })).toBeVisible()
  const before = await chat.boundingBox()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(async () => (await chat.boundingBox())?.width).toBe(390)
  await exactButton(chat, 'Minimize Tengri').click()
  await expect(chat).toBeHidden()
  await expect(chat.locator('..')).toHaveCSS('transform', 'none')
  await exactButton(page, 'Open Tengri').click()
  await expect(chat).toBeVisible()
  await exactButton(chat, 'Maximize Tengri').click()
  await exactButton(chat, 'Restore Tengri').click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(() => chat.boundingBox()).toEqual(before)
  await page.reload()
  await expect.poll(() => chat.boundingBox()).toEqual(before)
})

test('touch layout fills landscape and preserves its draft through rotation', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  try {
    const page = await context.newPage()
    await visitDesktop(page)
    const chat = desktopWindow(page, 'Tengri')
    const composer = chat.getByRole('textbox', { name: 'Message your agent', exact: true })
    await composer.fill('Preserve this draft through rotation')
    await page.setViewportSize({ width: 844, height: 390 })
    await expect.poll(async () => (await chat.boundingBox())?.width).toBe(844)
    await expect(chat).toHaveCSS('border-radius', '0px')
    await expect(composer).toBeInViewport()
    await expect(exactButton(chat, 'Send message')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => (await chat.boundingBox())?.width).toBe(390)
    await expect(composer).toHaveValue('Preserve this draft through rotation')
    expect(await page.evaluate(() => scrollY)).toBe(0)
  } finally {
    await context.close()
  }
})

for (const width of [320, 390, 430]) {
  test(`phone chat keeps its draft and controls stable through keyboard resize at ${width}px`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    })
    try {
      const page = await context.newPage()
      const store: ThreadStore = {
        threads: [savedChat('thread-phone', 'Phone chat', 1)],
      }
      await visitDesktop(page, { threadStore: store })
      const chat = desktopWindow(page, 'Tengri')
      const composer = chat.getByRole('textbox', { name: 'Message your agent', exact: true })
      await expect(composer).toHaveCSS('font-size', '16px')
      await expect(composer).not.toBeFocused()
      await composer.tap()
      await composer.fill('Keep this unsent phone draft')
      expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
      const before = await chat.boundingBox()
      expect(before?.x).toBeCloseTo(0, 0)
      expect(before?.width).toBeCloseTo(width, 0)
      await page.evaluate(async () => {
        const visual = window.visualViewport
        if (!visual) throw new Error('Visual viewport is required')
        Object.defineProperty(visual, 'height', { configurable: true, value: 0 })
        Object.defineProperty(visual, 'width', { configurable: true, value: 0 })
        visual.dispatchEvent(new Event('resize'))
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      await expect
        .poll(() => page.locator('[data-tengri-desktop]').evaluate((element) => element.getBoundingClientRect().height))
        .toBe(844)
      await page.evaluate(() => {
        if (!window.visualViewport) return
        Reflect.deleteProperty(window.visualViewport, 'height')
        Reflect.deleteProperty(window.visualViewport, 'width')
      })
      await page.evaluate(() => {
        const visual = window.visualViewport
        if (!visual) return
        Object.defineProperty(visual, 'height', { configurable: true, value: 800 })
        visual.dispatchEvent(new Event('resize'))
      })
      await expect.poll(async () => (await chat.boundingBox())?.height).toBeCloseTo(before?.height ?? 0, 0)
      await expect
        .poll(() =>
          page.locator('[data-tengri-dock-container]').evaluate((element) => element.getBoundingClientRect().height),
        )
        .toBe(44)
      await page.evaluate(() => {
        const viewport = window.visualViewport
        if (!viewport) throw new Error('Visual viewport is required')
        Object.defineProperty(viewport, 'height', { configurable: true, value: 400 })
        Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 120 })
        viewport.dispatchEvent(new Event('resize'))
        viewport.dispatchEvent(new Event('scroll'))
      })
      await expect
        .poll(() => page.locator('main.tengri-theme').evaluate((element) => element.getBoundingClientRect().height))
        .toBe(400)
      await expect
        .poll(() => page.locator('[data-tengri-desktop]').evaluate((element) => element.getBoundingClientRect().top))
        .toBe(120)
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
      await expect(composer).toBeInViewport()
      await expect(exactButton(chat, 'Send message')).toBeInViewport()
      await expect
        .poll(() =>
          page.locator('[data-tengri-dock-container]').evaluate((element) => element.getBoundingClientRect().height),
        )
        .toBe(0)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
        .toBeLessThanOrEqual(1)
      await page.screenshot({ path: test.info().outputPath(`phone-keyboard-${width}.png`) })
      await page.evaluate(() => {
        const viewport = window.visualViewport
        if (!viewport) return
        Reflect.deleteProperty(viewport, 'height')
        Reflect.deleteProperty(viewport, 'offsetTop')
        viewport.dispatchEvent(new Event('resize'))
      })
      await expect
        .poll(() => page.locator('main.tengri-theme').evaluate((element) => element.getBoundingClientRect().height))
        .toBe(844)
      await expect(composer).toHaveValue('Keep this unsent phone draft')
      await composer.blur()
      await exactButton(chat, 'Show conversations').tap()
      const sidebar = chat.getByTestId('agent-conversation-sidebar')
      const dismiss = exactButton(sidebar, 'Hide conversations')
      const dismissTarget = await dismiss.boundingBox()
      expect(dismissTarget?.width).toBeGreaterThanOrEqual(44)
      expect(dismissTarget?.height).toBeGreaterThanOrEqual(44)
      await dismiss.tap()
      await expect(sidebar).toBeHidden()
      await expect(exactButton(chat, 'Show conversations')).toBeFocused()
      await exactButton(chat, 'Show conversations').tap()
      if (width === 320) {
        await expect(dismiss).toBeFocused()
        await dismiss.press('Escape')
        await expect(sidebar).toBeHidden()
        await expect(exactButton(chat, 'Show conversations')).toBeFocused()
        await exactButton(chat, 'Show conversations').tap()
      }
      await exactButton(sidebar, 'Phone chat').tap()
      await expect(sidebar).toBeHidden()
      await expect(composer).not.toBeFocused()
      await exactButton(chat, 'Show conversations').tap()
      const archive = exactButton(sidebar, 'Archive Phone chat')
      await expect(archive).toBeVisible()
      await expect(archive).toHaveText('')
      const target = await archive.boundingBox()
      expect(target?.width).toBeGreaterThanOrEqual(44)
      expect(target?.height).toBeGreaterThanOrEqual(44)
      await expect(exactButton(sidebar, 'Chat actions for Phone chat')).toHaveCount(0)
      await page.screenshot({ path: test.info().outputPath(`phone-sidebar-${width}.png`) })
      await archive.tap()
      await expect.poll(() => store.threads[0]?.archived).toBe(true)
    } finally {
      await context.close()
    }
  })
}

test('phone keyboard and viewport panning preserve the transcript reading position', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  try {
    const page = await context.newPage()
    await mockTengri(page, {
      resumeThreadRawJson: codexHistory([
        completedTurn(
          'history-turn',
          Array.from({ length: 80 }, (_, index) =>
            agentMessage(
              `history-${index}`,
              `History message ${index}. ` + 'Preserve this reading position. '.repeat(20),
            ),
          ),
        ),
      ]),
    })
    await selectSavedThread(page, 'mobile-reading-thread')
    await page.goto('/')
    const chat = desktopWindow(page, 'Tengri')
    const scroll = chat.getByTestId('agent-conversation-scroll')
    await expect(chat.getByRole('article', { name: 'Codex response' })).toHaveCount(80)
    await scroll.evaluate((element) => {
      element.scrollTop = 1000
      element.dispatchEvent(new Event('scroll'))
    })
    await expect(exactButton(chat, 'Jump to latest')).toBeVisible()
    const position = await scroll.evaluate((element) => element.scrollTop)
    await chat.getByRole('textbox', { name: 'Message your agent', exact: true }).tap()
    await page.evaluate(() => {
      const visual = window.visualViewport
      if (!visual) throw new Error('Visual viewport required')
      Object.defineProperty(visual, 'height', { configurable: true, value: 400 })
      Object.defineProperty(visual, 'offsetTop', { configurable: true, value: 120 })
      visual.dispatchEvent(new Event('resize'))
      visual.dispatchEvent(new Event('scroll'))
    })
    await expect
      .poll(() => page.locator('[data-tengri-desktop]').evaluate((element) => element.getBoundingClientRect().top))
      .toBe(120)
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(position, 0)
    await page.evaluate(() => {
      const visual = window.visualViewport
      if (!visual) return
      Reflect.deleteProperty(visual, 'height')
      Reflect.deleteProperty(visual, 'offsetTop')
      visual.dispatchEvent(new Event('resize'))
      visual.dispatchEvent(new Event('scroll'))
    })
    await expect
      .poll(() => page.locator('[data-tengri-desktop]').evaluate((element) => element.getBoundingClientRect().height))
      .toBe(844)
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(position, 0)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  } finally {
    await context.close()
  }
})

for (const mode of ['idle', 'current', 'other', 'closed'] as const) {
  test(`renews connections during active work without an idle renewal loop: ${mode}`, async ({ page }) => {
    const activeRun = mode !== 'idle'
    await page.clock.install({ time: new Date('2026-08-26T12:34:00.000Z') })
    await mockTengri(
      page,
      activeRun
        ? {
            durableRun: {
              runId: '66666666-6666-4666-8666-666666666666',
              agentId: readyAgent.id,
              threadId: 'thread-active',
              state: { phase: 'running', turnId: 'turn-active' },
            },
            resumeThreadRawJson: codexHistory([runningTurn('turn-active')], { id: 'thread-active' }),
          }
        : {},
    )
    if (activeRun) await selectSavedThread(page, 'thread-active')
    let reconciliations = 0
    await page.route('**/api/tengri/connections**', async (route) => {
      if (route.request().method() === 'POST') {
        expect(connectionRequestSchema.parse(route.request().postDataJSON())).toEqual({
          kind: 'reconcile',
          agentId: readyAgent.id,
        })
        reconciliations += 1
      }
      await route.fulfill({ json: { connections: [], recoveryGeneration: '1' } })
    })
    await page.goto('/')
    await expect.poll(() => reconciliations).toBeGreaterThan(0)
    if (activeRun) await expect(exactButton(page, 'Stop response')).toBeVisible()
    if (mode === 'other') {
      const chat = desktopWindow(page, 'Tengri')
      await exactButton(chat, 'New conversation').click()
      await expect(exactButton(chat, 'Stop response')).toHaveCount(0)
    }
    if (mode === 'closed') {
      await exactButton(page, 'Close Tengri').click()
      await expect(desktopWindow(page, 'Tengri')).toHaveCount(0)
    }
    await page.clock.runFor(1_000)
    const baseline = reconciliations
    await page.clock.fastForward(61_000)
    if (activeRun) await expect.poll(() => reconciliations).toBe(baseline + 1)
    else expect(reconciliations).toBe(baseline)
  })
}

test('keeps workspace sharing in Tengri and directs administration to its own portal', async ({ page }) => {
  await mockTengri(page)
  const reads: string[] = []
  await page.route('**/api/tengri/access**', async (route) => {
    reads.push(route.request().url())
    await route.fulfill({ json: { version: '20', workspaceState: 'active', entries: [] } })
  })
  await page.goto('/')
  const settings = await openSettings(page, 'Privacy & Security')
  const sharing = settings.getByRole('region', { name: 'Access administration', exact: true })
  await expect(sharing.getByRole('heading', { name: 'Workspace access', exact: true })).toBeVisible()
  await expect(exactButton(sharing, 'Add collaborator')).toBeVisible()
  await expect(sharing.getByRole('tab')).toHaveCount(0)
  await expect(sharing.getByRole('link', { name: 'Workspace administration', exact: true })).toHaveAttribute(
    'href',
    'https://admin.proompteng.ai/',
  )
  expect(reads.length).toBeGreaterThan(0)
  for (const read of reads) {
    expect(new URL(read).searchParams.get('view')).toBe('workspace')
    expect(new URL(read).searchParams.get('workspace')).toBeTruthy()
  }
})

for (const { outcome, repair } of [
  { outcome: 'connected', repair: false },
  { outcome: 'cancelled', repair: false },
  { outcome: 'account-mismatch', repair: false },
  { outcome: 'connected', repair: true },
] as const) {
  test(`restores provider authorization on a phone without repeating setup or prompting for passkeys: ${outcome}, repair ${repair}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockTengri(page, { preserveDraftStorageOnReload: true })
    const saves: SaveConnection[] = []
    let begins = 0
    let signIns = 0
    let accountReady = false
    let connections: Record<string, unknown>[] = repair
      ? [
          {
            id: '88888888-8888-4888-8888-888888888888',
            clientService: 'tengri-web',
            clientReference: readyAgent.uid + '/inventory',
            actions: ['inventory.items.read', 'inventory.details.read'],
            resources: [{ kind: 'inventory.account', id: 'inventory/team' }],
            binding: { service: 'tengri', id: readyAgent.uid },
            enabled: true,
            version: '1',
            credentialActive: false,
          },
        ]
      : []
    await page.route('**/api/auth/*', (route) => {
      signIns++
      return replyWithError(route, 500, 'No sign-in expected')
    })
    await mockConnectorCatalog(page, () =>
      (repair ? ['items', 'details'] : ['items']).map((name) => ({
        connectorId: 'inventory',
        name,
        action: `inventory.${name}.read`,
        description: name === 'items' ? 'Read team inventory' : 'Read detailed inventory',
        readOnly: true,
        targets: [{ name: 'Team inventory', resource: { kind: 'inventory.account', id: 'inventory/team' } }],
      })),
    )
    await page.route('**/api/platform/provider-connections', (route) => {
      if (route.request().method() === 'POST') {
        begins++
        return route.fulfill({
          json: {
            authorizationUrl: 'https://oauth.fixture.test/authorize',
            connectionId: '77777777-7777-4777-8777-777777777777',
          },
        })
      }
      return route.fulfill({
        json: {
          connections: [
            {
              profileId: 'inventory',
              name: 'Inventory',
              connectorId: 'inventory',
              connectionId: repair ? '77777777-7777-4777-8777-777777777777' : '',
              state: accountReady ? 'PROVIDER_CONNECTION_STATE_READY' : 'PROVIDER_CONNECTION_STATE_RECONNECT',
              accountName: accountReady ? 'Team' : '',
              providerScopes: ['items.read'],
            },
          ],
        },
      })
    })
    await page.route('https://oauth.fixture.test/authorize', (route) => {
      // The protocol fixture separately verifies code exchange; this exercises the actual browser return and saved UI intent.
      accountReady = true
      return route.fulfill({
        status: 302,
        headers: { location: desktopOrigin + '/?platform_connection=' + outcome + '&provider_profile=inventory' },
        body: '',
      })
    })
    await page.route('**/api/tengri/connections**', async (route) => {
      if (route.request().method() === 'POST') {
        const request = connectionRequestSchema.parse(route.request().postDataJSON())
        if (request.kind === 'save') {
          saves.push(request)
          connections = [
            {
              id: request.connectionId,
              clientService: 'tengri-web',
              clientReference: readyAgent.uid + '/inventory',
              actions: request.operations.map((name) => `inventory.${name}.read`),
              resources: request.targets,
              binding: { service: 'tengri', id: readyAgent.uid },
              enabled: true,
              version: String(BigInt(request.expectedVersion) + BigInt(1)),
              credentialActive: true,
              credentialGeneration: '5',
              recoveryGeneration: '1',
              delegationId: '33333333-3333-4333-8333-333333333333',
              proofKeyThumbprint: 'a'.repeat(43),
              credentialBinding: { service: 'tengri', id: readyAgent.uid, generation: readyAgent.runtimeEpoch },
              expiresAtUnixMs: String(Date.now() + 900_000),
            },
          ]
        }
      }
      return route.fulfill({ json: { connections, recoveryGeneration: '1' } })
    })
    await page.goto('/')
    const settings = await openSettings(page, 'Connections')
    if (repair) {
      await exactButton(settings, 'Manage').click()
      await exactButton(settings, 'Customize access').click()
      await settings.getByRole('checkbox', { name: 'Read detailed inventory', exact: true }).uncheck()
      await settings
        .getByRole('button', { name: /^(Connect account|Reconnect account|Save changes)$/ })
        .first()
        .click()
    } else {
      await exactButton(settings, 'Connect').click()
    }
    if (outcome === 'connected') {
      await expect(exactButton(settings, 'Manage')).toBeVisible()
      await expect(settings.getByText('Connected', { exact: true })).toBeVisible()
      expect(saves).toHaveLength(1)
      expect(saves[0]?.operations).toEqual(['items'])
      if (repair) {
        expect(saves[0]?.connectionId).toBe('88888888-8888-4888-8888-888888888888')
        expect(saves[0]?.expectedVersion).toBe('1')
      }
    } else {
      await expect(
        settings.getByText(
          outcome === 'cancelled'
            ? 'Connection cancelled. Your choices are saved.'
            : 'Use the account you originally connected. The selected account was not connected.',
          { exact: true },
        ),
      ).toBeVisible()
      await expect(settings.getByRole('checkbox', { name: 'Team inventory', exact: true })).toBeChecked()
      expect(saves).toHaveLength(0)
    }
    expect(begins).toBe(1)
    expect(signIns).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await settings.screenshot({ path: test.info().outputPath('provider-return-phone-' + outcome + '.png') })
  })
}

test('scopes recovery to the selected conversation and permits independent new work during another outage', async ({
  page,
}) => {
  const mock = await mockTengri(page, {
    threadStore: {
      threads: [
        savedChat('thread-unavailable', 'Unavailable task', 2),
        savedChat('thread-ready', 'Ready conversation', 1),
      ],
    },
  })
  const recoveryThreads: string[] = []
  await routeTengriAction(page, 'active-codex-runs', async (action, route) => {
    recoveryThreads.push(action.threadId || '')
    if (action.threadId === 'thread-unavailable')
      return replyWithError(route, 503, 'Selected task status is unavailable')
    return route.fallback()
  })
  await selectSavedThread(page, 'thread-unavailable')
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const sidebar = chat.getByTestId('agent-conversation-sidebar')
  const composer = chat.getByRole('textbox', { name: 'Message your agent', exact: true })
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Status unavailable')
  await composer.fill('Keep this unavailable conversation draft')
  await expect(exactButton(chat, 'Send message')).toBeDisabled()
  await sidebar.locator('[data-conversation-id="thread-ready"]').click()
  await composer.fill('Safe selected conversation draft')
  await expect(exactButton(chat, 'Send message')).toBeEnabled()
  await expect.poll(() => recoveryThreads.includes('thread-ready')).toBe(true)
  expect(recoveryThreads).not.toContain('')
  await exactButton(sidebar, 'New conversation').click()
  await composer.fill('Read the workspace in a fresh conversation')
  await exactButton(chat, 'Send message').click()
  await expect
    .poll(() => mock.calls('send-turn')[0])
    .toMatchObject({
      threadId: 'thread-1',
      text: 'Read the workspace in a fresh conversation',
    })
  expect(mock.calls('interrupt-turn')).toHaveLength(0)
})

test('keeps known Stop usable during observation loss and allows renewed Stop while cancelling', async ({ page }) => {
  const run: TengriCodexRun = codexRun('99999999-9999-4999-8999-999999999999', 'thread-recovered', {
    phase: 'running',
    turnId: 'turn-recovered',
  })
  const mock = await mockTengri(page, { durableRun: run })
  let unavailable = false
  let failedLists = 0
  let failedStatuses = 0
  await routeTengriPost(page, async (action, route) => {
    if (unavailable && ['active-codex-runs', 'codex-run'].includes(action.action)) {
      if (action.action === 'active-codex-runs') failedLists += 1
      else failedStatuses += 1
      return replyWithError(route, 503, 'Observation is temporarily unavailable')
    }
    return route.fallback()
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const stop = exactButton(chat, 'Stop response')
  await expect(stop).toBeEnabled()
  const composer = chat.getByRole('textbox', { name: /^(Message your agent|Steer the current turn)$/ })
  await composer.fill('Keep this follow-up draft while stopping.')
  const image = await pasteClipboardImage(page, composer)
  const attachment = chat.getByRole('list', { name: 'Image attachments' }).getByRole('img')
  await expect(attachment).toHaveAttribute('src', `data:image/png;base64,${image}`)
  await expect(stop).toHaveCount(0)
  unavailable = true
  await expect.poll(() => failedLists, { timeout: 10_000 }).toBeGreaterThan(0)
  await expect.poll(() => failedStatuses, { timeout: 10_000 }).toBeGreaterThan(0)
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Status unavailable')
  await expect(
    chat.getByRole('form', { name: 'Message composer' }).getByRole('button', { name: 'Stop response' }),
  ).toHaveCount(0)
  await stop.click()
  await expect.poll(() => mock.calls('interrupt-turn').length).toBe(1)
  expect(mock.calls('interrupt-turn')[0]?.runId).toBe(run.runId)
  unavailable = false
  run.state = { phase: 'cancelling', turnId: 'turn-recovered', reason: 'waiting for command cleanup receipt' }
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Stopping', { timeout: 10_000 })
  await stop.click()
  await expect.poll(() => mock.calls('interrupt-turn').length).toBe(2)
  const stops = mock.calls('interrupt-turn')
  expect(stops[1]?.operationId).not.toBe(stops[0]?.operationId)
  await expect(composer).toHaveValue('Keep this follow-up draft while stopping.')
  await expect(attachment).toHaveAttribute('src', `data:image/png;base64,${image}`)
  await emitCodexEvent(page, {
    sequence: 51,
    method: 'item/agentMessage/delta',
    threadId: run.threadId,
    turnId: 'turn-recovered',
    itemId: 'last-confirmed-update',
    text: 'Acknowledged the stop request.',
  })
  await expect(chat.getByText('Acknowledged the stop request.', { exact: true })).toBeVisible()
  expect(mock.calls('send-turn', 'steer-turn')).toHaveLength(0)
})

test('opens saved conversation file links and preserves the draft through preview and pinning', async ({ page }) => {
  const mock = await visitDesktop(page, {
    savedThread: 'thread-preview',
    resumeThreadRawJson: codexHistory([
      completedTurn('finished-turn', [
        {
          id: 'request',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Create /workspace/not-produced.md' }],
        },
        agentMessage(
          'answer',
          '[Workspace report](/workspace/README.md) and [Review change](https://github.com/proompteng/lab/pull/123)',
        ),
        {
          id: 'change',
          type: 'fileChange',
          changes: [{ path: 'src/main.ts', diff: '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new' }],
        },
      ]),
    ]),
  })
  const chat = desktopWindow(page, 'Tengri')
  const composer = chat.getByRole('textbox', { name: 'Message your agent', exact: true })
  await composer.fill('Keep the next question unsent')
  await expect(chat.getByRole('tablist', { name: 'Agent views' })).toHaveCount(0)
  await expect(chat.getByRole('link', { name: 'Review change', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/proompteng/lab/pull/123',
  )
  await exactButton(chat, 'Ran commands').first().click()
  await chat.getByRole('article', { name: 'Codex changes', exact: true }).locator('summary').click()
  await expect(chat.getByRole('article', { name: 'Codex changes', exact: true })).toContainText('+new')
  await exactButton(chat, 'Workspace report').click()
  await expect(chat.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  const preview = chat.getByRole('region', { name: 'File preview' })
  await expect(preview).toContainText('persistent')
  await exactButton(preview, 'Pin /workspace/README.md').click()
  await expect(chat.getByRole('navigation', { name: 'Pinned resources', exact: true })).toContainText('README.md')
  await chat.getByRole('tab', { name: 'README.md', exact: true }).press('Delete')
  await expect(chat.getByRole('tablist', { name: 'Agent views' })).toHaveCount(0)
  await expect(chat.getByRole('region', { name: 'Chat', exact: true })).toBeFocused()
  await expect(composer).toHaveValue('Keep the next question unsent')
  expect(mock.calls('read-file').map((action) => action.path)).toEqual(['/workspace/README.md'])
  expect(mock.calls('send-turn')).toHaveLength(0)
})

test('does not let late initial run discovery steal a directly submitted new conversation', async ({ page }) => {
  const existing: TengriCodexRun = codexRun('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'thread-existing', {
    phase: 'running',
    turnId: 'turn-existing',
  })
  const mock = await mockTengri(page, {
    threadStore: { threads: [savedChat(existing.threadId, 'Existing task', 1)] },
  })
  let releaseDiscovery = () => {}
  let releaseCreation = () => {}
  const discovery = new Promise<void>((resolve) => {
    releaseDiscovery = resolve
  })
  const creation = new Promise<void>((resolve) => {
    releaseCreation = resolve
  })
  let discovering = false
  let creating = false
  await routeTengriPost(page, async (action, route) => {
    if (action.action === 'active-codex-runs' && !action.threadId) {
      discovering = true
      await discovery
      return replyWithResult(route, [existing])
    }
    if (action.action === 'create-thread') {
      creating = true
      await creation
    }
    return route.fallback()
  })
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  try {
    await expect.poll(() => discovering).toBe(true)
    await chat.getByRole('textbox', { name: 'Message your agent', exact: true }).fill('A separate new task')
    await exactButton(chat, 'Send message').click()
    await expect.poll(() => creating).toBe(true)
    const recovered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/tengri') &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON().action === 'active-codex-runs' &&
        !response.request().postDataJSON().threadId,
    )
    releaseDiscovery()
    await (await recovered).finished()
    await afterPaint(page)
  } finally {
    releaseDiscovery()
    releaseCreation()
  }
  await expect
    .poll(() => mock.calls('send-turn')[0])
    .toMatchObject({
      threadId: 'thread-1',
      text: 'A separate new task',
    })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tengri-thread:microvm-ada'))).toBe('thread-1')
  await expect(chat.locator('[data-conversation-id="thread-1"]')).toHaveAttribute('aria-current', 'true')
  await expect(chat.locator('[data-conversation-id="thread-existing"]')).not.toHaveAttribute('aria-current', 'true')
})

test('reconciles a finished background run without coupling its failures to the selected conversation', async ({
  page,
}) => {
  const background: TengriCodexRun = codexRun('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'thread-alpha', {
    phase: 'running',
    turnId: 'turn-alpha',
  })
  const mock = await mockTengri(page, {
    durableRun: background,
    threadStore: {
      threads: [savedChat('thread-alpha', 'Alpha', 2), savedChat('thread-beta', 'Beta', 1)],
    },
  })
  let observingBackground = false
  let outcome: 'unavailable' | 'mismatched' | 'terminal' = 'unavailable'
  let failedReads = 0
  let mismatchedReads = 0
  let terminalReads = 0
  let selectedReads = 0
  const { promise: terminalResponse, resolve: releaseTerminal } = Promise.withResolvers<void>()
  await routeTengriPost(page, async (action, route) => {
    if (action.action === 'active-codex-runs' && action.threadId === 'thread-beta') selectedReads += 1
    if (!observingBackground || action.action !== 'codex-run' || action.runId !== background.runId)
      return route.fallback()
    if (outcome === 'unavailable') {
      failedReads += 1
      return replyWithError(route, 503, 'Background status is unavailable')
    }
    if (outcome === 'mismatched') {
      mismatchedReads += 1
      return replyWithResult(route, {
        ...background,
        threadId: 'thread-beta',
        state: { phase: 'succeeded', turnId: 'turn-alpha' },
      })
    }
    terminalReads += 1
    await terminalResponse
    return replyWithResult(route, background)
  })
  await selectSavedThread(page, 'thread-alpha')
  await page.goto('/')
  const chat = desktopWindow(page, 'Tengri')
  const sidebar = chat.getByTestId('agent-conversation-sidebar')
  const archiveAlpha = exactButton(sidebar, 'Archive Alpha')
  await expect(exactButton(chat, 'Stop response')).toBeEnabled()
  observingBackground = true
  await sidebar.locator('[data-conversation-id="thread-beta"]').click()
  const composer = composerInput(chat)
  await composer.fill('Read the Beta workspace')
  await expect.poll(() => failedReads).toBeGreaterThan(0)
  await expect(exactButton(chat, 'Send message')).toBeEnabled()
  await expect(chat.getByLabel('Agent status', { exact: true })).toHaveText('Ready')
  await exactButton(sidebar, 'Alpha').hover()
  await expect(archiveAlpha).toBeDisabled()
  await exactButton(chat, 'Send message').click()
  await expect
    .poll(() => mock.calls('send-turn')[0])
    .toMatchObject({
      threadId: 'thread-beta',
      text: 'Read the Beta workspace',
    })
  await expect(exactButton(chat, 'Stop response')).toBeEnabled()
  await composer.fill('Keep the selected conversation draft')
  const mismatchedResponse = page.waitForResponse(
    async (response) =>
      response.status() === 200 &&
      response.url().endsWith('/api/tengri') &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON().action === 'codex-run' &&
      response.request().postDataJSON().runId === background.runId &&
      (await response.json()).result?.threadId === 'thread-beta',
  )
  outcome = 'mismatched'
  await expect.poll(() => mismatchedReads).toBe(1)
  await (await mismatchedResponse).finished()
  await afterPaint(page)
  await expect(archiveAlpha).toBeDisabled()
  await expect(exactButton(chat, 'Steer turn')).toBeEnabled()
  try {
    background.state = { phase: 'succeeded', turnId: 'turn-alpha' }
    outcome = 'terminal'
    await emitCodexEvent(page, {
      sequence: 70,
      kind: 'thread-state',
      method: 'turn/completed',
      threadId: 'thread-alpha',
      turnId: 'turn-alpha',
    })
    await expect.poll(() => terminalReads).toBe(1)
    const readsBefore = selectedReads
    await expect.poll(() => selectedReads).toBeGreaterThan(readsBefore + 1)
    expect(terminalReads).toBe(1)
    await expect(archiveAlpha).toBeDisabled()
    await expect(exactButton(chat, 'Steer turn')).toBeEnabled()
  } finally {
    releaseTerminal()
  }
  await expect(archiveAlpha).toBeEnabled()
  await expect(sidebar.locator('[data-conversation-id="thread-beta"]')).toHaveAttribute('aria-current', 'true')
  await expect(composer).toHaveValue('Keep the selected conversation draft')
  await expect(chat.getByRole('alert')).toHaveCount(0)
  expect(mock.calls('interrupt-turn')).toHaveLength(0)
})

test('AgentRun card refreshes and retains an uncertain cancellation on a narrow screen', async ({ page }) => {
  const width = 390
  await page.setViewportSize({ width, height: 900 })
  const view = {
    kind: 'agent-run',
    targetId: 'agents/lab',
    run: { runId: '77777777-7777-4777-8777-777777777777', status: 'Pending' },
  }
  await mockTengri(page, {
    resumeThreadRawJson: codexHistory([
      completedTurn('turn-1', [
        {
          id: 'relay-start',
          type: 'mcpToolCall',
          server: 'relay',
          tool: 'start_run',
          status: 'completed',
          result: { content: [{ type: 'text', text: JSON.stringify({ structuredContent: view }) }] },
        },
      ]),
    ]),
  })
  await selectSavedThread(page, 'thread-1')
  const commands: string[] = []
  await page.route('**/api/tengri/runs', async (route) => {
    const command = route.request().postDataJSON()
    commands.push(command.operation)
    if (command.operation === 'cancel_run') return replyWithError(route, 503, 'Lost reply')
    return route.fulfill({
      json: {
        view: {
          ...view,
          run: {
            ...view.run,
            status: 'Running',
            progress: { activeTools: [{ title: 'Checking the requested change' }] },
          },
        },
        canCancel: true,
      },
    })
  })
  await page.goto('/')
  const card = page.locator('[aria-label="Agent run"]')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Refresh run' }).click()
  await expect(card.getByRole('status')).toHaveText('Running')
  await expect(card.getByText('Checking the requested change')).toBeVisible()
  await card.getByRole('button', { name: 'Cancel run' }).click()
  await expect(card.getByRole('alert')).toContainText('Cancellation could not be confirmed')
  await expect(card.getByRole('button', { name: 'Cancel run' })).toBeDisabled()
  await card.getByRole('button', { name: 'Refresh run' }).click()
  expect(commands).toEqual(['get_result', 'cancel_run', 'get_result'])
  const bounds = await card.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
  if (process.env.TENGRI_RUN_CARD_SCREENSHOTS)
    await card.screenshot({ path: `${process.env.TENGRI_RUN_CARD_SCREENSHOTS}/run-card-${width}.png` })
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Agent run"]').analyze()
  expect(accessibility.violations).toEqual([])
})
