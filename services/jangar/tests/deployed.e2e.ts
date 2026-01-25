import { randomUUID } from 'node:crypto'

import { expect, test } from '@playwright/test'
import { connect, StringCodec } from 'nats'

const baseURL = process.env.JANGAR_DEPLOYED_BASE_URL ?? 'http://jangar'
const shouldRun = process.env.PLAYWRIGHT_DEPLOYED === '1'
const generalNatsUrl = process.env.JANGAR_AGENT_COMMS_NATS_URL ?? ''
const generalNatsUser = process.env.JANGAR_AGENT_COMMS_NATS_USER
const generalNatsPassword = process.env.JANGAR_AGENT_COMMS_NATS_PASSWORD
const canPublishGeneral = shouldRun && Boolean(generalNatsUrl)

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
  const counts = new Map<string, number>()

  page.on('websocket', (socket) => {
    const match = socket.url().match(/\/api\/terminals\/([^/]+)\/ws/)
    if (!match) return
    const sessionId = decodeURIComponent(match[1] ?? '')
    if (!sessionId) return
    sockets.set(sessionId, socket)
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1)
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

  return {
    waitFor,
    wasClosed: (sessionId: string) => closed.has(sessionId),
    connectionCount: (sessionId: string) => counts.get(sessionId) ?? 0,
  }
}

const waitForHydration = async (page: import('@playwright/test').Page) => {
  await page.waitForFunction(() => document.documentElement.dataset.hydrated === 'true')
}

const readTerminalSize = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal-canvas"]') as HTMLElement | null
    const cols = Number(el?.dataset.termCols ?? 0)
    const rows = Number(el?.dataset.termRows ?? 0)
    return { cols, rows }
  })

const parseSttySizeFromOutput = (output: string, marker: string) => {
  const escapeChar = String.fromCharCode(27)
  const carriageReturn = String.fromCharCode(13)
  const ansiPattern = new RegExp(`${escapeChar}\\[[0-9;?]*[A-Za-z]`, 'g')
  const carriageReturnPattern = new RegExp(carriageReturn, 'g')
  const normalized = output.replace(ansiPattern, '').replace(carriageReturnPattern, '')
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.includes(marker)) continue
    const match = trimmed.match(new RegExp(`${marker}:\\s*(\\d+)\\s+(\\d+)`))
    if (!match) continue
    return { rows: Number(match[1]), cols: Number(match[2]) }
  }
  return null
}

const waitForTerminalSnapshotContaining = async (sessionId: string, marker: string, timeoutMs = 20_000) => {
  const start = Date.now()
  let snapshot = ''
  while (Date.now() - start < timeoutMs) {
    snapshot = await fetchTerminalSnapshot(sessionId)
    if (snapshot.includes(marker)) {
      const parsed = parseSttySizeFromOutput(snapshot, marker)
      if (parsed) return snapshot
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for terminal snapshot containing ${marker}`)
}

const isTerminalFocusWithin = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const container = document.querySelector('[data-testid="terminal-canvas"]')
    const active = document.activeElement
    return !!(container && active && container.contains(active))
  })

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
    const response = await fetch(`${baseURL}/api/terminals/${encodeURIComponent(sessionId)}/stream`, {
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`stream status ${response.status}`)
    }
    return await response.text()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return ''
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

const publishGeneralMessage = async (content: string) => {
  const nc = await connect({
    servers: generalNatsUrl,
    user: generalNatsUser,
    pass: generalNatsPassword,
  })
  const sc = StringCodec()
  const messageId = randomUUID()
  const sentAt = new Date().toISOString()
  const payload = {
    message_id: messageId,
    sent_at: sentAt,
    timestamp: sentAt,
    kind: 'status',
    workflow_uid: `e2e-${messageId}`,
    workflow_name: 'e2e-general',
    workflow_namespace: 'e2e',
    agent_id: 'e2e-agent',
    role: 'assistant',
    channel: 'general',
    content,
  }
  nc.publish('workflow.general.status', sc.encode(JSON.stringify(payload)))
  await nc.flush()
  await nc.close()
  return { messageId, sentAt }
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

  test('codex search and runs pages render', async ({ page }) => {
    await page.goto('/codex/search')
    await expect(page.getByRole('heading', { name: 'Run history', level: 1 })).toBeVisible()
    await expect(page.getByText('You can type any issue number.')).toBeVisible()

    const issueInput = page.getByRole('combobox', { name: 'Issue number' })
    await issueInput.click()
    await issueInput.fill('999999')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Load runs' }).click()
    await expect(page).toHaveURL(/\/codex\/search\?/)
    await expect(issueInput).toHaveValue('999999')

    await page.goto('/codex/runs')
    await expect(page.getByRole('heading', { name: 'All runs', level: 1 })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Issue' })).toBeVisible()
    await expect(page.getByLabel('Rows per page')).toBeVisible()
  })

  test('worktree snapshot renders a hierarchical file tree', async ({ page }) => {
    await page.goto('/github/pulls/proompteng/lab/2311')
    await page.getByRole('button', { name: 'Files' }).click()
    const tree = page.getByRole('tree', { name: 'Worktree files' })
    await expect(tree).toBeVisible()

    const directoryItem = tree.locator('[role="treeitem"][aria-expanded]').first()
    await expect(directoryItem).toBeVisible()

    const hasNestedItems = await tree.evaluate((root) =>
      Array.from(root.querySelectorAll('[role="treeitem"]')).some(
        (item) => Number(item.getAttribute('aria-level') || '1') > 1,
      ),
    )
    expect(hasNestedItems).toBe(true)

    await expect(directoryItem).toHaveAttribute('aria-expanded', 'true')
    await directoryItem.click()
    await expect(directoryItem).toHaveAttribute('aria-expanded', 'false')
    await directoryItem.click()
    await expect(directoryItem).toHaveAttribute('aria-expanded', 'true')
  })

  test('general agent stream receives live messages', async ({ page }) => {
    test.skip(
      !canPublishGeneral,
      'Set PLAYWRIGHT_DEPLOYED=1 and JANGAR_AGENT_COMMS_NATS_URL (plus creds) to publish a general message.',
    )

    const content = `e2e-general-${Date.now()}`
    await page.goto('/agents/general')
    await expect(page.getByRole('heading', { name: 'General channel', level: 1 })).toBeVisible()

    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 })

    await publishGeneralMessage(content)

    await expect(page.getByText(content)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Disconnected')).toHaveCount(0)
  })

  test('torghut visuals render overlays and signals', async ({ page, request }) => {
    test.setTimeout(120_000)

    await page.goto('/torghut/visuals')
    await expect(page.getByRole('heading', { name: 'Visuals', level: 1 })).toBeVisible()
    await waitForHydration(page)

    const symbolSelect = page.locator('#torghut-symbol')
    await expect(symbolSelect).toBeEnabled()

    await page.locator('#torghut-range').selectOption('1d')
    await page.locator('#torghut-resolution').selectOption('1m')

    const symbol = await symbolSelect.inputValue()
    const now = new Date()
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const params = new URLSearchParams({
      symbol,
      range: '1d',
      resolution: '1m',
      limit: '500',
      refresh: '0',
      from: from.toISOString(),
      to: now.toISOString(),
    })

    const barsResponse = await request.get(`/api/torghut/ta/bars?${params.toString()}`)
    expect(barsResponse.ok()).toBe(true)
    const barsPayload = (await barsResponse.json()) as { items?: unknown[] }
    const bars = Array.isArray(barsPayload.items) ? barsPayload.items : []
    expect(bars.length).toBeGreaterThan(0)

    const signalsResponse = await request.get(`/api/torghut/ta/signals?${params.toString()}`)
    expect(signalsResponse.ok()).toBe(true)
    const signalsPayload = (await signalsResponse.json()) as { items?: Array<Record<string, unknown>> }
    const signals = Array.isArray(signalsPayload.items) ? signalsPayload.items : []
    expect(signals.length).toBeGreaterThan(0)
    expect(
      signals.some(
        (item) => typeof item.ema12 === 'number' || typeof (item.ema as Record<string, unknown>)?.ema12 === 'number',
      ),
    ).toBe(true)
    expect(
      signals.some(
        (item) =>
          typeof item.boll_mid === 'number' ||
          typeof (item.boll as Record<string, unknown>)?.mid === 'number' ||
          typeof (item.boll as Record<string, unknown>)?.upper === 'number',
      ),
    ).toBe(true)
    expect(
      signals.some(
        (item) => typeof item.macd === 'number' || typeof (item.macd as Record<string, unknown>)?.macd === 'number',
      ),
    ).toBe(true)
    expect(signals.some((item) => typeof item.rsi14 === 'number' || typeof item.rsi_14 === 'number')).toBe(true)

    await page.getByRole('checkbox', { name: 'EMA 12/26' }).check()
    await page.getByRole('checkbox', { name: 'Bollinger' }).check()
    await page.getByRole('checkbox', { name: 'MACD' }).check()
    await page.getByRole('checkbox', { name: 'RSI' }).check()

    const priceChart = page.getByRole('img', { name: 'Candlestick chart with indicator overlays' })
    const signalChart = page.getByRole('img', { name: 'Indicator chart for MACD and RSI' })

    await expect(priceChart).toBeVisible()
    await expect(signalChart).toBeVisible()

    await expect(page.getByText('No candles for this range.')).toHaveCount(0)
    await expect(page.getByText('Enable MACD or RSI to render the indicator panel.')).toHaveCount(0)
    await expect(page.getByText('No indicator points for this window.')).toHaveCount(0)

    await expect
      .poll(async () => Number((await priceChart.getAttribute('data-candle-count')) ?? 0), { timeout: 20_000 })
      .toBeGreaterThan(0)
    await expect
      .poll(async () => Number((await priceChart.getAttribute('data-overlay-count')) ?? 0), { timeout: 20_000 })
      .toBeGreaterThan(0)
    await expect
      .poll(async () => Number((await signalChart.getAttribute('data-signal-count')) ?? 0), { timeout: 20_000 })
      .toBeGreaterThan(0)
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
        reconnectToken?: string | null
      }
    }
    expect(sessionPayload.ok).toBe(true)
    expect(sessionPayload.session?.id).toBe(sessionId)
    expect(sessionPayload.session?.worktreePath ?? '').toContain('/.worktrees/')
    expect(sessionPayload.session?.status).toBe('ready')
    expect(sessionPayload.session?.reconnectToken).toBeTruthy()

    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })
    const wsStatus = await wsTracker.waitFor(sessionId)
    await assertWebSocketStaysOpen(page, wsStatus, 6000)
    await fetchTerminalSnapshot(sessionId)

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
    const listRow = page.locator(`[data-session-id="${sessionId}"]`)
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
    request,
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
    const row = page.locator(`[data-session-id="${sessionId}"]`)
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
    const wsCount = wsTracker.connectionCount(sessionId)

    const marker = `ui-e2e-${Date.now()}`
    const terminal = page.getByTestId('terminal-canvas')
    await terminal.click()
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')

    const start = Date.now()
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 2500 }).toContain(marker)
    expect(Date.now() - start).toBeLessThan(2500)
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 20_000 }).toContain(marker)

    await page.getByRole('link', { name: 'All sessions' }).click()
    await expect(page).toHaveURL(/\/terminals\/?$/)
    await expect
      .poll(
        async () => {
          const listResponse = await request.get('/api/terminals')
          if (!listResponse.ok()) return false
          const listPayload = (await listResponse.json()) as { ok?: boolean; sessions?: Array<{ id: string }> }
          return Boolean(listPayload.ok && listPayload.sessions?.some((session) => session.id === sessionId))
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    await page.goto('/terminals')
    await expect(page.getByRole('heading', { name: 'Terminal sessions', level: 1 })).toBeVisible()
    const listRow = page.locator(`[data-session-id="${sessionId}"]`)
    await expect(listRow).toBeVisible({ timeout: 20_000 })
    await expect(listRow.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 })
    await listRow.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/terminals/${sessionId}$`))
    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 20_000 }).toContain(marker)

    await page.reload()
    await expect(page).toHaveURL(new RegExp(`/terminals/${sessionId}$`))
    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => wsTracker.connectionCount(sessionId), { timeout: 20_000 }).toBeGreaterThan(wsCount)
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 20_000 }).toContain(marker)

    await page.getByRole('button', { name: 'Terminate session' }).click()
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 30_000 }).toBe('closed')
    await page.goto('/terminals')
    await expect(page.getByRole('heading', { name: 'Terminal sessions', level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Show closed' }).click()
    const closedRow = page.locator(`[data-session-id="${sessionId}"]`)
    await expect(closedRow).toBeVisible()
    await closedRow.getByRole('button', { name: 'Delete' }).click()
    const dialog = page
      .getByRole('alertdialog', { name: 'Delete terminal session?' })
      .or(page.getByRole('dialog', { name: 'Delete terminal session?' }))
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(closedRow).toHaveCount(0)

    expect(inputRequests).toEqual([])
    expect(apiFailures).toEqual([])
  })

  test('terminal fullscreen route fills viewport', async ({ page, request }) => {
    test.setTimeout(90_000)

    const createResponse = await request.get('/api/terminals?create=1')
    expect(createResponse.ok()).toBe(true)
    const createPayload = (await createResponse.json()) as {
      ok: boolean
      session?: { id?: string }
      message?: string
    }
    expect(createPayload.ok).toBe(true)
    const sessionId = createPayload.session?.id
    if (!sessionId) {
      throw new Error(`Terminal session creation returned no id: ${createPayload.message ?? 'unknown error'}`)
    }
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 90_000 }).toBe('ready')

    await page.goto(`/terminals/${sessionId}/fullscreen`)
    await waitForHydration(page)
    await expect(page.getByTestId('terminal-canvas')).toBeVisible({ timeout: 20_000 })

    const bounds = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="terminal-canvas"]') as HTMLElement | null
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return { width: rect.width, height: rect.height, viewportW: window.innerWidth, viewportH: window.innerHeight }
    })

    expect(bounds).not.toBeNull()
    if (bounds) {
      expect(Math.abs(bounds.width - bounds.viewportW)).toBeLessThan(6)
      expect(Math.abs(bounds.height - bounds.viewportH)).toBeLessThan(6)
    }

    await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/terminate`)
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 30_000 }).toBe('closed')
  })

  test('terminal stays visually stable across blur/focus', async ({ page, context, request }) => {
    test.setTimeout(120_000)

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
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 90_000 }).toBe('ready')

    await page.goto(`/terminals/${sessionId}`)
    await waitForHydration(page)
    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })

    const terminal = page.getByTestId('terminal-canvas')
    await terminal.click()
    const drawCmd =
      "printf '\\033[2J\\033[H'; printf 'LINE-1: 012345678901234567890123456789012345678901234567890123456789\\n'; printf 'LINE-2: 012345678901234567890123456789012345678901234567890123456789\\n'"
    await page.keyboard.type(drawCmd)
    await page.keyboard.press('Enter')
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 10_000 }).toContain('LINE-1:')

    await expect.poll(async () => (await readTerminalSize(page)).cols, { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(async () => (await readTerminalSize(page)).rows, { timeout: 10_000 }).toBeGreaterThan(0)
    const sizeBefore = await readTerminalSize(page)
    expect(sizeBefore.cols).toBeGreaterThan(0)
    expect(sizeBefore.rows).toBeGreaterThan(0)

    const beforeMarker = `STTY-BEFORE-${Date.now()}`
    const beforeInput = await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/input`, {
      data: { data: Buffer.from(`printf '${beforeMarker}:'; stty size; printf '\\n'\n`).toString('base64') },
    })
    expect(beforeInput.ok()).toBe(true)
    const beforeSnapshot = await waitForTerminalSnapshotContaining(sessionId, beforeMarker, 20_000)
    const beforeSize = parseSttySizeFromOutput(beforeSnapshot, beforeMarker)
    expect(beforeSize).toEqual({ rows: sizeBefore.rows, cols: sizeBefore.cols })

    const initialViewport = page.viewportSize()
    const other = await context.newPage()
    await other.goto('about:blank')
    await other.bringToFront()
    if (initialViewport) {
      await page.setViewportSize({
        width: initialViewport.width + 140,
        height: initialViewport.height + 120,
      })
    }
    await page.waitForTimeout(800)
    await page.bringToFront()
    await page.waitForTimeout(800)

    const sizeAfter = await readTerminalSize(page)
    expect(sizeAfter.cols).toBeGreaterThan(0)
    expect(sizeAfter.rows).toBeGreaterThan(0)
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 5_000 }).toContain('LINE-1:')

    const afterMarker = `STTY-AFTER-${Date.now()}`
    const afterInput = await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/input`, {
      data: { data: Buffer.from(`printf '${afterMarker}:'; stty size; printf '\\n'\n`).toString('base64') },
    })
    expect(afterInput.ok()).toBe(true)
    const afterSnapshot = await waitForTerminalSnapshotContaining(sessionId, afterMarker, 20_000)
    const afterSize = parseSttySizeFromOutput(afterSnapshot, afterMarker)
    expect(afterSize).toEqual({ rows: sizeAfter.rows, cols: sizeAfter.cols })

    await page.keyboard.press('Enter')

    await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/terminate`)
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 30_000 }).toBe('closed')
  })

  test('terminal stays visually stable across window resize', async ({ page, request }) => {
    test.setTimeout(120_000)

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
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 90_000 }).toBe('ready')

    await page.goto(`/terminals/${sessionId}`)
    await waitForHydration(page)
    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })

    const terminal = page.getByTestId('terminal-canvas')
    await terminal.click()
    const drawCmd =
      "printf '\\033[2J\\033[H'; printf 'LINE-1: 012345678901234567890123456789012345678901234567890123456789\\n'; printf 'LINE-2: 012345678901234567890123456789012345678901234567890123456789\\n'"
    await page.keyboard.type(drawCmd)
    await page.keyboard.press('Enter')
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 10_000 }).toContain('LINE-1:')

    await expect.poll(async () => (await readTerminalSize(page)).cols, { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(async () => (await readTerminalSize(page)).rows, { timeout: 10_000 }).toBeGreaterThan(0)
    const sizeBefore = await readTerminalSize(page)

    const beforeMarker = `STTY-RESIZE-BEFORE-${Date.now()}`
    const beforeInput = await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/input`, {
      data: { data: Buffer.from(`printf '${beforeMarker}:'; stty size; printf '\\n'\n`).toString('base64') },
    })
    expect(beforeInput.ok()).toBe(true)
    const beforeSnapshot = await waitForTerminalSnapshotContaining(sessionId, beforeMarker, 20_000)
    const beforeSize = parseSttySizeFromOutput(beforeSnapshot, beforeMarker)
    expect(beforeSize).toEqual({ rows: sizeBefore.rows, cols: sizeBefore.cols })

    const initialViewport = page.viewportSize()
    if (!initialViewport) {
      throw new Error('Missing viewport size for resize test')
    }
    await page.setViewportSize({
      width: initialViewport.width + 240,
      height: initialViewport.height + 180,
    })
    await page.waitForTimeout(800)

    const sizeAfter = await readTerminalSize(page)
    expect(sizeAfter.cols).toBeGreaterThan(0)
    expect(sizeAfter.rows).toBeGreaterThan(0)
    await expect.poll(() => fetchTerminalSnapshot(sessionId), { timeout: 5_000 }).toContain('LINE-1:')

    const afterMarker = `STTY-RESIZE-AFTER-${Date.now()}`
    const afterInput = await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/input`, {
      data: { data: Buffer.from(`printf '${afterMarker}:'; stty size; printf '\\n'\n`).toString('base64') },
    })
    expect(afterInput.ok()).toBe(true)
    const afterSnapshot = await waitForTerminalSnapshotContaining(sessionId, afterMarker, 20_000)
    const afterSize = parseSttySizeFromOutput(afterSnapshot, afterMarker)
    expect(afterSize).toEqual({ rows: sizeAfter.rows, cols: sizeAfter.cols })

    await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/terminate`)
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 30_000 }).toBe('closed')
  })

  test('terminal focus UX is keyboard focusable without auto-focus', async ({ page, request }) => {
    test.setTimeout(120_000)

    const createResponse = await request.get('/api/terminals?create=1')
    expect(createResponse.ok()).toBe(true)
    const createPayload = (await createResponse.json()) as { ok?: boolean; session?: { id?: string } }
    expect(createPayload.ok).toBe(true)
    const sessionId = createPayload.session?.id ?? ''
    expect(sessionId).toMatch(/^jangar-terminal-/)
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 90_000 }).toBe('ready')

    await page.goto(`/terminals/${sessionId}`)
    await waitForHydration(page)
    await expect(page.getByText('Status: connected', { exact: false })).toBeVisible({ timeout: 20_000 })

    expect(await isTerminalFocusWithin(page)).toBe(false)

    const terminal = page.getByTestId('terminal-canvas')
    await terminal.focus()
    await expect.poll(() => isTerminalFocusWithin(page), { timeout: 5_000 }).toBe(true)

    await request.post(`/api/terminals/${encodeURIComponent(sessionId)}/terminate`)
    await expect.poll(() => fetchSessionStatus(sessionId), { timeout: 30_000 }).toBe('closed')
  })
})
