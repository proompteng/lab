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
