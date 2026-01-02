import { expect, test } from '@playwright/test'

const baseURL = process.env.JANGAR_DEPLOYED_BASE_URL ?? 'http://jangar'
const shouldRun = process.env.PLAYWRIGHT_DEPLOYED === '1'

const fetchSessionStatus = async (sessionId: string) => {
  const response = await fetch(`${baseURL}/api/terminals/${encodeURIComponent(sessionId)}`)
  if (!response.ok) return null
  const payload = (await response.json()) as { ok?: boolean; session?: { status?: string } }
  return payload.session?.status ?? null
}

const fetchTerminalSnapshot = async (sessionId: string, timeoutMs = 8000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    try {
      const response = await fetch(`${baseURL}/api/terminals/${encodeURIComponent(sessionId)}/stream`, {
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`stream status ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let collected = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')

          const dataMatch = chunk.match(/data: ?(.*)/)
          if (dataMatch && dataMatch[1] !== undefined) {
            const decoded = Buffer.from(dataMatch[1], 'base64').toString('utf8')
            if (decoded) collected += decoded
          }
        }

        if (collected) return collected
      }

      return collected
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return ''
      throw error
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

test.describe('deployed jangar e2e', () => {
  test.skip(
    !shouldRun,
    'Set PLAYWRIGHT_DEPLOYED=1 to run against deployed Jangar. Override JANGAR_DEPLOYED_BASE_URL if needed.',
  )

  test.use({ baseURL })

  test('navigation and terminals entry', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Memories', level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Terminals' })).toBeVisible()
    await page.getByRole('link', { name: 'Terminals' }).click()
    await expect(page).toHaveURL(/\/terminals\/?$/)
    await expect(page.getByRole('heading', { name: 'Terminal sessions', level: 1 })).toBeVisible()
  })

  test('terminal session lifecycle end-to-end', async ({ page, request }) => {
    test.setTimeout(120_000)

    await page.goto('/terminals')
    await expect(page.getByRole('heading', { name: 'Terminal sessions', level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled()

    const createResponse = await request.get('/api/terminals?create=1')
    expect(createResponse.ok()).toBe(true)
    const createPayload = (await createResponse.json()) as {
      ok: boolean
      session?: { id: string; status?: string }
      message?: string
    }
    expect(createPayload.ok).toBe(true)
    if (!createPayload.session?.id) {
      throw new Error(`Terminal session creation returned no id: ${createPayload.message ?? 'unknown error'}`)
    }

    const sessionId = createPayload.session.id
    expect(sessionId).toMatch(/^jangar-terminal-/)
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 90_000 }).toBe('ready')

    await page.goto(`/terminals/${sessionId}`)
    const sessionResponse = await request.get(`/api/terminals/${encodeURIComponent(sessionId)}`)
    expect(sessionResponse.ok()).toBe(true)
    const sessionPayload = (await sessionResponse.json()) as {
      ok: boolean
      session?: {
        id: string
        worktreePath: string | null
        createdAt: string | null
        attached: boolean
        status?: string
      }
    }
    expect(sessionPayload.ok).toBe(true)
    expect(sessionPayload.session?.id).toBe(sessionId)
    expect(sessionPayload.session?.worktreePath ?? '').toContain('/.worktrees/')
    expect(sessionPayload.session?.status).toBe('ready')

    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })

    const marker = `e2e-${Date.now()}`
    const inputResponse = await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/input`, {
      data: { data: Buffer.from(`echo ${marker}\n`).toString('base64') },
    })
    expect(inputResponse.ok()).toBe(true)
    const inputPayload = (await inputResponse.json()) as { ok: boolean }
    expect(inputPayload.ok).toBe(true)

    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 20_000 }).toContain(marker)

    await page.getByRole('link', { name: 'All sessions' }).click()
    await expect(page).toHaveURL(/\/terminals\/?$/)
    await expect(page.getByText(`Session id: ${sessionId}`)).toBeVisible()

    await page.getByText(`Session id: ${sessionId}`).click()
    await expect(page).toHaveURL(new RegExp(`/terminals/${sessionId}$`))
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 20_000 }).toContain(marker)

    const listResponse = await request.get('/api/terminals')
    expect(listResponse.ok()).toBe(true)
    const listPayload = (await listResponse.json()) as { ok: boolean; sessions?: Array<{ id: string }> }
    expect(listPayload.ok).toBe(true)
    expect(listPayload.sessions?.some((session) => session.id === sessionId)).toBe(true)

    const resizeResponse = await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/resize`, {
      data: { cols: 120, rows: 40 },
    })
    expect(resizeResponse.ok()).toBe(true)
    const resizePayload = (await resizeResponse.json()) as { ok: boolean }
    expect(resizePayload.ok).toBe(true)
  })

  test('terminal session created from UI stays connected, accepts input, and restores after reconnect', async ({
    page,
  }) => {
    test.setTimeout(120_000)

    await page.goto('/terminals')
    await expect(page.getByRole('heading', { name: 'Terminal sessions', level: 1 })).toBeVisible()

    const [createResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/terminals?create=1')),
      page.getByRole('button', { name: 'New session' }).click(),
    ])
    expect(createResponse.ok()).toBe(true)
    const createPayload = (await createResponse.json()) as { ok: boolean; session?: { id: string } }
    expect(createPayload.ok).toBe(true)
    const sessionId = createPayload.session?.id ?? ''
    expect(sessionId).toMatch(/^jangar-terminal-/)

    await expect(page.getByText(`Session id: ${sessionId}`)).toBeVisible()
    await expect(page.getByText('Creating', { exact: true })).toBeVisible()
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 90_000 }).toBe('ready')

    await page.getByText(`Session id: ${sessionId}`).click()
    await expect(page).toHaveURL(new RegExp(`/terminals/${sessionId}$`))
    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Connection lost. Refresh to retry.')).toBeHidden()

    const marker = `ui-e2e-${Date.now()}`
    const terminal = page.locator('.xterm')
    await terminal.click()
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')

    await expect(page.locator('.xterm-rows')).toContainText(marker, { timeout: 20_000 })
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 20_000 }).toContain(marker)

    await page.getByRole('link', { name: 'All sessions' }).click()
    await expect(page).toHaveURL(/\/terminals\/?$/)
    await expect(page.getByText(`Session id: ${sessionId}`)).toBeVisible()

    await page.getByText(`Session id: ${sessionId}`).click()
    await expect(page).toHaveURL(new RegExp(`/terminals/${sessionId}$`))
    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 20_000 }).toContain(marker)

    await page.reload()
    await expect(page).toHaveURL(new RegExp(`/terminals/${sessionId}$`))
    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 20_000 }).toContain(marker)

    await page.getByRole('button', { name: 'Terminate session' }).click()
    await expect(page).toHaveURL(/\/terminals\/?$/)
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 30_000 }).toBe('closed')
    const row = page.locator('li', { hasText: sessionId })
    await expect(row).toContainText('Closed')
    await page.getByText(`Session id: ${sessionId}`).click()
    await expect(page).toHaveURL(/\/terminals\/?$/)
  })
})
