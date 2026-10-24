# OpenCode development server

The `opencode` Argo Application owns namespace `opencode`. Its native OpenCode
2.1.3 server runs at https://opencode.ide-newton.ts.net through a private Tailscale
Ingress. The image includes the same pinned `ciToolchain` as lab development,
plus a compiler, Rust/Clippy/Rustfmt, Ruff, Lua, Protobuf, SSH, SQLite, the CI-pinned
Promtool/Alloy validators and an init process. There is no Docker daemon
or Kubernetes service-account token in the development container. Docker/buildkit
clients need a separately authorized remote engine; installing clients grants no
cluster or registry authority.

The 50 GiB `opencode-development` PVC retains `/workspace` and the private home,
including sessions, provider authentication, caches and the server password.
The first boot clones the public lab repository. Later boots preserve the exact
checkout, branch and uncommitted work. Git push access requires an explicit user
login; the server does not inherit the operator's GitHub or Codex credentials.
The developer has an initialized single-user Nix store, so Nix commands can evaluate and
build without a root daemon. Project files, sessions and credentials persist on the PVC;
additional tools built into the container layer reset on rollout. The research container
keeps its read-only root filesystem.

Flamingo (`flamingo/qwen36-flamingo`) is the default. Native tools remain enabled.
The full native integration catalog remains available through Connect and Models.
For remote sign-in, choose OpenAI > Codex device code (legacy) to use a supported ChatGPT plan. Other
providers need their own credentials or credits; a catalog entry does not grant
access or make paid inference free. Provider credentials are stored only in the
personal home. No personal provider credentials are mounted into Bayn research.

The server creates a private 256-bit password once. Use the native API command
from an administrator's checkout to create a one-time browser link:

```bash
kubectl --context galactic-tailscale -n opencode exec deployment/opencode -c opencode -- \
  sh -c '
    export OPENCODE_PASSWORD="$(cat "$HOME/server-password")"
    opencode api --server http://127.0.0.1:4096 post /api/pair
  ' | jq -r '"https://opencode.ide-newton.ts.net/auth/connect/" + .code'
```

The explicit `--server` targets the deployed process. The password stays inside
the pod, and the printed link expires after five minutes. Paste it into the
browser's **Connect to a server** screen. Keep passwords and pairing links out of
logs and commits. Unauthenticated API and pairing requests must fail. Tailnet
membership and the scoped Ingress NetworkPolicy provide a separate network
boundary; Funnel is disabled.

## Connect ChatGPT from a remote browser

1. In **Settings > Providers**, connect **OpenAI > Codex device code (legacy)**.
2. Open the authorization link, enter the displayed device code and complete
   OpenAI's account verification in your browser.
3. Return to OpenCode and confirm **ChatGPT connected** before selecting a model.

The [native device-code method](https://github.com/anomalyco/opencode/blob/v2.1.3/packages/core/src/plugin/provider/openai.ts#L172-L231)
polls OpenAI from the server and needs no browser callback to the pod. The separate
[Sign in with ChatGPT method](https://github.com/anomalyco/opencode/blob/v2.1.3/packages/core/src/plugin/provider/chatgpt.ts#L147-L149)
hardcodes a random loopback callback. Server hostname and client `--server`
settings do not change that callback. Existing working accounts can stay connected;
native OpenCode stores and refreshes their credentials in the personal PVC.

## Retained research state

Bayn's bounded research gateway moves to `opencode-research` within this
application. It retains its pinned CLI, read-only agent, one-call relay,
free-only model, frozen configuration hash, exclusive attempts and study mapping.
It has a separate protected PVC and no personal development credentials; its agent cannot use development tools.
Server and Bayn worker images release independently: receipts retain both actual
source revisions. The HTTP source attestation must match the response's server
revision, while model/configuration/request/stream/cost/timing evidence still
passes the existing verifier. A server revision cannot be relabeled as the worker.

The protected `bayn/bayn-opencode-state` PVC retains the original volume as
recovery evidence. No active workload mounts it. The temporary migration Jobs and
old gateway Deployment, Service and NetworkPolicy are retired after the verified
transfer. The gateway continues to use `/var/lib/bayn-opencode` within its separate
`opencode-research-state` PVC so native paths and the frozen configuration stay valid.

The one-time migration implementation is retained in [PR #15336](https://github.com/proompteng/lab/pull/15336).
It stops the original writer before export, verifies the source PVC identity,
binds the archive to a frozen inventory hash and checks every restored byte and
SQLite database before activation. `migrate_state.py` retains the offline archive
verification and restore functions. Restore refuses an existing destination and
rejects escaping paths and unsafe links. The target waits for the atomic
`.migration-complete.json` marker before starting.

[Migration proof](migration-proof.json) records the archive and frozen inventory
hashes, source and target PVC identities, and the retained session and claim counts.
The private archive contains the source bytes and remains outside the repository.

Keep the private migration archive and pre/post native session and claim identities
with the delivery evidence. Before recovery, stop the active writer. After any new
requests, migrate the latest state with the same checks before changing writers.
Never activate two writers for one study or retry an already claimed financial attempt.

Image delivery is reviewed main -> immutable `lab/opencode` publication ->
Warehouse/Stage `opencode` in `lab-delivery` -> `kargo/opencode` -> Argo. The Stage
updates the Kustomize input by digest. `bayn` keeps its trading runtime, Jev
credentials, risk checks and capital authority. This deployment does not qualify
Bayn's trading performance or complete prior failed financial experiments.

Validation: `python3 -m unittest discover -s services/opencode`, research receipt
and native gateway tests, rendered manifests and the image's offline server/tool
verification. Live acceptance additionally requires authenticated Tailscale use,
Flamingo tool execution, ChatGPT login and inference, a real repository edit/test,
restart persistence and the retained research migration proof.
