import { expect, test } from '@playwright/test'

const isOkPayload = (value: unknown): value is { ok: true } => {
  if (!value || typeof value !== 'object') return false
  if (!('ok' in value)) return false
  return (value as { ok?: unknown }).ok === true
}

test.describe('live deps (Tilt / remote cluster)', () => {
  test.skip(
    process.env.PLAYWRIGHT_LIVE_DEPS !== '1',
    'Set PLAYWRIGHT_LIVE_DEPS=1 to run tests that require real remote deps (eg via Tilt port-forwards).',
  )

  test('atlas search returns ok (no DB connection error)', async ({ page }) => {
    await page.goto('/atlas/search')
    await expect(page.getByRole('heading', { name: 'Search', level: 1 })).toBeVisible()

    await page.getByLabel('Query').fill('kysely')

    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          candidate.url().includes('/api/search') &&
          candidate.request().method() === 'GET' &&
          candidate.url().includes('query=kysely'),
      ),
      page.getByRole('button', { name: 'Search' }).click(),
    ])

    const status = response.status()
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      payload = await response.text().catch(() => null)
    }

    expect(
      response.ok(),
      `Expected /api/search to succeed; got ${status}. Payload: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`,
    ).toBe(true)

    await expect(page.getByText(/Search failed \(\d+\)/)).toHaveCount(0)
    await expect(page.getByText(/No matches found\.|Found \d+ matches\./)).toBeVisible()
  })

  test('atlas search route works for temporal query (URL navigation)', async ({ page }) => {
    const target = '/atlas/search?query=temporal&repository=&ref=&pathPrefix=&limit=25'

    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          candidate.url().includes('/api/search') &&
          candidate.request().method() === 'GET' &&
          candidate.url().includes('query=temporal'),
      ),
      page.goto(target),
    ])

    const status = response.status()
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      payload = await response.text().catch(() => null)
    }

    expect(
      response.ok(),
      `Expected /api/search to succeed for temporal; got ${status}. Payload: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`,
    ).toBe(true)

    // The UI should surface a success status string.
    await expect(page.getByText(/No matches found\.|Found \d+ matches\./)).toBeVisible()

    // And it should not surface the common infra errors.
    await expect(
      page.getByText(/atlas search failed|Connection terminated unexpectedly|ECONNREFUSED|embedding request failed/i),
    ).toHaveCount(0)
  })

  test('api search temporal responds quickly and reliably', async ({ request }) => {
    const url = '/api/search?query=temporal&repository=&ref=&pathPrefix=&limit=25'

    // Run the same request multiple times to catch flaky port-forwards / pool issues.
    for (let i = 0; i < 3; i += 1) {
      const response = await request.get(url, {
        timeout: 15_000,
        headers: {
          accept: 'application/json',
        },
      })

      const status = response.status()
      const text = await response.text()
      let payload: unknown = null
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }

      expect(
        response.ok(),
        `Expected ${url} to succeed on attempt ${i + 1}; got ${status}. Payload: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`,
      ).toBe(true)

      expect(
        isOkPayload(payload),
        `Expected payload.ok=true on attempt ${i + 1}; got: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`,
      ).toBe(true)
    }
  })

  test('agents general channel opens SSE and does not surface DB errors', async ({ page }) => {
    await page.goto('/agents/general')
    await expect(page.getByRole('heading', { name: 'General channel', level: 1 })).toBeVisible()

    const response = await page.waitForResponse((candidate) => candidate.url().includes('/api/agents/events'))
    const status = response.status()
    const contentType = response.headers()['content-type'] ?? ''
    expect(response.ok(), `Expected /api/agents/events to succeed; got ${status} (${contentType}).`).toBe(true)
    expect(contentType).toContain('text/event-stream')

    await expect(page.getByText('Stream disconnected. Refresh to retry.')).toHaveCount(0)

    // Give the first poll a moment to run.
    await page.waitForTimeout(2500)

    await expect(page.getByText(/ECONNREFUSED|connect ECONNREFUSED|DATABASE_URL/)).toHaveCount(0)
    await expect(page.getByText('No messages yet. Waiting for the general channel to publish events.')).toBeVisible()
  })

  test('terminal sessions can be created and re-opened', async ({ page, request }) => {
    await page.goto('/terminals')
    await expect(page.getByRole('heading', { name: 'Terminal sessions', level: 1 })).toBeVisible()

    const [createResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/terminals?create=1')),
      page.getByRole('button', { name: 'New session' }).click(),
    ])
    expect(createResponse.ok()).toBe(true)
    const createPayload = (await createResponse.json()) as { ok?: boolean; session?: { id?: string } }
    expect(createPayload.ok).toBe(true)
    const sessionId = createPayload.session?.id
    expect(sessionId).toBeTruthy()

    await expect
      .poll(
        async () => {
          const response = await request.get(`/api/terminals/${encodeURIComponent(sessionId ?? '')}`)
          if (!response.ok()) return null
          const payload = (await response.json()) as { session?: { status?: string } }
          return payload.session?.status ?? null
        },
        { timeout: 90_000 },
      )
      .toBe('ready')

    await page.getByText(`Session id: ${sessionId}`).click()
    await page.waitForURL(new RegExp(`/terminals/${sessionId}`))
    await expect(page.getByText('Status: connected')).toBeVisible({ timeout: 20_000 })

    await page.goto('/terminals')
    await expect(page.getByText(`Session id: ${sessionId}`)).toBeVisible()

    await page.getByText(`Session id: ${sessionId}`).click()
    await page.waitForURL(new RegExp(`/terminals/${sessionId}`))
    await expect(page.getByText('Status: connected')).toBeVisible({ timeout: 15_000 })
  })
})
