import { expect, test } from '@playwright/test'

const memoryCount = 12
const torghutSymbolsResponse = {
  items: [
    { assetClass: 'equity', enabled: true, symbol: 'AAPL', updatedAt: '2024-01-01T00:00:00.000Z' },
    { assetClass: 'crypto', enabled: false, symbol: 'BTC-USD', updatedAt: '2024-01-02T00:00:00.000Z' },
  ],
}

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
    ({ memoryCountValue, symbolsValue }) => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url
        if (url.includes('/_serverFn')) {
          const rawBody =
            typeof init?.body === 'string'
              ? init.body
              : init?.body instanceof URLSearchParams
                ? init.body.toString()
                : undefined
          const isCount =
            url.includes('countMemories') || (typeof rawBody === 'string' && rawBody.includes('countMemories'))
          const body = JSON.stringify(isCount ? { ok: true, count: memoryCountValue } : { ok: true, memories: [] })
          return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
        }

        if (url.includes('/api/torghut/symbols')) {
          if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
            return new Response(JSON.stringify(symbolsValue), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

        return originalFetch(input, init)
      }
    },
    { memoryCountValue: memoryCount, symbolsValue: torghutSymbolsResponse },
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

test('torghut symbols route screenshot', async ({ page }) => {
  await page.goto('/torghut/symbols')
  await expect(page.getByRole('cell', { name: 'AAPL' })).toBeVisible()
  await expect(page).toHaveScreenshot('torghut-symbols.png', { fullPage: true, animations: 'disabled' })
})
