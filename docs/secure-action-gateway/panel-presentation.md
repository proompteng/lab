# SAG Panel Presentation

## 1. Problem

Enterprises want agents to replace brittle internal dashboards, scripts, and runbooks, but they cannot hand agents production authority without control over identity, policy, approvals, connectors, and audit evidence.

## 2. Product

SAG is a behind-the-firewall action gateway. An operator submits a natural-language task. SAG creates a plan, evaluates policy before each connector call, executes safe read steps, holds risky mutations for approval, and writes every decision to an audit trail.

## 3. Live Workflow

Open `https://sag.proompteng.ai`.

Run:

```text
Final panel smoke: inspect live agent runs, read SQL policy state, query audit graph, and parse the legacy feed
```

Show:

- Task succeeds.
- SQL, REST, GraphQL, and legacy connector steps are recorded.
- AgentRun secrets are redacted as `secret:<hash>`.
- Audit export includes task intake, plan, connector calls, and policy decisions.

## 4. Guarded Mutation

Run:

```text
Final panel smoke: inspect AgentRuns and execute a guarded restart if policy allows it
```

Show:

- The task enters `waiting_approval`.
- The approval row shows `guarded_action.execute`.
- Approving as `greg` moves the task to `succeeded` with decision `approved`.

## 5. Codex Rule Creation

Run:

```text
Require approval before agents change billing database records
```

Show:

- The rule is created with translator `codex-app-server`.
- The rule targets mutating operations and participates in later approval decisions.

## 6. Evidence

- Live URL: `https://sag.proompteng.ai`
- Argo app: `sag`, `Synced Healthy`
- Final image: `registry.ide-newton.ts.net/lab/sag:sag-20260513095640`
- Database counts after smoke: `tasks=5`, `calls=20`, `events=39`, `approvals=2`, `rules=5`
- Source PRs: `#6452`, `#6453`, `#6454`, `#6455`, `#6456`

## 7. Close

This is not an AgentRun viewer and not a mock dashboard. The implemented primitive is: `identity -> task -> plan step -> connector call -> policy decision -> approval -> audit event`.

The wedge is safe internal action execution. The platform path is connector breadth, policy primitives, approval workflows, and compliance evidence across every enterprise system an agent touches.
