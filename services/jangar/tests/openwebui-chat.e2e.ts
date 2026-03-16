import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { expect, test } from '@playwright/test'

const execFileAsync = promisify(execFile)
const testDir = dirname(fileURLToPath(import.meta.url))
const serviceDir = resolve(testDir, '..')
const composeFile = resolve(serviceDir, 'docker-compose.yml')
const outputDir = resolve(serviceDir, 'output', 'playwright')
const shouldRun = process.env.PLAYWRIGHT_OPENWEBUI_E2E === '1'
const playwrightPort = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? process.env.JANGAR_PORT ?? '3000', 10)
const openwebuiPort = Number.parseInt(process.env.OPENWEBUI_PORT ?? '38080', 10)
const composeProject = process.env.OPENWEBUI_E2E_COMPOSE_PROJECT ?? `jangar-openwebui-e2e-${process.pid}`
const openwebuiBaseUrl = process.env.OPENWEBUI_BASE_URL ?? `http://127.0.0.1:${openwebuiPort}`
const jangarChatCompletionsUrl = `http://127.0.0.1:${playwrightPort}/openai/v1/chat/completions`
const startupTimeoutMs = Number.parseInt(process.env.OPENWEBUI_E2E_STARTUP_TIMEOUT_MS ?? '300000', 10)
const useExistingStack = process.env.OPENWEBUI_E2E_USE_EXISTING_STACK === '1'
const useMockCodex = process.env.OPENWEBUI_E2E_USE_MOCK_CODEX === '1' || process.env.JANGAR_MOCK_CODEX === '1'
const openWebUiModel = process.env.OPENWEBUI_E2E_MODEL ?? process.env.JANGAR_DEFAULT_MODEL ?? 'gpt-5.4'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

const composeEnv = {
  ...process.env,
  OPENWEBUI_PORT: String(openwebuiPort),
  OPENWEBUI_POSTGRES_CONTAINER_NAME: `${composeProject}-postgres`,
  OPENWEBUI_CONTAINER_NAME: `${composeProject}-openwebui`,
  JANGAR_OPENAI_BASE_URL:
    process.env.JANGAR_OPENAI_BASE_URL ?? `http://host.docker.internal:${playwrightPort}/openai/v1`,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'stub-key',
  OPENWEBUI_DEFAULT_MODEL: process.env.OPENWEBUI_DEFAULT_MODEL ?? openWebUiModel,
}

const runDockerCompose = async (...args: string[]) => {
  await execFileAsync('docker', ['compose', '-p', composeProject, '-f', composeFile, ...args], {
    cwd: serviceDir,
    env: composeEnv,
    maxBuffer: 1024 * 1024 * 20,
  })
}

const waitForHttpOk = async (url: string, timeoutMs = 120_000) => {
  const startedAt = Date.now()
  let lastError = 'not started'
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `status ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`)
}

const getComposer = (page: import('@playwright/test').Page) => page.locator('textarea, [contenteditable="true"]').last()

const dismissBlockingModal = async (page: import('@playwright/test').Page) => {
  const dialog = page.getByRole('dialog').last()
  const dialogVisible = await dialog.waitFor({ state: 'visible', timeout: 5_000 }).then(
    () => true,
    () => false,
  )
  if (!dialogVisible) return

  const continueButton = dialog.getByRole('button', { name: /okay, let's go!/i })
  if (await continueButton.isVisible().catch(() => false)) {
    await continueButton.click({ force: true })
    await expect(dialog).not.toBeVisible({ timeout: 30_000 })
    return
  }

  const closeButton = dialog.getByRole('button', { name: /^close$/i }).last()
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click({ force: true })
    await expect(dialog).not.toBeVisible({ timeout: 30_000 })
    return
  }

  await page.keyboard.press('Escape').catch(() => undefined)
  await expect(dialog).not.toBeVisible({ timeout: 30_000 })
}

const dismissUpdateBanner = async (page: import('@playwright/test').Page) => {
  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter((element) => {
      const text = element.textContent?.trim() ?? ''
      return text.includes('A new version') && text.includes('now available')
    })

    for (const candidate of candidates) {
      const container =
        candidate.closest<HTMLElement>('[data-sonner-toast], [role="alert"], [role="status"]') ??
        candidate.parentElement
      if (!container) continue
      const closeButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => !button.disabled && button.offsetParent !== null,
      )
      if (closeButton) {
        closeButton.click()
        continue
      }
      container.remove()
    }
  })
}

const ensureModelSelected = async (page: import('@playwright/test').Page) => {
  await dismissBlockingModal(page)
  const composer = getComposer(page)
  if (await composer.isVisible().catch(() => false)) return

  const selectModelButton = page.getByRole('button', { name: /select a model/i }).first()
  if (!(await selectModelButton.isVisible().catch(() => false))) return

  await selectModelButton.click()

  const modelSearch = page.getByRole('textbox', { name: /search in models/i })
  if (await modelSearch.isVisible().catch(() => false)) {
    await modelSearch.fill(openWebUiModel)
  }

  const modelOption = page.getByText(openWebUiModel, { exact: true }).last()
  await expect(modelOption).toBeVisible({ timeout: 30_000 })
  await modelOption.click()
}

const composerHasText = async (composer: ReturnType<typeof getComposer>) =>
  composer.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value.trim().length > 0
    }
    return (element.textContent ?? '').trim().length > 0
  })

const waitForComposerToClear = async (
  page: import('@playwright/test').Page,
  composer: ReturnType<typeof getComposer>,
) => {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (!(await composerHasText(composer))) return true
    await page.waitForTimeout(100)
  }
  return !(await composerHasText(composer))
}

const clickComposerSendButton = async (composer: ReturnType<typeof getComposer>) =>
  composer.evaluate((element) => {
    const searchRoots = [element.closest('form'), element.parentElement, element.parentElement?.parentElement].filter(
      (value): value is HTMLElement => value instanceof HTMLElement,
    )

    for (const root of searchRoots) {
      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter(
        (button) => !button.disabled && button.offsetParent !== null,
      )
      const submitButton = buttons.at(-1)
      if (submitButton) {
        submitButton.click()
        return true
      }
    }

    return false
  })

const sendOpenWebUiMessage = async (page: import('@playwright/test').Page, message: string) => {
  await dismissBlockingModal(page)
  await dismissUpdateBanner(page)
  await ensureModelSelected(page)
  const composer = getComposer(page)
  await expect(composer).toBeVisible({ timeout: 60_000 })
  await composer.focus()

  const isRichTextComposer = await composer.evaluate((element) => element.getAttribute('contenteditable') === 'true')
  if (isRichTextComposer) {
    await page.keyboard.type(message)
  } else {
    await composer.fill(message)
  }

  const submitAttempts: Array<() => Promise<boolean>> = [
    async () => {
      await page.keyboard.press('Enter')
      return waitForComposerToClear(page, composer)
    },
    async () => {
      await page.keyboard.press('Meta+Enter').catch(() => undefined)
      return waitForComposerToClear(page, composer)
    },
    async () => {
      await page.keyboard.press('Control+Enter').catch(() => undefined)
      return waitForComposerToClear(page, composer)
    },
    async () => {
      const clicked = await clickComposerSendButton(composer)
      if (!clicked) return false
      return waitForComposerToClear(page, composer)
    },
  ]

  for (const submit of submitAttempts) {
    if (await submit()) return
    await dismissUpdateBanner(page)
  }

  throw new Error(`OpenWebUI did not submit the composer message '${message}'`)
}

const extractRenderLinksFromText = (content: string): RenderLink[] => {
  const links = new Map<string, RenderLink>()
  const pattern =
    /(Open full transcript|Open full diff|Open full result|Open image preview|Open detail):\s*<?(https?:\/\/[^\s>]+\/api\/openwebui\/rich-ui\/render\/[^\s>]+)>?/g

  for (const match of content.matchAll(pattern)) {
    const text = match[1]?.trim() ?? ''
    const href = match[2]?.trim() ?? ''
    if (text.length > 0 && href.length > 0) {
      links.set(href, { text, href })
    }
  }

  return Array.from(links.values())
}

const readStreamingAssistantTurn = async (response: Response) => {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('chat completions response did not include a readable body')
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let assistantReply = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue

      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') {
        return { assistantReply, renderLinks: extractRenderLinksFromText(assistantReply) }
      }

      const frame = JSON.parse(payload) as {
        error?: { message?: string; code?: string }
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
      }

      if (frame.error) {
        throw new Error(
          `chat completions returned ${frame.error.code ?? 'unknown_error'}: ${frame.error.message ?? 'unknown error'}`,
        )
      }

      for (const choice of frame.choices ?? []) {
        if (typeof choice.delta?.content === 'string') {
          assistantReply += choice.delta.content
          continue
        }
        if (typeof choice.message?.content === 'string') {
          assistantReply += choice.message.content
        }
      }
    }
  }

  return { assistantReply, renderLinks: extractRenderLinksFromText(assistantReply) }
}

const readStreamingAssistantReply = async (response: Response) =>
  (await readStreamingAssistantTurn(response)).assistantReply

const runChatCompletionTurn = async (chatId: string, messages: ChatMessage[]) => {
  const response = await fetch(jangarChatCompletionsUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openwebui-chat-id': chatId,
    },
    body: JSON.stringify({
      model: openWebUiModel,
      stream: true,
      stream_options: {
        include_usage: true,
      },
      messages,
    }),
  })

  if (!response.ok) {
    throw new Error(`chat completions returned ${response.status}: ${await response.text()}`)
  }

  return readStreamingAssistantReply(response)
}

const runChatCompletionTurnWithRenderLinks = async (chatId: string, messages: ChatMessage[]) => {
  const response = await fetch(jangarChatCompletionsUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openwebui-chat-id': chatId,
    },
    body: JSON.stringify({
      model: openWebUiModel,
      stream: true,
      stream_options: {
        include_usage: true,
      },
      messages,
    }),
  })

  if (!response.ok) {
    throw new Error(`chat completions returned ${response.status}: ${await response.text()}`)
  }

  return readStreamingAssistantTurn(response)
}

const expectAssistantReply = async (page: import('@playwright/test').Page, expected: string) => {
  const response = page.getByText(expected).last()
  const abortError = page.getByText(/request was aborted by the client/i).last()
  const deadline = Date.now() + 180_000

  while (Date.now() < deadline) {
    if (await abortError.isVisible().catch(() => false)) {
      throw new Error(`OpenWebUI surfaced a client abort while waiting for '${expected}'`)
    }
    if (await response.isVisible().catch(() => false)) {
      return
    }
    await page.waitForTimeout(250)
  }

  await expect(response).toBeVisible({ timeout: 1_000 })
}

type RenderLink = {
  text: string
  href: string
}

const collectRenderLinks = async (page: import('@playwright/test').Page): Promise<RenderLink[]> =>
  page.evaluate(() => {
    const renderLinks = new Map<string, { text: string; href: string }>()

    for (const anchor of Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/api/openwebui/rich-ui/render/"]'),
    )) {
      const text = anchor.textContent?.trim() ?? ''
      const href = anchor.href ?? ''
      if (text.length > 0 && href.length > 0) {
        renderLinks.set(href, { text, href })
      }
    }

    const bodyText = document.body.innerText ?? ''
    const textPattern =
      /(Open full transcript|Open full diff|Open full result|Open image preview|Open detail):\s*<?(https?:\/\/[^\s>]+\/api\/openwebui\/rich-ui\/render\/[^\s>]+)>?/g

    for (const match of bodyText.matchAll(textPattern)) {
      const text = match[1]?.trim() ?? ''
      const href = match[2]?.trim() ?? ''
      if (text.length > 0 && href.length > 0) {
        renderLinks.set(href, { text, href })
      }
    }

    return Array.from(renderLinks.values())
  })

const conversationViewportPositions = [0, 0.2, 0.4, 0.6, 0.8, 1]

const scrollConversation = async (page: import('@playwright/test').Page, position: number) => {
  await page.locator('[role="log"]').evaluate((element, nextPosition) => {
    const scrollable = element instanceof HTMLElement ? element : element.parentElement
    if (!scrollable) return
    const maxScrollTop = Math.max(0, scrollable.scrollHeight - scrollable.clientHeight)
    scrollable.scrollTop = Math.round(maxScrollTop * nextPosition)
  }, position)
  await page.waitForTimeout(250)
}

const collectRenderLinksAcrossViewport = async (page: import('@playwright/test').Page): Promise<RenderLink[]> => {
  const links = new Map<string, RenderLink>()
  for (const position of conversationViewportPositions) {
    await scrollConversation(page, position)
    for (const link of await collectRenderLinks(page)) {
      links.set(link.href, link)
    }
  }
  return Array.from(links.values())
}

const expectVisibleWhileScrolling = async (page: import('@playwright/test').Page, expected: string) => {
  for (const position of conversationViewportPositions) {
    await scrollConversation(page, position)
    const locator = page.getByText(expected).last()
    if (await locator.isVisible().catch(() => false)) return
  }

  await expect(page.getByText(expected).last()).toBeVisible({ timeout: 1_000 })
}

const waitForRenderLinks = async (page: import('@playwright/test').Page, minimumCount: number) => {
  await expect
    .poll(async () => (await collectRenderLinksAcrossViewport(page)).length, {
      timeout: 180_000,
      message: `Expected at least ${minimumCount} OpenWebUI render links to appear`,
    })
    .toBeGreaterThanOrEqual(minimumCount)

  return collectRenderLinksAcrossViewport(page)
}

test.describe.serial('OpenWebUI chat end-to-end', () => {
  test.skip(!shouldRun, 'Set PLAYWRIGHT_OPENWEBUI_E2E=1 to run the local OpenWebUI browser regression.')

  test.beforeAll(async () => {
    test.setTimeout(startupTimeoutMs)
    await mkdir(outputDir, { recursive: true })

    if (useExistingStack) {
      await waitForHttpOk(openwebuiBaseUrl, startupTimeoutMs)
      return
    }

    await runDockerCompose('down', '-v', '--remove-orphans').catch(() => undefined)
    await runDockerCompose('up', '-d', 'postgres', 'openwebui')
    await waitForHttpOk(openwebuiBaseUrl, startupTimeoutMs)
  })

  test.afterAll(async () => {
    test.setTimeout(120_000)
    if (useExistingStack) return
    await runDockerCompose('down', '-v', '--remove-orphans').catch(() => undefined)
  })

  test('OpenAI-compatible streaming chat completes across follow-up turns', async () => {
    test.setTimeout(240_000)
    const chatId = `openwebui-http-${Date.now()}`
    const firstUser = 'Add 21873 and 31415. Reply with digits only.'
    const secondUser = 'Add 27182 and 14142. Reply with digits only.'
    const thirdUser = 'Add 16180 and 17320. Reply with digits only.'

    const firstReply = await runChatCompletionTurn(chatId, [{ role: 'user', content: firstUser }])
    expect(firstReply).toContain('53288')

    const secondReply = await runChatCompletionTurn(chatId, [
      { role: 'user', content: firstUser },
      { role: 'assistant', content: firstReply.trim() },
      { role: 'user', content: secondUser },
    ])
    expect(secondReply).toContain('41324')

    const thirdReply = await runChatCompletionTurn(chatId, [
      { role: 'user', content: firstUser },
      { role: 'assistant', content: firstReply.trim() },
      { role: 'user', content: secondUser },
      { role: 'assistant', content: secondReply.trim() },
      { role: 'user', content: thirdUser },
    ])
    expect(thirdReply).toContain('33500')
  })

  test('OpenWebUI browser chat does not fall into a compaction loop across follow-up turns', async ({ page }) => {
    test.setTimeout(360_000)
    const firstUser = 'Add 21873 and 31415. Reply with digits only.'
    const secondUser = 'Add 27182 and 14142. Reply with digits only.'
    const thirdUser = 'Add 16180 and 17320. Reply with digits only.'

    await page.goto(openwebuiBaseUrl, { waitUntil: 'domcontentloaded' })

    await sendOpenWebUiMessage(page, firstUser)
    await expectAssistantReply(page, '53288')

    await sendOpenWebUiMessage(page, secondUser)
    await expectAssistantReply(page, '41324')

    await sendOpenWebUiMessage(page, thirdUser)
    await expectAssistantReply(page, '33500')
  })

  test('OpenWebUI browser chat renders rich activity summaries and detail pages with mock Codex', async ({
    page,
    context,
  }) => {
    test.skip(!useMockCodex, 'Rich-activity browser coverage runs only when mock Codex mode is enabled.')
    test.setTimeout(360_000)

    await page.goto(openwebuiBaseUrl, { waitUntil: 'domcontentloaded' })

    await sendOpenWebUiMessage(page, 'Run the rich activity demo and include every activity block.')
    await expectAssistantReply(page, 'Completed the rich activity demo.')

    await expectVisibleWhileScrolling(page, 'Starting the rich activity demo.')
    await expectVisibleWhileScrolling(page, 'Completed the rich activity demo.')
    await expectVisibleWhileScrolling(page, 'Validate the browser transcript and the staged detail pages.')
    await expectVisibleWhileScrolling(page, 'Rate limits')
    await expectVisibleWhileScrolling(page, 'src/rich-activity.ts')
    await expectVisibleWhileScrolling(page, 'catalog.search')
    await expectVisibleWhileScrolling(page, 'Generated audit findings for the mock activity.')
    await expectVisibleWhileScrolling(page, 'status board mock')

    const renderTurn = await runChatCompletionTurnWithRenderLinks(`openwebui-http-rich-${Date.now()}`, [
      { role: 'user', content: 'Run the rich activity demo and include every activity block.' },
    ])
    const renderLinks = renderTurn.renderLinks
    expect(renderLinks.length).toBeGreaterThanOrEqual(6)
    expect(renderLinks.some((link) => link.text === 'Open full transcript')).toBe(true)
    expect(renderLinks.some((link) => link.text === 'Open full diff')).toBe(true)
    expect(renderLinks.filter((link) => link.text === 'Open full result').length).toBeGreaterThanOrEqual(3)
    expect(renderLinks.some((link) => link.text === 'Open image preview')).toBe(true)

    const transcriptHref = renderLinks.find((link) => link.text === 'Open full transcript')?.href
    expect(transcriptHref).toBeTruthy()
    const transcriptPage = await context.newPage()
    await transcriptPage.goto(transcriptHref!)
    await expect(transcriptPage.locator('.label').filter({ hasText: /^Transcript$/ })).toBeVisible({ timeout: 30_000 })
    await expect(transcriptPage.getByText('mock transcript line 1')).toBeVisible({ timeout: 30_000 })
    await transcriptPage.close()

    const diffHref = renderLinks.find((link) => link.text === 'Open full diff')?.href
    expect(diffHref).toBeTruthy()
    const diffPage = await context.newPage()
    await diffPage.goto(diffHref!)
    await expect(diffPage.locator('.label').filter({ hasText: /^Unified Diff$/ })).toBeVisible({ timeout: 30_000 })
    await expect(diffPage.locator('code').filter({ hasText: /^src\/rich-activity\.ts$/ })).toBeVisible({
      timeout: 30_000,
    })
    await diffPage.close()

    const resultLinks = renderLinks.filter((link) => link.text === 'Open full result')
    const resultBodies: string[] = []
    for (const link of resultLinks.slice(0, 3)) {
      const resultPage = await context.newPage()
      await resultPage.goto(link.href)
      resultBodies.push((await resultPage.locator('body').textContent()) ?? '')
      await resultPage.close()
    }

    expect(resultBodies.some((body) => body.includes('catalog item 1'))).toBe(true)
    expect(resultBodies.some((body) => body.includes('audit item 1'))).toBe(true)
    expect(resultBodies.some((body) => body.includes('search item 1'))).toBe(true)

    const imageHref = renderLinks.find((link) => link.text === 'Open image preview')?.href
    expect(imageHref).toBeTruthy()
    const imagePage = await context.newPage()
    await imagePage.goto(imageHref!)
    await expect(imagePage.locator('.label').filter({ hasText: /^Preview$/ })).toBeVisible({ timeout: 30_000 })
    await expect(imagePage.locator('img')).toBeVisible({ timeout: 30_000 })
    await imagePage.close()
  })

  test('OpenWebUI browser chat renders assistant error blocks with mock Codex', async ({ page }) => {
    test.skip(!useMockCodex, 'Mock failure coverage runs only when mock Codex mode is enabled.')
    test.setTimeout(240_000)

    await page.goto(openwebuiBaseUrl, { waitUntil: 'domcontentloaded' })

    await sendOpenWebUiMessage(page, 'Run the failure activity demo.')
    await expect(page.getByText('Starting the failure activity demo.').last()).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByText('mock Codex app server error: command timed out while collecting artifacts').last(),
    ).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('request was aborted by the client').last()).not.toBeVisible()
  })
})
