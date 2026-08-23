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
- no runtime activation labels are present, and all four canary DaemonSets have desired count zero;
- Ceph has six of six OSDs up/in, three monitors, and no recovery-suppression flags, but it is not clean: 18 placement
  groups are remapped and backfilling or waiting to backfill, 1.654% of objects are misplaced, and two OSDs report slow
  BlueStore operations.

Current installer and acceptance ledger:

| Machine | Current schematic                                                  | Installed Kata resource | Corrected digest proven in installer | Corrected runtime acceptance |
| ------- | ------------------------------------------------------------------ | ----------------------- | ------------------------------------ | ---------------------------- |
| Ryzen   | `1146e679c37da65960431dfb8f90ec3fe9af454d68da3a7ffe78ec72aa7571bd` | `kata-runtimes 4.1.0`   | No                                   | None                         |
| Turin   | `cf3a3e88087d1ccb35a6aa3ebc4404bc7b66cd90f836bf66f42cea5b2854f0ca` | `kata-runtimes 4.1.0`   | No                                   | None                         |
| Altra   | `6e246b622304aee389cfed7ed4f13dd4dac4a751243ed43bae10d73c63195e7d` | Not installed           | No                                   | None                         |

Earlier Turin testing against a pre-correction build produced QEMU and Cloud Hypervisor evidence, exposed the
Firecracker large-host vCPU failure, and did not prove Dragonball. That evidence explains the correction but cannot
accept the current digest. No runtime is marked accepted until a fresh canary supplies guest boot, guest kernel, CRI
sandbox, and host-side VMM or Dragonball shim evidence from the corrected installer.

## Required next phase

Turin is the already-started, incomplete phase, so it must be completed before Ryzen or Altra changes again:

1. wait for Ceph to have every placement group active and clean and rerun the full preflight;
2. prove that Turin's exact generated installer was built from extension digest
   `sha256:f829d94e178a709d2c1bb46dd1c3c71dd7d50064db2843132768cf18d29d5d46`;
3. let Omni converge the reviewed schematic and reboot; Omni will normally uncordon when it finalizes the reboot;
4. immediately re-cordon Turin for runtime validation;
5. prove QEMU, Cloud Hypervisor, Firecracker, and Dragonball one at a time; and
6. uncordon Turin and advance only after all four pass and the Kubernetes, etcd, and Ceph postchecks are clean.

Publishing, catalog resolution, extension installation by name, and Omni `up to date` are not completion. Galactic
completion requires exact digest proof plus fresh evidence for all twelve node/runtime combinations.
