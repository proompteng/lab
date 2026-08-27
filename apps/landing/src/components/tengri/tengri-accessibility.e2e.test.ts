import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const readyAgent = {
  id: 'microvm-ada',
  displayName: 'Tengri',
  phase: 'ready',
  architecture: 'amd64',
  cpuMillis: 2_000,
  memoryMib: 4_096,
  workspaceGib: 16,
  nodeName: 'ryzen',
  message: '',
  createdAt: '2026-08-26T12:00:00.000Z',
  readyAt: '2026-08-26T12:00:08.000Z',
  lastActivityAt: '2026-08-26T12:30:00.000Z',
  idleDeadline: '2026-08-26T13:30:00.000Z',
  expiresAt: '2026-08-26T16:00:00.000Z',
  conditions: [],
}

async function mockReadyDesktop(page: Page) {
  await page.addInitScript(() => {
    class HealthyEventSource extends EventTarget {
      static readonly CLOSED = 2
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      readonly CLOSED = 2
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly readyState = 1
      readonly url: string
      readonly withCredentials = false
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onopen: ((event: Event) => void) | null = null

      constructor(url: string | URL) {
        super()
        this.url = String(url)
        queueMicrotask(() => this.onopen?.(new Event('open')))
      }

      close() {}
    }

    Object.defineProperty(window, 'EventSource', { configurable: true, value: HealthyEventSource })
    localStorage.clear()
  })

  await page.route('**/api/tengri', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          authConfigured: true,
          controlPlaneConfigured: true,
          authenticated: true,
          user: { id: '424242', name: 'Ada Lovelace', email: 'ada@example.test', image: null },
          agents: [readyAgent],
        }),
      })
      return
    }

    const action = request.postDataJSON() as { action?: string; path?: string }
    const result =
      action.action === 'codex-account'
        ? { authenticated: true, email: 'ada@example.test', plan: 'pro' }
        : action.action === 'list-files'
          ? { path: action.path ?? '/', entries: [] }
          : null
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result }) })
  })
}

test('exposes usable browser tabs, connection state, and contrast', async ({ page }) => {
  await mockReadyDesktop(page)
  await page.goto('/')

  await expect(page.getByRole('region', { name: 'Chrome window' })).toBeVisible()
  await expect(page.getByText('Connected', { exact: true })).toBeAttached()
  await expect(page.getByText('pro', { exact: true })).toBeVisible()

  const tablist = page.getByRole('tablist', { name: 'Browser tabs' })
  const firstTab = tablist.getByRole('tab', { name: /Tengri Agent/ })
  await expect(firstTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: /Tengri Agent/ })).toBeVisible()

  await page.getByRole('button', { name: 'New tab' }).click()
  const tabs = tablist.getByRole('tab', { name: /Tengri Agent/ })
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

  await tabs.nth(1).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(tabs.nth(0)).toBeFocused()
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('Delete')
  await expect(tablist.getByRole('tab')).toHaveCount(1)
  await expect(tablist.getByRole('tab')).toBeFocused()

  const seriousViolations = (await new AxeBuilder({ page }).analyze()).violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(seriousViolations).toEqual([])
})
