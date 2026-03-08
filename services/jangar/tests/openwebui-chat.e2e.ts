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

const readStreamingAssistantReply = async (response: Response) => {
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
      if (payload === '[DONE]') return assistantReply

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

  return assistantReply
}

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

  test('OpenAI-compatible streaming chat completes across follow-up turns with real Codex', async () => {
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
})
