# Galactic Talos, Kubernetes, and Kata rollout

This is the production runbook for the three-control-plane `galactic` cluster. Omni owns machine configuration and
Talos/Kubernetes upgrades. Argo CD owns Kubernetes resources. The rollout installs one signed Kata Containers system
extension that exposes QEMU, Cloud Hypervisor, Firecracker, and Dragonball without a custom controller, CRD,
privileged launcher, AgentRun, or KubeVirt.

## Pinned targets

| Component       | Target    | Source of truth                                                                          |
| --------------- | --------- | ---------------------------------------------------------------------------------------- |
| Talos           | `v1.13.9` | [Talos release](https://github.com/siderolabs/talos/releases/tag/v1.13.9)                |
| Kubernetes      | `v1.36.4` | [Kubernetes release](https://github.com/kubernetes/kubernetes/releases/tag/v1.36.4)      |
| Kata Containers | `4.1.0`   | [Kata release](https://github.com/kata-containers/kata-containers/releases/tag/4.1.0)    |
| Firecracker     | `1.12.1`  | bundled by the Kata `4.1.0` release                                                      |
| Image Factory   | `v1.5.0`  | [Image Factory release](https://github.com/siderolabs/image-factory/releases/tag/v1.5.0) |

The version pins, image digests, extension catalog, and node-specific installer profiles are code-reviewed in this
repository. Do not replace them with a floating `latest` tag during a rollout.

Primary operational references:

- [Omni cluster upgrades](https://docs.siderolabs.com/omni/cluster-management/upgrading-clusters)
- [Omni cluster templates](https://docs.siderolabs.com/omni/reference/cluster-templates)
- [Self-hosted Image Factory](https://docs.siderolabs.com/omni/self-hosted/run-image-factory-on-prem)
- [Talos boot assets and system extensions](https://docs.siderolabs.com/talos/v1.13/platform-specific-installations/boot-assets)
- [Kata virtualization design](https://github.com/kata-containers/kata-containers/blob/main/docs/design/virtualization.md)
- local runtime documentation: `devices/galactic/extensions/kata-firecracker/README.md`
- local Image Factory documentation: `devices/nuc/image-factory/README.md`

## Cluster inventory

The addresses below are Elauwit provider-LAN addresses, not Tailscale addresses:

| Machine | Kubernetes node       | Architecture | Talos API         | Omni machine UUID                      |
| ------- | --------------------- | ------------ | ----------------- | -------------------------------------- |
| Ryzen   | `talos-192-168-1-194` | `amd64`      | `100.100.244.141` | `ff115a00-c307-11f0-a28f-648eab3e4100` |
| Turin   | `turin`               | `amd64`      | `100.100.244.190` | `8bf7ec00-171c-11f1-8000-7cc255f16774` |
| Altra   | `talos-192-168-1-85`  | `arm64`      | `100.100.244.142` | `12345678-9abc-deff-1234-56789abcdeff` |

Expected final extension sets:

| Machine | Required extensions                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ryzen   | `siderolabs/amdgpu`, `siderolabs/amd-ucode`, `siderolabs/glibc`, `siderolabs/tailscale`, `proompteng/talos-kata-runtimes`                            |
| Turin   | `siderolabs/nvidia-open-gpu-kernel-modules-lts`, `siderolabs/nvidia-container-toolkit-lts`, `siderolabs/tailscale`, `proompteng/talos-kata-runtimes` |
| Altra   | `siderolabs/nvidia-open-gpu-kernel-modules-lts`, `siderolabs/nvidia-container-toolkit-lts`, `siderolabs/tailscale`, `proompteng/talos-kata-runtimes` |

The custom extension replaces the stock Kata extension. Never install both on the same node.

## Signed artifact chain

The main-branch workflows create the immutable inputs:

1. `.github/workflows/kata-firecracker-extension.yaml` builds
   `ghcr.io/proompteng/talos-kata-runtimes:4.1.0-talos-v1.13.9` for `linux/amd64` and `linux/arm64`.
2. The workflow signs and verifies the multi-architecture digest with the exact main-branch GitHub Actions identity.
3. It copies the full official `v1.13.9` extension catalog, appends the digest-pinned custom extension, publishes
   `ghcr.io/proompteng/talos-extensions:v1.13.9`, and signs that immutable catalog digest.
4. It builds and signs independent `ryzen-amd64`, `turin-amd64`, and `altra-arm64` installer receipts. These prove
   that every architecture-specific extension combination can be assembled.
5. `.github/workflows/microvm-agent.yaml` publishes and signs the `linux/amd64` and `linux/arm64` canary agent.
6. GitOps canary images must use the published agent digest, never a mutable tag.

Before touching a node, retain the workflow URLs, image digests, Cosign verification output, and generated installer
digests in the rollout evidence directory.

### Artifact identity and Image Factory cache gate

Tags and version strings are discovery aids, not rollout identity. The authoritative runtime input is the signed
extension digest recorded in the release receipt. Before every node phase, prove that the live factory catalog resolves
the custom extension to that digest:

```bash
export FACTORY='http://100.100.244.148:8081'
export EXPECTED_KATA_DIGEST='sha256:f829d94e178a709d2c1bb46dd1c3c71dd7d50064db2843132768cf18d29d5d46'

curl -fsS "$FACTORY/version/v1.13.9/extensions/official" \
  | jq -er '.[] | select(.name == "proompteng/talos-kata-runtimes") | .digest' \
  | grep -Fx "$EXPECTED_KATA_DIGEST"
```

An unchanged schematic ID does **not** prove that a rebuilt installer contains a new extension digest. Image Factory
derives the ID from the customization request, including the ordered extension names, while the catalog tag can later
resolve those names to a different digest. An installer already cached under the same schematic and Talos version can
therefore predate the current catalog.

For the exact target machine, retain all of the following before allowing Omni to reboot it:

1. the current `SchematicConfiguration` ID and ordered customization returned by
   `GET /schematics/<schematic-id>`;
2. the live catalog readback showing `EXPECTED_KATA_DIGEST`;
3. the generated `metal-installer` manifest digest for that exact schematic and Talos version; and
4. Image Factory build or registry evidence that the installer was assembled from `EXPECTED_KATA_DIGEST`.

Restarting Image Factory refreshes its catalog input but does not prove that an existing cached installer was rebuilt.
Do not accept a tag, matching extension name/version, unchanged schematic ID, `MachineUpgradeStatus: up to date`, or a
successful installer pull as a substitute for this chain. If the exact installer cannot be tied to the expected digest,
stop and rebuild or invalidate that one factory artifact through a reviewed procedure; do not reboot the node.

### Same-schematic artifact replacement

Omni does not schedule another machine task when both the desired schematic ID and Talos version already match the
machine. If the exact cached installer is rebuilt from a corrected extension digest without changing either value,
`MachineUpgradeStatus: up to date` is expected and cannot install the replacement by itself. Do not invent a version
bump, add a `machine.install.image` patch, or change the customization merely to force a new schematic ID.

Use this exception only after the target-specific cache procedure in `devices/nuc/image-factory/README.md` has produced
a new installer manifest digest and the factory build evidence ties it to `EXPECTED_KATA_DIGEST`:

1. prove that Omni has no active machine or cluster upgrade task and that no template sync is running;
2. capture the normal Kubernetes, etcd, KVM, drain, and artifact evidence, plus an etcd snapshot from a non-target
   control-plane node;
3. cordon and completely drain the target before installing; a failed PDB-aware drain still stops the operation unless
   the operator explicitly authorizes a maintenance override, in which case retain the exact affected Pods and prove
   every owning controller and stateful workload recovered afterward;
4. if the target is the etcd leader, forfeit leadership and prove another voter became leader; and
5. run the direct Talos upgrade only against the already-drained target, with Talos drainage disabled so that a second
   drain cannot race the completed Kubernetes maintenance operation:

   ```bash
   export TALOS_NODE='<target Talos API address>'
   export SCHEMATIC_ID='<proven target schematic>'

   talosctl --nodes "$TALOS_NODE" --endpoints "$TALOS_NODE" upgrade \
     --image "100.100.244.148:8081/metal-installer/${SCHEMATIC_ID}:v1.13.9" \
     --drain=false \
     --wait \
     --timeout=30m \
     --progress=plain 2>&1 | tee "$EVIDENCE_DIR/talos-upgrade.txt"
   ```

Require the pull line to contain the newly proven installer manifest digest. Keep the node cordoned after it returns,
then perform the same extension, CRI, guest, and host-side runtime acceptance as an Omni-driven upgrade. This is a
same-identity cache-replacement exception, not a second upgrade authority: normal version or schematic changes remain
Omni-owned.

## One-time Image Factory handoff

The public factory cannot consume an arbitrary private extension catalog. The NUC therefore runs the community Image
Factory and a private backing registry from `devices/nuc/image-factory`.

1. Publish and verify the signed combined catalog.
2. Copy the checked-in Image Factory directory to `/home/kalmyk/image-factory` on the NUC.
3. Create `.env` from `.env.example`, then run `./bootstrap.sh`.
4. Require `./validate.sh` and `./verify.sh` to pass. This verifies the live catalog, not every previously cached
   per-machine installer; apply the artifact identity gate above separately to the rollout target.
5. Deploy the checked-in `devices/nuc/omni/omni.yaml` to `/home/kalmyk/omni/omni.yaml`.
6. Restart only the Omni service and verify that its primary factory is
   `http://100.100.244.148:8081/`.

The factory catalog accepts only official Sidero Labs signing identities and the exact main-branch Kata workflow.
Its cache-signing key and registry state under `/var/lib/image-factory` are persistent and must be backed up.

## Export and review Omni desired state

Authenticate `omnictl` and export the live template to a mode-`0600` temporary file. Imported patches contain the
Tailscale auth key and SideroLink join token, so never commit the raw export:

```bash
umask 077
omnictl cluster template export galactic \
  --include-kernel-args \
  --output /tmp/galactic-cluster-template.raw.yaml \
  --force

bun devices/galactic/omni/render-template.ts \
  --secrets-from /tmp/galactic-cluster-template.raw.yaml \
  --output /tmp/galactic-cluster-template.rendered.yaml

omnictl cluster template validate \
  --file /tmp/galactic-cluster-template.rendered.yaml
```

The checked-in `devices/galactic/omni/cluster-template.yaml` is the authoritative secret-redacted template. It
preserves every imported patch, uses placeholders for both credentials, and removes stale imported
`machine.install.image` overrides so Omni derives the desired installer from the machine schematic. Confirm that the
control-plane machine set retains a rolling upgrade strategy with `maxParallelism: 1`.

Apply the registry transport configuration as a separate phase before changing any schematic. In the exported
`kind: Cluster` document, add the checked-in file as a cluster-wide config patch (file paths are resolved relative to
the template), then preview and sync:

```yaml
patches:
  - file: image-factory-registry.yaml
```

```bash
omnictl cluster template sync \
  --file /tmp/galactic-cluster-template.rendered.yaml \
  --dry-run \
  --verbose

omnictl cluster template sync \
  --file /tmp/galactic-cluster-template.rendered.yaml \
  --verbose
```

Wait until all three machines report the registry config applied with no pending configuration update. Verify that
each node has the `RegistryMirrorConfig` in its effective machine configuration before changing a `systemExtensions`
list. The explicit HTTP mirror is material: Talos `v1.13.9` validates installer images through the same configured
registry resolver used by system containerd, while an unmirrored reference defaults to HTTPS. Prove the factory's
generated `metal-installer` manifest is retrievable through the HTTP OCI endpoint; a health check alone is not enough.
Do not use a `machine.install.image` patch: Omni derives the desired installer from each machine's schematic and
selected system extensions.

Add `proompteng/talos-kata-runtimes` to only one `kind: Machine` document in the checked-in redacted template per
rollout phase, then rerender it. On Ryzen, remove
`siderolabs/kata-containers` in the same change; on Turin and Altra, preserve all three existing NVIDIA/Tailscale
extensions. For a new rollout, validate, review, commit, and sync each phase independently in the Ryzen, Turin, Altra
order. When resuming a partially completed rollout, finish and accept the already-started machine before returning to
that order. This keeps the other two machines' desired schematics unchanged and prevents an Omni sync from starting
their installer operations early.

## Hard safety gates

Run the checked-in preflight immediately before every individual node:

```bash
export NODE='<kubernetes-node>'
export EVIDENCE_DIR="/tmp/galactic-kata-${NODE}-$(date -u +%Y%m%dT%H%M%SZ)"
devices/galactic/extensions/kata-firecracker/preflight-node.sh "$NODE" "$EVIDENCE_DIR"
```

The script must prove all of the following:

1. the Kubernetes API is ready and the target node is `Ready` and schedulable;
2. etcd has three healthy non-learner members;
3. `/dev/kvm` exists on the target;
4. all six Ceph OSDs are up and in, all three monitors have quorum, and no placement group is degraded, undersized,
   remapped, recovering, backfilling, inactive, down, stale, incomplete, inconsistent, or unknown;
5. Ceph has no `noout`, `norecover`, `nobackfill`, or `pause` flag;
6. a server-side Kubernetes drain dry-run succeeds.

Any failed gate stops the rollout. Do not clear Ceph flags, bypass a PDB, force a drain, delete storage Pods, remove an
etcd member, or reset a node to make the gate green. Fix the owning system first and rerun the complete preflight.

Never use a status copied into this document as a rollout gate. Record fresh command output immediately before the
target phase. Any remapped, recovering, or backfilling placement group is a hard blocker even when all OSDs are up/in
and there are no recovery-suppression flags.

## Sequential rollout

For a new rollout, use this order:

1. Ryzen: `talos-192-168-1-194`
2. Turin: `turin`
3. Altra: `talos-192-168-1-85`

If a previous attempt already changed one machine, that machine is the current phase. Finish its immutable artifact
proof, installer convergence, and four-runtime acceptance before changing another machine; do not skip to the nominal
first node.

For each node:

1. Confirm the checked-in template changes only this machine's `systemExtensions` list and the control-plane
   `upgradeStrategy.rolling.maxParallelism` is `1`.
2. Run and retain the complete preflight evidence.
3. Rerender the template, run `omnictl cluster template sync --dry-run --verbose`, and reject any unexpected resource
   or machine change.
4. Prove the exact installer-to-extension digest chain in the artifact identity gate above.
5. Sync the reviewed template and let Omni perform its normal cordon, drain, installer upgrade, reboot, and health
   checks. Do not lock the cluster or unrelated machines, and do not run a competing manual `talosctl upgrade`. The
   only direct-upgrade exception is the already-drained, same-schematic artifact replacement documented above.
6. Wait for the target to return on Talos `v1.13.9`, Kubernetes `v1.36.4`, and `Ready`. Omni's lifecycle finalizer
   normally uncordons the node after it returns; that is transport completion, not runtime acceptance.
7. Immediately create the separate runtime-validation cordon and prove it took effect before adding a runtime label:

   ```bash
   kubectl --context galactic-lan cordon "$NODE"
   kubectl --context galactic-lan get node "$NODE"
   ```

   Require `Ready,SchedulingDisabled`. The canaries are DaemonSets, whose controller tolerates the built-in
   unschedulable taint, so they can still be created on this validation-cordoned node. There is a short interval between
   Omni's automatic uncordon and this command; do not call the phase complete during that interval.

8. Verify the exact expected node-specific AMD/NVIDIA, glibc, Tailscale, and Kata extensions, the CRI configuration,
   and the installed schematic. Extension name `kata-runtimes` and version `4.1.0` alone do not identify its digest.
9. Activate and prove QEMU, Cloud Hypervisor, Firecracker, and Dragonball one at a time as described below. Keep the
   validation cordon in place throughout all four tests.
10. Recheck Kubernetes API readiness, three-member etcd health, and clean Ceph state after all four runtimes pass.
11. Only then uncordon the accepted node and prove it is `Ready` and schedulable:

    ```bash
    kubectl --context galactic-lan uncordon "$NODE"
    kubectl --context galactic-lan get node "$NODE"
    ```

12. Commit the next machine's extension-list change only after the current node has passed every gate above.

If Omni leaves a failed target cordoned, diagnose the current failure first. If Omni automatically uncordons after a
successful reboot, restore the runtime-validation cordon before testing. A manual uncordon is forbidden while artifact
identity or any of the four runtime proofs is missing. Never add the next machine's desired extension until the current
phase is accepted.

## Runtime activation and proof

Argo CD application `kata-runtimes` owns four node-gated RuntimeClasses:

| RuntimeClass      | VMM              | Required node label                           |
| ----------------- | ---------------- | --------------------------------------------- |
| `kata-qemu`       | QEMU             | `runtime.proompteng.ai/kata-qemu=ready`       |
| `kata-clh`        | Cloud Hypervisor | `runtime.proompteng.ai/kata-clh=ready`        |
| `kata-fc`         | Firecracker      | `runtime.proompteng.ai/kata-fc=ready`         |
| `kata-dragonball` | Dragonball       | `runtime.proompteng.ai/kata-dragonball=ready` |

Installing the handlers does not schedule a canary. The target must already be `Ready,SchedulingDisabled` under the
post-Omni runtime-validation cordon. Activate one runtime on one node at a time:

Before activating Firecracker, verify the effective Talos CRI configuration on that node:

```bash
! talosctl --nodes "$TALOS_NODE" --endpoints "$TALOS_NODE" read /etc/cri/containerd.toml \
  | rg -F 'io.containerd.snapshotter.v1.blockfile'
talosctl --nodes "$TALOS_NODE" --endpoints "$TALOS_NODE" read /etc/cri/conf.d/cri.toml \
  | rg 'discard_unpacked_layers = false|use_local_image_pull = false|snapshotter = .blockfile.'
talosctl --nodes "$TALOS_NODE" --endpoints "$TALOS_NODE" logs cri --tail 1000 \
  | rg 'loading plugin.*io.containerd.snapshotter.v1.blockfile'
```

The node's Omni machine patch owns the first two settings. The extension owns the blockfile handler, bundled scratch
filesystem, and Firecracker `default_maxvcpus = 32` cap. A failure in any of these checks is an installer or machine
configuration failure, not a RuntimeClass scheduling problem.

```bash
kubectl --context galactic-lan label node "$NODE" \
  runtime.proompteng.ai/kata-qemu=ready --overwrite
```

Repeat for `kata-clh`, `kata-fc`, and `kata-dragonball` only after the preceding canary passes. Each long-running
canary is a native Kubernetes Pod using `runtimeClassName`; it is not a privileged launcher. Collect the full proof:

```bash
export PROOF_DIR="/tmp/galactic-kata-proof-$(date -u +%Y%m%dT%H%M%SZ)"
devices/galactic/extensions/kata-firecracker/verify-runtimes.sh "$PROOF_DIR" "$NODE" qemu
```

Use `clh`, `fc`, or `dragonball` for the next individual activation. After all four labels pass on all three nodes,
run the verifier without filters for the final twelve-combination evidence bundle.

Acceptance requires, for every runtime on every architecture:

1. the expected RuntimeClass and independent scheduling label;
2. exactly one Ready canary Pod on the target, using the digest-pinned agent image;
3. guest evidence with a non-empty boot ID and kernel release matching the node architecture;
4. a Talos CRI sandbox corresponding to the Pod;
5. the expected host process: `qemu-system-*`, `cloud-hypervisor`, or `firecracker`;
6. for Dragonball, the built-in runtime-rs shim and Dragonball configuration, because it intentionally has no separate
   VMM process;
7. no plaintext bootstrap proof nonce in agent logs.

The canaries remain running for inspection. If a runtime fails, remove only its activation label and leave the node
validation-cordoned:

```bash
kubectl --context galactic-lan label node "$NODE" \
  runtime.proompteng.ai/kata-fc-
```

## Rollback boundaries

- A failed RuntimeClass canary: remove that runtime's node label and inspect the retained evidence. No node reboot is
  required, but the node remains validation-cordoned and the next node must not start.
- A failed Talos installer rollout: preserve Omni and Talos logs and restore the previously proven schematic through
  Omni only after Kubernetes, etcd, and Ceph gates pass. Do not lock the whole cluster merely to pause one failed
  machine.
- A failed Image Factory deployment: restore the previous `omni.yaml` primary factory and restart Omni; do not point
  machines at a partially verified catalog.
- Never roll back by resetting a machine, deleting an etcd member, purging an OSD, bypassing PDBs, or changing disks
  without a separate recovery plan and explicit authorization.

Completion means the signed artifacts and exact configuration are merged, every installed schematic is tied to the
expected extension digest, all three sequential installer operations have passed the hard gates, and all twelve
node/runtime combinations have fresh guest and host-side evidence. Only accepted nodes are uncordoned.
