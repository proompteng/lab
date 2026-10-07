import { expect, test, type WebSocket } from '@playwright/test'
import { codexModelFixtures } from './codex-models.fixture'

test.afterEach(async ({ request }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || process.env.TENGRI_EDITOR_BROWSER_FIXTURE !== '1') return
  const response = await request
    .post('http://127.0.0.1:8080/_test/computer', { data: { action: 'screenshot' } })
    .catch(() => null)
  if (!response?.ok()) return
  const value = await response.json()
  const image = value.result?.content?.find((block: { type: string }) => block.type === 'image')
  if (image)
    await testInfo.attach('guest-display-on-failure', {
      body: Buffer.from(image.data, 'base64'),
      contentType: 'image/png',
    })
})

test('shares a real persistent Chromium browser between the desktop and CUA @browser', async ({
  page,
  request,
  context,
}, testInfo) => {
  test.skip(process.env.TENGRI_EDITOR_BROWSER_FIXTURE !== '1', 'Run the real guest browser acceptance runner')
  test.setTimeout(240_000)
  const sockets: WebSocket[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('websocket', (socket) => {
    if (socket.url().includes('/websockify')) sockets.push(socket)
  })
  await page.route('**/api/tengri', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          authenticated: true,
          authConfigured: true,
          controlPlaneConfigured: true,
          previewGatewayOrigin: 'https://gateway.tengri.localhost:3443',
          user: { id: 'browser-test-owner', name: 'Browser test', email: 'browser@example.test', image: null },
          agents: [
            {
              id: 'editor-fixture',
              displayName: 'Tengri',
              phase: 'ready',
              architecture: 'amd64',
              cpuMillis: 4000,
              memoryMib: 8192,
              workspaceGib: 16,
              power: { idleTimeoutMinutes: 60 },
              createdAt: '2026-09-08T00:00:00Z',
              conditions: [],
            },
          ],
        },
      })
      return
    }
    const action = route.request().postDataJSON()
    let result: unknown = null
    if (action.action === 'browser-session') {
      const response = await request.get('http://127.0.0.1:33082/_test/browser', { timeout: 300_000 })
      expect(response.ok()).toBeTruthy()
      result = await response.json()
    } else if (action.action === 'revoke-preview-session') {
      const response = await request.post('http://127.0.0.1:33082/_test/revoke', { data: action })
      expect(response.ok()).toBeTruthy()
    } else if (action.action === 'list-files') result = { path: action.path, entries: [] }
    else if (action.action === 'codex-account')
      result = { authenticated: true, email: 'browser@example.test', plan: 'pro' }
    else if (action.action === 'codex-login-status') result = { active: false }
    else if (action.action === 'list-terminals') result = { sessions: [] }
    else if (action.action === 'codex-models') result = { models: codexModelFixtures, nextCursor: null }
    else if (action.action === 'list-conversations') result = { threads: [] }
    await route.fulfill({ json: { result } })
  })
  await page.route('**/api/tengri/**/events**', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }),
  )
  const state = async () => {
    const response = await request.get('http://127.0.0.1:8080/_test/browser-state')
    expect(response.ok()).toBeTruthy()
    return response.json()
  }
  const computer = async (arguments_: Record<string, unknown>) => {
    const response = await request.post('http://127.0.0.1:8080/_test/computer', { data: arguments_, timeout: 300_000 })
    expect(response.ok()).toBeTruthy()
    const value = await response.json()
    expect(value.error).toBeUndefined()
    return value.result
  }
  await page.goto('/')
  const agent = page.getByRole('region', { name: 'Tengri window', exact: true })
  await expect(agent.getByRole('textbox', { name: 'Message your agent' })).toBeVisible()
  await page.getByRole('button', { name: 'Open Chrome', exact: true }).click()
  const chrome = page.getByRole('region', { name: 'Chrome window', exact: true })
  const frame = chrome.getByTitle('Chrome browser').contentFrame()
  const canvas = frame.locator('canvas')
  await expect(frame.locator('#screen')).toHaveAttribute('data-connected', 'true', { timeout: 180_000 })
  const returnControl = frame.getByRole('button', { name: 'Let agent use browser', exact: true })
  if (await returnControl.isVisible()) {
    await returnControl.click()
    await expect(frame.getByRole('button', { name: 'Take control', exact: true })).toBeVisible()
  }
  await expect(chrome.getByText('Starting Chrome…')).not.toBeVisible()
  await expect(chrome.getByRole('textbox', { name: 'Message your agent' })).toHaveCount(0)
  await canvas.click({ position: { x: 350, y: 60 } })
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${modifier}+a`)
  await page.keyboard.type('http://127.0.0.1:8080/_test/site?human=1')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state()).loaded?.url).toContain('?human=1')
  await expect.poll(async () => (await state()).loaded?.userAgent).toContain('Chrome/')
  await page.keyboard.type('Human input works')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state()).submitted?.message).toBe('Human input works')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => navigator.clipboard.writeText('Clipboard input works'))
  await page.keyboard.press(`${modifier}+a`)
  await page.keyboard.press(`${modifier}+v`)
  await expect.poll(async () => (await state()).input?.message).toBe('Clipboard input works')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state()).submitted?.message).toBe('Clipboard input works')
  await page.keyboard.press(`${modifier}+a`)
  await page.keyboard.press(`${modifier}+c`)
  await frame.getByRole('button', { name: 'Copy selected text', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Clipboard input works')
  const screenshot = await computer({ action: 'screenshot' })
  expect(screenshot.isError, screenshot.isError ? JSON.stringify(screenshot.content) : undefined).not.toBe(true)
  expect(screenshot.structuredContent.width).toBeGreaterThan(500)
  expect(screenshot.structuredContent.height).toBeGreaterThan(300)
  const image = screenshot.content.find((block: { type: string }) => block.type === 'image')
  expect(image.mimeType).toBe('image/png')
  const bytes = Buffer.from(image.data, 'base64')
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  await testInfo.attach('agent-sees-shared-chromium', { body: bytes, contentType: 'image/png' })
  await computer({ action: 'navigate', url: 'http://127.0.0.1:8080/_test/site?agent=1' })
  await expect.poll(async () => (await state()).loaded?.url).toContain('?agent=1')
  expect((await state()).loaded.previousCookie).toContain('browser-proof=persistent')
  expect((await state()).loaded.previousStorage).toBe('persistent')
  await computer({ action: 'click', x: 150, y: 260 })
  await computer({ action: 'type', text: 'Agent CUA input works' })
  await computer({ action: 'key', key: 'Return' })
  await expect.poll(async () => (await state()).submitted?.message).toBe('Agent CUA input works')
  await page.screenshot({ path: testInfo.outputPath('human-and-agent-shared-chromium.png') })

  await computer({ action: 'key', key: 'ctrl+t' })
  await computer({ action: 'navigate', url: 'http://127.0.0.1:8080/_test/site?tab=1' })
  await expect.poll(async () => (await state()).loaded?.url).toContain('?tab=1')
  await computer({ action: 'navigate', url: 'http://127.0.0.1:8080/_test/site?second=1' })
  await expect.poll(async () => (await state()).loaded?.url).toContain('?second=1')
  await computer({ action: 'key', key: 'alt+Left' })
  await expect.poll(async () => (await state()).loaded?.url).toContain('?tab=1')
  await computer({ action: 'key', key: 'alt+Right' })
  await expect.poll(async () => (await state()).loaded?.url).toContain('?second=1')
  await computer({ action: 'key', key: 'ctrl+w' })
  await computer({ action: 'navigate', url: 'http://127.0.0.1:8080/_test/download' })
  await expect.poll(async () => (await state()).download).toBe('CHROMIUM_DOWNLOAD_OK\n')

  await frame.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(frame.getByRole('button', { name: 'Let agent use browser', exact: true })).toBeVisible()
  expect((await computer({ action: 'status' })).structuredContent.userControl).toBe(true)
  expect((await computer({ action: 'screenshot' })).isError).toBe(true)
  expect((await computer({ action: 'type', text: 'must not type' })).isError).toBe(true)
  await frame.getByRole('button', { name: 'Let agent use browser', exact: true }).click()
  await expect(frame.getByRole('button', { name: 'Take control', exact: true })).toBeVisible()
  expect((await computer({ action: 'status' })).structuredContent.userControl).toBe(false)
  expect((await computer({ action: 'screenshot' })).isError).not.toBe(true)
  await chrome.getByRole('button', { name: 'Close Chrome', exact: true }).click()
  await expect(chrome).toHaveCount(0)
  await expect.poll(() => sockets.length > 0 && sockets.every((socket) => socket.isClosed())).toBe(true)
  await page.getByRole('button', { name: 'Open Chrome', exact: true }).click()
  await expect(frame.locator('#screen')).toHaveAttribute('data-connected', 'true')
  await computer({ action: 'navigate', url: 'http://127.0.0.1:8080/_test/site?reopened=1' })
  await expect.poll(async () => (await state()).loaded?.url).toContain('?reopened=1')
  expect((await state()).loaded.previousCookie).toContain('browser-proof=persistent')
  expect((await state()).loaded.previousStorage).toBe('persistent')
  await page.screenshot({ path: testInfo.outputPath('separate-tengri-and-chrome.png') })
  expect(errors).toEqual([])
})
