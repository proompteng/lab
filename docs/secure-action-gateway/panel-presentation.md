# SAG Panel Walkthrough

## Message

SAG is the policy and audit boundary between agent intent and enterprise authority.

## 2-5 Minute Flow

1. Open `https://sag.proompteng.ai`.
2. Submit:

```text
Inspect protected workloads, policy records, audit history, and operations feed
```

3. Show the Agent Action Run:
   - policy data step executed;
   - workload API step executed;
   - audit graph step executed;
   - ops feed step executed;
   - each step has decision and evidence.

4. Submit:

```text
Inspect protected workloads and execute a guarded restart after policy approval
```

5. Show `Needs approval` on the mutation step.
6. Approve the pending action.
7. Show the run updates to `Approved`.
8. Open `Audit`.
9. Export the audit replay.

## What To Say

- "The product primitive is Agent Action Run."
- "Chat is only intake. The product is controlled action release."
- "Every action has source, decision, approval state, and evidence."
- "Kubernetes is one source; the same contract covers databases, APIs, graph endpoints, and legacy feeds."

## Evidence To Have Ready

- Live URL: `https://sag.proompteng.ai`
- Argo app: `sag`
- Source: `services/sag`, `argocd/sag`, `packages/scripts/src/sag`
- Docs: PRD, TDD, market research, authorship note
- Checks: test, typecheck, lint, build, live health, browser flow
