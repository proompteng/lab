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

const renderDashboard = (snapshot: RuntimeSnapshot) => {
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
