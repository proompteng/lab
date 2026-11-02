# agentctl CLI Design

Status: Current implementation contract, verified 2026-08-30 at `2279c55bf2427c346d496a747020355e4c0c7b4b`

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
contains Bun binary and Homebrew-generation scripts. The build targets Node, but the current Kubernetes backend calls
`Bun.spawn` for `kubectl` and pod logs. Node-only kube execution is therefore not a demonstrated support path at this
revision; verify Bun availability when using the generated Node bundle against Kubernetes.

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
top-level commands, not subcommands of a resource.

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
agentctl completion <shell> install <shell>
```

`<shell>` is `bash`, `zsh`, or `fish`. The current command tree places the shell argument on both completion levels,
so the install form is, for example, `agentctl completion zsh install zsh`; `agentctl completion install zsh` is not a
valid current invocation. Installation writes under `$XDG_CONFIG_HOME/agentctl/completions` or
`$HOME/.config/agentctl/completions` and prints a shell-specific activation hint.

`help all` prints the generated Effect command help plus the custom global flags.

`version --client` (or `--client-only`) prints only `agentctl <version>`. Without that flag it prints the client
version and attempts to report the server: the kube path prints the Agents deployment image or
`server info unavailable (kube mode)`, while the gRPC path calls `GetServerInfo` and prints the server version and,
when present, build SHA/time.

`auth` is local file management. `auth login` saves a token and does not contact or validate the server. `--with-token`
reads the token from stdin and cannot be combined with a command or global `--token`; if no token is supplied, the
interactive login prompts. `auth status` and `auth logout` inspect or modify only the config file, and logout is not a
server-side revocation.

`config init` is intended to be interactive unless all required answers are supplied. It asks for namespace, optional
kubeconfig and context, and whether to configure gRPC; the gRPC branch asks for address, optional token, and TLS.
`config set` is intended to need at least one setting and write without prompting.

Known implementation gap: the entrypoint's global-flag pre-parser removes `--namespace`, `--server`, `--address`,
`--token`, `--kubeconfig`, and `--context` before the `config set`/`config init` handlers receive their command-local
options. Consequently those values are currently ignored by these two subcommands: for example,
`agentctl config set --namespace demo` reaches the handler with no setting and fails, while `config init --namespace
demo` can still prompt for the namespace. `--tls` and `--no-tls` are read from the raw argument vector and do work.
This is a parser/command wiring defect, not a supported configuration workflow; use a config file or fix the wiring
before documenting those option forms as operational.

### Resource verbs

```text
agentctl get [(-l|--selector <selector>)] [--phase <phase>] [--runtime <runtime>] <resource> [<name>]
agentctl describe <resource> <name>
agentctl list [(-l|--selector <selector>)] [--phase <phase>] [--runtime <runtime>] <resource>
agentctl watch [(-l|--selector <selector>)] [--phase <phase>] [--runtime <runtime>]
                 [--interval <seconds>] <resource>
agentctl apply (-f|--file <path|->) [--dry-run]
agentctl delete [--dry-run] <resource> <name>
agentctl explain <resource>
```

`get <resource>` without a name is a list operation; adding a name gets one resource. `list` is the explicit list
alias. `--phase` and `--runtime` are valid only when the resource resolves to `run`; other resources reject those
filters. A named `get` rejects selectors and run filters. `describe` is the named get form with YAML as its default
output when no global `--output` was supplied.

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
`agentctl impl init`, `agentctl run apply`, `agentctl run get`, `agentctl run list`, `agentctl run watch`,
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
agentctl run submit --agent <name> --impl <name> --runtime <type>
                    --runtime-config <key=value>... --param <key=value>...
                    [--idempotency-key <key>] [--workload-image <image>]
                    [--cpu <quantity>] [--memory <quantity>] [--memory-ref <name>]
                    [--vcs <name>] [--vcs-mode <mode>] [--vcs-required] [--wait]

agentctl run logs [--follow] <name>
agentctl run wait <name>
agentctl run cancel <name>

agentctl run codex [--prompt <prompt>] [--agent <name>] [--runtime <type>]
                   --runtime-config <key=value>... --param <key=value>...
                   [--workload-image <image>] [--cpu <quantity>] [--memory <quantity>]
                   [--memory-ref <name>] [--vcs <name>] [--vcs-mode <mode>]
                   [--vcs-required] [--idempotency-key <key>] [--wait]
```

`run submit` and `run codex` mutate the selected backend immediately. They have no confirmation prompt and no
`--dry-run` option. To inspect a run manifest without creating a resource, use `init run` without `--apply`; do not
probe either submission command against a production context.

`run submit` constructs the following logical spec fields:

| Flag                         | Manifest/RPC field                                                     |
| ---------------------------- | ---------------------------------------------------------------------- |
| `--agent`                    | `spec.agentRef.name` / `agent_name`                                    |
| `--impl`                     | `spec.implementationSpecRef.name` / `implementation_name`              |
| `--runtime`                  | `spec.runtime.type` / `runtime_type`                                   |
| `--runtime-config key=value` | `spec.runtime.config` / repeated `runtime_config` entries              |
| `--param key=value`          | `spec.parameters` / repeated `parameters` entries                      |
| `--memory-ref`               | `spec.memoryRef.name` / `memory_ref`                                   |
| `--vcs`                      | `spec.vcsRef.name` / `vcs_ref`                                         |
| `--vcs-mode`                 | `spec.vcsPolicy.mode` / `vcs_policy_mode`                              |
| `--vcs-required`             | `spec.vcsPolicy.required` / `vcs_policy_required`                      |
| `--workload-image`           | `spec.workload.image` / `workload.image`                               |
| `--cpu`, `--memory`          | `spec.workload.resources.requests` / `workload.cpu`, `workload.memory` |
| `--idempotency-key`          | kube delivery-id label; gRPC `idempotency_key`                         |

When runtime is `workflow`, the generated manifest also contains `workflow.steps: [{name: implement}]`. Kube submit
uses a generated name prefix `<agent>-` and labels the object `agents.proompteng.ai/delivery-id`. The kube path does
not deduplicate on that label; `--idempotency-key` is only a delivery identifier there. gRPC submit sends the key to
`SubmitAgentRun`, whose response includes `resource_json`, `record_json`, and `idempotent`; the CLI renders the resource
JSON and does not render the separate record.

With `--wait`, kube submit polls the created AgentRun every two seconds until its phase is `Succeeded`, `Failed`,
`Cancelled`, or `Canceled`. gRPC submit and `run wait` consume `StreamAgentRunStatus` and render the latest resource
when the stream ends. A kube terminal failure is rendered as a resource and does not itself change the CLI exit code.
The gRPC wait helper also does not inspect the terminal phase for its exit code; it returns a runtime failure when the
stream closes without any resource update (or when the transport fails).

`run logs` resolves the AgentRun's runtime. In kube mode it selects a pod from the runtime Job (or the AgentRun label),
then invokes pod logs; `--follow` is passed through. In gRPC mode it calls `StreamAgentRunLogs`; messages tagged
`stderr` go to stderr and other messages go to stdout. gRPC logs are therefore implemented, not an optional placeholder.

`run cancel` calls `CancelAgentRun` in gRPC mode. In kube mode it deletes workflow or job resources associated with the
run and prints `cancelled` (or `job not found` for a missing named job). Kube cancellation does not patch the AgentRun
status. Temporal and custom runtimes have no kube cancellation path and return `No cancellable runtime found for this
AgentRun`.

`run codex` is implemented. It prompts for a Codex prompt, agent, and runtime when omitted (runtime defaults to
`workflow`), calls the workspace Codex package for a JSON ImplementationSpec shaped as summary/text/acceptance
criteria/labels, creates or applies that spec, and then submits an AgentRun using the resulting name. It uses the
current process working directory and does not expose `--file`; source data is not generated by this command.

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
- Table columns are `NAME NAMESPACE STATUS`.
- Wide columns are `NAME NAMESPACE KIND AGE STATUS LABELS DETAILS`.

Status text for resource rows is selected in this order: `status.phase`, `status.status`, `status.state`,
`status.result`, then the `Ready` condition status. Details are populated for AgentRun runtime type, ImplementationSpec
summary, ImplementationSource provider, Schedule schedule, ToolRun tool reference, and Agent provider reference.

`describe` uses YAML unless the caller explicitly provides `--output`; `get`, `list`, and `watch` use the resolved
default table format.

### Status and diagnose

`status` and `diagnose` are identical one-shot commands. Both use the selected namespace. In gRPC mode, the CLI calls
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

Kube mode does not synthesize the gRPC payload. It probes the namespace, the first deployment labeled
`app.kubernetes.io/name=agents`, and the required CRDs, and emits this different JSON/YAML shape:

```json
{
  "mode": "kube",
  "generated_at": "2026-08-30T00:00:00.000Z",
  "namespace": "agents",
  "deployment": {
    "name": "agents",
    "status": "healthy",
    "message": "ready 1/1 available 1 image ghcr.io/example/agents:tag"
  },
  "crds": {
    "status": "healthy",
    "missing": []
  },
  "namespace_status": {
    "status": "healthy",
    "message": ""
  }
}
```

Kube status tables use the same four columns and the rows `namespace`, `deployment/<name>`, and `crds`. The exact
required CRD names are:

```text
agents.agents.proompteng.ai
agentruns.agents.proompteng.ai
agentproviders.agents.proompteng.ai
implementationspecs.agents.proompteng.ai
implementationsources.agents.proompteng.ai
memories.agents.proompteng.ai
orchestrations.orchestration.proompteng.ai
orchestrationruns.orchestration.proompteng.ai
approvalpolicies.approvals.proompteng.ai
budgets.budgets.proompteng.ai
secretbindings.security.proompteng.ai
signals.signals.proompteng.ai
signaldeliveries.signals.proompteng.ai
tools.tools.proompteng.ai
toolruns.tools.proompteng.ai
schedules.schedules.proompteng.ai
artifacts.artifacts.proompteng.ai
workspaces.workspaces.proompteng.ai
```

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
- A fully Node-only Kubernetes subprocess implementation; the current kube backend uses `Bun.spawn`.

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
  renderers, status payloads, waits, and gRPC client.
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
