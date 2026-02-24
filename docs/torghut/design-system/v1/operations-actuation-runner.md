# Operations: Gated Actuation Runner (GitOps-First)

## Status

- Version: `v1`
- Last updated: **2026-02-10**
- Source of truth (config): `argocd/applications/torghut/**`

## Purpose

Define a **gated actuation runner** that performs common Torghut recovery actions **via GitOps PRs** (not direct
kubectl mutations). This is the production-safe counterpart to the read-only health report.

## Guardrails (non-negotiable)

- **GitOps-first only:** actuation must open PRs against `argocd/applications/torghut/**`.
- **Explicit gating:** actuation runs must carry the label gate and confirmation parameters.
- **No safety regressions:** paper/live defaults remain unchanged unless a separate audited change is approved.
- **No secrets:** do not add or expose secret values in PRs, logs, or AgentRun parameters.
- **Minimal diffs:** prefer single-file, single-field patches for auditability.

## Gating requirements (make actuation hard to do accidentally)

Actuation runs must meet **all** of the following:

- AgentRun labels:
  - `torghut.proompteng.ai/purpose=actuation`
  - `torghut.proompteng.ai/actuation="true"`
- VCS policy: `required: true`, `mode: read-write`.
- Required confirmation parameters:
  - `change`: one of the supported procedures (see below).
  - `reason`: short human justification.
  - `confirm`: **exact** string `ACTUATE_TORGHUT`.

## Supported actuation procedures (v1)

Each procedure is GitOps-only and must map to a **single file** change.

| Procedure            | File to change                                        | Patch shape                                                                                            | Rollback                                                                    |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Pause trading        | `argocd/applications/torghut/knative-service.yaml`    | `env[].name: TRADING_ENABLED` → `value: "false"`                                                       | Set `TRADING_ENABLED` back to `"true"` via PR (or `git revert`).            |
| Restart WS forwarder | `argocd/applications/torghut/ws/deployment.yaml`      | Bump `spec.template.metadata.annotations.kubectl.kubernetes.io/restartedAt` to a new RFC3339 timestamp | `git revert` (no runtime rollback needed; annotation is a restart trigger). |
| Suspend TA           | `argocd/applications/torghut/ta/flinkdeployment.yaml` | Set `spec.job.state: suspended`                                                                        | Set `spec.job.state: running` via PR (optionally bump `spec.restartNonce`). |
| Resume TA            | `argocd/applications/torghut/ta/flinkdeployment.yaml` | Set `spec.job.state: running` and increment `spec.restartNonce` by 1 if the job is stuck               | Set `spec.job.state: suspended` via PR.                                     |

## Procedure details (exact patches)

### Pause trading (GitOps PR)

Target file: `argocd/applications/torghut/knative-service.yaml`

Patch shape:

```yaml
- name: TRADING_ENABLED
  value: 'false'
```

Rollback:

```yaml
- name: TRADING_ENABLED
  value: 'true'
```

### Restart WS forwarder (GitOps PR)

Target file: `argocd/applications/torghut/ws/deployment.yaml`

Patch shape:

```yaml
spec:
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/restartedAt: 2026-02-10T12:34:56Z
```

Rollback:

- `git revert` the PR (annotation change is a one-time restart trigger).

### Suspend TA (GitOps PR)

Target file: `argocd/applications/torghut/ta/flinkdeployment.yaml`

Patch shape:

```yaml
spec:
  job:
    state: suspended
```

Rollback (resume):

```yaml
spec:
  job:
    state: running
  restartNonce: <increment by 1 if the job needs a restart>
```

### Resume TA (GitOps PR)

Target file: `argocd/applications/torghut/ta/flinkdeployment.yaml`

Patch shape:

```yaml
spec:
  job:
    state: running
  restartNonce: <increment by 1 if the job needs a restart>
```

Rollback (suspend):

```yaml
spec:
  job:
    state: suspended
```

## AgentRun template (gated actuation, GitOps PRs)

This is intentionally **separate** from diagnostics. It should be rejected by admission policies unless the actuation
label + confirmation parameters are present.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: torghut-actuation-gitops
  namespace: agents
  labels:
    torghut.proompteng.ai/purpose: actuation
    torghut.proompteng.ai/actuation: 'true'
spec:
  agentRef:
    name: <agent-name>
  implementationSpecRef:
    name: torghut-actuation-runner-v1
  runtime:
    type: workflow
  ttlSecondsAfterFinished: 7200
  vcsRef:
    name: <vcs-provider-name>
  vcsPolicy:
    required: true
    mode: read-write
  parameters:
    repository: proompteng/lab
    base: main
    head: agentruns/torghut-actuation-<yyyymmdd-hhmm>
    gitopsPath: argocd/applications/torghut
    torghutNamespace: torghut
    change: <pause-trading|restart-ws|suspend-ta|resume-ta>
    reason: <short-human-justification>
    confirm: ACTUATE_TORGHUT
```

## ImplementationSpec contract (actuation runner)

The ImplementationSpec should **require** confirmation parameters so the run cannot proceed without explicit intent.

```yaml
apiVersion: agents.proompteng.ai/v1alpha1
kind: ImplementationSpec
metadata:
  name: torghut-actuation-runner-v1
  namespace: agents
spec:
  contract:
    requiredKeys:
      - repository
      - base
      - head
      - gitopsPath
      - torghutNamespace
      - change
      - reason
      - confirm
  text: |
    Objective: Perform a single Torghut actuation change via GitOps PR.

    Guardrails:
    - Only modify files under ${gitopsPath}.
    - Require confirm == ACTUATE_TORGHUT.
    - Do not change TRADING_LIVE_ENABLED or TRADING_MODE.
    - Do not expose secrets.

    Steps:
    1) Validate change in {pause-trading|restart-ws|suspend-ta|resume-ta}.
    2) Apply the exact patch shape defined in docs/torghut/design-system/v1/operations-actuation-runner.md.
    3) Open PR against ${repository} with base ${base} and head ${head}.
    4) Output PR link and rollback instructions.
```

## Rollback guidance

- Prefer `git revert` of the actuation PR for an auditable rollback.
- For `pause-trading`, set `TRADING_ENABLED` back to `"true"` via a new PR if the incident is resolved.
- For `suspend-ta`, set `spec.job.state` back to `running` and bump `restartNonce` if needed.

## References

- `docs/torghut/design-system/v1/agentruns-handoff.md`
- `docs/torghut/design-system/v1/argo-gitops-and-overlays.md`
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`
