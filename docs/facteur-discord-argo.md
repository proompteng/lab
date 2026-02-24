# facteur Discord ↔ Argo bridge scaffolding

Facteur receives Discord interactions, validates signatures, and submits Argo Workflows against a pre-provisioned WorkflowTemplate. The goal is to document the configuration contract and deployment surface so future automation can plug in without reworking the service. For background, see the [Discord interactions reference](https://discord.com/developers/docs/interactions/receiving-and-responding) and the [Argo Workflows architecture overview](https://argo-workflows.readthedocs.io/en/stable/).

> Note: Codex planning/review dispatch is deprecated; implementation-only automation should be treated as the current production flow.

## Configuration model

Configuration can be supplied via YAML or environment variables prefixed with `FACTEUR_`. Environment values override the file to support container-based overrides.

### Required fields

| Path                     | Env var                          | Description                                                                                                                                                              |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `discord.bot_token`      | `FACTEUR_DISCORD_BOT_TOKEN`      | Discord bot token used for interactions API calls.                                                                                                                       |
| `discord.application_id` | `FACTEUR_DISCORD_APPLICATION_ID` | Discord application identifier for validating interaction payloads.                                                                                                      |
| `redis.url`              | `FACTEUR_REDIS_URL`              | Redis connection string (e.g. `redis://host:6379/0`) for session storage.                                                                                                |
| `postgres.dsn`           | `FACTEUR_POSTGRES_DSN`           | Postgres connection string for Facteur-managed schema migrations and application state.                                                                                  |
| `argo.namespace`         | `FACTEUR_ARGO_NAMESPACE`         | Kubernetes namespace containing the Argo Workflows controller (see the [Argo Workflows install docs](https://argo-workflows.readthedocs.io/en/stable/getting-started/)). |
| `argo.workflow_template` | `FACTEUR_ARGO_WORKFLOW_TEMPLATE` | WorkflowTemplate name to clone when dispatching workflows.                                                                                                               |

### Optional fields

| Path                               | Env var                                    | Description                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discord.public_key`               | `FACTEUR_DISCORD_PUBLIC_KEY`               | Discord public key for signature verification.                                                                                                                          |
| `discord.guild_id`                 | `FACTEUR_DISCORD_GUILD_ID`                 | Guild identifier used for scoping role checks.                                                                                                                          |
| `argo.service_account`             | `FACTEUR_ARGO_SERVICE_ACCOUNT`             | Service account name supplied to workflow submissions (defaults to controller value).                                                                                   |
| `argo.parameters`                  | `FACTEUR_ARGO_PARAMETERS`                  | Key/value overrides applied to every workflow submission. Expect a JSON object when sourced from env vars.                                                              |
| `role_map`                         | `FACTEUR_ROLE_MAP`                         | Mapping of command names to the Discord role IDs that can invoke them. See [role map schema](../schemas/facteur-discord-role-map.schema.json).                          |
| `codex_dispatch.planning_enabled`  | `FACTEUR_CODEX_DISPATCH_PLANNING_ENABLED`  | Feature flag guarding Codex planning dispatch. Keep `false` until codex_kb ingestion (#1635) and dispatch plumbing (#1636) land, then flip during the rollout playbook. |
| `codex_dispatch.payload_overrides` | `FACTEUR_CODEX_DISPATCH_PAYLOAD_OVERRIDES` | Optional map merged into the planning payload before Argo submission (values parsed as JSON when possible).                                                             |
| `codex_listener.enabled`           | `FACTEUR_CODEX_LISTENER_ENABLED`           | Set to `true` to stream the structured Codex task topic for debugging (                                                                                                 |
| `facteur codex-listen`).           |
| `codex_listener.brokers`           | `FACTEUR_CODEX_LISTENER_BROKERS`           | Comma-separated Kafka bootstrap brokers used by the listener.                                                                                                           |
| `codex_listener.topic`             | `FACTEUR_CODEX_LISTENER_TOPIC`             | Structured Codex task topic (default `github.issues.codex.tasks`).                                                                                                      |
| `codex_listener.group_id`          | `FACTEUR_CODEX_LISTENER_GROUP_ID`          | Kafka consumer group name for the listener (defaults to `facteur-codex-listener`).                                                                                      |

The sample at `services/facteur/config/example.yaml` includes the `codex_dispatch` defaults so operators can see the disabled state before rollout. Coordinate with the planning handoff playbook prior to enabling the flag.

## Role map schema

The role map controls which Discord roles can invoke specific commands. Schema definition: `schemas/facteur-discord-role-map.schema.json`. Each key is a command name; the value is a non-empty array of Discord role IDs permitted to run that command.

## Service surfaces

- **CLI (`cmd/facteur`)** – Cobra-based commands; `facteur serve --config ./config/production.yaml` bootstraps the HTTP handlers and Discord signature verification.
- **Configuration (`internal/config`)** – Central loader for YAML + env with validation.
- **Discord handlers (`internal/discord`)** – Command routing, role enforcement, and session coordination.
- **Bridge (`internal/bridge`)** – Facade around Argo clients and business logic for workflow execution.
- **Session store (`internal/session`)** – Redis-backed storage for in-flight command interactions (deployed via the OT-Container-Kit Redis Operator).
- **Argo integration (`internal/argo`)** – Workflow submission and status inspection plumbing.
- **Knowledge store (`internal/knowledge`)** – Codex knowledge base persistence layer for ideas, tasks, task runs, and future reflection/metrics surfaces.

## Deployment artifacts

- `services/facteur/Dockerfile` builds a distroless container.
- Pushes to `main` run `.github/workflows/facteur-build-push.yaml`, cross-building the image for linux/amd64 and linux/arm64 and publishing it to `registry.ide-newton.ts.net/lab/facteur`.
- Kubernetes manifests live under `argocd/applications/facteur` (base + overlays) and include a Knative `Service`, ConfigMap, RBAC, a Redis custom resource, and WorkflowTemplate resources so the runtime can scale-to-zero when idle.
- `argocd/applications/facteur/overlays/cluster/facteur-redis.yaml` provisions an in-cluster Redis instance via the OT-Container-Kit Redis Operator; confirm the platform `redis-operator` Application stays healthy before syncing facteur.
- Argo CD applications reside in `argocd/applications/facteur` and are referenced by `argocd/applicationsets/product.yaml` so the automation discovers and syncs the service.

## Operations scripts

- `bun run build:facteur` builds and pushes the multi-arch image via Docker (override registry/tag with `FACTEUR_IMAGE_*`).
- `bun run facteur:reseal` refreshes the `facteur-discord` SealedSecret from 1Password (`op` must be logged in). Kafka credentials are sourced from Strimzi-managed `KafkaUser` secrets instead of SealedSecrets.
- `bun run facteur:deploy` builds a fresh container image, pushes it to the registry, reapplies supporting manifests, and then rolls the Knative Service via `kn service apply`. Override `FACTEUR_IMAGE_TAG`/`FACTEUR_IMAGE_REGISTRY`/`FACTEUR_IMAGE_REPOSITORY` as needed before running.
- `go run ./services/facteur/cmd/facteur migrate` (or `facteur migrate` from a released image) applies database migrations out of band. Use it for manual smoke-tests before rolling a new binary.
- `bun run facteur:consume` runs the local Kafka consumer with `services/facteur/config/example.yaml` (override via `FACTEUR_CONSUMER_CONFIG`).

### Kafka credentials

Create a dedicated `KafkaUser` (the repo defines one named `facteur`) in the Strimzi `kafka` namespace and let the User Operator manage its SCRAM secret. The `kubernetes-reflector` application mirrors the generated secret into the `facteur` namespace, so the Knative `KafkaSource` can mount live credentials without touching SealedSecrets. This keeps Kafka passwords under Strimzi’s rotation model and avoids committing new YAML when they rotate.

## Codex knowledge base persistence

Facteur now owns a dedicated CloudNativePG cluster so Codex automation can persist the artefacts generated during `plan` → `implement` → `review` runs.

- Cluster: `facteur-vector-cluster` (namespace `facteur`) running `registry.ide-newton.ts.net/lab/vecteur:18-trixie`, three instances, 20&nbsp;Gi `rook-ceph-block` volumes with data checksums enabled.
- Database: `facteur_kb`, owned by the `facteur` role. Facteur applies embedded goose migrations at startup, enabling the `pgcrypto` and `vector` extensions and seeding schema objects.
- Connection secret: `facteur-vector-cluster-app` (namespace `facteur`). It follows the standard CloudNativePG app secret contract (`host`, `port`, `dbname`, `user`, `password`, `uri`). The Knative Service maps the `uri` key into `FACTEUR_POSTGRES_DSN` so the binary can run migrations on startup. Mount or template this secret into consuming workloads to hydrate Codex clients.
- Schema: `codex_kb` with two tables.
  - `runs` – UUID primary key (defaults to `gen_random_uuid()`), stores `repo_slug`, `issue_number`, `workflow`, lifecycle timestamps, and JSONB `metadata`. Intended to capture one Codex execution per issue/workflow combination.
  - `entries` – UUID primary key with a foreign key to `runs.id`, carries `step_label`, `artifact_type`, `artifact_stage`, free-form `content`, JSONB `metadata`, and a `vector(1536)` embedding column. An IVFFLAT index (`codex_kb_entries_embedding_idx`, cosine distance, 100 lists) accelerates similarity search.
- Privileges: the migrations assign ownership of `runs` and `entries` to the `facteur` role, grant schema usage, apply direct CRUD privileges on existing tables, and set default table grants so future objects remain writeable without extra scripts.

Future changes to the embedding dimensionality will require `ALTER TABLE codex_kb.entries ALTER COLUMN embedding TYPE vector(<new_dim>)` followed by `REINDEX INDEX codex_kb_entries_embedding_idx`.

## Initial command contract

The first public cut will ship three Discord slash commands that map to the existing workflow submission bridge. All commands run against the configured `argo.workflow_template`; the dispatcher injects an `action` parameter that mirrors the command name, and the Discord option names become workflow parameters after merging with static defaults defined under `argo.parameters`. The dispatcher still prefixes workflow names with the command that was invoked so we can trace intent in Argo.

| Command      | Primary goal                                             | Required options      | Optional options    | Workflow parameters                                         |
| ------------ | -------------------------------------------------------- | --------------------- | ------------------- | ----------------------------------------------------------- |
| `/plan`      | Shape upcoming work and capture acceptance checkpoints.  | `objective`           | `project`           | `action=plan`, `project`, `objective`                       |
| `/implement` | Kick off execution for an approved plan.                 | `project`, `branch`   | `ticket`, `notes`   | `action=implement`, `project`, `branch`, `ticket`, `notes`  |
| `/review`    | Collect artefacts for async review and notify approvers. | `project`, `artifact` | `notes`, `deadline` | `action=review`, `project`, `artifact`, `notes`, `deadline` |

### Event transport

Discord slash commands terminate at the shared webhook bridge (`apps/froussard`). The service verifies the Ed25519
signature (`x-signature-ed25519` and `x-signature-timestamp`), normalises the interaction into a stable payload, and
publishes it to Kafka topic `discord.commands.incoming` as an `application/x-protobuf` payload. The canonical contract
is `proompteng.facteur.v1.CommandEvent` defined in `proto/proompteng/facteur/v1/contract.proto`; generated stubs live under
`services/facteur/internal/facteurpb` (Go) and `apps/froussard/src/proto/proompteng/facteur/v1` (TypeScript). Facteur subscribes to that
topic, deserialises the message via the protobuf stubs, and drives the workflow dispatcher. Facteur is also responsible
for using the interaction token carried in the event to post follow-up updates back to Discord once the workflow
completes.

Structured Codex tasks arrive through a dedicated KafkaSource (`argocd/applications/facteur/overlays/cluster/facteur-codex-kafkasource.yaml`) that
subscribes to `github.issues.codex.tasks` and forwards each protobuf payload to the Knative service at `/codex/tasks`.
The handler simply logs the stage, repository, issue number, and delivery identifier today so operators can verify the
feed before deeper integrations are wired up.

### Protobuf workflow

- The repository is wired to a Buf workspace (`buf.yaml`). Run `buf generate` (or `bun run proto:generate`) to
  refresh the Go and TypeScript stubs directly with the locally installed Buf CLI.
- Go stubs continue to land in `services/facteur/internal/facteurpb` and TypeScript stubs are generated with
  [`protobuf-es`](https://github.com/bufbuild/protobuf-es) for use in `apps/froussard`. Keep dependant services pinned
  to the generated classes instead of hand-rolled JSON structures.
- GitHub-facing payloads now share the same toolchain via `proompteng/froussard/v1/codex_task.proto`, landing in
  `services/facteur/internal/froussardpb` (Go) and `apps/froussard/src/proto/proompteng/froussard/v1` (TypeScript). The
  structured Codex stream publishes to
  `github.issues.codex.tasks`; run `facteur codex-listen` to tail those payloads locally before wiring them into the
  workflow dispatcher.
- Continuous integration runs `buf format --diff` and `buf lint` through `.github/workflows/buf-ci.yml`, with
  breaking-change detection enabled once the base branch carries matching Buf configs.

### `/plan`

- **Use case**: product or tech leads can request a structured plan for upcoming work. The backing workflow assembles a checklist, drafts milestones, and posts updates to downstream systems.
- **Discord options**:
  - `objective` (string, required) – short description of the desired outcome.
  - `project` (string, optional) – canonical project or repository slug; defaults to an implementation-specific fallback when omitted.
- **Workflow expectations**: the workflow template must accept parameters named `action`, `objective`, and `project`. When `project` is omitted, the bridge drops the key so downstream defaults apply.
- **Response contract**: facteur echoes the workflow name and namespace, and stores the `DispatchResult` in Redis (15-minute TTL) so follow-up commands can link back using the correlation ID.

### `/implement`

- **Use case**: engineers start implementation once planning is signed off. The workflow clones repositories, provisions feature environments, and updates status dashboards.
- **Discord options**:
  - `project` (string, required) – matches the `/plan` project slug to keep telemetry aligned.
  - `branch` (string, required) – Git branch that will host the work.
  - `ticket` (string, optional) – identifier for the tracking issue or ticket (e.g. JIRA, Linear).
  - `notes` (string, optional) – any extra instructions for the automation.
- **Workflow expectations**: parameters `action`, `project`, `branch`, `ticket`, and `notes` are provided. Empty optional values are omitted at submission time.
- **Response contract**: mirrors `/plan`, with the same Redis persistence so `/review` can automatically reference the most recent implementation run for the requesting user.

### `/review`

- **Use case**: request an asynchronous review of generated artefacts (PRs, docs, videos) and broadcast the workstream status.
- **Discord options**:
  - `project` (string, required) – consistent identifier carried across the other commands.
  - `artifact` (string, required) – URI or short handle pointing to the item under review.
  - `notes` (string, optional) – context for reviewers (e.g. areas needing attention).
  - `deadline` (string, optional) – ISO 8601 date to nudge reminders.
- **Workflow expectations**: workflow template consumes `action`, `project`, `artifact`, `notes`, and `deadline`. Facteur injects the last stored correlation ID (when present) as an additional parameter `last_correlation_id` so review automation can fetch logs or artefacts from previous steps.
- **Response contract**: if a cached `DispatchResult` exists, facteur appends `Last request correlation: <id>` to the Discord reply. Otherwise it only reports workflow submission status.

### Permission model

- Role assignments live under `role_map` in configuration. Each command should map to at least one Discord role ID; an empty entry makes the command publicly accessible.
- Recommended defaults:
  - `/plan`: product/tech lead roles (e.g. `bot.plan`).
  - `/implement`: engineering contributor roles (e.g. `bot.engineer`).
  - `/review`: allow both leads and engineers so that any stakeholder can trigger reviews.
- The handler short-circuits with a friendly error when the invoking user lacks the necessary role, and the request is not forwarded to Argo.

## Observability

Facteur initialises OpenTelemetry during startup, enabling spans and metrics across the HTTP server (via `otelfiber`), Kafka consumer, and Argo dispatcher. The Knative Service populates default observability endpoints:

| Variable                              | Value                                                                                                 | Purpose                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `OTEL_SERVICE_NAME`                   | `facteur`                                                                                             | Identifies the service in telemetry backends.                |
| `OTEL_SERVICE_NAMESPACE`              | `metadata.namespace`                                                                                  | Mirrors the Kubernetes namespace in resource metadata.       |
| `OTEL_EXPORTER_OTLP_PROTOCOL`         | `http/protobuf`                                                                                       | Aligns with the observability stack's OTLP HTTP gateways.    |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | `http://observability-tempo-gateway.observability.svc.cluster.local:4318/v1/traces`                   | Tempo ingestion endpoint.                                    |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics`                    | Mimir ingestion endpoint.                                    |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | `http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/push` | Loki ingestion endpoint (reserved for future log exporting). |

Knative does not inject the observability wiring automatically; the Argo CD overlay now provisions a dedicated Grafana Alloy deployment (`facteur-alloy`) that tails all pods in the `facteur` namespace and pushes the output to the in-cluster Loki gateway. The manifests live in `argocd/applications/facteur/overlays/cluster/alloy-*.yaml`, keeping the observability routing alongside the rest of the service configuration.

Locally, point the same variables at your observability environment to capture traces and metrics. Instrumentation surfaces counters such as `facteur_command_events_processed_total`, `facteur_command_events_failed_total`, and `facteur_command_events_dlq_total`, plus spans scoped to Kafka message handling and workflow submissions.

## Codex task ingestion

- **Endpoint**: `POST /codex/tasks` expects a `proompteng.froussard.v1.CodexTask` protobuf payload (binary wire format).
- **Storage**: the handler upserts rows into `codex_kb.ideas`, `codex_kb.tasks`, and `codex_kb.task_runs`, using `delivery_id` to guarantee idempotent retries (`ON CONFLICT (delivery_id) DO UPDATE …`).
- **Dependencies**: set `FACTEUR_POSTGRES_DSN` and `redis.url`; migrations run automatically on startup (`go run ./cmd/facteur migrate` runs them manually).
- **Sample payload**: `docs/examples/codex-task.json` mirrors the fields emitted by Froussard. Encode it via `buf beta protoc --encode proompteng.froussard.v1.CodexTask proto/proompteng/froussard/v1/codex_task.proto`.
- **Manual validation**:
  1. Start Postgres (`postgres://postgres:postgres@127.0.0.1:6543/postgres?sslmode=disable`) and Redis.
  2. Run `go run . serve --config config/example.yaml`.
  3. `curl -H 'Content-Type: application/x-protobuf' --data-binary @/tmp/codex-task.bin http://127.0.0.1:8080/codex/tasks`.
  4. Inspect persisted rows using `psql "$FACTEUR_POSTGRES_DSN" -c "SELECT idea_id, stage, delivery_id FROM codex_kb.task_runs JOIN codex_kb.tasks ON task_runs.task_id = tasks.id;"`.
- **Idempotency check**: re-send the same `delivery_id` and verify the handler responds `202 Accepted` while returning the existing `task_run_id`.

## Next steps

Future issues will implement:

- Discord interaction handling (slash commands, component interactions).
- Authentication with real Discord and Argo APIs.
- Operational runbooks and playbooks.
- End-to-end validation against staging workflows.
