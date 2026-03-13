import type { Logger } from './logger'
import { SymphonyOrchestrator } from './orchestrator'

export class SymphonyHttpServer {
  private readonly orchestrator: SymphonyOrchestrator
  private readonly logger: Logger
  private server: ReturnType<typeof Bun.serve> | null = null

  constructor(orchestrator: SymphonyOrchestrator, logger: Logger) {
    this.orchestrator = orchestrator
    this.logger = logger.child({ component: 'http-server' })
  }

  start(port: number, host: string): number {
    this.server = Bun.serve({
      hostname: host,
      port,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method === 'GET' && (url.pathname === '/livez' || url.pathname === '/readyz')) {
          return Response.json({ ok: true })
        }
        if (request.method === 'GET' && url.pathname === '/') {
          return new Response(this.renderDashboard(), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }
        if (request.method === 'GET' && url.pathname === '/api/v1/state') {
          return Response.json(this.orchestrator.getSnapshot())
        }
        if (request.method === 'POST' && url.pathname === '/api/v1/refresh') {
          await this.orchestrator.triggerRefresh()
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
          const issueIdentifier = decodeURIComponent(url.pathname.replace('/api/v1/', ''))
          if (issueIdentifier.length === 0) {
            return Response.json(
              { error: { code: 'invalid_issue_identifier', message: 'missing issue identifier' } },
              { status: 400 },
            )
          }
          const details = this.orchestrator.getIssueDetails(issueIdentifier)
          if (!details) {
            return Response.json(
              { error: { code: 'issue_not_found', message: `issue ${issueIdentifier} is not in memory` } },
              { status: 404 },
            )
          }
          return Response.json(details)
        }
        if (url.pathname === '/' || url.pathname.startsWith('/api/v1/')) {
          return Response.json(
            { error: { code: 'method_not_allowed', message: 'method not allowed' } },
            { status: 405 },
          )
        }
        return Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 })
      },
    })
    this.logger.log('info', 'http_server_started', { host, port: this.server.port })
    return this.server.port ?? port
  }

  stop(): void {
    void this.server?.stop(true)
    this.server = null
  }

  private renderDashboard(): string {
    const snapshot = this.orchestrator.getSnapshot()
    const runningRows = snapshot.running
      .map(
        (row) => `
          <tr>
            <td>${row.issueIdentifier}</td>
            <td>${row.state}</td>
            <td>${row.turnCount}</td>
            <td>${row.lastEvent ?? ''}</td>
            <td>${row.lastMessage ?? ''}</td>
            <td>${row.tokens.totalTokens}</td>
          </tr>`,
      )
      .join('')

    const retryRows = snapshot.retrying
      .map(
        (row) => `
          <tr>
            <td>${row.issueIdentifier}</td>
            <td>${row.attempt}</td>
            <td>${row.dueAt}</td>
            <td>${row.error ?? ''}</td>
          </tr>`,
      )
      .join('')

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Symphony</title>
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #111827; color: #f9fafb; padding: 24px; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
      th, td { border: 1px solid #374151; padding: 8px; text-align: left; vertical-align: top; }
      h1, h2 { margin: 0 0 12px; }
      .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
      .card { border: 1px solid #374151; padding: 12px; background: #0f172a; }
    </style>
  </head>
  <body>
    <h1>Symphony</h1>
    <div class="grid">
      <div class="card">running: ${snapshot.counts.running}</div>
      <div class="card">retrying: ${snapshot.counts.retrying}</div>
      <div class="card">total tokens: ${snapshot.codexTotals.totalTokens}</div>
      <div class="card">seconds running: ${snapshot.codexTotals.secondsRunning.toFixed(1)}</div>
    </div>
    <h2>Running</h2>
    <table>
      <thead><tr><th>Issue</th><th>State</th><th>Turns</th><th>Last Event</th><th>Last Message</th><th>Total Tokens</th></tr></thead>
      <tbody>${runningRows}</tbody>
    </table>
    <h2>Retrying</h2>
    <table>
      <thead><tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Error</th></tr></thead>
      <tbody>${retryRows}</tbody>
    </table>
  </body>
</html>`
  }
}
