import { expect, test, type WebSocket as PlaywrightWebSocket } from '@playwright/test'
import { readFile, writeFile, rm, readdir } from 'node:fs/promises'

test.use({ actionTimeout: 15_000 })
const diagnostics: string[] = []
test.afterEach(async ({ page }, testInfo) => {
  await testInfo.attach('upstream-console', { body: diagnostics.join('\n'), contentType: 'text/plain' })
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('workbench-frames', {
      body: JSON.stringify(page.frames().map((frame) => ({ url: frame.url(), name: frame.name() }))),
      contentType: 'application/json',
    })
  }
})

test('runs the upstream VS Code workbench against real guest files and terminals @vscode', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    process.env.TENGRI_EDITOR_BROWSER_FIXTURE !== '1',
    'Run the VS Code acceptance runner with its real guest and gateway',
  )
  test.setTimeout(180_000)
  const home = process.env.TENGRI_EDITOR_TEST_HOME
  if (!home) throw new Error('TENGRI_EDITOR_TEST_HOME is required')
  await rm(`${home}/workspace/from-terminal.txt`, { force: true })
  await writeFile(`${home}/workspace/hello.ts`, 'export const answer = 41\n')
  await writeFile(
    `${home}/workspace/README.md`,
    '# Real VS Code preview\n\nRendered by the upstream Markdown extension.\n',
  )
  const agent = {
    id: 'editor-fixture',
    displayName: 'Tengri',
    phase: 'ready',
    architecture: 'amd64',
    cpuMillis: 2000,
    memoryMib: 4096,
    workspaceGib: 16,
    nodeName: 'local',
    createdAt: '2026-09-08T00:00:00Z',
    conditions: [],
  }
  let authenticated = true
  let failRevocation = true
  let editorOrigin = ''
  const signOutActions: string[] = []
  const editorSockets: PlaywrightWebSocket[] = []
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).hostname.startsWith('tengri-')) editorSockets.push(socket)
  })
  await page.route('**/api/auth/sign-out', async (route) => {
    signOutActions.push('sign-out')
    await expect.poll(() => editorSockets.every((socket) => socket.isClosed())).toBe(true)
    authenticated = false
    await route.fulfill({ json: { success: true } })
  })
  await page.route('**/api/tengri', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          authConfigured: true,
          controlPlaneConfigured: true,
          previewGatewayOrigin:
            process.env.TENGRI_EDITOR_TEST_HTTPS === '1'
              ? 'https://gateway.tengri.localhost:3443'
              : 'http://localhost:33082',
          authenticated,
          user: authenticated
            ? { id: 'editor-test-owner', name: 'Local editor test', email: 'editor@example.test', image: null }
            : null,
          agents: authenticated ? [agent] : [],
        },
      })
      return
    }
    if (!authenticated) {
      await route.fulfill({ status: 401, json: { error: 'Authentication is required' } })
      return
    }
    const action = route.request().postDataJSON()
    let result: unknown = null
    if (action.action === 'editor-session') {
      const response = await request.get(
        `http://127.0.0.1:33082/_test/editor?window=${encodeURIComponent(action.windowId)}`,
        { timeout: 120_000 },
      )
      expect(response.ok()).toBeTruthy()
      result = await response.json()
      editorOrigin = (result as { previewOrigin: string }).previewOrigin
    } else if (action.action === 'revoke-editor-sessions') {
      signOutActions.push('revoke-editors')
      if (failRevocation) {
        await route.fulfill({ status: 503, json: { error: 'Editor sessions could not be revoked' } })
        return
      }
      const response = await request.post('http://127.0.0.1:33082/_test/revoke-editors')
      expect(response.ok()).toBeTruthy()
    } else if (action.action === 'revoke-preview-session') {
      await request.post('http://127.0.0.1:33082/_test/revoke', { data: action })
    } else if (action.action === 'list-files') {
      const response = await request.get(`http://127.0.0.1:8080/v1/files?path=${encodeURIComponent(action.path)}`, {
        headers: { Authorization: 'Bearer editor-browser-fixture' },
      })
      result = await response.json()
    } else if (action.action === 'codex-account') result = { authenticated: false, email: '', plan: '' }
    else if (action.action === 'codex-login-status') result = { active: false }
    else if (action.action === 'list-terminals') result = { sessions: [] }
    await route.fulfill({ json: { result } })
  })
  await page.route('**/api/tengri/**/events**', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }),
  )
  const errors: string[] = []
  diagnostics.length = 0
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(message.text())
  })
  page.on('requestfailed', (failed) => diagnostics.push(`${failed.url()}: ${failed.failure()?.errorText}`))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open Code', exact: true }).click()
  const code = page.getByRole('region', { name: 'Code window', exact: true })
  const workbench = code.getByTitle('VS Code workbench').contentFrame()
  await expect(workbench.locator('.monaco-workbench')).toBeVisible({ timeout: 25_000 })
  await expect(code.getByText('Connecting to VS Code…')).not.toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: testInfo.outputPath('real-vscode-workbench.png') })
  await workbench.getByRole('treeitem', { name: /hello.ts/ }).dblclick()
  await expect(workbench.getByRole('tab', { name: /hello.ts/ })).toBeVisible()
  await workbench.locator('.monaco-editor .view-lines').first().click()
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${modifier}+a`)
  await page.keyboard.type('export const answer = 42\n')
  await page.keyboard.press(`${modifier}+s`)
  await expect.poll(() => readFile(`${home}/workspace/hello.ts`, 'utf8')).toBe('export const answer = 42\n')
  await page.keyboard.press('F1')
  await workbench.getByRole('textbox').filter({ visible: true }).last().fill('>Terminal: Create New Terminal')
  await page.keyboard.press('Enter')
  const trust = workbench.getByRole('button', { name: 'Trust Folder & Continue' })
  const runningTerminal = workbench.getByRole('textbox', { name: /^Terminal [0-9]+, (bash|zsh)/ })
  await expect(trust.or(runningTerminal)).toBeVisible()
  if (await trust.isVisible()) await trust.click()
  await expect(workbench.getByRole('textbox', { name: /^Terminal [0-9]/ })).toBeVisible()
  const terminal = workbench.getByRole('textbox', { name: /^Terminal [0-9]/ })
  await expect(trust).not.toBeVisible()
  await expect(runningTerminal).toBeVisible()
  await terminal.focus()
  await terminal.pressSequentially("printf 'VSCODE_TERMINAL_OK' > from-terminal.txt", { delay: 30 })
  await page.keyboard.press('Enter')
  await expect
    .poll(() => readFile(`${home}/workspace/from-terminal.txt`, 'utf8').catch(() => ''))
    .toBe('VSCODE_TERMINAL_OK')
  await workbench.getByRole('tab', { name: /hello.ts/ }).click()
  await workbench.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press(`${modifier}+a`)
  await page.keyboard.type('export const answer: string = 42\n')
  await expect(workbench.locator('.squiggly-error').first()).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press(`${modifier}+a`)
  await page.keyboard.type('export const answer = 43\n')
  await code.getByRole('button', { name: 'Close Code', exact: true }).click()
  const saveDialog = workbench.getByRole('dialog')
  await expect(saveDialog.getByText(/Do you want to save/)).toBeVisible()
  await saveDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(code).toBeVisible()
  expect(await readFile(`${home}/workspace/hello.ts`, 'utf8')).toBe('export const answer = 42\n')
  const origin = new URL(
    page
      .frames()
      .find((frame) => frame.url().includes('tengri-'))!
      .url(),
  ).origin
  const backups = `${home}/.tengri/vscode/data/User/Backups`
  await expect
    .poll(async () => {
      const paths = await readdir(backups, { recursive: true }).catch(() => [])
      for (const path of paths) {
        if ((await readFile(`${backups}/${path}`, 'utf8').catch(() => '')).includes('export const answer = 43'))
          return true
      }
      return false
    })
    .toBe(true)
  page.on('dialog', (dialog) => dialog.accept())
  await page.reload()
  await expect(workbench.locator('.monaco-workbench')).toBeVisible({ timeout: 30_000 })
  await expect(code.getByText('Connecting to VS Code…')).not.toBeVisible({ timeout: 30_000 })
  expect(
    new URL(
      page
        .frames()
        .find((frame) => frame.url().includes('tengri-'))!
        .url(),
    ).origin,
  ).toBe(origin)
  await expect(workbench.locator('.monaco-editor .view-lines').first()).toContainText('43')
  await code.getByRole('button', { name: 'Close Code', exact: true }).click()
  await saveDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(code).toHaveCount(0)
  expect(await readFile(`${home}/workspace/hello.ts`, 'utf8')).toBe('export const answer = 43\n')
  await page.getByRole('button', { name: 'Open Finder', exact: true }).click()
  const finder = page.getByRole('region', { name: 'Finder window', exact: true })
  await finder.getByRole('button', { name: /README\.md/ }).click()
  await finder.getByRole('button', { name: 'Finder actions' }).click()
  await page.getByRole('menuitem', { name: 'Open in Code', exact: true }).click()
  await expect(workbench.getByRole('tab', { name: /README.md/ })).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press('F1')
  await workbench.getByRole('textbox').filter({ visible: true }).last().fill('>Markdown: Open Preview to the Side')
  await page.keyboard.press('Enter')
  const webview = workbench.locator('iframe.webview')
  await expect(webview).toBeVisible()
  const activePreview = webview.contentFrame().locator('#active-frame')
  await expect(activePreview).toBeVisible({ timeout: 30_000 })
  await expect(activePreview).toHaveCSS('visibility', 'visible')
  await expect(
    activePreview.contentFrame().getByRole('heading', { name: 'Real VS Code preview', exact: true }),
  ).toBeVisible()
  await activePreview
    .contentFrame()
    .locator('body')
    .screenshot({ path: testInfo.outputPath('markdown-content.png') })
  await page.screenshot({ path: testInfo.outputPath('real-vscode-markdown.png') })
  await workbench.getByRole('tab', { name: /^Extensions \(/ }).click()
  await expect(workbench.getByRole('listitem', { name: /^Tengri Desktop Integration,/ })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('real-vscode-extensions.png') })
  const probeEditor = () => page.context().request.get(editorOrigin, { ignoreHTTPSErrors: true })
  expect((await probeEditor()).ok()).toBe(true)
  expect(editorSockets.some((socket) => !socket.isClosed())).toBe(true)
  await page.getByRole('menuitem', { name: 'Tengri menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Sign Out', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Editor sessions could not be revoked' })).toBeVisible()
  expect(signOutActions).toEqual(['revoke-editors'])
  expect(authenticated).toBe(true)
  expect((await probeEditor()).ok()).toBe(true)
  failRevocation = false
  await page.getByRole('menuitem', { name: 'Tengri menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Sign Out', exact: true }).click()
  await expect(code).toHaveCount(0)
  expect(signOutActions).toEqual(['revoke-editors', 'revoke-editors', 'sign-out'])
  expect(authenticated).toBe(false)
  expect((await probeEditor()).status()).toBe(401)
  expect(errors).toEqual([])
})
