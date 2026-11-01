import { afterAll, beforeAll, expect, test } from 'bun:test'
import AxeBuilder from '@axe-core/playwright'
import { chromium, expect as browserExpect, type Browser } from '@playwright/test'
import { policyWriteSchema, type PolicyWrite } from '@/lib/platform/policies'

// This fixture exercises the UI against the public JSON contracts. The real Ofz platform fixture separately proves
// gateway/session isolation, policy writes, permission revocation and both Relay consumers.
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const human = 'a'.repeat(64)
const identities = ['spiffe://proompteng.ai/ns/fixture/sa/first', 'spiffe://proompteng.ai/ns/fixture/sa/second']
let browser: Browser
let server: ReturnType<typeof Bun.serve>
let base: string
let writes: PolicyWrite[] = []
let applications = 0
let loseReply = true
let requireMfa = false
const outcomes = new Map<string, string>()
const grants = new Map<string, string[]>([
  [identities[0]!, ['status_reader']],
  [identities[1]!, []],
])
const metadata = {
  id: workspace,
  name: 'Lab',
  resources: [{ name: 'Tengri', resource: { kind: 'kubernetes.namespace', id: 'galactic/namespace-uid' } }],
}
const detail = {
  workspace: metadata,
  policyVersion: '20',
  members: [
    {
      humanId: human,
      githubId: '1',
      displayName: 'Alex',
      role: 'PLATFORM_WORKSPACE_ROLE_ADMINISTRATOR',
      admitted: true,
    },
  ],
  clients: [{ client: { id: 'fixture', displayName: 'Fixture client', identities }, enabled: true }],
}
beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL('./admin-browser.fixture.tsx', import.meta.url).pathname],
    target: 'browser',
    minify: true,
    plugins: [
      {
        name: 'fixture-navigation',
        setup(build) {
          build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }))
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `const router={push:(path)=>window.location.assign(path),replace:(path)=>window.location.replace(path),refresh:()=>window.location.reload()};export function useRouter(){return router}`,
            loader: 'js',
          }))
        },
      },
    ],
  })
  if (!bundle.success) throw new AggregateError(bundle.logs, 'Portal fixture bundle failed')
  const script = await bundle.outputs[0]!.text()
  const stylesheet = process.env.PLATFORM_UI_STYLESHEET ? await Bun.file(process.env.PLATFORM_UI_STYLESHEET).text() : ''
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/fixture.css') return new Response(stylesheet, { headers: { 'Content-Type': 'text/css' } })
      if (url.pathname === '/fixture-font.woff2')
        return new Response(Bun.file(new URL('../../../public/tengri/fonts/GeistSans.woff2', import.meta.url)), {
          headers: { 'Content-Type': 'font/woff2' },
        })
      if (url.pathname === '/fixture.js')
        return new Response(script, { headers: { 'Content-Type': 'text/javascript' } })
      if (url.pathname === '/api/platform/workspaces')
        return Response.json({ workspaces: [metadata, { id: other, name: 'Other workspace' }] })
      if (url.pathname === `/api/platform/workspaces/${workspace}`) return Response.json(detail)
      if (url.pathname.startsWith(`/api/platform/workspaces/${other}`))
        return Response.json({ error: 'Workspace access was removed.' }, { status: 403 })
      if (url.pathname === `/api/platform/workspaces/${workspace}/activity`)
        return Response.json({
          receipts: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              createdAtUnixMs: '1793510000000',
              platformWorkspaceId: workspace,
              platformAction: 'relay.execution.succeeded',
              allowed: true,
              reason: 'Connector operation completed',
              platformClient: 'OpenCode',
            },
          ],
        })
      if (url.pathname === '/api/platform/policies') {
        if (request.method === 'GET') {
          if (url.searchParams.size)
            return Response.json({
              policyVersion: '20',
              relations: grants.get(url.searchParams.get('subjectId') || '') || [],
            })
          return Response.json({
            policyVersion: '20',
            policyCatalogJson: JSON.stringify({
              version: 1,
              actions: [],
              resources: [
                {
                  kind: 'kubernetes.namespace',
                  workspaceScoped: true,
                  relations: [
                    { name: 'status_reader', subjects: ['human', 'workload'] },
                    { name: 'log_reader', subjects: ['human', 'workload'] },
                    { name: 'status_workspace', subjects: ['workspace'] },
                    { name: 'log_workspace', subjects: ['workspace'] },
                  ],
                },
              ],
            }),
          })
        }
        const write = policyWriteSchema.parse(await request.json())
        writes.push(write)
        if (requireMfa) return Response.json({ error: 'Verify with your passkey before continuing.' }, { status: 428 })
        if (!outcomes.has(write.operationId)) {
          applications++
          outcomes.set(write.operationId, '22222222-2222-4222-8222-222222222222')
          for (const change of write.relationships) {
            const previous = grants.get(change.subjectId) || []
            grants.set(
              change.subjectId,
              change.enabled
                ? [...new Set([...previous, change.relation])]
                : previous.filter((value) => value !== change.relation),
            )
          }
          if (loseReply) {
            loseReply = false
            return Response.json({ error: 'The response was lost.' }, { status: 503 })
          }
        }
        return Response.json({ decision: { allowed: true, auditReceiptId: outcomes.get(write.operationId) } })
      }
      if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Not found' }, { status: 404 })
      return new Response(
        `<!doctype html><html class="dark"><head><title>Workspace administration fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>${stylesheet ? '@font-face{font-family:FixtureGeist;src:url(/fixture-font.woff2)}:root{--font-geist-sans:FixtureGeist}' : '[data-slot="checkbox"]{display:inline-flex;width:18px;height:18px}[data-slot="dialog-content"]{position:fixed;inset:15%;background:#18181b;padding:24px}[data-slot="dialog-backdrop"]{position:fixed;inset:0;background:#0008}input{font-size:16px}'}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        { headers: { 'Content-Type': 'text/html' } },
      )
    },
  })
  base = `http://127.0.0.1:${server.port}`
  browser = await chromium.launch({ headless: true })
}, 30_000)
afterAll(async () => {
  await browser?.close()
  server?.stop(true)
})

test('changes only selected permissions and recovers the exact pending operation after reload', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${base}/workspaces/${workspace}/integrations`)
    const panel = page.getByRole('region', { name: 'Resource access', exact: true })
    await panel.getByLabel('Who can use it', { exact: true }).click()
    await page.getByRole('option', { name: 'Fixture client', exact: true }).click()
    await browserExpect(panel.getByRole('checkbox', { name: 'Pod status', exact: true })).toHaveAttribute(
      'aria-checked',
      'mixed',
    )
    await browserExpect(panel.getByRole('button', { name: 'Save access', exact: true })).toBeDisabled()
    await panel.getByRole('checkbox', { name: 'Pod logs', exact: true }).check()
    await panel.getByLabel('Reason for this change', { exact: true }).fill('Approve bounded diagnostic logs')
    await panel.getByRole('button', { name: 'Save access', exact: true }).click()
    await browserExpect(panel.getByText('The response was lost.', { exact: true })).toBeVisible()
    expect(writes).toHaveLength(1)
    expect(writes[0]!.relationships).toEqual(
      identities.map((subjectId) => ({
        resource: { kind: 'kubernetes.namespace', id: 'galactic/namespace-uid' },
        relation: 'log_reader',
        subjectKind: 'workload',
        subjectId,
        enabled: true,
      })),
    )
    const original = structuredClone(writes[0]!)
    await page.reload()
    await panel.getByRole('button', { name: 'Retry saved change', exact: true }).click()
    await browserExpect(panel.getByText('Access updated.', { exact: true })).toBeVisible()
    expect(writes[1]).toEqual(original)
    expect(applications).toBe(1)
    expect(grants.get(identities[0]!)).toEqual(['status_reader', 'log_reader'])
    expect(grants.get(identities[1]!)).toEqual(['log_reader'])
  } finally {
    await page.close()
  }
}, 30_000)

test('keeps verification beside its access change and removes stale content after changing workspaces', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    requireMfa = true
    await page.goto(`${base}/workspaces/${workspace}/integrations`)
    const clients = page.getByRole('region', { name: 'Workspace clients', exact: true })
    await clients.getByRole('button', { name: 'Disable', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason', { exact: true }).fill('Remove this client from the workspace')
    await dialog.getByRole('button', { name: 'Disable client', exact: true }).click()
    await browserExpect(dialog.getByRole('button', { name: 'Verify & continue', exact: true })).toBeVisible()
    await browserExpect(page.getByRole('button', { name: 'Verify & continue', exact: true })).toHaveCount(1)
    await page.reload()
    await page.getByLabel('Workspace', { exact: true }).click()
    await page.getByRole('option', { name: 'Other workspace', exact: true }).click()
    await browserExpect(page.getByRole('alert')).toContainText('Workspace access was removed.')
    await browserExpect(page.getByRole('region', { name: 'Resource access', exact: true })).toHaveCount(0)
    await browserExpect(page.getByRole('region', { name: 'Workspace clients', exact: true })).toHaveCount(0)
  } finally {
    requireMfa = false
    await page.close()
  }
}, 30_000)

test('keeps portal navigation and member controls usable on desktop and phones', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  try {
    await page.goto(`${base}/workspaces/${workspace}/integrations`)
    await browserExpect(page.getByRole('region', { name: 'Resource access', exact: true })).toBeVisible()
    if (process.env.PLATFORM_UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: process.env.PLATFORM_UI_SCREENSHOT_DIR + '/portal-desktop.png',
        fullPage: true,
        animations: 'disabled',
      })
    const accessibility = await new AxeBuilder({ page })
      .include('main')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(accessibility.violations).toEqual([])
    await page.getByRole('tab', { name: 'Integrations', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await browserExpect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Add person', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const username = dialog.getByLabel('GitHub username', { exact: true })
    await username.fill('example-member')
    if (process.env.PLATFORM_UI_STYLESHEET)
      expect(
        await username.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(16)
    await page.setViewportSize({ width: 390, height: 500 })
    await browserExpect(username).toHaveValue('example-member')
    if (process.env.PLATFORM_UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: process.env.PLATFORM_UI_SCREENSHOT_DIR + '/portal-phone-keyboard.png',
        fullPage: true,
        animations: 'disabled',
      })
    const bounds = await dialog.boundingBox()
    expect(bounds).toBeTruthy()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(500)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    await context.close()
  }
}, 30_000)
