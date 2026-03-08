# Incident Report: Agents Namespace Queue Saturation Stalled Jangar and Torghut Swarms

- **Date**: 8 Mar 2026 (UTC)
- **Detected by**: live `kubectl` triage after operator report that the `agents` control plane might be down
- **Reported by**: gregkonush
- **Services Affected**: `agents` namespace AgentRun admission/reconciliation, Jangar control-plane scheduled swarms, Torghut quant scheduled swarms
- **Severity**: High (autonomous swarm work stopped making progress even though core control-plane deployments stayed healthy)

## Impact Summary

- Core `agents` namespace deployments remained healthy:
  - `deployment/agents` `1/1`
  - `deployment/agents-controllers` `2/2`
  - `deployment/agents-alloy` `1/1`
- Both swarm scheduler families kept firing on schedule:
  - `jangar-control-plane-{discover,plan,implement,verify}-sched-cron`
  - `torghut-quant-{discover,plan,implement,verify}-sched-cron`
- End-to-end work did not progress because AgentRuns accumulated with `Blocked=True`, `reason=QueueLimit`, message `Namespace agents reached queue limit`.
- Before cleanup, the namespace had `341` QueueLimit-blocked AgentRuns, and each swarm family showed the same stalled shape:
  - `166 Pending`
  - `14` with no `status.phase` populated yet
  - a small residual set of older `Failed` and `Succeeded` history
- Direct deletion of queued runs did not drain the queue immediately because blocked AgentRuns entered `Terminating` while still holding the `agents.proompteng.ai/runtime-cleanup` finalizer.

## User-Facing Symptom

The control plane looked partially healthy from the outside: controllers were up, cronjobs were still scheduling, and recent cronjob Jobs were completing. In practice, both swarms were stalled because newly created AgentRuns were being admitted into a blocked backlog instead of progressing through reconciliation and runtime execution.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-03-08 07:39 | Operator asked whether the `agents` namespace control plane was working. |
| 2026-03-08 07:40-07:44 | Live checks confirmed healthy core deployments and recent successful `jangar-control-plane-*-sched-cron` Jobs, but large numbers of `Pending` AgentRuns remained in namespace `agents`. |
| 2026-03-08 07:44 | Sample AgentRuns from both swarm families showed `Blocked=True`, `reason=QueueLimit`, message `Namespace agents reached queue limit`. |
| 2026-03-08 07:46 | Verified the schedulers were not disabled: all eight Jangar/Torghut swarm cronjobs had `spec.suspend=false` and recent `lastScheduleTime` values. |
| 2026-03-08 07:48 | Manual mitigation started by suspending all eight swarm cronjobs to stop new queue growth. |
| 2026-03-08 07:49 | Counted `360` queued swarm AgentRuns matching the active Jangar/Torghut scheduler prefixes and issued delete requests. |
| 2026-03-08 07:50 | Confirmed the delete path was stalled: queued AgentRuns had `deletionTimestamp` set but still carried finalizer `agents.proompteng.ai/runtime-cleanup`. |
| 2026-03-08 07:50-07:53 | Removed the finalizer from `340` terminating queued swarm AgentRuns so deletion could complete. |
| 2026-03-08 07:53 | Removed `9` additional non-swarm QueueLimit-blocked AgentRuns (`agents-chart` and `torghut-market-context` backlog) and cleared their finalizers as well. |
| 2026-03-08 07:53 | Verified queue recovery: `0` AgentRuns remained with `Blocked=True` and `reason=QueueLimit`. |

## Root Cause

This incident was a queue-admission saturation problem combined with an incomplete cleanup path for blocked runs.

Primary causes:

1. **Namespace queue capacity was exhausted**
   - The `agents` control plane enforces queue limits for AgentRuns.
   - Repo configuration documents a default namespace queue ceiling of `200` in `charts/agents/values.yaml`, with the `agents` Argo overlay overriding `controller.queue.perRepo` to `200` in `argocd/applications/agents/values.yaml`.
   - Once queue depth crossed the namespace ceiling, new AgentRuns were marked blocked with `QueueLimit` instead of progressing.

2. **Both swarm schedulers kept generating work after saturation**
   - Jangar control-plane and Torghut quant cronjobs were still active (`spec.suspend=false`).
   - Recent cronjob Jobs were still completing, so the system kept creating fresh AgentRun CRs even though the namespace could not admit more work.

3. **Blocked backlog cleanup was not self-draining**
   - Deleting queued AgentRuns did not clear them promptly because many immediately moved to `Terminating` while retaining finalizer `agents.proompteng.ai/runtime-cleanup`.
   - For queue-blocked runs that never reached useful runtime work, the finalizer became the operational barrier to recovery.

## Evidence

- Healthy core deployments:
  - `kubectl get deploy -n agents agents agents-controllers agents-alloy -o wide`
  - Result at triage time: `agents 1/1`, `agents-controllers 2/2`, `agents-alloy 1/1`
- Swarm schedulers active before mitigation:
  - `kubectl get cronjobs -n agents ...`
  - All eight Jangar/Torghut scheduler cronjobs showed `spec.suspend=false` with recent `lastScheduleTime`
- Queue-limit admission failures:
  - Example Jangar AgentRun blocked condition:
    - `Blocked=True`
    - `reason=QueueLimit`
    - `message=Namespace agents reached queue limit`
  - Example Torghut AgentRun showed the same condition
- Backlog counts before mitigation:
  - Jangar control-plane scheduled runs: `166 Pending`, `14 None`, `7 Failed`, `2 Succeeded`
  - Torghut quant scheduled runs: `166 Pending`, `14 None`, `5 Failed`, `2 Succeeded`
  - Total QueueLimit-blocked AgentRuns across namespace: `341`
- Cleanup-path blockage:
  - Sample queued AgentRun after delete request had:
    - populated `deletionTimestamp`
    - finalizer `agents.proompteng.ai/runtime-cleanup`
- Recovery verification:
  - `kubectl get agentruns.agents.proompteng.ai -n agents -o json | jq ...`
  - Final result after cleanup: `0` QueueLimit-blocked AgentRuns

## Contributing Factors

- Queue saturation was not automatically turning off the schedulers that were feeding the backlog.
- Queue-blocked AgentRuns were operationally cheap to create but operationally expensive to clear once the finalizer path stalled.
- Healthy deployments and successful cronjob Job completions made the incident easy to misread as a swarm-specific runtime problem rather than a namespace admission problem.
- One manual plan run (`jangar-manual-plan-6xw45`) failed during the same window because the Codex Spark model hit a usage limit, which added noise during triage but was not the primary queue-saturation cause.

## What Was Not the Root Cause

- The `agents` control-plane deployments were not down.
- The swarms were not disabled before mitigation; they were still scheduling normally.
- This was not primarily a pod crashloop or deployment rollout failure.

## Corrective Actions Taken

1. Suspended all eight Jangar and Torghut swarm cronjobs in namespace `agents`.
2. Identified `360` queued swarm AgentRuns matching the active scheduler prefixes and issued delete requests.
3. Confirmed those deletions were stalling in `Terminating` because of finalizer `agents.proompteng.ai/runtime-cleanup`.
4. Removed that finalizer from `340` terminating queued swarm AgentRuns so deletion could complete.
5. Deleted the remaining `9` non-swarm QueueLimit-blocked AgentRuns and cleared their finalizers.
6. Re-verified the namespace after cleanup and confirmed `0` QueueLimit-blocked AgentRuns remained.

## Residual State Left Intact

The cleanup intentionally left historical failed swarm AgentRuns in place for postmortem visibility:

- `jangar-control-plane-discover-sched-k7srv`
- `jangar-control-plane-implement-sched-tdg7g`
- `jangar-control-plane-verify-sched-gpw64`
- `jangar-control-plane-verify-sched-qhgwx`
- `torghut-quant-discover-sched-58kbb`
- `torghut-quant-implement-sched-77t4z`
- `torghut-quant-implement-sched-wcvxc`
- `torghut-quant-verify-sched-bmpjr`

## Preventive Actions

1. Add an automatic namespace freeze path that suspends or rejects scheduler-driven enqueueing once `QueueLimit` backlog crosses a defined threshold.
2. Make deletion of never-started or queue-blocked AgentRuns finalizer-safe so operators do not need manual finalizer removal for recovery.
3. Emit an explicit alert on sustained `Blocked=True, reason=QueueLimit` counts by namespace, repo, and workload family.
4. Add a control-plane dashboard that pairs queue-limit counts with scheduler activity so “healthy deployments, unhealthy admission” is immediately visible.
5. Consider fair-share or separate queue budgets for independent workload families so one swarm lane cannot starve the rest of the namespace.

## Lessons Learned

- “Cronjobs are firing” and “deployments are healthy” are not enough to conclude the control plane is operational.
- Queue-admission saturation needs a first-class recovery path, not just an enforcement path.
- Finalizers on blocked runs need the same design scrutiny as finalizers on active runtime objects; otherwise cleanup becomes the outage.

## References

- [docs/agents/designs/throughput-backpressure-quotas.md](../agents/designs/throughput-backpressure-quotas.md)
- [docs/incidents/2026-03-01-jangar-control-plane-reconcile-storm.md](2026-03-01-jangar-control-plane-reconcile-storm.md)
