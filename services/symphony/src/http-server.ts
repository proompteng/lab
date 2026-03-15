import { Effect } from 'effect'
import type { ManagedRuntime } from 'effect/ManagedRuntime'

import { OrchestratorService } from './orchestrator'
import type { Logger } from './logger'
import type { RuntimeSnapshot } from './types'

type IssueIdentifierParams = {
  issueIdentifier: string
}

export const parseIssueIdentifierPath = (pathname: string): IssueIdentifierParams | null => {
  if (!pathname.startsWith('/api/v1/')) return null
  const issueIdentifier = decodeURIComponent(pathname.replace('/api/v1/', ''))
  return issueIdentifier.length > 0 ? { issueIdentifier } : null
}

const stringifyForHtml = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

const escapeHtml = (value: unknown): string =>
  stringifyForHtml(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const renderKeyValueRows = (items: Array<{ key: string; value: unknown }>) =>
  items
    .map(
      (item) => `
        <tr>
          <th>${escapeHtml(item.key)}</th>
          <td>${escapeHtml(item.value)}</td>
        </tr>`,
    )
    .join('')

const renderDashboard = (snapshot: RuntimeSnapshot) => {
  const runningRows = snapshot.running
    .map(
      (row) => `
        <tr>
          <td><a href="/api/v1/${encodeURIComponent(row.issueIdentifier)}">${escapeHtml(row.issueIdentifier)}</a></td>
          <td>${escapeHtml(row.state)}</td>
          <td>${escapeHtml(row.turnCount)}</td>
          <td>${escapeHtml(row.lastEvent ?? '')}</td>
          <td>${escapeHtml(row.lastMessage ?? '')}</td>
          <td>${escapeHtml(row.tokens.totalTokens)}</td>
        </tr>`,
    )
    .join('')

  const retryRows = snapshot.retrying
    .map(
      (row) => `
        <tr>
          <td><a href="/api/v1/${encodeURIComponent(row.issueIdentifier)}">${escapeHtml(row.issueIdentifier)}</a></td>
          <td>${escapeHtml(row.attempt)}</td>
          <td>${escapeHtml(row.dueAt)}</td>
          <td>${escapeHtml(row.error ?? '')}</td>
        </tr>`,
    )
    .join('')

  const recentEventRows = snapshot.recentEvents
    .map(
      (event) => `
        <tr>
          <td>${escapeHtml(event.at)}</td>
          <td>${escapeHtml(event.level ?? 'info')}</td>
          <td>${escapeHtml(event.event)}</td>
          <td>${escapeHtml(event.issueIdentifier ?? '')}</td>
          <td>${escapeHtml(event.reason ?? '')}</td>
          <td>${escapeHtml(event.message ?? '')}</td>
        </tr>`,
    )
    .join('')

  const recentErrorRows = snapshot.recentErrors
    .map(
      (error) => `
        <tr>
          <td>${escapeHtml(error.at)}</td>
          <td>${escapeHtml(error.code)}</td>
          <td>${escapeHtml(error.issueIdentifier ?? '')}</td>
          <td>${escapeHtml(error.context)}</td>
          <td>${escapeHtml(error.message)}</td>
        </tr>`,
    )
    .join('')

  const stateLinkRows = [
    ...snapshot.running.map((row) => row.issueIdentifier),
    ...snapshot.retrying.map((row) => row.issueIdentifier),
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort()
    .map(
      (issueIdentifier) => `
        <li><a href="/api/v1/${encodeURIComponent(issueIdentifier)}">${escapeHtml(issueIdentifier)}</a></li>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Symphony</title>
    <style>
      :root { color-scheme: dark; }
      body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: linear-gradient(180deg, #0f172a 0%, #111827 100%); color: #f9fafb; padding: 24px; margin: 0; }
      a { color: #93c5fd; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
      th, td { border: 1px solid #374151; padding: 8px; text-align: left; vertical-align: top; }
      h1, h2 { margin: 0 0 12px; }
      h3 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #cbd5e1; }
      ul { margin: 0; padding-left: 20px; }
      .shell { max-width: 1440px; margin: 0 auto; }
      .hero { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
      .hero-meta { color: #94a3b8; font-size: 13px; }
      .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
      .two-up { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }
      .three-up { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }
      .card { border: 1px solid #334155; padding: 14px; background: rgba(15, 23, 42, 0.9); border-radius: 14px; box-shadow: 0 10px 40px rgba(2, 6, 23, 0.25); }
      .metric { font-size: 28px; font-weight: 700; margin-top: 4px; }
      .subtle { color: #94a3b8; }
      .status { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 999px; border: 1px solid #334155; }
      .leader { color: #86efac; border-color: #166534; background: rgba(20, 83, 45, 0.25); }
      .follower { color: #fca5a5; border-color: #7f1d1d; background: rgba(127, 29, 29, 0.25); }
      .table-card { overflow: hidden; }
      .table-scroll { overflow: auto; }
      .json-link { color: #cbd5e1; }
      @media (max-width: 1100px) {
        .grid, .two-up, .three-up { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="hero">
        <div>
          <h1>Symphony</h1>
          <div class="hero-meta">instance ${escapeHtml(snapshot.instance.name)} · generated ${escapeHtml(snapshot.generatedAt)} · <a class="json-link" href="/api/v1/state">raw JSON</a></div>
        </div>
        <div class="status ${snapshot.leader.isLeader ? 'leader' : 'follower'}">
          <strong>${snapshot.leader.isLeader ? 'Leader' : 'Follower'}</strong>
          <span>${escapeHtml(snapshot.leader.identity)}</span>
        </div>
      </div>

      <div class="grid">
        <div class="card"><div class="subtle">Running</div><div class="metric">${snapshot.counts.running}</div></div>
        <div class="card"><div class="subtle">Retrying</div><div class="metric">${snapshot.counts.retrying}</div></div>
        <div class="card"><div class="subtle">Total Tokens</div><div class="metric">${snapshot.codexTotals.totalTokens}</div></div>
        <div class="card"><div class="subtle">Runtime Seconds</div><div class="metric">${snapshot.codexTotals.secondsRunning.toFixed(1)}</div></div>
      </div>

      <div class="three-up">
        <div class="card">
          <h3>Instance</h3>
          <table>
            <tbody>${renderKeyValueRows([
              { key: 'name', value: snapshot.instance.name },
              { key: 'namespace', value: snapshot.instance.namespace },
              { key: 'argocdApplication', value: snapshot.instance.argocdApplication },
            ])}</tbody>
          </table>
        </div>
        <div class="card">
          <h3>Leader Status</h3>
          <table>
            <tbody>${renderKeyValueRows([
              { key: 'enabled', value: String(snapshot.leader.enabled) },
              { key: 'required', value: String(snapshot.leader.required) },
              {
                key: 'lease',
                value:
                  snapshot.leader.leaseNamespace && snapshot.leader.leaseName
                    ? `${snapshot.leader.leaseNamespace}/${snapshot.leader.leaseName}`
                    : 'N/A',
              },
              { key: 'lastTransitionAt', value: snapshot.leader.lastTransitionAt },
              { key: 'lastSuccessAt', value: snapshot.leader.lastSuccessAt },
              { key: 'lastError', value: snapshot.leader.lastError },
            ])}</tbody>
          </table>
        </div>
        <div class="card">
          <h3>Target</h3>
          <table>
            <tbody>${renderKeyValueRows([
              { key: 'name', value: snapshot.target.name },
              { key: 'namespace', value: snapshot.target.namespace },
              { key: 'argocdApplication', value: snapshot.target.argocdApplication },
              { key: 'repo', value: snapshot.target.repo },
              { key: 'defaultBranch', value: snapshot.target.defaultBranch },
            ])}</tbody>
          </table>
        </div>
        <div class="card">
          <h3>Policy</h3>
          <table>
            <tbody>${renderKeyValueRows([
              { key: 'approvalPolicy', value: snapshot.policy.approvalPolicy },
              { key: 'threadSandbox', value: snapshot.policy.threadSandbox },
              { key: 'turnSandboxPolicy', value: JSON.stringify(snapshot.policy.turnSandboxPolicy) },
              { key: 'allowedTools', value: snapshot.policy.allowedTools.join(', ') || 'none' },
              { key: 'workspaceRoot', value: snapshot.policy.workspaceRoot },
              { key: 'pollIntervalMs', value: snapshot.policy.pollIntervalMs },
              { key: 'maxConcurrentAgents', value: snapshot.policy.maxConcurrentAgents },
            ])}</tbody>
          </table>
        </div>
      </div>

      <div class="two-up">
        <div class="card">
          <h3>Release</h3>
          <table>
            <tbody>${renderKeyValueRows([
              { key: 'mode', value: snapshot.release.mode },
              { key: 'requiredChecksSource', value: snapshot.release.requiredChecksSource },
              { key: 'promotionBranchPrefix', value: snapshot.release.promotionBranchPrefix },
              { key: 'blockedLabels', value: snapshot.release.blockedLabels.join(', ') || 'none' },
              {
                key: 'deployables',
                value: snapshot.release.deployables.map((deployable) => deployable.name).join(', ') || 'none',
              },
            ])}</tbody>
          </table>
        </div>
        <div class="card">
          <h3>Workflow</h3>
          <table>
            <tbody>${renderKeyValueRows([
              { key: 'workflowPath', value: snapshot.workflow.workflowPath },
              { key: 'trackerKind', value: snapshot.workflow.trackerKind },
              { key: 'projectSlug', value: snapshot.workflow.projectSlug },
              { key: 'promptTemplateEmpty', value: String(snapshot.workflow.promptTemplateEmpty) },
              { key: 'activeStates', value: snapshot.policy.activeStates.join(', ') || 'none' },
              { key: 'terminalStates', value: snapshot.policy.terminalStates.join(', ') || 'none' },
            ])}</tbody>
          </table>
        </div>
      </div>

      <div class="two-up">
        <div class="card">
          <h3>Capacity</h3>
          <table>
            <tbody>${renderKeyValueRows([
              { key: 'availableSlots', value: snapshot.capacity.availableSlots },
              { key: 'running', value: snapshot.capacity.running },
              { key: 'retrying', value: snapshot.capacity.retrying },
              { key: 'saturated', value: String(snapshot.capacity.saturated) },
            ])}</tbody>
          </table>
          <div class="subtle">Per-state caps</div>
          <ul>${snapshot.capacity.byState.map((entry) => `<li>${escapeHtml(entry.state)}: ${escapeHtml(entry.running)}/${escapeHtml(entry.limit)}${entry.saturated ? ' (saturated)' : ''}</li>`).join('') || '<li>none</li>'}</ul>
        </div>
        <div class="card">
          <h3>Target Health</h3>
          <table>
            <tbody>${renderKeyValueRows([
              { key: 'readyForDispatch', value: String(snapshot.targetHealth.readyForDispatch) },
              { key: 'openPromotionPr', value: String(snapshot.targetHealth.openPromotionPr) },
              { key: 'promotionPrCount', value: snapshot.targetHealth.promotionPrCount },
              { key: 'checkedAt', value: snapshot.targetHealth.checkedAt },
              { key: 'lastError', value: snapshot.targetHealth.lastError },
            ])}</tbody>
          </table>
          <div class="subtle">Checks</div>
          <ul>${snapshot.targetHealth.checks.map((check) => `<li>${escapeHtml(check.name)}: ${escapeHtml(check.ok ? 'ok' : 'failing')} (${escapeHtml(check.message)})</li>`).join('') || '<li>none</li>'}</ul>
        </div>
      </div>

      <div class="two-up">
        <div class="card table-card">
          <h2>Running Sessions</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Issue</th><th>State</th><th>Turns</th><th>Last Event</th><th>Last Message</th><th>Total Tokens</th></tr></thead>
              <tbody>${runningRows || '<tr><td colspan="6">No active sessions.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="card table-card">
          <h2>Retry Queue</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Error</th></tr></thead>
              <tbody>${retryRows || '<tr><td colspan="4">Retry queue is empty.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="two-up">
        <div class="card table-card">
          <h2>Recent Errors</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>At</th><th>Code</th><th>Issue</th><th>Context</th><th>Message</th></tr></thead>
              <tbody>${recentErrorRows || '<tr><td colspan="5">No recent errors.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="card table-card">
          <h2>Recent Events</h2>
          <div class="table-scroll">
            <table>
              <thead><tr><th>At</th><th>Level</th><th>Event</th><th>Issue</th><th>Reason</th><th>Message</th></tr></thead>
              <tbody>${recentEventRows || '<tr><td colspan="6">No recent events.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Issue Drilldowns</h2>
        <ul>${stateLinkRows || '<li>No active or retrying issues.</li>'}</ul>
      </div>
    </div>
  </body>
</html>`
}

const handleRequestEffect = (request: Request) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorService
    const url = new URL(request.url)

    if (request.method === 'GET' && (url.pathname === '/livez' || url.pathname === '/readyz')) {
      return Response.json({ ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const snapshot = yield* orchestrator.getSnapshot
      return new Response(renderDashboard(snapshot as never), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/state') {
      return Response.json(yield* orchestrator.getSnapshot)
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/refresh') {
      yield* orchestrator.triggerRefresh
      return Response.json(
        {
          queued: true,
          coalesced: false,
          requestedAt: new Date().toISOString(),
          operations: ['poll', 'reconcile'],
        },
        { status: 202 },
      )
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/v1/')) {
      const params = parseIssueIdentifierPath(url.pathname)
      if (!params) {
        return Response.json(
          { error: { code: 'invalid_issue_identifier', message: 'missing issue identifier' } },
          { status: 400 },
        )
      }

      const details = yield* orchestrator.getIssueDetails(params.issueIdentifier)
      if (!details) {
        return Response.json(
          { error: { code: 'issue_not_found', message: `issue ${params.issueIdentifier} is not in memory` } },
          { status: 404 },
        )
      }
      return Response.json(details)
    }

    if (url.pathname === '/' || url.pathname.startsWith('/api/v1/')) {
      return Response.json({ error: { code: 'method_not_allowed', message: 'method not allowed' } }, { status: 405 })
    }

    return Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 })
  })

export class SymphonyHttpServer<R, E> {
  private readonly runtime: ManagedRuntime<R, E>
  private readonly logger: Logger
  private server: ReturnType<typeof Bun.serve> | null = null

  constructor(runtime: ManagedRuntime<R, E>, logger: Logger) {
    this.runtime = runtime
    this.logger = logger.child({ component: 'http-server' })
  }

  start(port: number, host: string): number {
    this.server = Bun.serve({
      hostname: host,
      port,
      fetch: (request): Promise<Response> =>
        (this.runtime.runPromise(handleRequestEffect(request) as never) as Promise<Response>).catch((error: unknown) =>
          Response.json(
            {
              error: {
                code: 'internal_error',
                message: error instanceof Error ? error.message : String(error),
              },
            },
            { status: 500 },
          ),
        ),
    })
    this.logger.log('info', 'http_server_started', { host, port: this.server.port })
    return this.server.port ?? port
  }

  stop(): void {
    void this.server?.stop(true)
    this.server = null
  }
}
