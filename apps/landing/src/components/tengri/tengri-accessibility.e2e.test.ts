import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { codexModelFixtures } from './codex-models.fixture'

const readyAgent = {
  id: 'microvm-ada',
  displayName: 'Tengri',
  phase: 'ready',
  architecture: 'amd64',
  cpuMillis: 2_000,
  memoryMib: 4_096,
  workspaceGib: 16,
  power: { idleTimeoutMinutes: 60 },
  nodeName: 'ryzen',
  message: '',
  createdAt: '2026-08-26T12:00:00.000Z',
  readyAt: '2026-08-26T12:00:08.000Z',
  lastActivityAt: '2026-08-26T12:30:00.000Z',
  idleDeadline: '2026-08-26T13:30:00.000Z',
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
          previewGatewayOrigin: 'http://localhost:8080',
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
        : action.action === 'codex-models'
          ? { models: codexModelFixtures, nextCursor: null }
          : action.action === 'list-files'
            ? { path: action.path ?? '/', entries: [] }
            : null
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result }) })
  })
}

test('exposes the separate Tengri app, connection state, and accessible controls', async ({ page }) => {
  await mockReadyDesktop(page)
  await page.goto('/')
  const agent = page.getByRole('region', { name: 'Tengri window' })
  await expect(agent).toBeVisible()
  await expect(page.getByText('Connected', { exact: true })).toBeAttached()
  await expect(page.getByLabel('Agent status')).toHaveText('Ready')
  await expect(agent.getByRole('textbox', { name: 'Message your agent' })).toBeFocused()
  await agent.getByRole('button', { name: 'Close Tengri', exact: true }).click()
  await expect(agent).toHaveCount(0)
  const launcher = page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Open Tengri' })
  await launcher.click()
  await expect(agent.getByRole('textbox', { name: 'Message your agent' })).toBeFocused()
  await launcher.hover()
  await expect(launcher.getByRole('tooltip', { includeHidden: true })).toHaveCSS('opacity', '1')
  const seriousViolations = (await new AxeBuilder({ page }).analyze()).violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(seriousViolations).toEqual([])
})
