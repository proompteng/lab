import { afterAll, beforeAll, expect, test } from 'bun:test'
import AxeBuilder from '@axe-core/playwright'
import { chromium, expect as browserExpect, type Browser } from '@playwright/test'
import tailwind from '@tailwindcss/postcss'
import { createRequire } from 'node:module'
import { policyWriteSchema, type PolicyWrite } from '@/lib/platform/policies'
import { accessRequestMutationSchema, type AccessRequestMutation } from '@/lib/platform/access-requests'
import { providerMutationSchema, type ProviderMutation } from '@/lib/platform/provider-connections'

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
let directoryFailures = 0
let loginStarts = 0
let loginReturn = ''
let policyStatus = 0
let staleRequest = false
let activityPages = false
let workspaceDelay = 0
let workspaceStatus = 0
const newHuman = 'b'.repeat(64)
let requestPending = false
let requestLoseReply = false
let requestMfa = false
let providerEnabled = false
let providerConnected = false
let providerLoseReply = false
const providerWrites: ProviderMutation[] = []
const providerOutcomes = new Set<string>()
const requestWrites: AccessRequestMutation[] = []
const requestOutcomes = new Map<string, string>()
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
            contents: `const router={push:(path)=>window.location.assign(path),replace:(path)=>window.location.replace(path),refresh:()=>window.dispatchEvent(new Event('fixture-identity-refresh'))};export function useRouter(){return router}`,
            loader: 'js',
          }))
        },
      },
    ],
  })
  if (!bundle.success) throw new AggregateError(bundle.logs, 'Portal fixture bundle failed')
  const script = await bundle.outputs[0]!.text()
  const source = new URL('../../app/globals.css', import.meta.url)
  const postcss = createRequire(import.meta.resolve('@tailwindcss/postcss'))('postcss')
  const stylesheet = (
    await postcss([tailwind({ base: new URL('../../../', import.meta.url).pathname })]).process(
      await Bun.file(source).text(),
      { from: source.pathname },
    )
  ).css
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
      if (url.pathname === '/api/platform/workspaces') {
        if (directoryFailures > 0) {
          directoryFailures--
          return Response.json({ error: 'Workspace discovery is temporarily unavailable.' }, { status: 503 })
        }
        return Response.json({ workspaces: [metadata, { id: other, name: 'Other workspace' }] })
      }
      if (url.pathname === '/api/auth/logout') return Response.json({ loggedOut: true })
      if (url.pathname === '/api/platform/provider-connections') {
        if (request.method === 'GET')
          return Response.json({
            connections:
              providerEnabled && url.searchParams.get('workspaceId') === workspace
                ? [
                    {
                      profileId: 'inventory',
                      name: 'Shared inventory',
                      connectorId: 'inventory',
                      workspaceManaged: true,
                      connectionId: '77777777-7777-4777-8777-777777777777',
                      state: providerConnected
                        ? 'PROVIDER_CONNECTION_STATE_READY'
                        : 'PROVIDER_CONNECTION_STATE_DISCONNECTED',
                      accountName: providerConnected ? 'Team inventory' : '',
                      providerScopes: ['items.read'],
                    },
                  ]
                : [],
          })
        const write = providerMutationSchema.parse(await request.json())
        providerWrites.push(write)
        if (write.kind === 'begin')
          return Response.json({
            authorizationUrl: 'https://oauth.workspace.fixture/authorize',
            connectionId: '77777777-7777-4777-8777-777777777777',
          })
        providerOutcomes.add(write.operationId)
        providerConnected = false
        if (providerLoseReply) {
          providerLoseReply = false
          return Response.json({ error: 'The account disconnect response was lost.' }, { status: 503 })
        }
        return Response.json({
          decision: { allowed: true, auditReceiptId: '22222222-2222-4222-8222-222222222222' },
          providerRevocationConfirmed: true,
        })
      }
      if (['/api/auth/login', '/api/auth/step-up', '/api/auth/add-passkey'].includes(url.pathname)) {
        loginReturn = request.headers.get('x-platform-return-path') || ''
        loginStarts++
        return Response.json({ url: url.origin + '/signed-in' })
      }
      if (url.pathname === '/api/platform/access-requests') {
        if (request.method === 'GET')
          return Response.json({
            requests: (url.searchParams.get('history') === 'true' ? requestOutcomes.size > 0 : requestPending)
              ? [
                  {
                    id: '44444444-4444-4444-8444-444444444444',
                    requesterHumanId: human,
                    clientService: 'fixture',
                    scope: {
                      workspaceId: workspace,
                      workspaceName: 'Lab',
                      resourceName: 'Tengri',
                      resource: metadata.resources[0]!.resource,
                      actions: ['kubernetes.logs.read'],
                    },
                    reason: 'Investigate an application crash',
                    state:
                      url.searchParams.get('history') === 'true'
                        ? 'PLATFORM_ACCESS_REQUEST_STATE_APPROVED'
                        : 'PLATFORM_ACCESS_REQUEST_STATE_PENDING',
                    decisionReason:
                      url.searchParams.get('history') === 'true' ? 'Approved requested workspace access' : '',
                    createdAtUnixMs: '1793510000000',
                    updatedAtUnixMs: '1793510000000',
                  },
                ]
              : [],
          })
        const write = accessRequestMutationSchema.parse(await request.json())
        requestWrites.push(write)
        if (staleRequest) {
          requestPending = false
          return Response.json({ error: 'Another administrator already decided this request.' }, { status: 409 })
        }
        if (requestMfa) return Response.json({ error: 'Verify with your passkey before continuing.' }, { status: 428 })
        if (!requestOutcomes.has(write.operationId)) {
          requestOutcomes.set(write.operationId, crypto.randomUUID())
          requestPending = false
          if (requestLoseReply) {
            requestLoseReply = false
            return Response.json({ error: 'The approval response was lost.' }, { status: 503 })
          }
        }
        return Response.json({ decision: { allowed: true, auditReceiptId: requestOutcomes.get(write.operationId) } })
      }
      if (url.pathname === `/api/platform/workspaces/${workspace}/people`)
        return Response.json({ humanId: newHuman, name: 'Synthetic teammate' })
      if (url.pathname === `/api/platform/workspaces/${workspace}`) {
        if (workspaceDelay) await Bun.sleep(workspaceDelay)
        if (workspaceStatus)
          return Response.json(
            { error: workspaceStatus === 401 ? 'Your session expired.' : 'Workspace access was removed.' },
            { status: workspaceStatus },
          )
        return Response.json(detail)
      }
      if (url.pathname.startsWith(`/api/platform/workspaces/${other}`))
        return Response.json({ error: 'Workspace access was removed.' }, { status: 403 })
      if (url.pathname === `/api/platform/workspaces/${workspace}/activity`) {
        const all = Array.from({ length: activityPages ? 205 : 1 }, (_, index) => ({
          id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
          sequence: String(1000 - index),
          createdAtUnixMs: '1793510000000',
          platformWorkspaceId: workspace,
          platformAction: index % 2 ? 'ofz.relationships.write' : 'relay.execution.succeeded',
          allowed: index % 3 !== 1,
          reason: 'Synthetic workspace operation',
          platformClient: 'fixture',
          actor: { humanId: human },
          platformResources: ['kubernetes.namespace/galactic/namespace-uid#'],
        }))
        const filtered = all.filter(
          (receipt) =>
            (!url.searchParams.get('cursor') || Number(receipt.sequence) < Number(url.searchParams.get('cursor'))) &&
            (!url.searchParams.get('action') || receipt.platformAction === url.searchParams.get('action')) &&
            (!url.searchParams.get('outcome') || receipt.allowed === (url.searchParams.get('outcome') === 'allowed')) &&
            (!url.searchParams.get('actorId') || url.searchParams.get('actorId') === human),
        )
        return Response.json({
          receipts: filtered.slice(0, 100),
          cursor: filtered.length > 100 ? filtered[99]!.sequence : '',
        })
      }
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
        if (policyStatus)
          return Response.json(
            { error: policyStatus === 401 ? 'Your session expired.' : 'Workspace permission was revoked.' },
            { status: policyStatus },
          )
        if (requireMfa) return Response.json({ error: 'Verify with your passkey before continuing.' }, { status: 428 })
        if (!outcomes.has(write.operationId)) {
          const membership = write.relationships.filter(
            (change) => change.resource.kind === 'platform.workspace' && change.subjectKind === 'human',
          )
          if (membership.length) {
            const subject = membership[0]!.subjectId
            const role = membership.find((change) => change.enabled)?.relation
            const existing = detail.members.find((member) => member.humanId === subject)
            const remainingAdmins = detail.members.filter(
              (member) =>
                member.humanId !== subject &&
                member.admitted &&
                member.role === 'PLATFORM_WORKSPACE_ROLE_ADMINISTRATOR',
            ).length
            if (
              existing?.role === 'PLATFORM_WORKSPACE_ROLE_ADMINISTRATOR' &&
              role !== 'administrator' &&
              !remainingAdmins
            )
              return Response.json({ error: 'Workspace must retain an active administrator.' }, { status: 422 })
            detail.members = detail.members.filter((member) => member.humanId !== subject)
            if (role)
              detail.members.push({
                humanId: subject,
                githubId: existing?.githubId || '2',
                displayName: existing?.displayName || 'Synthetic teammate',
                admitted: true,
                role:
                  role === 'administrator' ? 'PLATFORM_WORKSPACE_ROLE_ADMINISTRATOR' : 'PLATFORM_WORKSPACE_ROLE_MEMBER',
              })
          }
          for (const change of write.relationships.filter(
            (change) => change.resource.kind === 'platform.workspace' && change.relation === 'client',
          )) {
            for (const entry of detail.clients)
              if (entry.client.identities.includes(change.subjectId)) entry.enabled = change.enabled
          }
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
        `<!doctype html><html class="dark" lang="en"><head><meta charset="utf-8"><title>Workspace administration fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>@font-face{font-family:FixtureGeist;src:url(/fixture-font.woff2)}:root{--font-geist-sans:FixtureGeist}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        { headers: { 'Content-Type': 'text/html' } },
      )
    },
  })
  base = `http://127.0.0.1:${server.port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLATFORM_UI_CHROMIUM })
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.stop(true)
})

test('reviews a member request on a phone and retries the original approval after verification and a lost response', async () => {
  requestPending = true
  requestMfa = true
  requestLoseReply = true
  requestWrites.length = 0
  requestOutcomes.clear()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.goto(`${base}/workspaces/${workspace}/requests`)
    const panel = page.getByRole('region', { name: 'Access requests', exact: true })
    await browserExpect(panel.getByText('Investigate an application crash', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Review', exact: true }).click()
    if (process.env.PLATFORM_UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: process.env.PLATFORM_UI_SCREENSHOT_DIR + '/request-review-phone.png',
        fullPage: true,
        animations: 'disabled',
      })
    await panel.getByRole('button', { name: 'Approve access', exact: true }).click()
    await browserExpect(panel.getByRole('button', { name: 'Verify & continue', exact: true })).toBeVisible()
    const original = structuredClone(requestWrites[0])
    requestMfa = false
    await page.reload()
    await panel.getByRole('button', { name: 'Retry saved request', exact: true }).click()
    await browserExpect(panel.getByText('The approval response was lost.', { exact: true })).toBeVisible()
    await page.reload()
    await panel.getByRole('button', { name: 'Retry saved request', exact: true }).click()
    await browserExpect(panel.getByText('No pending access requests.', { exact: true })).toBeVisible()
    expect(requestWrites).toEqual([original, original, original])
    expect(requestOutcomes.size).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    requestPending = false
    requestMfa = false
    await page.close()
  }
}, 30_000)

test('changes only selected permissions and recovers the exact pending operation after reload', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${base}/workspaces/${workspace}/resources`)
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
    await clients.getByRole('button', { name: 'Manage Fixture client', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason', { exact: true }).fill('Remove this client from the workspace')
    await dialog.getByRole('button', { name: 'Disable client', exact: true }).click()
    await browserExpect(dialog.getByRole('button', { name: 'Verify & continue', exact: true })).toBeVisible()
    await browserExpect(page.getByRole('button', { name: 'Verify & continue', exact: true })).toHaveCount(1)
    await page.reload()
    await browserExpect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await browserExpect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
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

test('shows activity at its recorded time in the browser timezone', async () => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Los_Angeles' })
  const page = await context.newPage()
  try {
    await page.goto(`${base}/workspaces/${workspace}/activity`)
    const timestamp = page.getByRole('region', { name: 'Workspace activity', exact: true }).locator('time')
    await browserExpect(timestamp).toHaveAttribute('datetime', '2026-11-01T05:13:20.000Z')
    await browserExpect(timestamp).toHaveText('10/31/2026, 10:13:20 PM')
    if (process.env.PLATFORM_UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: process.env.PLATFORM_UI_SCREENSHOT_DIR + '/activity-timestamp.png',
        fullPage: true,
        animations: 'disabled',
      })
  } finally {
    await context.close()
  }
}, 30_000)

test('keeps portal navigation and member controls usable on desktop and phones', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  try {
    await page.goto(`${base}/workspaces/${workspace}/resources`)
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
    await page.getByRole('link', { name: 'People & access', exact: true }).focus()
    await page.keyboard.press('Enter')
    await browserExpect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Add person', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const username = dialog.getByLabel('GitHub username', { exact: true })
    await username.fill('example-member')
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

test('retries workspace discovery after an initial failure at the portal root', async () => {
  const page = await browser.newPage()
  try {
    directoryFailures = 1
    await page.goto(base)
    await browserExpect(page.getByRole('alert')).toContainText('Workspace discovery is temporarily unavailable.')
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await browserExpect(page.getByRole('region', { name: 'Workspace overview', exact: true })).toBeVisible()
    await browserExpect(page).toHaveURL(`${base}/workspaces/${workspace}/overview`)
  } finally {
    directoryFailures = 0
    await page.close()
  }
}, 30_000)

test('allows signing in after sign-out refreshes identity without remounting the portal', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${base}/workspaces/${workspace}/integrations`)
    await page.getByRole('button', { name: 'Alex', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
    const signIn = page.getByRole('button', { name: /Continue with GitHub|Opening sign-in/ })
    await browserExpect(signIn).toBeEnabled()
    const before = loginStarts
    await signIn.click()
    await browserExpect.poll(() => loginStarts).toBe(before + 1)
  } finally {
    await page.close()
  }
}, 30_000)

test('connects a shared provider on a phone and retries its original disconnect after a lost response and reload', async () => {
  providerEnabled = true
  providerConnected = false
  providerLoseReply = true
  providerWrites.length = 0
  providerOutcomes.clear()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    await page.route('https://oauth.workspace.fixture/authorize', (route) => {
      providerConnected = true
      return route.fulfill({
        status: 302,
        headers: {
          location:
            base + `/workspaces/${workspace}/connections?platform_connection=connected&provider_profile=inventory`,
        },
        body: '',
      })
    })
    await page.goto(`${base}/workspaces/${workspace}/connections`)
    const panel = page.getByRole('region', { name: 'Workspace accounts', exact: true })
    await panel.getByRole('button', { name: 'Reconnect account', exact: true }).click()
    await browserExpect(panel.getByText('Account connected.', { exact: true })).toBeVisible()
    await browserExpect(panel.getByText('Team inventory · Connected', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Disconnect account', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm disconnect', exact: true }).click()
    await browserExpect(panel.getByRole('alert')).toHaveText('The account disconnect response was lost.')
    const original = structuredClone(providerWrites.at(-1))
    if (original?.kind !== 'disconnect') throw new Error('Expected a saved provider disconnect')
    await page.reload()
    await browserExpect(panel.getByRole('button', { name: 'Retry disconnect', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Retry disconnect', exact: true }).click()
    await browserExpect(panel.getByText('Account disconnected.', { exact: true })).toBeVisible()
    expect(providerWrites.filter((write) => write.kind === 'disconnect')).toEqual([original, original])
    expect(providerOutcomes.size).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    providerEnabled = false
    await page.close()
  }
}, 20_000)

for (const width of [390, 768, 1440]) {
  test(`all administration pages are accessible at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    try {
      for (const section of [
        'overview',
        'people',
        'integrations',
        'resources',
        'connections',
        'requests',
        'activity',
        'settings',
      ]) {
        await page.goto(`${base}/workspaces/${workspace}/${section}`)
        await browserExpect(page.getByRole('heading', { level: 1 })).toBeVisible()
        await browserExpect(page.getByLabel('Loading workspace', { exact: true })).toHaveCount(0)
        await browserExpect(page.getByLabel('Loading page', { exact: true })).toHaveCount(0)
        await page.evaluate(() => document.fonts.ready)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations,
        ).toEqual([])
        if (process.env.PLATFORM_UI_SCREENSHOT_DIR)
          await page.screenshot({
            path: `${process.env.PLATFORM_UI_SCREENSHOT_DIR}/${section}-${width}.png`,
            fullPage: true,
            animations: 'disabled',
          })
      }
    } finally {
      await context.close()
    }
  }, 60_000)
}

test('onboards, updates and removes an admitted member with validation and last-admin protection', async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(7000)
  loseReply = false
  try {
    await page.goto(`${base}/workspaces/${workspace}/people`)
    await page.getByRole('button', { name: 'Manage Alex', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await browserExpect(
      dialog.getByText('Add another active administrator before demoting or removing this person.'),
    ).toBeVisible()
    await dialog.getByLabel('Workspace role').click()
    await browserExpect(page.getByRole('option', { name: 'Remove from workspace' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Add person', exact: true }).click()
    await dialog.getByLabel('GitHub username').fill('synthetic-teammate')
    await dialog.getByRole('button', { name: 'Save access', exact: true }).click()
    await browserExpect(dialog.getByText('Explain the access change')).toBeVisible()
    await dialog.getByLabel('Reason', { exact: true }).fill('Onboard synthetic workspace teammate')
    await dialog.getByRole('button', { name: 'Save access', exact: true }).click()
    await browserExpect(page.getByRole('button', { name: 'Manage Synthetic teammate' })).toBeVisible()
    await page.getByRole('button', { name: 'Manage Synthetic teammate' }).click()
    await dialog.getByLabel('Workspace role').click()
    await page.getByRole('option', { name: 'Administrator', exact: true }).click()
    await dialog.getByLabel('Reason', { exact: true }).fill('Share workspace administration')
    await dialog.getByRole('button', { name: 'Save access', exact: true }).click()
    await browserExpect(dialog).toBeHidden()
    expect(detail.members.find((member) => member.humanId === newHuman)?.role).toBe(
      'PLATFORM_WORKSPACE_ROLE_ADMINISTRATOR',
    )
    await page.getByRole('button', { name: 'Manage Synthetic teammate' }).click()
    await dialog.getByLabel('Workspace role').click()
    await page.getByRole('option', { name: 'Remove from workspace', exact: true }).click()
    await dialog.getByLabel('Reason', { exact: true }).fill('Complete synthetic onboarding acceptance')
    const before = applications
    await dialog.getByRole('button', { name: 'Save access', exact: true }).click()
    await browserExpect(dialog.getByText('Confirm removal before continuing')).toBeVisible()
    expect(applications).toBe(before)
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Save access', exact: true }).click()
    await browserExpect(page.getByRole('button', { name: 'Manage Synthetic teammate' })).toHaveCount(0)
    expect(detail.members.some((member) => member.humanId === newHuman)).toBe(false)
  } finally {
    detail.members = detail.members.filter((member) => member.humanId === human)
    await page.close()
  }
}, 30_000)

test('retains the exact change after permission loss and session expiration, preserving the sign-in destination', async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(7000)
  try {
    await page.goto(`${base}/workspaces/${workspace}/integrations`)
    await page.getByRole('button', { name: 'Manage Fixture client' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason', { exact: true }).fill('Synthetic client access change')
    const before = applications
    policyStatus = 403
    await dialog.getByRole('button', { name: 'Disable client', exact: true }).click()
    await browserExpect(dialog.getByText('Workspace permission was revoked.')).toBeVisible()
    const original = structuredClone(writes.at(-1))
    expect(applications).toBe(before)
    await page.reload()
    await dialog.getByRole('button', { name: 'Retry saved change' }).click()
    await browserExpect(dialog.getByText('Workspace permission was revoked.')).toBeVisible()
    expect(writes.at(-1)).toEqual(original)
    policyStatus = 401
    await dialog.getByRole('button', { name: 'Retry saved change' }).click()
    await browserExpect(dialog.getByText('Your session expired.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Verify & continue' }).click()
    await browserExpect.poll(() => loginReturn).toBe(`/workspaces/${workspace}/integrations?client=fixture`)
    expect(applications).toBe(before)
  } finally {
    policyStatus = 0
    await page.close()
  }
}, 30_000)

test('shows the authoritative stale approval outcome and decided request history', async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(7000)
  requestPending = true
  requestOutcomes.set('synthetic-decided-request', 'synthetic-receipt')
  try {
    await page.goto(`${base}/workspaces/${workspace}/requests`)
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    staleRequest = true
    await page.getByRole('button', { name: 'Approve access' }).click()
    await browserExpect(page.getByText('Another administrator already decided this request.')).toBeVisible()
    await browserExpect(page.getByText('No pending access requests.')).toBeVisible()
    await page.getByRole('tab', { name: 'History', exact: true }).click()
    await browserExpect(page.getByText('Decision reason: Approved requested workspace access')).toBeVisible()
    await browserExpect(page.getByRole('button', { name: 'Approve access' })).toHaveCount(0)
    await page.reload()
    await browserExpect(page.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  } finally {
    staleRequest = false
    requestPending = false
    await page.close()
  }
}, 20_000)

test('activity filters apply before cursor pagination and survive reload and browser history', async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(7000)
  activityPages = true
  try {
    await page.goto(`${base}/workspaces/${workspace}/activity`)
    const panel = page.getByRole('region', { name: 'Workspace activity' })
    await browserExpect(panel.locator('li')).toHaveCount(100)
    await panel.getByRole('button', { name: 'Load earlier activity' }).click()
    await browserExpect(page).toHaveURL(/cursor=901/)
    await page.reload()
    await browserExpect(panel.locator('li')).toHaveCount(100)
    await page.getByLabel('Outcome', { exact: true }).click()
    await page.getByRole('option', { name: 'Denied', exact: true }).click()
    await browserExpect(page).not.toHaveURL(/cursor=/)
    await browserExpect(panel.locator('li')).toHaveCount(68)
    await page.getByLabel('Exact action').fill('ofz.relationships.write')
    await page.getByRole('button', { name: 'Apply action filter' }).click()
    await browserExpect(panel.locator('li')).toHaveCount(34)
    await page.goBack()
    await browserExpect(panel.locator('li')).toHaveCount(68)
    await page.goForward()
    await browserExpect(panel.locator('li')).toHaveCount(34)
    await panel.locator('summary').first().click()
    await browserExpect(
      panel.getByText('kubernetes.namespace/galactic/namespace-uid#', { exact: true }).first(),
    ).toBeVisible()
  } finally {
    activityPages = false
    await page.close()
  }
}, 25_000)

test('recovers loading, denied and expired-session routes without exposing workspace panels', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  try {
    workspaceDelay = 1000
    await page.goto(`${base}/workspaces/${workspace}/people`)
    await browserExpect(page.getByLabel('Loading workspace', { exact: true })).toBeVisible()
    if (process.env.PLATFORM_UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.PLATFORM_UI_SCREENSHOT_DIR}/people-loading-390.png`,
        fullPage: true,
      })
    await browserExpect(page.getByRole('button', { name: 'Add person' })).toBeVisible()
    workspaceDelay = 0
    workspaceStatus = 403
    await page.reload()
    await browserExpect(page.getByRole('alert')).toContainText('Workspace access denied')
    await browserExpect(page.getByRole('button', { name: 'Add person' })).toHaveCount(0)
    if (process.env.PLATFORM_UI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.PLATFORM_UI_SCREENSHOT_DIR}/people-denied-390.png`, fullPage: true })
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations,
    ).toEqual([])
    workspaceStatus = 401
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await browserExpect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await browserExpect.poll(() => loginReturn).toBe(`/workspaces/${workspace}/people`)
  } finally {
    workspaceDelay = 0
    workspaceStatus = 0
    await context.close()
  }
}, 20_000)

test('collection search, paging and detail URLs survive reload and browser navigation', async () => {
  const context = await browser.newContext({ viewport: { width: 768, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  const original = structuredClone(detail.members)
  try {
    for (let index = 0; index < 24; index++)
      detail.members.push({
        humanId: (index + 2).toString(16).padStart(64, '0'),
        githubId: String(index + 100),
        displayName: `Synthetic ${String(index).padStart(2, '0')}`,
        role: 'PLATFORM_WORKSPACE_ROLE_MEMBER',
        admitted: true,
      })
    await page.goto(`${base}/workspaces/${workspace}/people`)
    await browserExpect(page.getByRole('status')).toContainText('25 results')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await browserExpect(page.getByRole('status')).toContainText('Page 2 of 2')
    await page.reload()
    await browserExpect(page.getByRole('status')).toContainText('Page 2 of 2')
    await page.getByLabel('Search people').fill('Synthetic 23')
    await browserExpect(page.getByRole('status')).toContainText('1 results')
    await page.getByRole('button', { name: 'Manage Synthetic 23' }).click()
    await browserExpect(page).toHaveURL(/person=/)
    await page.reload()
    await browserExpect(page.getByRole('dialog').getByRole('heading', { name: 'Synthetic 23' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.goBack()
    await browserExpect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByLabel('Search people').fill('no such synthetic member')
    await browserExpect(
      page.getByText('No people match these filters. Clear the search or add an admitted person.'),
    ).toBeVisible()
    if (process.env.PLATFORM_UI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.PLATFORM_UI_SCREENSHOT_DIR}/people-empty-768.png`, fullPage: true })
  } finally {
    detail.members = original
    await context.close()
  }
}, 25_000)

test('enrolls and disables registered clients without creating resource grants', async () => {
  const page = await browser.newPage()
  page.setDefaultTimeout(7000)
  loseReply = false
  detail.clients[0]!.enabled = false
  try {
    await page.goto(`${base}/workspaces/${workspace}/integrations?client=fixture`)
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason', { exact: true }).fill('Enroll synthetic application')
    await dialog.getByRole('button', { name: 'Enable client' }).click()
    await browserExpect(dialog).toBeHidden()
    expect(detail.clients[0]!.enabled).toBe(true)
    expect(writes.at(-1)?.relationships).toEqual(
      identities.map((subjectId) => ({
        resource: { kind: 'platform.workspace', id: workspace },
        relation: 'client',
        subjectKind: 'workload',
        subjectId,
        enabled: true,
      })),
    )
    await page.getByRole('button', { name: 'Manage Fixture client' }).click()
    await dialog.getByRole('link', { name: 'Inspect resource grants' }).click()
    await browserExpect(page.getByLabel('Who can use it')).toContainText('Fixture client')
    await page.goto(`${base}/workspaces/${workspace}/integrations?client=fixture`)
    await dialog.getByLabel('Reason', { exact: true }).fill('Disable synthetic application')
    await dialog.getByRole('button', { name: 'Disable client' }).click()
    await browserExpect(dialog).toBeHidden()
    expect(detail.clients[0]!.enabled).toBe(false)
    await page.goto(`${base}/workspaces/${workspace}/resources?recipient=fixture`)
    await browserExpect(page.getByRole('alert')).toContainText(
      'This recipient is not currently eligible in this workspace.',
    )
    await browserExpect(page.getByRole('button', { name: 'Save access' })).toBeDisabled()
  } finally {
    detail.clients[0]!.enabled = true
    await page.close()
  }
}, 25_000)
