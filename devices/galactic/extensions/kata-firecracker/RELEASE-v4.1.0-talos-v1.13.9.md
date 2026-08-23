# Kata 4.1.0 / Talos v1.13.9 release receipt

Recorded on 2026-08-23. This receipt separates signed artifact publication, Image Factory resolution, Omni installer
convergence, and live runtime acceptance. Only the last state proves that a RuntimeClass works on Galactic.

## Source and workflows

- Runtime correction merge: [`a4efd5beae61ceb7ee3a4a2624ba6fe65f1e3bb0`](https://github.com/proompteng/lab/commit/a4efd5beae61ceb7ee3a4a2624ba6fe65f1e3bb0),
  [PR #14015](https://github.com/proompteng/lab/pull/14015).
- Runtime workflow: [Kata multi-runtime Talos extension run 32661898945](https://github.com/proompteng/lab/actions/runs/32661898945),
  successful for the multi-architecture extension, catalog, and all three installer build receipts.
- Agent source: `ffebebfcf0bf4f11b8f0e44614749f08ed07e8d9`.
- Agent workflow: [MicroVM agent run 32631290227](https://github.com/proompteng/lab/actions/runs/32631290227),
  successful.

The correction caps Firecracker at 32 vCPUs and changes its VMM socket timing to a 100 ms initial dial with a
45-second reconnect budget. It retains the Talos CRI blockfile prerequisites required for a Firecracker rootfs.

## Immutable artifacts

| Artifact                      | Platform                     | Immutable reference                                                                                              |
| ----------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Kata runtime extension        | `linux/amd64`, `linux/arm64` | `ghcr.io/proompteng/talos-kata-runtimes@sha256:f829d94e178a709d2c1bb46dd1c3c71dd7d50064db2843132768cf18d29d5d46` |
| Combined extension catalog    | OCI manifest                 | `ghcr.io/proompteng/talos-extensions@sha256:98c2013398434f1c0d0600d6d2071ec7aa9ef9444c04ca256c2bde640f8306c1`    |
| Ryzen installer build receipt | `linux/amd64`                | `ghcr.io/proompteng/talos-kata-runtimes@sha256:6d8ee2f30b38384df6c0b021ddd0417f8891afb387e32fc3659b7cea70b8b39d` |
| Turin installer build receipt | `linux/amd64`                | `ghcr.io/proompteng/talos-kata-runtimes@sha256:af107449c30a1cc9c06339392182e733c6a43bbb5f380df17648e1cbd6143ab9` |
| Altra installer build receipt | `linux/arm64`                | `ghcr.io/proompteng/talos-kata-runtimes@sha256:29ceb3c37b8eaca8b9d2d0f20609b05d1a707d4d5bd94569066130461e3b8d4d` |
| Long-running microVM agent    | `linux/amd64`, `linux/arm64` | `ghcr.io/proompteng/microvm-agent@sha256:5573551391d01240297680da6ac172d3c819b57d493c3c3e2e11fa1388b06640`       |

All six references passed keyless Cosign verification against GitHub Actions OIDC. The extension, catalog, and
installer receipts use identity
`https://github.com/proompteng/lab/.github/workflows/kata-firecracker-extension.yaml@refs/heads/main`; the agent uses
`https://github.com/proompteng/lab/.github/workflows/microvm-agent.yaml@refs/heads/main`. Both use issuer
`https://token.actions.githubusercontent.com`.

The live 84-entry catalog currently resolves the custom entry to:

```text
ghcr.io/proompteng/talos-kata-runtimes:4.1.0-talos-v1.13.9@sha256:f829d94e178a709d2c1bb46dd1c3c71dd7d50064db2843132768cf18d29d5d46
```

## NUC Image Factory handoff

The community Image Factory `v1.5.0` and private registry are running at
`http://100.100.244.148:8081`. After the service restart, live catalog readback returned the expected extension digest
`sha256:f829d94e178a709d2c1bb46dd1c3c71dd7d50064db2843132768cf18d29d5d46`.

The smoke request returned schematic
`2e2b452f790f45e5cc3be7e1fd6bf2fa5124b48454a908dd288aea898288c103` both before and after the catalog update. That
is expected: a schematic ID identifies the ordered customization request, not the resolved extension content. The
smoke result and catalog readback do not prove that an older per-machine installer cache entry was rebuilt. Every node
still requires the exact installer-to-extension digest proof in the rollout runbook.

## Live Galactic snapshot

The following was read directly from Kubernetes, Talos, Omni, Ceph, and Image Factory on 2026-08-23:

- all three Kubernetes nodes are `Ready`, schedulable, and running Kubernetes `v1.36.4`;
- Omni reports Talos `v1.13.9` and `machine is up to date` for each node's current schematic;
- Ryzen and Turin report installed extension `kata-runtimes` version `4.1.0`, but Talos does not expose the source OCI
  digest in that resource;
- Altra does not report an installed Kata extension;
- Ryzen has all four runtime activation labels, and its QEMU, Cloud Hypervisor, Firecracker, and Dragonball canary Pods
  are Ready and retained for inspection; Turin and Altra have no runtime activation labels;
- Ceph has six of six OSDs up/in and three monitors, but remains `HEALTH_WARN`: 586 placement groups are active and
  clean, 13 are waiting to backfill, 2 are backfilling, and 1.332% of objects are misplaced.

Current installer and acceptance ledger:

| Machine | Current schematic                                                  | Installed Kata resource | Corrected digest proven in installer                                                 | Corrected runtime acceptance       |
| ------- | ------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| Ryzen   | `1146e679c37da65960431dfb8f90ec3fe9af454d68da3a7ffe78ec72aa7571bd` | `kata-runtimes 4.1.0`   | Yes, index `sha256:93235a29a518661225b78d72a88797f4a389e4f53cddca6eb482dfa7f094844c` | QEMU, CLH, FC, Dragonball accepted |
| Turin   | `cf3a3e88087d1ccb35a6aa3ebc4404bc7b66cd90f836bf66f42cea5b2854f0ca` | `kata-runtimes 4.1.0`   | No                                                                                   | None                               |
| Altra   | `6e246b622304aee389cfed7ed4f13dd4dac4a751243ed43bae10d73c63195e7d` | Not installed           | No                                                                                   | None                               |

Earlier Turin testing against a pre-correction build produced QEMU and Cloud Hypervisor evidence, exposed the
Firecracker large-host vCPU failure, and did not prove Dragonball. That evidence explains the correction but cannot
accept the current digest. No runtime is marked accepted until a fresh canary supplies guest boot, guest kernel, CRI
sandbox, and host-side VMM or Dragonball shim evidence from the corrected installer.

## Ryzen acceptance receipt

The cached Ryzen installer index was
`sha256:6344e42093186c2a08f9857394ed249df8efed07caee7d91ad354f3279b51ab5`; its amd64 config was created before the
corrected extension workflow completed. The target-only cache entry was invalidated after matching that exact digest.
Image Factory then rebuilt the unchanged schematic from the live catalog entry
`sha256:f829d94e178a709d2c1bb46dd1c3c71dd7d50064db2843132768cf18d29d5d46` and produced:

- multi-architecture installer index
  `sha256:93235a29a518661225b78d72a88797f4a389e4f53cddca6eb482dfa7f094844c`;
- amd64 child `sha256:f07ba968ef14892d0c9aa11e8a0a164366ca195d94ddd9d77ac15f6314cc66a6`; and
- amd64 config creation time `2026-08-23T21:14:42Z`.

Because the corrected image kept schematic
`1146e679c37da65960431dfb8f90ec3fe9af454d68da3a7ffe78ec72aa7571bd` and Talos `v1.13.9`, Omni correctly reported
the machine as up to date and created no upgrade task. The documented same-schematic exception was therefore used with
no concurrent Omni operation. Before install, an etcd snapshot was captured from Turin at revision `522353247` with
snapshot hash `c91004ad`, and Ryzen forfeited etcd leadership to Turin.

The operator explicitly waived the Ceph-clean and PDB gates for this maintenance. Ryzen was drained with
`--disable-eviction`; the already-terminating `bilig-db-1`, `synthesis-db-1`, and `torghut-db-1` Pods required immediate
deletion because their configured grace period was 30 minutes. The already-drained node then ran:

```bash
talosctl --nodes 100.100.244.141 --endpoints 100.100.244.141 upgrade \
  --image 100.100.244.148:8081/metal-installer/1146e679c37da65960431dfb8f90ec3fe9af454d68da3a7ffe78ec72aa7571bd:v1.13.9 \
  --drain=false \
  --wait \
  --timeout=30m \
  --progress=plain
```

Talos pulled the exact index digest
`sha256:93235a29a518661225b78d72a88797f4a389e4f53cddca6eb482dfa7f094844c`, installed successfully, rebooted, and
returned with Talos `v1.13.9`, Kubernetes `v1.36.4`, kernel `6.18.44-talos`, and containerd `2.2.7`. The installed
extension set contains the corrected `kata-runtimes 4.1.0`, AMD microcode, AMDGPU, glibc, Tailscale, and the expected
schematic extension. The live Firecracker configuration reports `default_maxvcpus = 32`, `dial_timeout_ms = 100`, and
`reconnect_timeout_ms = 45000`; CRI selects the `blockfile` snapshotter only for `kata-fc`.

Fresh canaries then passed all acceptance checks on Ryzen:

| Runtime          | RuntimeClass      | Guest kernel | Guest boot ID                          | Host proof                    |
| ---------------- | ----------------- | ------------ | -------------------------------------- | ----------------------------- |
| QEMU             | `kata-qemu`       | `6.18.35`    | `476b2b27-7353-4823-a29f-c37f5e75a565` | `qemu-system-x86_64`          |
| Cloud Hypervisor | `kata-clh`        | `6.18.35`    | `71bb0bff-a141-4152-9b02-6aaedf35164a` | `cloud-hypervisor`            |
| Firecracker      | `kata-fc`         | `6.18.35`    | `78d7d88a-0dea-4e8a-94f9-f4da4107d663` | `firecracker`                 |
| Dragonball       | `kata-dragonball` | `6.18.35`    | `9e591020-2e0c-426a-a4a5-71582d821f74` | runtime-rs Kata shim + config |

The proof bundle was captured under `/tmp/galactic-kata-ryzen-proof-lPPcFG` and includes the RuntimeClasses, Pods,
guest evidence, CRI sandbox mapping, and host processes. All four canaries remain Ready. Ryzen was uncordoned only
after the combined proof passed and the Kubernetes API plus all three etcd voters were healthy.

The drain also exposed an existing Altra Flannel pod-CIDR exhaustion condition: the CloudNativePG operator initially
rescheduled there and could not create a sandbox. Deleting that stateless pending operator Pod allowed its Deployment
to reschedule on Turin. CloudNativePG then recreated every drained database Pod; the `bilig-db`, `synthesis-db`,
`torghut-db`, `agents-db-next`, `bayn-db`, and `buzz-db` clusters all returned to their full configured ready-instance
counts before this receipt was updated.

## Required next phase

Ryzen is accepted. Turin is now the only allowed next machine because its pre-correction testing was already started:

1. rerun the full live preflight; the Ryzen maintenance exception does not automatically waive any Turin gate;
2. prove that Turin's exact generated installer was rebuilt from extension digest
   `sha256:f829d94e178a709d2c1bb46dd1c3c71dd7d50064db2843132768cf18d29d5d46`;
3. use Omni normally if its desired schematic changes, or the documented same-schematic replacement only if the new
   installer manifest keeps Turin's current schematic and Talos version;
4. immediately re-cordon Turin for runtime validation;
5. prove QEMU, Cloud Hypervisor, Firecracker, and Dragonball one at a time; and
6. uncordon Turin and advance only after all four pass and the authorized postchecks pass.

Publishing, catalog resolution, extension installation by name, and Omni `up to date` are not completion. Galactic
completion requires exact digest proof plus fresh evidence for all twelve node/runtime combinations.
