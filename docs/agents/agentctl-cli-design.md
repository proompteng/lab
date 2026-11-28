# agentctl CLI Design

Status: Current source contract (Wave 22C)

Docs index: [README](README.md)

Location: `services/agents/agentctl` (ships with the Agents service; it is not a separate service or control plane).

This document describes the command tree and wire/output contracts that are actually shipped by the current
`src/index.ts` entrypoint. It is deliberately narrower than the older design proposals. Draft behavior is called out
as future work and is not an invocation contract.

## Purpose and implementation boundary

`agentctl` manages Agents Kubernetes resources, submits AgentRuns, renders common manifests, and reports control-plane
health. It is an Effect CLI application with two transport implementations:

- Kubernetes mode shells out to `kubectl` for resource and pod operations.
- gRPC mode calls the Agents `AgentctlService` for resource operations, AgentRun submission/cancellation/logs/status,
  server information, and control-plane status.

The package is `@proompteng/agentctl` at version `0.2.2`. The npm entry point is `dist/agentctl.js`; the repository also
contains Bun binary and Homebrew-generation scripts. The Kubernetes backend invokes `kubectl` through Node's
child-process API in both the npm launcher and the Bun binaries.

The CLI does not replace `kubectl` for arbitrary Kubernetes operations, manage Helm, own database lifecycle, or manage
ingress. It operates only on the resource kinds and RPCs listed below.

## Transport modes and endpoints

### Mode selection

The mode resolution order is:

1. `--kube` forces Kubernetes mode.
2. Otherwise `--grpc` forces gRPC mode.
3. Otherwise `AGENTCTL_MODE=kube` or `AGENTCTL_MODE=grpc` selects the mode.
4. Otherwise Kubernetes mode is the default.

`--kube` wins if both mode flags are supplied. A configured address by itself does not select gRPC; in kube mode an
explicit address produces the warning `gRPC address configured; use --grpc to enable gRPC mode.`

Kubernetes mode uses the selected kubeconfig and context, and passes the selected namespace to `kubectl`. When gRPC
mode is selected, the client connects to the resolved address. If no address is configured, the client default is:

```text
agents-grpc.agents.svc.cluster.local:50051
```

The Agents chart exposes the primary control-plane gRPC service as `agents-grpc` on port `50051` when `grpc.enabled`
is true. The separate `agents-controllers-grpc` Service is gated by `controllers.service.enabled` and is disabled in
the production values; it is not the agentctl production endpoint. A local port-forward therefore looks like:

```bash
kubectl -n agents port-forward svc/agents-grpc 50051:50051
agentctl --grpc --server 127.0.0.1:50051 status
```

The agentctl proto and CLI expose no HTTP or SSE transport. The Agents service separately registers
`GET /v1/control-plane/stream`, but the current agentctl client does not call that route; `status` and `diagnose` use
the unary gRPC `GetControlPlaneStatus` RPC in gRPC mode.

### gRPC authentication and TLS

`--token` is sent as gRPC metadata `authorization: Bearer <token>`. The server checks that token when
`AGENTS_GRPC_TOKEN` is configured. `--tls` enables TLS; client certificate material is read from environment paths
when supplied:

```text
AGENTCTL_CA_CERT
AGENTCTL_CLIENT_CERT
AGENTCTL_CLIENT_KEY
```

The CLI has no `--tls-ca`, `--tls-cert`, `--tls-key`, or server-name flag. Those flags are future work, not current
syntax. Without `--tls`, the gRPC client uses insecure channel credentials.

## Command surface

Global flags are pre-parsed and can be used with the commands below. The command names are literal: resource verbs are
top-level commands, not subcommands of a resource. `run list` is a convenience alias for `list run`.

The complete custom global flag set is:

| Flag                    | Current behavior                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `--kube` / `--grpc`     | Select the transport mode, with `--kube` taking precedence.                             |
| `--namespace`, `-n`     | Select the namespace; default `agents`.                                                 |
| `--server`, `--address` | Resolve the gRPC address; they do not by themselves select gRPC mode.                   |
| `--token`               | Resolve the client gRPC bearer token.                                                   |
| `--tls`, `--no-tls`     | Enable or disable client gRPC TLS.                                                      |
| `--kubeconfig`          | Select the kubeconfig file.                                                             |
| `--context`             | Select the kubeconfig context.                                                          |
| `--output`, `-o`        | Select `table`, `wide`, `json`, `yaml`, `yaml-stream`, or `text`.                       |
| `--yes`, `-y`           | Skip top-level `apply` and `delete` confirmation prompts.                               |
| `--no-input`            | Disable interactive prompts.                                                            |
| `--color`, `--no-color` | `--no-color` sets `NO_COLOR`; `--color` is accepted but applies no additional override. |
| `--pager`, `--no-pager` | Opt into/out of the pager; paging is only started for a TTY and is off unless enabled.  |

The Effect CLI also supplies `--help/-h`, `--version`, `--completions sh|bash|fish|zsh`, `--log-level`, and
`--wizard` in its generated help.

### Discovery and local configuration

```text
agentctl help [<topic>]
agentctl examples [<topic>]
agentctl quickstart
agentctl version [--client|--client-only]

agentctl auth login [--token <token>] [--with-token]
agentctl auth status
agentctl auth logout

agentctl config view [--show-secrets]
agentctl config set [--namespace <ns>] [--server <address>] [--address <address>]
                     [--token <token>] [--kubeconfig <path>] [--context <name>] [--tls|--no-tls]
agentctl config init [--namespace <ns>] [--server <address>] [--address <address>]
                     [--token <token>] [--kubeconfig <path>] [--context <name>] [--tls|--no-tls]

agentctl completion <shell>
agentctl completion install <shell>
```

`<shell>` is `bash`, `zsh`, or `fish`. Use `agentctl completion install zsh` to install rather than print a script.
Installation writes under `$XDG_CONFIG_HOME/agentctl/completions` or `$HOME/.config/agentctl/completions` and prints
a shell-specific activation hint.

`help all` and `--help` show descriptions for commands and flags, with one inherited global-flags section.

`version --client` (or `--client-only`) prints only `agentctl <version>`. Without that flag it prints the client
version and attempts to report the server: the kube path prints the Agents deployment image or
`server info unavailable (kube mode)`, while the gRPC path calls `GetServerInfo` and prints the server version and,
when present, build SHA/time.

`auth` is local file management. `auth login` saves a token and does not contact or validate the server. `--with-token`
reads the token from stdin and cannot be combined with `--token`; if no token is supplied, the
interactive login prompts. `auth status` and `auth logout` inspect or modify only the config file, and logout is not a
server-side revocation.

`config init` prompts for settings not supplied by flags. It asks for namespace, optional kubeconfig and context,
and whether to configure gRPC; the gRPC branch asks for address, optional token, and TLS. `config set` saves only the
settings explicitly provided and does not prompt.

### Resource verbs

```text
agentctl get <resource> [<name>] [--selector <selector>] [run filters]
agentctl describe <resource> <name>
agentctl list <resource> [--selector <selector>] [run filters]
agentctl run list [--selector <selector>] [run filters]
agentctl watch <resource> [--selector <selector>] [run filters] [--interval <seconds>]
agentctl apply (-f|--file <path|->) [--dry-run]
agentctl delete [--dry-run] <resource> <name>
agentctl explain <resource>
```

`get <resource>` without a name is a list operation. A named `get` rejects selectors and run filters. Selectors
can be abbreviated `-l`. AgentRun lists accept these filters in addition to the selector:

- `--phase <phase>` matches the AgentRun CR phase; `--runtime <type>` matches the runtime in its spec.
- `--sort-by age|name|phase` defaults to newest-first. Name and phase sort ascending, with name breaking ties.
- `--active` keeps non-terminal runs or live Pods. For example, a stale Pending CR with a completed Job and no live
  Pod is not active. In gRPC mode, only the CR phase is available.
- `--stale` (kube only) keeps runs whose CR and current runtime evidence disagree. A snapshot can catch a normal
  transition, so investigate persistent mismatches before intervening.
- `--limit <n>` keeps the first positive integer number of rows after filtering and sorting.

In kube mode the CLI joins each namespace's AgentRun, Job, and Pod lists once. It correlates owner references, run UID
labels, and `status.runtimeRef`; it does not merge evidence from replaced runs or Jobs with conflicting UIDs. A Job's
active count does not imply a Running Pod, and a Pod failure inside a retryable Job is not a terminal run failure.
JSON and YAML preserve the raw resource objects; Pod/Job metadata and inferred phases appear only in the human views.

`describe run <name>` defaults to a human summary in kube mode: CR phase and conditions, runtimeRef, Job and Pod phases,
node, branch, service account, MCP token projection/mount, a bounded excerpt of `run.json.prompt`, and up to ten recent
Events for the AgentRun, Job, and Pod. ConfigMap and Event access gaps are shown in the summary. Structured
`-o json`/`-o yaml` returns the raw CR without fetching workloads or Events. Other resource types and gRPC
`describe` default to YAML.

`watch` repeatedly performs the corresponding list operation every five seconds by default. `--interval` is parsed as
seconds; invalid, zero, and negative values fall back to five seconds. This is client-side polling in both transports,
not a Kubernetes watch or a gRPC resource-watch stream. Table and wide output clear the terminal between iterations;
structured output separates iterations with blank lines. SIGINT exits the polling loop.

`apply` reads one or more YAML documents from a file or `-` (stdin). `--dry-run` parses and renders the documents
without contacting the backend. A normal top-level apply asks for confirmation; pass `--yes` for automation, including
non-TTY, CI, or `--no-input` execution. In kube mode the backend applies supported manifests; in gRPC mode each
document is routed to its kind-specific Apply RPC. Unsupported kinds fail rather than being silently ignored.

`delete` only supports non-AgentRun resources. It confirms before mutation unless `--yes` is supplied. `--dry-run`
fetches and renders the current object without deleting it. To stop a run, use `agentctl run cancel <name>`; the generic
delete path rejects AgentRuns.

`explain` prints the resolved Kind, API version, plural, and an empty-spec sample manifest. Unknown resource aliases
are validation errors.

The following older nested forms are not in the current command tree: `agentctl agent get`, `agentctl impl create`,
`agentctl impl init`, `agentctl run apply`, `agentctl run get`, `agentctl run watch`,
`agentctl run status`, and `agentctl run init`. Use the top-level resource verbs and the `create impl`/`init impl`/
`init run` forms documented here. They are not compatibility aliases.

### Creation and manifest templates

```text
agentctl create impl --text <text|@file|-> [--summary <summary>]
                       [--source provider=<p>[,externalId=<id>][,url=<url>]]

agentctl init impl [--name <name>] [--text <text|@file|->] [--summary <summary>]
                    [--acceptance|--criteria <criterion>]...
                    [--label|--labels <label>]...
                    [--source <provider=...,...>] [--file <path>] [--apply]

agentctl init run [--name <name>] [--agent <name>] [--impl <name>] [--runtime <type>]
                  [--runtime-config <key=value>]... [--param <key=value>]...
                  [--workload-image <image>] [--cpu <quantity>] [--memory <quantity>]
                  [--memory-ref <name>] [--file <path>] [--apply] [--wait]
```

`create impl` requires `--text`, accepts inline text, `@file`, or `-` for stdin, and directly creates an
ImplementationSpec. It uses a generated `impl-` name in kube mode; no `--apply`, acceptance, or label option exists on
this command. Its source shorthand renders only when it contains `provider=...`; it also accepts `externalId` (or
`external_id`) and `url`.

`init impl` prompts for omitted values when interactive. Text, acceptance criteria, labels, and source are rendered in
an `agents.proompteng.ai/v1alpha1` `ImplementationSpec`; omitted optional lists are omitted from the manifest. `--file`
writes the YAML, and `--apply` submits it. If gRPC apply is selected without `--name`, the CLI gives the manifest a
concrete random `impl-<8 hex>` name because the gRPC Apply RPC cannot rely on Kubernetes `generateName`. Unlike
top-level `apply`, `init impl --apply` and `init run --apply` do not invoke the generic confirmation prompt.

`init run` prompts for agent, ImplementationSpec, and runtime when omitted. The runtime prompt suggests
`workflow|job|temporal|custom` and defaults to `workflow`; the value is passed through without CLI validation. It
renders an `AgentRun` with `agentRef`, `implementationSpecRef`, `runtime.type`, optional runtime config and
parameters, optional `memoryRef` and workload resources, and a single `implement` workflow step when the runtime is
`workflow`. This command does not expose VCS, idempotency-key, or VCS-policy flags. `--wait` has an effect only with
`--apply`. Without `--apply`, the command only writes or prints the manifest.

For all init prompts, `--no-input`, a non-TTY, or `CI` disables prompting; missing required values then fail with a
validation error. Repeated key/value options may be repeated or comma-separated. Values are split at the first `=`;
for generated kube maps, a duplicate key keeps the last value.

### AgentRun actions

```text
agentctl run submit --agent <name> --runtime <type> (--impl <name>|--inline-prompt <text>|--prompt-file <path|->)
agentctl run codex [--agent <name>] [--runtime <type>] (--inline-prompt <text>|--prompt-file <path|->|--prompt <text>)

agentctl run logs <name> [-f|--follow] [--tail <lines>] [--since <duration>] [--timestamps] [--previous]
agentctl run wait <name> [--timeout <duration>] [--interval <duration>]
agentctl run cancel <name>
```

`run submit` and `run codex` create an AgentRun immediately; neither prompts for confirmation nor has a dry-run
option. Use `init run` without `--apply` to render a manifest for an existing ImplementationSpec. The prompt belongs in
the ImplementationSpec or inline implementation. The CLI rejects `--param prompt=...` before reading a prompt file,
calling local Codex, or submitting anything.

`run codex` defaults to `--agent codex-agent --runtime workflow`. `--inline-prompt` and `--prompt-file` submit the
literal task without starting local Codex. `--prompt` (or the interactive prompt when no task flag is supplied) instead
uses local Codex to generate an ImplementationSpec and submits a reference to it. The two paths are mutually exclusive.

| Submission flag                           | AgentRun field or behavior                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `--agent`                                 | `spec.agentRef.name`                                                                      |
| `--impl`                                  | `spec.implementationSpecRef.name` (submit only)                                           |
| `--inline-prompt`, `--prompt-file`        | `spec.implementation.inline.text`                                                         |
| `--repo`, `--base`, `--head`              | `spec.parameters.repository`, `base`, `head`; take precedence over `--param`              |
| `--runtime`, `--runtime-config key=value` | `spec.runtime.type` and `config`                                                          |
| `--param key=value`                       | `spec.parameters`; repeat for multiple values                                             |
| `--memory-ref`                            | `spec.memoryRef.name`                                                                     |
| `--vcs`, `--vcs-mode`, `--vcs-required`   | `spec.vcsRef.name`, `spec.vcsPolicy.mode`, `spec.vcsPolicy.required`                      |
| `--workload-image`                        | `spec.workload.image`                                                                     |
| `--cpu`, `--memory-request`               | `spec.workload.resources.requests`; `--memory` aliases `--memory-request`                 |
| `--memory-limit`                          | `spec.workload.resources.limits.memory`                                                   |
| `--ttl`                                   | `spec.ttlSecondsAfterFinished` in seconds; 0 disables per-run TTL                         |
| `--secret`                                | `spec.secrets`; repeat for multiple allowed Kubernetes Secret names                       |
| `--idempotency-key`                       | `spec.idempotencyKey` for controller deduplication when enabled (gRPC: `idempotency_key`) |
| `--wait`                                  | Wait for the submitted run using the same terminal-state logic as `run wait`              |
| `--verify`                                | Check the rendered prompt and runner identity before returning                            |

Kube submit generates a name from the Agent name, labels the resource for delivery tracking, and adds a single
`implement` step for workflow runtime. The CLI does not set `spec.runtime.config.serviceAccountName` unless explicitly
supplied in `--runtime-config`; the Pod inherits the AgentProvider account (`codex-auto-ontology-runner` for Galactic's
standard Codex provider). The existing gRPC `SubmitAgentRun` RPC does not encode inline task text, memory limits, TTL,
or secrets. Those options and `--verify` require Kubernetes mode; the CLI does not bypass gRPC admission by applying
a substitute manifest.

`--verify` reads the AgentProvider's expected service account and token projection settings, then waits up to 60
seconds for a Pod and its mounted run-spec ConfigMap. A direct Job normally mounts `<run>-spec`; the CLI follows the
Pod mount to handle workflow attempt suffixes and truncated names. It checks that `run.json.prompt` matches the supplied
task text ignoring outer whitespace, the Pod uses the expected account, and `agent-runner` has the read-only projection
at the configured audience and mount path. For verification use literal, non-templated task text. The check reads no
Secret data or token contents. A failure after submission prints the existing AgentRun name; inspect that run rather
than blindly submitting again.

`run logs` selects the current runner Pod, preferring a live Pod over failed attempts. Kube mode forwards all the
listed switches to `kubectl logs`. In gRPC mode only `--follow` is supported by `StreamAgentRunLogs`; messages tagged
`stderr` are written to stderr, the rest to stdout.

`run wait` defaults to a two-hour timeout and a two-second kube polling interval. Durations accept seconds or one
of `ms`, `s`, `m`, or `h` (for example, `--timeout 10m --interval 500ms`). Kube mode honors a terminal CR first.
If it has not caught up, a completed or failed Job (or unambiguous Pod evidence) can end the wait. A workflow Job
does not end a run early if steps, loops, or retries can still change the outcome. Fallbacks are reported separately
from the raw CR; the command never patches it. Failed or cancelled runs and timeouts exit nonzero. gRPC mode uses a
deadline on `StreamAgentRunStatus` and does not accept `--interval`.

`run cancel` calls `CancelAgentRun` in gRPC mode. In kube mode it requests deletion of the current run's live Jobs,
ignoring Jobs already removed and leaving terminal Jobs and the AgentRun CR intact. It reports the request, not a
confirmed terminal run state. A run queued without a Job or using Temporal/custom runtime cannot be cancelled this
way; a workflow controller can also reconcile another attempt. Inspect status to confirm the outcome.

## Resource names and API identity

Resource arguments resolve case-insensitively through the registry. The canonical names, accepted aliases, API
identities, and generic operations are:

| Canonical argument | Accepted aliases                                                                                                   | Kind                     | API version                            | Plural                    | Generic operations                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------ | -------------------------------------- | ------------------------- | ---------------------------------------------- |
| `agent`            | `agent`, `agents`                                                                                                  | `Agent`                  | `agents.proompteng.ai/v1alpha1`        | `agents`                  | list/get/apply/delete                          |
| `provider`         | `provider`, `providers`, `agentprovider`, `agentproviders`                                                         | `AgentProvider`          | `agents.proompteng.ai/v1alpha1`        | `agentproviders`          | list/get/apply/delete                          |
| `impl`             | `impl`, `impls`, `implementation`, `implementations`, `implementationspec`, `implementationspecs`, `spec`, `specs` | `ImplementationSpec`     | `agents.proompteng.ai/v1alpha1`        | `implementationspecs`     | list/get/apply/delete; create                  |
| `source`           | `source`, `sources`, `implementationsource`, `implementationsources`                                               | `ImplementationSource`   | `agents.proompteng.ai/v1alpha1`        | `implementationsources`   | list/get/apply/delete                          |
| `vcs`              | `vcs`, `vcss`, `versioncontrolprovider`, `versioncontrolproviders`                                                 | `VersionControlProvider` | `agents.proompteng.ai/v1alpha1`        | `versioncontrolproviders` | list/get/apply/delete                          |
| `memory`           | `memory`, `memories`                                                                                               | `Memory`                 | `agents.proompteng.ai/v1alpha1`        | `memories`                | list/get/apply/delete                          |
| `tool`             | `tool`, `tools`                                                                                                    | `Tool`                   | `tools.proompteng.ai/v1alpha1`         | `tools`                   | list/get/apply/delete                          |
| `toolrun`          | `toolrun`, `toolruns`                                                                                              | `ToolRun`                | `tools.proompteng.ai/v1alpha1`         | `toolruns`                | list/get/apply/delete                          |
| `orchestration`    | `orchestration`, `orchestrations`                                                                                  | `Orchestration`          | `orchestration.proompteng.ai/v1alpha1` | `orchestrations`          | list/get/apply/delete                          |
| `orchestrationrun` | `orchestrationrun`, `orchestrationruns`                                                                            | `OrchestrationRun`       | `orchestration.proompteng.ai/v1alpha1` | `orchestrationruns`       | list/get/apply/delete                          |
| `approval`         | `approval`, `approvals`, `approvalpolicy`, `approvalpolicies`                                                      | `ApprovalPolicy`         | `approvals.proompteng.ai/v1alpha1`     | `approvalpolicies`        | list/get/apply/delete                          |
| `budget`           | `budget`, `budgets`                                                                                                | `Budget`                 | `budgets.proompteng.ai/v1alpha1`       | `budgets`                 | list/get/apply/delete                          |
| `secretbinding`    | `secretbinding`, `secretbindings`                                                                                  | `SecretBinding`          | `security.proompteng.ai/v1alpha1`      | `secretbindings`          | list/get/apply/delete                          |
| `signal`           | `signal`, `signals`                                                                                                | `Signal`                 | `signals.proompteng.ai/v1alpha1`       | `signals`                 | list/get/apply/delete                          |
| `signaldelivery`   | `signaldelivery`, `signaldeliveries`                                                                               | `SignalDelivery`         | `signals.proompteng.ai/v1alpha1`       | `signaldeliveries`        | list/get/apply/delete                          |
| `schedule`         | `schedule`, `schedules`                                                                                            | `Schedule`               | `schedules.proompteng.ai/v1alpha1`     | `schedules`               | list/get/apply/delete                          |
| `artifact`         | `artifact`, `artifacts`                                                                                            | `Artifact`               | `artifacts.proompteng.ai/v1alpha1`     | `artifacts`               | list/get/apply/delete                          |
| `workspace`        | `workspace`, `workspaces`                                                                                          | `Workspace`              | `workspaces.proompteng.ai/v1alpha1`    | `workspaces`              | list/get/apply/delete                          |
| `run`              | `run`, `runs`, `agentrun`, `agentruns`                                                                             | `AgentRun`               | `agents.proompteng.ai/v1alpha1`        | `agentruns`               | list/get/apply; run actions; no generic delete |

All rows above use `v1alpha1`; the API version column is the group/version used in manifests. `vcss` is the
registry-generated plural alias for `vcs`; use `vcs` or `versioncontrolprovider` in new scripts.

The gRPC mapping follows the canonical resource names. Each non-run resource has `List<Name>`, `Get<Name>`,
`Apply<Name>`, and `Delete<Name>` RPCs; ImplementationSpec additionally has `CreateImplementationSpec`. AgentRun has
the corresponding CRUD RPCs plus the run-specific RPCs below.

## Output contract

The accepted global output values are `table`, `wide`, `json`, `yaml`, `yaml-stream`, and `text`. The default is
`table`; an unknown output value is normalized silently to `table`. Output options affect resource and status renderers;
logs and local help/config/auth messages retain their command-specific text.

### Resource renderers

- A single resource with `json` is the resource object; `yaml` and `yaml-stream` print one YAML document; `text` prints
  `kind/name` (or the name when kind is absent).
- A list with `json` or `yaml` prints the raw list object, including its `items`; `yaml-stream` prints each item as a
  separate `---` YAML document; `text` prints one `kind/name` per item.
- `apply` and init apply results use an array for `json`/`yaml`; `yaml-stream` emits one document per result.
- Generic table columns are `NAME NAMESPACE STATUS`; wide columns are `NAME NAMESPACE KIND AGE STATUS LABELS DETAILS`.
- AgentRun table columns are `NAME AGENT PHASE POD_PHASE NODE HEAD AGE`; wide adds `SA DESYNC JOB`. The head branch
  comes from VCS status, falling back to the submitted parameter. `DESYNC` shows CR phase → workload phase; a dash
  means no observed mismatch, not that absent evidence was verified.

Status text for resource rows is selected in this order: `status.phase`, `status.status`, `status.state`,
`status.result`, then the `Ready` condition status. Details are populated for AgentRun runtime type, ImplementationSpec
summary, ImplementationSource provider, Schedule schedule, ToolRun tool reference, and Agent provider reference.

### Status, diagnose, and fleet

In gRPC mode both `status` and `diagnose` call
`GetControlPlaneStatus` and the JSON/YAML payload has this exact field family from the proto:

```json
{
  "service": "agents",
  "generated_at": "2026-08-30T00:00:00.000Z",
  "controllers": [
    {
      "name": "agents-controller",
      "enabled": true,
      "started": true,
      "crds_ready": true,
      "missing_crds": [],
      "last_checked_at": "2026-08-30T00:00:00.000Z",
      "status": "healthy",
      "message": ""
    }
  ],
  "runtime_adapters": [
    {
      "name": "workflow",
      "available": true,
      "status": "healthy",
      "message": "",
      "endpoint": ""
    }
  ],
  "database": {
    "configured": true,
    "connected": true,
    "status": "healthy",
    "message": "",
    "latency_ms": 12
  },
  "grpc": {
    "enabled": true,
    "address": "127.0.0.1:50051",
    "status": "healthy",
    "message": ""
  },
  "namespaces": [
    {
      "namespace": "agents",
      "status": "healthy",
      "degraded_components": []
    }
  ]
}
```

The values above are illustrative; fields and names are the contract. There is no `workflows` member in this gRPC
payload. For non-JSON/non-YAML status output, the table columns are `COMPONENT NAMESPACE STATUS MESSAGE`; namespace
entries, controllers, runtime adapters (prefixed `runtime:`), database, and gRPC are rendered as rows. An empty gRPC
message falls back to its address in the table.

Kube `status` reports observed health of the selected namespace and the split-mode deployments `agents`,
`agents-controllers`, `agents-auto-ontology-mcp-gateway`, and `agents-shell`. It shows the controller leader Lease
holder and renew time, optional CNPG Cluster `agents-db-next`, Agents CRD readiness, the CR/runtime mismatch count,
and Running Pods per node in that namespace. `status -o wide` and structured output enumerate all 20 required CRDs,
including `versioncontrolproviders.agents.proompteng.ai` and `swarms.swarm.proompteng.ai`. See
[the chart's CRDs](../../charts/agents/crds) for the installed names and schemas.

Kube `diagnose` adds targeted remediation for persistent phase desyncs, missing CRDs, unhealthy deployments, database
degradation, leader Lease issues, and incomplete reads. It does not restart or patch anything. For example:

```bash
agentctl --context galactic -n agents status
agentctl --context galactic -n agents diagnose -o wide
agentctl --context galactic -n agents run list --stale -o wide
```

Kube health JSON/YAML reports `components`, `leader`, `crds`, `runs`, `nodes`, and `unavailable` for the selected
namespace; diagnose adds `hints`. These snapshots replace the kube-only single-`deployment` payload. A denied read
is unknown, not a missing resource or a zero count.

`agentctl fleet` (alias `capacity`) shows total/active/pending/stale run counts, namespace Pod counts by node, node
architecture and allocatable CPU/RAM/Pods, and configured concurrency/rate limits for `deployment/agents-controllers`.
Pending is a subset of active; stale can overlap either. Pod counts are for the selected namespace, while
allocatable quantities are node-wide Kubernetes values, not remaining headroom. The CLI shows the allowlisted
deployment limits; entries sourced through `valueFrom` are identified without resolving their values. These views
require kube access to Jobs, Pods, AgentRuns and the named health resources; node and CRD lists are cluster-scoped.

## Configuration and environment

The config file is `$XDG_CONFIG_HOME/agentctl/config.json`, or `$HOME/.config/agentctl/config.json` when
`XDG_CONFIG_HOME` is unset. Writes create parent directories and attempt mode `0600`.

The file may contain `namespace`, `address`, `token`, `tls`, `kubeconfig`, and `context`. `config view` prints JSON and
masks the token unless `--show-secrets` is supplied. `auth status` masks a configured token as `first2****last2`
(short tokens become `****`).

The resolved precedence is:

| Setting      | Highest to lowest                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| mode         | `--kube`, `--grpc`, `AGENTCTL_MODE`, default `kube`                                                                                      |
| namespace    | `--namespace/-n`, `AGENTCTL_NAMESPACE`, config, `agents`                                                                                 |
| gRPC address | `--server/--address`, `AGENTCTL_SERVER`, `AGENTCTL_ADDRESS`, `AGENTS_GRPC_ADDRESS`, config, `agents-grpc.agents.svc.cluster.local:50051` |
| token        | `--token`, `AGENTCTL_TOKEN`, `AGENTS_GRPC_TOKEN`, config                                                                                 |
| TLS          | `--tls/--no-tls`, `AGENTCTL_TLS`, config, `false`                                                                                        |
| kubeconfig   | `--kubeconfig`, `AGENTCTL_KUBECONFIG`, config                                                                                            |
| context      | `--context`, `AGENTCTL_CONTEXT`, config                                                                                                  |
| output       | `--output/-o`, default `table`                                                                                                           |

Other implementation-level environment variables are:

- `AGENTCTL_VERSION` overrides the displayed client version.
- `AGENTCTL_PROTO_PATH` selects an existing client proto file; otherwise the package's embedded proto or repository
  proto is used.
- `AGENTCTL_DEBUG` makes unhandled failures print the Effect cause tree.
- `AGENTCTL_NO_INPUT` is set by `--no-input` and disables prompts. `--no-color` sets `NO_COLOR`.

`AGENTS_GRPC_ENABLED`, `AGENTS_GRPC_HOST`, `AGENTS_GRPC_PORT`, `AGENTS_GRPC_ADDRESS`, `AGENTS_GRPC_TOKEN`, and
`AGENTS_GRPC_PROTO_PATH` are server-side Agents configuration names. They are not substitutes for selecting client
gRPC mode; use `--grpc` or `AGENTCTL_MODE=grpc`.

## gRPC contract and transport parity

The source proto is [`proto/proompteng/agents/v1/agentctl.proto`](../../proto/proompteng/agents/v1/agentctl.proto) and
the client service is `proompteng.agents.v1.AgentctlService`. CRUD/list/get/apply/delete RPCs exist for every resource
in the registry, and ImplementationSpec has an additional create RPC. The special methods are:

```text
GetServerInfo
GetControlPlaneStatus
SubmitAgentRun
CancelAgentRun
StreamAgentRunLogs
StreamAgentRunStatus
```

Resource list/get/apply responses carry JSON strings; apply requests carry YAML manifests. The client sends namespace
and, for lists, optional label selectors. AgentRun submission additionally sends repeated key/value entries,
idempotency/workload/memory/VCS fields as described above.

The command surface is intentionally shared across transports, but parity is not identical internally:

- `watch` is client-side repeated list RPCs in gRPC mode and repeated Kubernetes list calls in kube mode.
- `run logs --follow` and `run wait` use the two existing AgentRun server-streaming RPCs in gRPC mode.
- There is no `WatchControlPlaneStatus` RPC and no server-streaming resource watch RPC in the current proto.
- Pagination, field selectors, structured protobuf resources, and structured error details are not current CLI options.

## Errors and exit codes

The entrypoint maps failures as follows:

| Exit code | Current meaning                                                                        |
| --------: | -------------------------------------------------------------------------------------- |
|       `0` | Success, cancellation of an interactive confirmation, or successful command completion |
|       `2` | Local validation/argument error, or gRPC `INVALID_ARGUMENT`                            |
|       `3` | Kubernetes backend error                                                               |
|       `4` | gRPC/runtime failure; gRPC `FAILED_PRECONDITION` and `NOT_FOUND` also map here         |
|       `5` | I/O, Codex, unknown, or otherwise unhandled error                                      |

There is no separate exit code for “runtime adapter submit/cancel”; the tag/status mapping above is authoritative.

## Explicitly deferred behavior

The following are proposals, not shipped commands or endpoints:

- `agentctl status watch`, `agentctl status --watch`, `agentctl diagnose --watch`, `--follow-only`, `--heartbeat`,
  `--retry`, `--fallback-poll`, `--since`, `--timeout`, `--transport`, and `--output ndjson` from
  [`agentctl-status-watch.md`](agentctl-status-watch.md).
- Agentctl integration with the service's HTTP SSE stream (`GET /v1/control-plane/stream`) and a gRPC
  `WatchControlPlaneStatus` method. The service route exists separately; its use as an agentctl status transport is not
  implemented here.
- Server-side watch RPCs for resources, pagination/field-selector options, and a common event schema from
  [`agentctl-grpc-coverage.md`](agentctl-grpc-coverage.md).
- CLI TLS certificate and server-name flags; the current supported certificate path is environment variables listed
  above.

Do not use examples from those Draft documents as current CLI syntax until the command tree, proto, and tests are
updated and this contract is reverified.

## Source of truth and validation

The implementation anchors for this document are:

- [`services/agents/agentctl/src/index.ts`](../../services/agents/agentctl/src/index.ts): entrypoint, platform mode,
  global flags, error/exit handling.
- [`services/agents/agentctl/src/cli/app.ts`](../../services/agents/agentctl/src/cli/app.ts): shipped command tree.
- [`services/agents/agentctl/src/cli/commands/verbs.ts`](../../services/agents/agentctl/src/cli/commands/verbs.ts):
  resource verbs, confirmation, dry-run, polling, and output routing.
- [`services/agents/agentctl/src/cli/commands/run.ts`](../../services/agents/agentctl/src/cli/commands/run.ts):
  AgentRun actions and payload mapping.
- [`services/agents/agentctl/src/cli/commands/create.ts`](../../services/agents/agentctl/src/cli/commands/create.ts)
  and [`init.ts`](../../services/agents/agentctl/src/cli/commands/init.ts): creation/template flows.
- [`services/agents/agentctl/src/config.ts`](../../services/agents/agentctl/src/config.ts) and
  [`services/agents/agentctl/src/cli/global-flags.ts`](../../services/agents/agentctl/src/cli/global-flags.ts):
  configuration and precedence.
- [`services/agents/agentctl/src/runtime.ts`](../../services/agents/agentctl/src/runtime.ts): resource registry data,
  generic renderers and gRPC client.
- [`src/kube/runs.ts`](../../services/agents/agentctl/src/kube/runs.ts) and
  [`src/kube/fleet.ts`](../../services/agents/agentctl/src/kube/fleet.ts): workload joins, phase evidence, and fleet health.
- [`services/agents/src/routes/v1/control-plane/stream.ts`](../../services/agents/src/routes/v1/control-plane/stream.ts):
  the separate Agents HTTP stream route, which is not consumed by agentctl.
- [`services/agents/agentctl/src/__tests__`](../../services/agents/agentctl/src/__tests__): config, flag, output,
  template, version, and transport-focused tests.

Focused checks for a source checkout are:

```bash
bun services/agents/agentctl/src/index.ts --help
bun run --filter @proompteng/agentctl lint
bun run --filter @proompteng/agentctl test
```
