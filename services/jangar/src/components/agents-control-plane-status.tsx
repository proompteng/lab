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

const formatScopeLabel = (value: string) =>
  value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

const formatLeaseStatusSummary = (status: ControlPlaneStatus) => {
  const counts = status.failure_domain_leases.leases.reduce<Record<string, number>>((acc, lease) => {
    acc[lease.status] = (acc[lease.status] ?? 0) + 1
    return acc
  }, {})
  return ['valid', 'degraded', 'expired', 'unknown', 'override']
    .map((statusKey) => `${statusKey} ${counts[statusKey] ?? 0}`)
    .join(' · ')
}

const formatMaterialVerdicts = (status: ControlPlaneStatus) => {
  const blocking = status.material_action_verdicts.filter((verdict) =>
    ['hold', 'block', 'contradicted', 'unknown'].includes(verdict.decision),
  )
  if (blocking.length === 0) return 'None'
  return blocking.map((verdict) => `${verdict.action_class}=${verdict.decision}`).join(', ')
}

const formatPressureActions = (status: ControlPlaneStatus) => {
  const ledger = status.evidence_pressure_ledger
  if (!ledger) return 'Not emitted'
  const held = ledger.action_pressure_budget.filter((budget) => budget.decision !== 'allow')
  if (held.length === 0) return 'None'
  return held.map((budget) => `${budget.action_class}=${budget.decision}`).join(', ')
}

const formatTerminalDebtActions = (status: ControlPlaneStatus) => {
  const ledger = status.terminal_debt_compaction_ledger
  if (!ledger) return 'Not emitted'
  if (ledger.scheduler_contract.would_hold_action_classes.length === 0) return 'None'
  return ledger.scheduler_contract.would_hold_action_classes.join(', ')
}

const formatAuthorityActions = (status: ControlPlaneStatus) => {
  const held = status.authority_provenance_settlement.action_class_decisions.filter(
    (decision) => decision.decision !== 'allow',
  )
  if (held.length === 0) return 'None'
  return held.map((decision) => `${decision.action_class}=${decision.decision}`).join(', ')
}

const formatAuthority = (authority: {
  mode: string
  source_deployment: string
  source_pod: string
  namespace: string
  fresh: boolean
  observed_at: string | null
}) => {
  const source =
    authority.source_deployment || authority.source_pod
      ? [authority.source_deployment, authority.source_pod].filter((value) => value.length > 0).join('/')
      : authority.namespace || 'unknown'
  const freshness = authority.fresh ? 'fresh' : 'stale'
  const observedAt = authority.observed_at ? formatTimestamp(authority.observed_at) : '—'
  return `Authority: ${authority.mode} · ${source} · ${freshness} · observed ${observedAt}`
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
                <div className="mt-1 text-muted-foreground">{formatAuthority(controller.authority)}</div>
                {controller.scope_namespaces.length > 0 ? (
                  <div className="mt-1 text-muted-foreground">Scope: {controller.scope_namespaces.join(', ')}</div>
                ) : null}
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
                <div className="mt-1 text-muted-foreground">{formatAuthority(adapter.authority)}</div>
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
            Authority provenance
          </div>
          <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">Settlement journal</span>
              <StatusBadge label={status.authority_provenance_settlement.settlement_state} />
            </div>
            <div className="text-muted-foreground">
              Mode: {status.authority_provenance_settlement.evidence_mode} · Winner:{' '}
              {status.authority_provenance_settlement.winning_authority}
            </div>
            <div className="text-muted-foreground">Held authority actions: {formatAuthorityActions(status)}</div>
            <div className="text-muted-foreground">
              Reentry windows: {status.authority_provenance_settlement.reentry_windows.length}
            </div>
            {status.authority_provenance_settlement.surfaces.length > 0 ? (
              <ul className="space-y-1 pt-1 text-muted-foreground">
                {status.authority_provenance_settlement.surfaces.slice(0, 5).map((surface) => (
                  <li key={surface.surface} className="text-[11px]">
                    <span className="font-medium text-foreground">{surface.surface}</span> · {surface.status} ·{' '}
                    {surface.settlement_state}
                    {surface.reason_codes.length > 0 ? ` (${surface.reason_codes.join(', ')})` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-muted-foreground">No authority surfaces available.</div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Terminal debt</div>
          <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">Compaction ledger</span>
              <StatusBadge label={status.terminal_debt_compaction_ledger?.scheduler_contract.status ?? 'missing'} />
            </div>
            <div className="text-muted-foreground">
              Active: {status.terminal_debt_compaction_ledger?.active_debt_summary.count ?? 0} · Retained audit:{' '}
              {status.terminal_debt_compaction_ledger?.retained_audit_summary.count ?? 0}
            </div>
            <div className="text-muted-foreground">Would hold: {formatTerminalDebtActions(status)}</div>
            {status.terminal_debt_compaction_ledger?.cohorts.length ? (
              <ul className="space-y-1 pt-1 text-muted-foreground">
                {status.terminal_debt_compaction_ledger.cohorts.slice(0, 5).map((cohort) => (
                  <li key={cohort.cohort_id} className="text-[11px]">
                    <span className="font-medium text-foreground">{cohort.class}</span> · {cohort.state} ·{' '}
                    {cohort.count} · {cohort.active_gate_effect}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-muted-foreground">No terminal debt cohorts.</div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Evidence pressure
          </div>
          <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">Watch backoff governor</span>
              <StatusBadge label={status.evidence_pressure_ledger?.watch_backoff_policy.state ?? 'missing'} />
            </div>
            <div className="text-muted-foreground">
              Mode: {status.evidence_pressure_ledger?.evidence_mode ?? '—'} · Sources:{' '}
              {status.evidence_pressure_ledger?.pressure_sources.length ?? 0}
            </div>
            <div className="text-muted-foreground">Pressure actions: {formatPressureActions(status)}</div>
            {status.evidence_pressure_ledger?.pressure_sources.length ? (
              <ul className="space-y-1 pt-1 text-muted-foreground">
                {status.evidence_pressure_ledger.pressure_sources.slice(0, 5).map((source) => (
                  <li key={source.source_id} className="text-[11px]">
                    <span className="font-medium text-foreground">{source.source_class}</span> · {source.severity}
                    {source.reason_codes.length > 0 ? ` (${source.reason_codes.join(', ')})` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-muted-foreground">No active evidence pressure sources.</div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            AgentRun ingestion
          </div>
          <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">{status.agentrun_ingestion.namespace}</span>
              <StatusBadge label={status.agentrun_ingestion.status} />
            </div>
            <div className="text-muted-foreground">{status.agentrun_ingestion.message || 'OK'}</div>
            <div className="text-muted-foreground">
              Last watch event: {formatTimestamp(status.agentrun_ingestion.last_watch_event_at || null)} · Last resync:{' '}
              {formatTimestamp(status.agentrun_ingestion.last_resync_at || null)}
            </div>
            <div className="text-muted-foreground">
              Untouched runs: {renderSummaryValue(status.agentrun_ingestion.untouched_run_count)} · Oldest age:{' '}
              {status.agentrun_ingestion.oldest_untouched_age_seconds == null
                ? '—'
                : `${status.agentrun_ingestion.oldest_untouched_age_seconds}s`}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Dependency quorum
          </div>
          <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">Decision</span>
              <StatusBadge label={status.dependency_quorum.decision} />
            </div>
            <div className="text-muted-foreground">{status.dependency_quorum.message || 'OK'}</div>
            <div className="text-muted-foreground">
              Degradation scope:{' '}
              {status.dependency_quorum.degradation_scope
                ? formatScopeLabel(status.dependency_quorum.degradation_scope)
                : '—'}
            </div>
            <div className="text-muted-foreground">
              Reasons: {status.dependency_quorum.reasons.length > 0 ? status.dependency_quorum.reasons.join(', ') : '—'}
            </div>
            {status.dependency_quorum.segments && status.dependency_quorum.segments.length > 0 ? (
              <ul className="space-y-1 pt-1 text-muted-foreground">
                {status.dependency_quorum.segments.map((segment) => (
                  <li key={segment.segment} className="text-[11px]">
                    <span className="font-medium text-foreground">{segment.segment}</span> · {segment.status} · scope{' '}
                    {formatScopeLabel(segment.scope)} · confidence {segment.confidence}
                    {segment.reasons.length > 0 ? ` (${segment.reasons.join(', ')})` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-muted-foreground">No segment detail available.</div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Failure-domain leases
          </div>
          <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">Shadow lease set</span>
              <StatusBadge label={status.failure_domain_leases.mode} />
            </div>
            <div className="text-muted-foreground">Digest: {status.failure_domain_leases.lease_set_digest}</div>
            <div className="text-muted-foreground">{formatLeaseStatusSummary(status)}</div>
            <div className="text-muted-foreground">
              Held actions:{' '}
              {status.failure_domain_leases.holdbacks.filter((holdback) => holdback.decision !== 'allow').length > 0
                ? status.failure_domain_leases.holdbacks
                    .filter((holdback) => holdback.decision !== 'allow')
                    .map((holdback) => holdback.action_class)
                    .join(', ')
                : 'None'}
            </div>
            {status.failure_domain_leases.leases.length > 0 ? (
              <ul className="space-y-1 pt-1 text-muted-foreground">
                {status.failure_domain_leases.leases.map((lease) => (
                  <li key={lease.lease_id} className="text-[11px]">
                    <span className="font-medium text-foreground">{lease.domain}</span> · {lease.status} · {lease.scope}
                    {lease.reason_codes.length > 0 ? ` (${lease.reason_codes.join(', ')})` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-muted-foreground">No failure-domain leases available.</div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Material action verdicts
          </div>
          <div className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">Final shadow verdict epoch</span>
              <StatusBadge label={status.material_action_verdict_epoch.mode} />
            </div>
            <div className="text-muted-foreground">Epoch: {status.material_action_verdict_epoch.epoch_id}</div>
            <div className="text-muted-foreground">Blocking verdicts: {formatMaterialVerdicts(status)}</div>
            {status.material_action_verdict_epoch.contradiction_refs.length > 0 ? (
              <div className="text-muted-foreground">
                Contradictions: {status.material_action_verdict_epoch.contradiction_refs.length}
              </div>
            ) : null}
            {status.material_action_verdicts.length > 0 ? (
              <ul className="space-y-1 pt-1 text-muted-foreground">
                {status.material_action_verdicts.map((verdict) => (
                  <li key={verdict.verdict_id} className="text-[11px]">
                    <span className="font-medium text-foreground">{verdict.action_class}</span> · {verdict.decision}
                    {verdict.blocking_reason_codes.length > 0 ? ` (${verdict.blocking_reason_codes.join(', ')})` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-muted-foreground">No material action verdicts available.</div>
            )}
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
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Empirical services
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['Forecast', status.empirical_services.forecast],
                ['LEAN', status.empirical_services.lean],
                ['Jobs', status.empirical_services.jobs],
              ] as const
            ).map(([label, service]) => (
              <div key={label} className="rounded-none border p-2 border-border/60 bg-muted/30 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{label}</span>
                  <StatusBadge label={service.status} />
                </div>
                <div className="text-muted-foreground">{service.message || 'OK'}</div>
                <div className="text-muted-foreground">Authoritative: {service.authoritative ? 'yes' : 'no'}</div>
                {service.calibration_status ? (
                  <div className="text-muted-foreground">Calibration: {service.calibration_status}</div>
                ) : null}
                {service.authoritative_modes && service.authoritative_modes.length > 0 ? (
                  <div className="text-muted-foreground">Modes: {service.authoritative_modes.join(', ')}</div>
                ) : null}
                {service.eligible_models && service.eligible_models.length > 0 ? (
                  <div className="text-muted-foreground">Eligible models: {service.eligible_models.join(', ')}</div>
                ) : null}
                {service.eligible_jobs && service.eligible_jobs.length > 0 ? (
                  <div className="text-muted-foreground">Eligible jobs: {service.eligible_jobs.join(', ')}</div>
                ) : null}
                {service.stale_jobs && service.stale_jobs.length > 0 ? (
                  <div className="text-muted-foreground">Stale jobs: {service.stale_jobs.join(', ')}</div>
                ) : null}
              </div>
            ))}
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
