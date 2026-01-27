import { expect, test } from '@playwright/test'

const repository = 'proompteng/lab'

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
    ({ repositoryValue }) => {
      const originalFetch = window.fetch.bind(window)
      const atlasCalls: { pathname: string; url: string; timestamp: number }[] = []
      window.__atlasCalls = atlasCalls

      const jsonResponse = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })

      const recordCall = (pathname: string, url: string) => {
        atlasCalls.push({ pathname, url, timestamp: Date.now() })
      }

      const buildItem = (index: number) => ({
        repository: repositoryValue,
        ref: 'main',
        commit: `deadbeef${index}`,
        path: `services/jangar/src/routes/file-${index}.ts`,
        updatedAt: `2024-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
        score: Number((0.98 - index * 0.01).toFixed(3)),
        summary: `Summary for file ${index}`,
        fileVersionId: `fv-${index}`,
        tags: ['atlas', 'search'],
      })

      const buildItems = (count: number) => Array.from({ length: count }, (_, idx) => buildItem(idx + 1))

      const totalMatches = 42

      window.fetch = async (input, init) => {
        const rawUrl = typeof input === 'string' ? input : input.url
        const resolvedUrl = new URL(rawUrl, window.location.origin)
        const pathname = resolvedUrl.pathname

        if (pathname === '/api/memories/count') return jsonResponse({ ok: true, count: 0 })
        if (pathname === '/api/memories') return jsonResponse({ ok: true, memories: [] })

        if (pathname === '/api/search') {
          recordCall(pathname, resolvedUrl.toString())
          const limitRaw = resolvedUrl.searchParams.get('limit') ?? '0'
          const limit = Number.parseInt(limitRaw, 10)
          const items = Number.isFinite(limit) && limit > 0 ? buildItems(limit) : []
          return jsonResponse({ ok: true, items, total: totalMatches })
        }

        if (pathname === '/api/atlas/file') {
          recordCall(pathname, resolvedUrl.toString())
          const path = resolvedUrl.searchParams.get('path') ?? ''
          const truncated = path.includes('file-2.ts')
          const content = truncated
            ? ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n')
            : `// ${path}\nexport const filePath = '${path}'\n`
          return jsonResponse({
            ok: true,
            repository: repositoryValue,
            ref: 'main',
            path,
            truncated,
            content,
          })
        }

        if (pathname === '/api/atlas/ast') {
          recordCall(pathname, resolvedUrl.toString())
          const fileVersionId = resolvedUrl.searchParams.get('fileVersionId') ?? 'unknown'
          return jsonResponse({
            ok: true,
            fileVersionId,
            summary: `AST summary for ${fileVersionId}`,
            facts: [
              {
                nodeType: 'FunctionDeclaration',
                matchText: 'loadData',
                startLine: 12,
                endLine: 18,
              },
              {
                nodeType: 'CallExpression',
                matchText: 'searchAtlas',
                startLine: 22,
                endLine: 22,
              },
            ],
          })
        }

        if (pathname === '/api/enrich') {
          return jsonResponse({ ok: true })
        }

        return originalFetch(input, init)
      }
    },
    { repositoryValue: repository },
  )

  await page.addStyleTag({ content: disableMotionStyles })
})

test('paginates atlas results and keeps URL in sync', async ({ page }) => {
  await page.goto('/atlas/search?query=vector&limit=10&page=1')

  await expect(page.getByRole('heading', { name: 'Search', level: 1 })).toBeVisible()
  await page.waitForFunction(() =>
    (window as typeof window & { __atlasCalls?: Array<{ pathname: string; url: string }> }).__atlasCalls?.some(
      (call) => call.pathname === '/api/search' && call.url.includes('limit=10'),
    ),
  )
  await expect(page.getByText('1-10 of 42')).toBeVisible()
  await expect(page.getByText('Page 1/5')).toBeVisible()
  await expect(page.getByText('services/jangar/src/routes/file-1.ts')).toBeVisible()

  const pagination = page.getByRole('navigation', { name: 'pagination' })
  await pagination.getByRole('button', { name: '2', exact: true }).click()
  await page.waitForFunction(() =>
    (window as typeof window & { __atlasCalls?: Array<{ pathname: string; url: string }> }).__atlasCalls?.some(
      (call) => call.pathname === '/api/search' && call.url.includes('limit=20'),
    ),
  )

  await expect(page).toHaveURL(/page=2/)
  await expect(page.getByText('11-20 of 42')).toBeVisible()
  await expect(page.getByText('services/jangar/src/routes/file-11.ts')).toBeVisible()
  await expect(page.getByText('services/jangar/src/routes/file-1.ts')).toHaveCount(0)
})

test('opens preview, loads content + ast, and reflects panel state in URL', async ({ page }) => {
  await page.goto('/atlas/search?query=vector&limit=10&page=1')

  const targetPath = 'services/jangar/src/routes/file-2.ts'
  await expect(page.getByText(targetPath)).toBeVisible()

  await page.getByText(targetPath).click()
  await page.waitForFunction(() =>
    (window as typeof window & { __atlasCalls?: Array<{ pathname: string; url: string }> }).__atlasCalls?.some(
      (call) => call.pathname === '/api/atlas/file' && call.url.includes('file-2.ts'),
    ),
  )

  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('heading', { name: targetPath })).toBeVisible()
  await expect(page.getByText('Showing the first 5 lines (truncated for performance).')).toBeVisible()
  await expect(page.getByText('line 5')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Enrich' })).toBeVisible()
  await expect(page).toHaveURL(/panelOpen=true/)
  await expect(page).toHaveURL(new RegExp(`panelPath=${encodeURIComponent(targetPath)}`))
  await expect(page).toHaveURL(/panelFileVersionId=fv-2/)

  await page.getByRole('button', { name: 'AST' }).click()
  await page.waitForFunction(() =>
    (window as typeof window & { __atlasCalls?: Array<{ pathname: string; url: string }> }).__atlasCalls?.some(
      (call) => call.pathname === '/api/atlas/ast' && call.url.includes('fileVersionId=fv-2'),
    ),
  )

  await expect(page.getByText('AST summary for fv-2')).toBeVisible()
  await expect(page.getByText('FunctionDeclaration')).toBeVisible()
  await expect(page.getByText('loadData')).toBeVisible()

  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).not.toHaveURL(/panelOpen=true/)
})

test('restores panel state from URL parameters', async ({ page }) => {
  const targetPath = 'services/jangar/src/routes/file-3.ts'
  const targetUrl = [
    '/atlas/search?query=vector&limit=10&page=1&panelOpen=true&panelTab=ast',
    `panelPath=${encodeURIComponent(targetPath)}`,
    `panelRepository=${encodeURIComponent(repository)}`,
    'panelRef=main',
    'panelFileVersionId=fv-3',
  ].join('&')

  await page.goto(targetUrl)
  await page.waitForFunction(() =>
    (window as typeof window & { __atlasCalls?: Array<{ pathname: string; url: string }> }).__atlasCalls?.some(
      (call) => call.pathname === '/api/atlas/file' && call.url.includes('file-3.ts'),
    ),
  )
  await page.waitForFunction(() =>
    (window as typeof window & { __atlasCalls?: Array<{ pathname: string; url: string }> }).__atlasCalls?.some(
      (call) => call.pathname === '/api/atlas/ast' && call.url.includes('fileVersionId=fv-3'),
    ),
  )

  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('heading', { name: targetPath })).toBeVisible()
  await expect(page.getByText('AST summary for fv-3')).toBeVisible()
  await expect(page.getByText('searchAtlas')).toBeVisible()
})
