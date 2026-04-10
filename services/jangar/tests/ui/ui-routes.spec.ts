import { expect, test } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? ''
const isLocalBaseURL = !baseURL || /localhost|127\.0\.0\.1/.test(baseURL)

test.skip(!isLocalBaseURL, 'UI snapshot tests are only stable against local renders.')

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
      id: 'gpt-5.4',
      object: 'model',
      created: 1717171717,
      owned_by: 'openai',
    },
  ],
}
const healthResponse = { status: 'ok', service: 'jangar' }
const githubPullsResponse = {
  ok: true,
  items: [
    {
      repository: 'proompteng/lab',
      number: 42,
      title: 'feat: add new PR review UI',
      body: null,
      state: 'open',
      merged: false,
      mergedAt: null,
      draft: false,
      authorLogin: 'octocat',
      authorAvatarUrl: null,
      htmlUrl: 'https://github.com/proompteng/lab/pull/42',
      headRef: 'feature/pr-ui',
      headSha: 'abc123',
      baseRef: 'main',
      baseSha: 'def456',
      mergeable: true,
      mergeableState: 'clean',
      labels: ['frontend'],
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      receivedAt: '2024-01-02T00:00:00.000Z',
      review: { decision: 'approved', requestedChanges: false, unresolvedThreadsCount: 0, latestReviewedAt: null },
      checks: {
        status: 'success',
        detailsUrl: null,
        totalCount: 1,
        successCount: 1,
        failureCount: 0,
        pendingCount: 0,
        runs: [],
      },
    },
  ],
  nextCursor: 'cursor-1',
  capabilities: { reviewsWriteEnabled: true, mergeWriteEnabled: false },
  repositoriesAllowed: ['proompteng/lab'],
  viewerLogin: 'octocat',
}
const githubPullsPageTwoResponse = {
  ok: true,
  items: [
    {
      repository: 'proompteng/lab',
      number: 41,
      title: 'fix: align breadcrumbs with route tree',
      body: null,
      state: 'open',
      merged: false,
      mergedAt: null,
      draft: false,
      authorLogin: 'octocat',
      authorAvatarUrl: null,
      htmlUrl: 'https://github.com/proompteng/lab/pull/41',
      headRef: 'fix/breadcrumbs',
      headSha: 'ghi789',
      baseRef: 'main',
      baseSha: 'def456',
      mergeable: true,
      mergeableState: 'clean',
      labels: ['ui'],
      additions: 4,
      deletions: 1,
      changedFiles: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      receivedAt: '2024-01-02T00:00:00.000Z',
      review: { decision: 'commented', requestedChanges: false, unresolvedThreadsCount: 1, latestReviewedAt: null },
      checks: {
        status: 'pending',
        detailsUrl: null,
        totalCount: 1,
        successCount: 0,
        failureCount: 0,
        pendingCount: 1,
        runs: [],
      },
    },
  ],
  nextCursor: null,
  capabilities: { reviewsWriteEnabled: true, mergeWriteEnabled: false },
  repositoriesAllowed: ['proompteng/lab'],
  viewerLogin: 'octocat',
}
const githubPullsSearchResponse = {
  ok: true,
  items: [
    {
      repository: 'proompteng/lab',
      number: 7,
      title: 'chore: update CI docs',
      body: null,
      state: 'open',
      merged: false,
      mergedAt: null,
      draft: false,
      authorLogin: 'reviewer',
      authorAvatarUrl: null,
      htmlUrl: 'https://github.com/proompteng/lab/pull/7',
      headRef: 'chore/ci-docs',
      headSha: 'xyz123',
      baseRef: 'main',
      baseSha: 'def456',
      mergeable: true,
      mergeableState: 'clean',
      labels: ['docs'],
      additions: 2,
      deletions: 0,
      changedFiles: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      receivedAt: '2024-01-02T00:00:00.000Z',
      review: { decision: 'approved', requestedChanges: false, unresolvedThreadsCount: 0, latestReviewedAt: null },
      checks: {
        status: 'success',
        detailsUrl: null,
        totalCount: 1,
        successCount: 1,
        failureCount: 0,
        pendingCount: 0,
        runs: [],
      },
    },
  ],
  nextCursor: null,
  capabilities: { reviewsWriteEnabled: true, mergeWriteEnabled: false },
  repositoriesAllowed: ['proompteng/lab'],
  viewerLogin: 'octocat',
}
const githubPullDetailResponse = {
  ok: true,
  pull: githubPullsResponse.items[0],
  review: githubPullsResponse.items[0].review,
  checks: githubPullsResponse.items[0].checks,
  issueComments: [
    {
      commentId: '9001',
      authorLogin: 'octocat',
      body: 'Please review the latest changes.',
      createdAt: '2024-01-02T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      url: 'https://github.com/proompteng/lab/pull/42#issuecomment-1',
    },
  ],
  capabilities: { reviewsWriteEnabled: true, mergeWriteEnabled: false },
}
const githubPullFilesResponse = {
  ok: true,
  files: [
    {
      path: 'services/jangar/src/routes/github/pulls.tsx',
      status: 'modified',
      additions: 10,
      deletions: 2,
      changes: 12,
      patch: '@@ -1,1 +1,2 @@',
      blobUrl: null,
      rawUrl: null,
      sha: null,
      previousFilename: null,
    },
  ],
}
const githubPullChecksResponse = {
  ok: true,
  commits: [
    {
      commitSha: 'abc123',
      status: 'success',
      detailsUrl: null,
      totalCount: 1,
      successCount: 1,
      failureCount: 0,
      pendingCount: 0,
      runs: [],
      updatedAt: '2024-01-02T00:00:00.000Z',
    },
  ],
}
const githubPullJudgeRunsResponse = {
  ok: true,
  runs: [],
}
const githubPullRefreshFilesResponse = {
  ok: true,
  commitSha: 'abc123',
  baseSha: 'def456',
  fileCount: 1,
}
const githubPullThreadsResponse = {
  ok: true,
  threads: [
    {
      threadKey: '55',
      threadId: null,
      isResolved: false,
      path: 'services/jangar/src/routes/github/pulls.tsx',
      line: 12,
      side: 'RIGHT',
      startLine: null,
      authorLogin: 'reviewer',
      createdAt: '2024-01-02T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      comments: [
        {
          commentId: '777',
          authorLogin: 'reviewer',
          body: 'Consider simplifying this block.',
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          path: 'services/jangar/src/routes/github/pulls.tsx',
          line: 12,
          side: 'RIGHT',
          startLine: null,
          diffHunk: '@@ -1,1 +1,2 @@',
          url: 'https://github.com/proompteng/lab/pull/42#discussion_r1',
        },
      ],
    },
  ],
}
const controlPlaneImplementationSpecResponse = {
  resource: {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'ImplementationSpec',
    metadata: {
      name: 'ship-trading-ui',
      namespace: 'agents',
      uid: 'spec-1',
      creationTimestamp: '2024-01-01T00:00:00.000Z',
      generation: 3,
    },
    spec: {
      summary: 'Ship trading UI',
      description: 'Deliver the production trading operator flow.',
      text: 'Implement the remaining Jangar operator route cleanup.',
      acceptanceCriteria: ['Loader-backed spec page', 'Behavior coverage for trading'],
      contract: {
        requiredKeys: ['repository', 'issueNumber', 'head'],
      },
    },
  },
  namespace: 'agents',
}
const controlPlaneAgentsResponse = {
  items: [
    {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'Agent',
      metadata: {
        name: 'codex-operator',
        namespace: 'agents',
      },
      spec: {
        providerRef: {
          name: 'codex',
        },
      },
    },
  ],
  total: 1,
  namespace: 'agents',
}
const controlPlaneAgentRunsResponse = {
  items: [
    {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        name: 'run-1',
        namespace: 'agents',
      },
      spec: {
        agentRef: {
          name: 'codex-operator',
        },
        implementationSpecRef: {
          name: 'ship-trading-ui',
        },
        runtime: {
          type: 'workflow',
        },
      },
      status: {
        phase: 'Running',
        conditions: [
          {
            type: 'Ready',
            status: 'True',
          },
        ],
      },
    },
  ],
  total: 1,
  namespace: 'agents',
}
const tradingStrategiesResponse = {
  ok: true,
  items: [
    {
      id: 'strategy-1',
      name: 'Momentum',
      enabled: true,
      baseTimeframe: '1D',
      universeSymbols: ['AAPL', 'MSFT'],
    },
  ],
}
const tradingSummaryResponse = {
  ok: true,
  summary: {
    interval: {
      tz: 'America/New_York',
      day: '2024-01-03',
      startUtc: '2024-01-03T14:30:00.000Z',
      endUtc: '2024-01-03T21:00:00.000Z',
    },
    strategy: {
      id: 'strategy-1',
      name: 'Momentum',
    },
    realizedPnl: {
      value: 1234.56,
      closedQty: 10,
      winRate: 0.6,
      winCount: 6,
      lossCount: 4,
      series: [
        { ts: '2024-01-03T15:00:00.000Z', realizedPnl: 0 },
        { ts: '2024-01-03T20:45:00.000Z', realizedPnl: 1234.56 },
      ],
      warnings: [],
    },
    executions: {
      filledCount: 10,
    },
    decisions: {
      generatedCount: 10,
      plannedCount: 8,
      blockedCount: 2,
      stalePlannedCount: 0,
      executionSubmitAttempts: 8,
      topBlockedReasons: [{ reason: 'risk', count: 2 }],
      submissionFunnel: {
        generatedCount: 10,
        blockedCount: 2,
        submittedCount: 8,
        filledCount: 6,
        rejectedCount: 2,
      },
    },
    rejections: {
      rejectedCount: 2,
      topReasons: [{ reason: 'risk', count: 2 }],
    },
    equity: {
      available: true,
      byAccount: [
        {
          alpacaAccountLabel: 'paper',
          delta: 321.12,
          series: [
            { ts: '2024-01-03T15:00:00.000Z', equity: 100000 },
            { ts: '2024-01-03T20:45:00.000Z', equity: 100321.12 },
          ],
        },
      ],
    },
    runtime: {
      profitability: {
        available: true,
        schemaVersion: 'v1',
        lookbackHours: 24,
        decisionCount: 10,
        executionCount: 6,
        tcaSampleCount: 6,
        realizedPnlProxyNotional: 120.5,
        avgAbsSlippageBps: 3.4,
        caveatCodes: [],
        error: null,
      },
      controlPlane: {
        available: true,
        activeRevision: 'abc1234',
        capitalStage: 'paper',
        capitalStageTotals: [{ stage: 'paper', count: 1 }],
        criticalToggleParity: {
          status: 'ok',
          mismatches: [],
        },
        error: null,
      },
    },
  },
}
const tradingExecutionsResponse = {
  ok: true,
  items: [
    {
      executionId: 'exec-1',
      tradeDecisionId: 'decision-1',
      strategyId: 'strategy-1',
      strategyName: 'Momentum',
      createdAt: '2024-01-03T20:30:00.000Z',
      symbol: 'AAPL',
      side: 'buy',
      filledQty: 10,
      avgFillPrice: 191.23,
      timeframe: '1D',
      alpacaAccountLabel: 'paper',
    },
  ],
}
const tradingDecisionsResponse = {
  ok: true,
  items: [
    {
      id: 'decision-2',
      createdAt: '2024-01-03T16:00:00.000Z',
      alpacaAccountLabel: 'paper',
      symbol: 'MSFT',
      timeframe: '1D',
      status: 'blocked',
      rationale: 'Risk limits exceeded',
      riskReasons: ['max position'],
      strategyId: 'strategy-1',
      strategyName: 'Momentum',
    },
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
    ({
      memoryCountValue,
      symbolsValue,
      atlasIndexedValue,
      atlasSearchValue,
      atlasPathsValue,
      modelsValue,
      healthValue,
      githubPullsResponseValue,
      githubPullsPageTwoResponseValue,
      githubPullsSearchResponseValue,
      githubPullDetailResponseValue,
      githubPullFilesResponseValue,
      githubPullChecksResponseValue,
      githubPullJudgeRunsResponseValue,
      githubPullRefreshFilesResponseValue,
      githubPullThreadsResponseValue,
      controlPlaneImplementationSpecResponseValue,
      controlPlaneAgentsResponseValue,
      controlPlaneAgentRunsResponseValue,
      tradingStrategiesResponseValue,
      tradingSummaryResponseValue,
      tradingExecutionsResponseValue,
      tradingDecisionsResponseValue,
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

        if (pathname === '/api/memories/count') return jsonResponse({ ok: true, count: memoryCountValue })
        if (pathname === '/api/memories') return jsonResponse({ ok: true, memories: [] })

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
        if (pathname === '/api/github/pulls') {
          const cursor = resolvedUrl.searchParams.get('cursor')
          const author = resolvedUrl.searchParams.get('author')
          if (cursor === 'cursor-1') return jsonResponse(githubPullsPageTwoResponseValue)
          if (author === 'reviewer') return jsonResponse(githubPullsSearchResponseValue)
          return jsonResponse(githubPullsResponseValue)
        }
        if (pathname === '/api/github/pulls/proompteng/lab/42') return jsonResponse(githubPullDetailResponseValue)
        if (pathname === '/api/github/pulls/proompteng/lab/42/files') return jsonResponse(githubPullFilesResponseValue)
        if (pathname === '/api/github/pulls/proompteng/lab/42/checks')
          return jsonResponse(githubPullChecksResponseValue)
        if (pathname === '/api/github/pulls/proompteng/lab/42/judge-runs')
          return jsonResponse(githubPullJudgeRunsResponseValue)
        if (pathname === '/api/github/pulls/proompteng/lab/42/refresh-files')
          return jsonResponse(githubPullRefreshFilesResponseValue)
        if (pathname === '/api/github/pulls/proompteng/lab/42/threads')
          return jsonResponse(githubPullThreadsResponseValue)
        if (pathname === '/api/agents/control-plane/resource') {
          const kind = resolvedUrl.searchParams.get('kind')
          const name = resolvedUrl.searchParams.get('name')
          if (kind === 'ImplementationSpec' && name === 'ship-trading-ui') {
            return jsonResponse(controlPlaneImplementationSpecResponseValue)
          }
        }
        if (pathname === '/api/agents/control-plane/resources') {
          const kind = resolvedUrl.searchParams.get('kind')
          if (kind === 'Agent') return jsonResponse(controlPlaneAgentsResponseValue)
          if (kind === 'AgentRun') return jsonResponse(controlPlaneAgentRunsResponseValue)
        }
        if (pathname === '/api/torghut/trading/strategies') return jsonResponse(tradingStrategiesResponseValue)
        if (pathname === '/api/torghut/trading/summary') return jsonResponse(tradingSummaryResponseValue)
        if (pathname === '/api/torghut/trading/executions') return jsonResponse(tradingExecutionsResponseValue)
        if (pathname === '/api/torghut/trading/decisions') return jsonResponse(tradingDecisionsResponseValue)

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
      githubPullsResponseValue: githubPullsResponse,
      githubPullsPageTwoResponseValue: githubPullsPageTwoResponse,
      githubPullsSearchResponseValue: githubPullsSearchResponse,
      githubPullDetailResponseValue: githubPullDetailResponse,
      githubPullFilesResponseValue: githubPullFilesResponse,
      githubPullChecksResponseValue: githubPullChecksResponse,
      githubPullJudgeRunsResponseValue: githubPullJudgeRunsResponse,
      githubPullRefreshFilesResponseValue: githubPullRefreshFilesResponse,
      githubPullThreadsResponseValue: githubPullThreadsResponse,
      controlPlaneImplementationSpecResponseValue: controlPlaneImplementationSpecResponse,
      controlPlaneAgentsResponseValue: controlPlaneAgentsResponse,
      controlPlaneAgentRunsResponseValue: controlPlaneAgentRunsResponse,
      tradingStrategiesResponseValue: tradingStrategiesResponse,
      tradingSummaryResponseValue: tradingSummaryResponse,
      tradingExecutionsResponseValue: tradingExecutionsResponse,
      tradingDecisionsResponseValue: tradingDecisionsResponse,
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
  await expect(page.getByText('services/jangar/src/server/atlas-store.ts')).toBeVisible()
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
  await expect(page.getByText('gpt-5.4')).toBeVisible()
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

test('github pulls route screenshot', async ({ page }) => {
  await page.goto('/github/pulls')
  await expect(page.getByRole('heading', { name: 'PR reviews' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'proompteng/lab#42' })).toBeVisible()
  await expect(page).toHaveScreenshot('github-pulls.png', { fullPage: true, animations: 'disabled' })
})

test('github pulls search and pagination', async ({ page }) => {
  await page.goto('/github/pulls')
  await expect(page.getByLabel('Repository')).toHaveValue('proompteng/lab')
  await expect(page.getByLabel('Author')).toHaveValue('octocat')
  await expect(page).toHaveURL(/repository=proompteng%2Flab/)
  await expect(page).toHaveURL(/author=octocat/)
  await expect(page).toHaveURL(/limit=25/)

  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('cell', { name: 'proompteng/lab#41' })).toBeVisible()
  await expect(page).toHaveURL(/cursor=cursor-1/)
  await expect(page).toHaveURL(/repository=proompteng%2Flab/)
  await expect(page).toHaveURL(/author=octocat/)
  await expect(page).toHaveURL(/limit=25/)

  await page.getByRole('button', { name: 'Previous' }).click()
  await expect(page.getByRole('cell', { name: 'proompteng/lab#42' })).toBeVisible()

  await page.getByLabel('Author').fill('reviewer')
  await page.getByRole('button', { name: 'Filter' }).click()
  await expect(page.getByRole('cell', { name: 'proompteng/lab#7' })).toBeVisible()
  await expect(page).toHaveURL(/author=reviewer/)
  await expect(page).toHaveURL(/repository=proompteng%2Flab/)
  await expect(page).toHaveURL(/limit=25/)
})

test('github pull detail route screenshot', async ({ page }) => {
  await page.goto('/github/pulls/proompteng/lab/42')
  await expect(page.getByRole('heading', { name: 'feat: add new PR review UI' })).toBeVisible()
  await expect(page.getByText('Merge controls')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Submit review' })).toBeEnabled()
  await expect(page).toHaveScreenshot('github-pull-detail.png', { fullPage: true, animations: 'disabled' })
})

test('control-plane implementation spec route loads spec and agents', async ({ page }) => {
  await page.goto('/control-plane/implementation-specs/ship-trading-ui?namespace=agents')
  await expect(page.getByRole('heading', { name: 'Run spec' })).toBeVisible()
  await expect(page.getByText('Ship trading UI', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Agent' })).toContainText('codex-operator')
  await expect(page.getByRole('button', { name: 'Run agent' })).toBeVisible()
})

test('control-plane runs route shows loader-backed runs', async ({ page }) => {
  await page.goto('/control-plane/runs?namespace=agents')
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeVisible()
  await expect(page.getByText('run-1')).toBeVisible()
  await expect(page.getByText('ship-trading-ui')).toBeVisible()
})

test('control-plane primitive aliases render real pages without redirecting', async ({ page }) => {
  await page.goto('/control-plane/agents?namespace=agents')
  await expect(page).toHaveURL(/\/control-plane\/agents\?namespace=agents$/)
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
  await expect(page.getByText('codex-operator')).toBeVisible()
})

test('torghut trading route loads trading summary data', async ({ page }) => {
  await page.goto('/torghut/trading')
  await expect(page.getByRole('heading', { name: 'Trading' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Strategy' })).toContainText('Momentum')
  await expect(page.getByText('$1,234.56')).toBeVisible()
  await expect(page.getByText('paper:')).toBeVisible()
})
