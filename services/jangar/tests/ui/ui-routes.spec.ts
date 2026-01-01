import { expect, test } from '@playwright/test'

const memoryCount = 12
const torghutSymbolsResponse = {
  items: [
    { assetClass: 'equity', enabled: true, symbol: 'AAPL', updatedAt: '2024-01-01T00:00:00.000Z' },
    { assetClass: 'crypto', enabled: false, symbol: 'BTC-USD', updatedAt: '2024-01-02T00:00:00.000Z' },
  ],
}
const atlasIndexedResponse = {
  ok: true,
  items: [
    {
      repository: 'proompteng/lab',
      ref: 'main',
      commit: '8861e215',
      path: 'services/jangar/src/server/db.ts',
      updatedAt: '2024-01-03T00:00:00.000Z',
    },
  ],
}
const atlasSearchResponse = {
  ok: true,
  total: 1,
  items: [
    {
      repository: 'proompteng/lab',
      ref: 'main',
      commit: '8861e215',
      path: 'services/jangar/src/server/atlas-store.ts',
      updatedAt: '2024-01-02T00:00:00.000Z',
      score: 0.987,
    },
  ],
}
const atlasPathsResponse = {
  ok: true,
  paths: ['services/jangar/src/server/atlas-store.ts', 'services/jangar/src/server/db.ts'],
}
const modelsResponse = {
  object: 'list',
  data: [
    {
      id: 'gpt-4o-mini',
      object: 'model',
      created: 1717171717,
      owned_by: 'openai',
    },
  ],
}
const healthResponse = { status: 'ok', service: 'jangar' }

const disableMotionStyles = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
  }
  * {
    caret-color: transparent !important;
  }
`

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({
      memoryCountValue,
      symbolsValue,
      atlasIndexedValue,
      atlasSearchValue,
      atlasPathsValue,
      modelsValue,
      healthValue,
    }) => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const rawUrl = typeof input === 'string' ? input : input.url
        const resolvedUrl = new URL(rawUrl, window.location.origin)
        const pathname = resolvedUrl.pathname

        const jsonResponse = (payload, status = 200) =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { 'content-type': 'application/json' },
          })

        if (pathname.includes('/_serverFn')) {
          const rawBody =
            typeof init?.body === 'string'
              ? init.body
              : init?.body instanceof URLSearchParams
                ? init.body.toString()
                : undefined
          const isCount =
            rawUrl.includes('countMemories') || (typeof rawBody === 'string' && rawBody.includes('countMemories'))
          const body = JSON.stringify(isCount ? { ok: true, count: memoryCountValue } : { ok: true, memories: [] })
          return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
        }

        if (pathname === '/api/torghut/symbols') {
          if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
            return jsonResponse(symbolsValue)
          }
          return jsonResponse({ ok: true })
        }

        if (pathname === '/api/atlas/indexed') return jsonResponse(atlasIndexedValue)
        if (pathname === '/api/search') return jsonResponse(atlasSearchValue)
        if (pathname === '/api/atlas/paths') return jsonResponse(atlasPathsValue)
        if (pathname === '/api/enrich') return jsonResponse({ ok: true })
        if (pathname === '/openai/v1/models') return jsonResponse(modelsValue)
        if (pathname === '/health') return jsonResponse(healthValue)

        return originalFetch(input, init)
      }
    },
    {
      memoryCountValue: memoryCount,
      symbolsValue: torghutSymbolsResponse,
      atlasIndexedValue: atlasIndexedResponse,
      atlasSearchValue: atlasSearchResponse,
      atlasPathsValue: atlasPathsResponse,
      modelsValue: modelsResponse,
      healthValue: healthResponse,
    },
  )

  await page.addStyleTag({ content: disableMotionStyles })
})

test('home route screenshot', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Memories' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  await expect(page).toHaveScreenshot('home.png', { fullPage: true, animations: 'disabled' })
})

test('memories route screenshot', async ({ page }) => {
  await page.goto('/memories')
  await expect(page.getByRole('button', { name: 'Search' })).toBeVisible()
  await expect(page).toHaveScreenshot('memories.png', { fullPage: true, animations: 'disabled' })
})

test('atlas search route screenshot', async ({ page }) => {
  await page.goto('/atlas/search?query=kysely&repository=proompteng/lab&ref=main')
  await expect(page.getByRole('heading', { name: 'Search' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'services/jangar/src/server/atlas-store.ts' })).toBeVisible()
  await expect(page).toHaveScreenshot('atlas-search.png', { fullPage: true, animations: 'disabled' })
})

test('atlas indexed route screenshot', async ({ page }) => {
  await page.goto('/atlas/indexed')
  await expect(page.getByRole('heading', { name: 'Indexed files' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'services/jangar/src/server/db.ts' })).toBeVisible()
  await expect(page).toHaveScreenshot('atlas-indexed.png', { fullPage: true, animations: 'disabled' })
})

test('atlas enrich route screenshot', async ({ page }) => {
  await page.goto('/atlas/enrich')
  await expect(page.getByRole('heading', { name: 'Enrichment', level: 1 })).toBeVisible()
  await expect(page.getByLabel('Repository')).toHaveValue('proompteng/lab')
  await expect(page).toHaveScreenshot('atlas-enrich.png', { fullPage: true, animations: 'disabled' })
})

test('api models route screenshot', async ({ page }) => {
  await page.goto('/api/models')
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
  await expect(page.getByText('gpt-4o-mini')).toBeVisible()
  await expect(page).toHaveScreenshot('api-models.png', { fullPage: true, animations: 'disabled' })
})

test('api health route screenshot', async ({ page }) => {
  await page.goto('/api/health')
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible()
  await expect(page.getByText('"service": "jangar"')).toBeVisible()
  await expect(page).toHaveScreenshot('api-health.png', { fullPage: true, animations: 'disabled' })
})

test('torghut symbols route screenshot', async ({ page }) => {
  await page.goto('/torghut/symbols')
  await expect(page.getByRole('cell', { name: 'AAPL' })).toBeVisible()
  await expect(page).toHaveScreenshot('torghut-symbols.png', { fullPage: true, animations: 'disabled' })
})
