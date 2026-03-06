import * as React from 'react'

import { formatTimestamp, StatusBadge } from '@/components/agents-control-plane'
import type { ControlPlaneStatus } from '@/data/agents-control-plane'
import { fetchControlPlaneStatus } from '@/data/agents-control-plane'

export type ControlPlaneStatusState = {
  status: ControlPlaneStatus | null
  error: string | null
  isLoading: boolean
  lastUpdatedAt: string | null
  refresh: () => void
}

export const useControlPlaneStatus = (namespace: string): ControlPlaneStatusState => {
  const [status, setStatus] = React.useState<ControlPlaneStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = React.useState<string | null>(null)

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true)
      setError(null)
      try {
        const result = await fetchControlPlaneStatus({ namespace, signal })
        if (!result.ok) {
          setError(result.message)
          setStatus(null)
          return
        }
        setStatus(result.status)
        setLastUpdatedAt(result.status.generated_at)
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Failed to load control plane status')
        setStatus(null)
      } finally {
        setIsLoading(false)
      }
    },
    [namespace],
  )

  React.useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const refresh = React.useCallback(() => {
    const controller = new AbortController()
    void load(controller.signal)
  }, [load])

  return { status, error, isLoading, lastUpdatedAt, refresh }
}

const renderSummaryValue = (value: string | number | boolean | null) => {
  if (value == null || value === '') return '—'
  return String(value)
}

const formatFailureReasons = (reasons: Array<{ reason: string; count: number }>) => {
  if (reasons.length === 0) {
    return '—'
  }

  return reasons.map((entry) => `${entry.reason} (${entry.count})`).join(', ')
}

export const ControlPlaneStatusPanel = ({
  status,
  error,
  isLoading,
}: {
  status: ControlPlaneStatus | null
  error: string | null
  isLoading: boolean
}) => (
  <section className="rounded-none border p-4 space-y-4 border-border bg-card">
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Control plane status</h2>
        <span className="text-xs text-muted-foreground">{formatTimestamp(status?.generated_at ?? null)}</span>
      </div>
      <p className="text-xs text-muted-foreground">Health and reconciliation status from the control plane.</p>
    </div>

    {error ? <div className="text-xs text-destructive">{error}</div> : null}
    {isLoading && !status ? <div className="text-xs text-muted-foreground">Loading status…</div> : null}

    {status ? (
      <div className="space-y-4 text-xs">
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Controllers</div>
          <ul className="space-y-2">
            {status.controllers.map((controller) => (
              <li key={controller.name} className="rounded-none border p-2 border-border/60 bg-muted/30">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{controller.name}</span>
                  <StatusBadge label={controller.status} />
                </div>
                <div className="mt-1 text-muted-foreground">{controller.message || 'OK'}</div>
                <div className="mt-1 text-muted-foreground">
                  CRDs ready: {controller.crds_ready ? 'yes' : 'no'} · Last checked{' '}
                  {formatTimestamp(controller.last_checked_at)}
                </div>
                {controller.missing_crds.length > 0 ? (
                  <div className="mt-1 text-muted-foreground">Missing: {controller.missing_crds.join(', ')}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Runtime adapters
          </div>
          <ul className="space-y-2">
            {status.runtime_adapters.map((adapter) => (
              <li key={adapter.name} className="rounded-none border p-2 border-border/60 bg-muted/30">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{adapter.name}</span>
                  <StatusBadge label={adapter.status} />
                </div>
                <div className="mt-1 text-muted-foreground">{adapter.message || 'OK'}</div>
                {adapter.endpoint ? (
                  <div className="mt-1 text-muted-foreground">Endpoint: {adapter.endpoint}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Watch reliability
          </div>
          <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">Kubernetes watch health</span>
              <StatusBadge label={status.watch_reliability.status} />
            </div>
            <div className="text-muted-foreground">
              Window: {status.watch_reliability.window_minutes}m · Streams: {status.watch_reliability.observed_streams}
            </div>
            <div className="text-muted-foreground">
              Events: {renderSummaryValue(status.watch_reliability.total_events)} · Errors:{' '}
              {renderSummaryValue(status.watch_reliability.total_errors)} · Restarts:{' '}
              {renderSummaryValue(status.watch_reliability.total_restarts)}
            </div>
            {status.watch_reliability.streams.length > 0 ? (
              <ul className="space-y-1 pt-1 text-muted-foreground">
                {status.watch_reliability.streams.map((entry) => (
                  <li key={`${entry.resource}:${entry.namespace}`} className="text-[11px]">
                    {entry.resource}/{entry.namespace}: events {entry.events} · errors {entry.errors} · restarts{' '}
                    {entry.restarts}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Workflow reliability
          </div>
          <div className="rounded-none border p-3 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap gap-4">
              <span>Active runs: {renderSummaryValue(status.workflows.active_job_runs)}</span>
              <span>Recent failed: {renderSummaryValue(status.workflows.recent_failed_jobs)}</span>
              <span>Backoff limit exceeded: {renderSummaryValue(status.workflows.backoff_limit_exceeded_jobs)}</span>
              <span>Window: {renderSummaryValue(status.workflows.window_minutes)}m</span>
            </div>
            <div className="flex flex-wrap gap-4">
              <span>Data confidence: {renderSummaryValue(status.workflows.data_confidence)}</span>
              <span>
                Namespace coverage: {renderSummaryValue(status.workflows.collected_namespaces)}/
                {renderSummaryValue(status.workflows.target_namespaces)}
              </span>
              <span>Collection errors: {renderSummaryValue(status.workflows.collection_errors)}</span>
            </div>
            {status.workflows.message ? (
              <div className="text-muted-foreground">Collection status: {status.workflows.message}</div>
            ) : null}
            <div className="text-muted-foreground">
              Top failure reasons:{' '}
              {status.workflows.top_failure_reasons.length > 0
                ? formatFailureReasons(status.workflows.top_failure_reasons)
                : '—'}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Dependencies</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">Database</span>
                <StatusBadge label={status.database.status} />
              </div>
              <div className="text-muted-foreground">{status.database.message || 'OK'}</div>
              <div className="text-muted-foreground">Latency: {renderSummaryValue(status.database.latency_ms)} ms</div>
            </div>
            <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">gRPC</span>
                <StatusBadge label={status.grpc.status} />
              </div>
              <div className="text-muted-foreground">{status.grpc.message || 'OK'}</div>
              <div className="text-muted-foreground">Address: {status.grpc.address || '—'}</div>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Rollout health</div>
          <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">Control-plane rollout</span>
              <StatusBadge label={status.rollout_health.status} />
            </div>
            <div className="text-muted-foreground">
              Deployments configured: {status.rollout_health.observed_deployments} · Degraded:{' '}
              {status.rollout_health.degraded_deployments}
            </div>
            <div className="text-muted-foreground">Message: {status.rollout_health.message}</div>
            {status.rollout_health.deployments.length > 0 ? (
              <ul className="space-y-1 pt-1 text-muted-foreground">
                {status.rollout_health.deployments.map((deployment) => (
                  <li key={deployment.name} className="text-[11px]">
                    <span className="font-medium text-foreground">{deployment.name}</span> ({deployment.namespace}):{' '}
                    {deployment.status} · ready {deployment.ready_replicas}/{deployment.desired_replicas} · available{' '}
                    {deployment.available_replicas}/{deployment.desired_replicas}
                    {deployment.message ? ` · ${deployment.message}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-muted-foreground">No rollout entries configured.</div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Namespaces</div>
          <ul className="space-y-2">
            {status.namespaces.map((entry) => (
              <li key={entry.namespace} className="rounded-none border p-2 border-border/60 bg-muted/30">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{entry.namespace}</span>
                  <StatusBadge label={entry.status} />
                </div>
                <div className="mt-1 text-muted-foreground">
                  Degraded: {entry.degraded_components.length > 0 ? entry.degraded_components.join(', ') : 'None'}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    ) : null}
  </section>
)
