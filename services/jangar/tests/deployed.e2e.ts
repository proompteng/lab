import { expect, test } from '@playwright/test'

const baseURL = process.env.JANGAR_DEPLOYED_BASE_URL ?? 'http://jangar'
const shouldRun = process.env.PLAYWRIGHT_DEPLOYED === '1'

const trackApiFailures = (page: import('@playwright/test').Page) => {
  const failures: string[] = []
  page.on('response', (response) => {
    const url = response.url()
    if (!url.includes('/api/terminals')) return
    if (response.ok()) return
    failures.push(`${response.status()} ${url}`)
  })
  page.on('requestfailed', (request) => {
    const url = request.url()
    if (!url.includes('/api/terminals')) return
    const errorText = request.failure()?.errorText ?? ''
    if (url.includes('/stream') && /aborted|cancelled|canceled|ERR_ABORTED/i.test(errorText)) {
      return
    }
    failures.push(`FAILED ${url} ${errorText}`.trim())
  })
  return failures
}

const trackInputRequests = (page: import('@playwright/test').Page) => {
  const inputs: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (!url.includes('/api/terminals')) return
    if (!url.includes('/input')) return
    inputs.push(url)
  })
  return inputs
}

const trackTerminalWebSockets = (page: import('@playwright/test').Page) => {
  const sockets = new Map<string, import('@playwright/test').WebSocket>()
  const closed = new Set<string>()

  page.on('websocket', (socket) => {
    const match = socket.url().match(/\/api\/terminals\/([^/]+)\/ws/)
    if (!match) return
    const sessionId = decodeURIComponent(match[1] ?? '')
    if (!sessionId) return
    sockets.set(sessionId, socket)
    socket.on('close', () => {
      closed.add(sessionId)
    })
  })

  const waitFor = async (sessionId: string) => {
    const existing = sockets.get(sessionId)
    if (existing) {
      return { ws: existing, wasClosed: () => closed.has(sessionId) }
    }
    await page.waitForEvent('websocket', {
      predicate: (socket) => socket.url().includes(`/api/terminals/${encodeURIComponent(sessionId)}/ws`),
      timeout: 20_000,
    })
    const socket = sockets.get(sessionId)
    if (!socket) {
      throw new Error('Terminal websocket opened but could not be tracked')
    }
    return { ws: socket, wasClosed: () => closed.has(sessionId) }
  }

  return { waitFor, wasClosed: (sessionId: string) => closed.has(sessionId) }
}

const waitForHydration = async (page: import('@playwright/test').Page) => {
  await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true')
}

const assertWebSocketStaysOpen = async (
  page: import('@playwright/test').Page,
  status: { wasClosed: () => boolean },
  durationMs = 8000,
) => {
  await page.waitForTimeout(durationMs)
  if (status.wasClosed()) {
    throw new Error('Terminal websocket closed before timeout')
  }
}

const assertUiSseStable = async (page: import('@playwright/test').Page, sessionId: string, durationMs = 8000) => {
  await page.evaluate(
    ({ id, duration }) =>
      new Promise<void>((resolve, reject) => {
        const source = new EventSource(`/api/terminals/${encodeURIComponent(id)}/stream`)
        let open = false
        const timeout = window.setTimeout(() => {
          source.close()
          if (open) {
            resolve()
          } else {
            reject(new Error('SSE did not open in time'))
          }
        }, duration)
        source.onopen = () => {
          open = true
        }
        source.onerror = () => {
          window.clearTimeout(timeout)
          source.close()
          reject(new Error('SSE error event fired'))
        }
      }),
    { id: sessionId, duration: durationMs },
  )
}

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

const assertSseStaysOpen = async (sessionId: string, durationMs = 15000) => {
  let closedEarly = false
  let canceled = false

  const response = await fetch(`${baseURL}/api/terminals/${encodeURIComponent(sessionId)}/stream`)
  if (!response.ok || !response.body) {
    throw new Error(`stream status ${response.status}`)
  }

  const reader = response.body.getReader()
  const readLoop = (async () => {
    while (true) {
      const { done } = await reader.read()
      if (done) {
        if (!canceled) closedEarly = true
        break
      }
    }
  })()

  await new Promise((resolve) => setTimeout(resolve, durationMs))
  canceled = true
  await reader.cancel()
  await readLoop.catch(() => undefined)

  if (closedEarly) {
    throw new Error('SSE stream closed before timeout')
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
    const apiFailures = trackApiFailures(page)
    const inputRequests = trackInputRequests(page)
    const wsTracker = trackTerminalWebSockets(page)

    await page.goto('/terminals')
    await expect(page.getByRole('heading', { name: 'Terminal sessions', level: 1 })).toBeVisible()
    await waitForHydration(page)
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
    const wsStatus = await wsTracker.waitFor(sessionId)
    await assertWebSocketStaysOpen(page, wsStatus, 6000)
    await assertSseStaysOpen(sessionId, 12_000)
    await assertUiSseStable(page, sessionId)

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
    const listRow = page.locator('li', { hasText: sessionId })
    await expect(listRow).toBeVisible()
    await expect(listRow.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 })
    await listRow.getByRole('link').click()
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

    expect(inputRequests).toEqual([])
    expect(apiFailures).toEqual([])
  })

  test('terminal session created from UI stays connected, accepts input, and restores after reconnect', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const apiFailures = trackApiFailures(page)
    const inputRequests = trackInputRequests(page)
    const wsTracker = trackTerminalWebSockets(page)

    await page.goto('/terminals')
    await expect(page.getByRole('heading', { name: 'Terminal sessions', level: 1 })).toBeVisible()
    await waitForHydration(page)

    const [createResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const url = response.url()
        if (!url.includes('/api/terminals')) return false
        if (url.includes('create=1')) return true
        return response.request().method() === 'POST'
      }),
      page.getByRole('button', { name: 'New session' }).click(),
    ])
    expect(createResponse.ok()).toBe(true)
    const createPayload = (await createResponse.json()) as { ok: boolean; session?: { id: string } }
    expect(createPayload.ok).toBe(true)
    const sessionId = createPayload.session?.id ?? ''
    expect(sessionId).toMatch(/^jangar-terminal-/)

    await page.getByRole('button', { name: 'Refresh' }).click()
    const row = page.locator('li', { hasText: sessionId })
    await expect(row).toBeVisible()
    await expect(row.getByText('Creating', { exact: true })).toBeVisible()
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 90_000 }).toBe('ready')
    await expect(row.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 })

    await row.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/terminals/${sessionId}$`))
    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Connection lost. Refresh to retry.')).toHaveCount(0)
    const wsStatus = await wsTracker.waitFor(sessionId)
    await assertWebSocketStaysOpen(page, wsStatus, 6000)

    const marker = `ui-e2e-${Date.now()}`
    const terminal = page.locator('.xterm')
    await terminal.click()
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')

    const start = Date.now()
    await expect(page.locator('.xterm-rows')).toContainText(marker, { timeout: 5000 })
    expect(Date.now() - start).toBeLessThan(5000)
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 20_000 }).toContain(marker)

    await page.getByRole('link', { name: 'All sessions' }).click()
    await expect(page).toHaveURL(/\/terminals\/?$/)
    const listRow = page.locator('li', { hasText: sessionId })
    await expect(listRow).toBeVisible()
    await expect(listRow.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 })
    await listRow.getByRole('link').click()
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
    await expect(page.getByText(`Session id: ${sessionId}`)).toBeHidden()

    await page.getByRole('button', { name: 'Show closed' }).click()
    const closedRow = page.locator('li', { hasText: sessionId })
    await expect(closedRow).toBeVisible()
    await closedRow.getByRole('button', { name: 'Delete' }).click()
    await expect(closedRow).toHaveCount(0)

    expect(inputRequests).toEqual([])
    expect(apiFailures).toEqual([])
  })
})
