# facteur Discord to Agents bridge

Facteur receives Discord command events and structured Codex task deliveries, validates domain-specific routing, persists intake state, and submits runtime work through the Agents service. It no longer owns a Kubernetes or Argo Workflows runtime path for Codex execution.

The retained runtime boundary is:

1. Froussard normalizes Discord interactions into `proompteng.facteur.v1.CommandEvent`.
2. Facteur consumes the event, enforces role policy, and builds a domain-neutral AgentRun payload.
3. Facteur calls `POST /v1/agent-runs` on `http://agents.agents.svc.cluster.local`.
4. `services/agents` owns controller reconciliation, runner contract generation, logs, artifacts, status, and cancellation.

## Configuration Model

Configuration can be supplied via YAML or environment variables prefixed with `FACTEUR_`. Environment values override the file to support container-based rollout overrides.

### Required Fields

| Path                     | Env Var                          | Description                                                              |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------ |
| `discord.bot_token`      | `FACTEUR_DISCORD_BOT_TOKEN`      | Discord bot token used for interactions API calls.                       |
| `discord.application_id` | `FACTEUR_DISCORD_APPLICATION_ID` | Discord application identifier.                                          |
| `redis.url`              | `FACTEUR_REDIS_URL`              | Redis connection string for session storage.                             |
| `postgres.dsn`           | `FACTEUR_POSTGRES_DSN`           | Postgres connection string for Facteur migrations and application state. |

### AgentRun Dispatch Fields

| Path                                                           | Env Var                                                                | Description                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `codex_implementation_orchestrator.agents_base_url`            | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_AGENTS_BASE_URL`            | Agents service base URL. Defaults to `http://agents.agents.svc.cluster.local`. |
| `codex_implementation_orchestrator.namespace`                  | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_NAMESPACE`                  | Target namespace for AgentRuns. Defaults to `agents`.                          |
| `codex_implementation_orchestrator.agent_name`                 | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_AGENT_NAME`                 | Target Agent resource. Defaults to `codex-agent`.                              |
| `codex_implementation_orchestrator.runtime_type`               | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_RUNTIME_TYPE`               | Agents runtime type. Defaults to `job`.                                        |
| `codex_implementation_orchestrator.runtime_config`             | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_RUNTIME_CONFIG`             | Runtime config passed to Agents, such as `serviceAccountName`.                 |
| `codex_implementation_orchestrator.parameters`                 | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_PARAMETERS`                 | Static AgentRun parameters merged into command payloads.                       |
| `codex_implementation_orchestrator.secrets`                    | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_SECRETS`                    | Secret names exposed through the Agents runner contract.                       |
| `codex_implementation_orchestrator.secret_binding_ref`         | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_SECRET_BINDING_REF`         | Agents SecretBinding used for policy-controlled secret access.                 |
| `codex_implementation_orchestrator.vcs_provider`               | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_VCS_PROVIDER`               | Optional VCS provider name, usually `github`.                                  |
| `codex_implementation_orchestrator.vcs_policy_mode`            | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_VCS_POLICY_MODE`            | VCS policy mode, usually `read-write`.                                         |
| `codex_implementation_orchestrator.vcs_required`               | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_VCS_REQUIRED`               | Whether Agents must enforce VCS configuration.                                 |
| `codex_implementation_orchestrator.goal_token_budget`          | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_GOAL_TOKEN_BUDGET`          | Optional goal token budget passed to Agents.                                   |
| `codex_implementation_orchestrator.ttl_seconds_after_finished` | `FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_TTL_SECONDS_AFTER_FINISHED` | Optional AgentRun TTL.                                                         |

Legacy `argo.*` keys are accepted only as compatibility aliases for static parameter merging during the transition. They are not required and are not used to create Kubernetes Workflows.

## Service Surfaces

- **CLI (`cmd/facteur`)**: starts the HTTP server, applies migrations, and exposes local debugging commands.
- **Configuration (`internal/config`)**: central loader for YAML and env overrides.
- **Discord handlers (`internal/discord`)**: command routing, role enforcement, and session coordination.
- **Bridge (`internal/bridge`)**: converts command events into Agents `AgentRun` submissions.
- **Agents client (`internal/agents`)**: posts to `/v1/agent-runs` and checks `/ready`.
- **Session store (`internal/session`)**: Redis-backed storage for in-flight command interactions.
- **Knowledge store (`internal/knowledge`)**: Codex knowledge base persistence for ideas, tasks, task runs, and future metrics.

## Dispatch Contract

The command path expects a `payload` JSON option containing at least:

```json
{
  "prompt": "Implement the requested work",
  "stage": "implementation"
}
```

Facteur builds:

- `idempotency-key`: request correlation ID, payload delivery ID, payload run ID, or a generated `facteur-...` ID.
- `implementation.text`: the prompt.
- `implementation.summary`: issue title, payload title, or command-derived fallback.
- `implementation.source`: `discord` by default, promoted to `github` when repository and issue metadata are present.
- `implementation.metadata`: command, stage, user, trace, repository, issue, branch, and posting flags.
- `parameters`: static configured parameters plus scalar payload fields.
- `goal.objective`: the prompt.

The response preserves the old `workflowName` JSON field as a compatibility alias, but it now contains the AgentRun name. New callers should read `agentRunName`.

## Deployment Artifacts

- `services/facteur/Dockerfile` builds the service container.
- Kubernetes manifests live under `argocd/applications/facteur` and include a Knative `Service`, ConfigMap, Redis resource, KafkaSources, Postgres cluster, and log shipping resources.
- Facteur no longer ships a `WorkflowTemplate`, workflow service account, or Argo workflow RBAC.
- The runtime image for Codex execution is selected by Agents through `AgentProvider` and the `agent-runner.json` contract, not by Facteur.

## Operations

- `bun run build:facteur` builds and pushes the multi-arch image.
- `bun run facteur:reseal` refreshes the `facteur-discord` SealedSecret from 1Password.
- `bun run facteur:deploy` builds a fresh container image, pushes it, reapplies manifests, and rolls the Knative Service.
- `go run ./services/facteur/cmd/facteur migrate` applies database migrations out of band.
- `bun run facteur:consume` runs the local Kafka consumer with `services/facteur/config/example.yaml`.

## Codex Task Ingestion

GitHub issue implementation runs no longer transit Facteur. Froussard submits those AgentRuns directly to the Agents service; Facteur remains responsible for Discord/domain command events on `/events`.

- **Storage**: Facteur writes `codex_kb.ideas`, `codex_kb.tasks`, and `codex_kb.task_runs`.
- **Runtime**: Facteur submits an Agents `AgentRun` and stores the returned AgentRun identity.
- **Idempotency**: repeated `delivery_id` values return the existing result.

## Observability

Facteur initialises OpenTelemetry during startup, including spans and metrics across the HTTP server, Kafka consumer, Agents dispatch, and Codex intake. The cluster overlay provisions Grafana Alloy resources under `argocd/applications/facteur/overlays/cluster/alloy-*.yaml` to forward Knative pod logs to Loki.

Primary counters include `facteur_command_events_processed_total`, `facteur_command_events_failed_total`, and `facteur_command_events_dlq_total`.
