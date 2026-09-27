# Lab development microVM

`codex-turin` is a persistent lab workstation on Turin with 8 vCPUs and 64 GiB RAM.
Kubernetes owns its lifecycle through a StatefulSet using the existing `kata-fc` RuntimeClass.
It has no AgentRun or Tengri control-plane dependency.

The small launcher fits the installed 512 MiB blockfile snapshotter. It extracts a
digest-pinned Ubuntu development image into the retained 500 GiB raw-block PVC and
starts the guest userspace inside that filesystem. The existing Kata agent mounts
the persistent block device. No host directories, containerd socket, or Kubernetes
service-account credential are exposed to the devbox.

The container is privileged inside its Firecracker guest so systemd, Docker, Nix,
and Codex's Linux sandbox can work. The manifests dedicate a namespace to this
workload; the developer connects over key-only SSH from the provider LAN.

## Deliver an image

The `Codex devbox` workflow validates both native architectures and both images.
It checks the launcher's populated 512 MiB filesystem and exercises the development
toolchain before publication. The launcher also extracts an archive with its installed
tar and verifies file contents, executable permissions, ownership, and symlinks.
Main builds publish signed immutable indexes.
Both images must finish validation and the release artifact must upload before
either Kargo discovery tag is exposed.
Publication uses the shared Docker retry helper to wait through the registry's
single-writer queue. Each build job allows three hours because the two compressed
development filesystems total about 7 GiB and uploads share a 1 MiB/s writer.
The 24 retry attempts remain bounded by that timeout; authentication and other
nonretryable errors still fail the release immediately.

The `codex-devbox` Warehouse binds the two images to one source commit and workflow
run. Its Stage writes their digests into the Kustomize inputs on
`kargo/codex-devbox`. Argo owns the namespace, initialization Job, PVC, StatefulSet,
and LAN SSH Service. Image updates restart the devbox, so schedule source changes
when its running development commands can be interrupted.
The source template on `main` uses inert unpublished image references. Only Kargo's
rendered branch supplies runnable digests; the launcher rejects mutable rootfs references.

The initialization Job alone carries the one-use filesystem initialization token.
It reserves 2 GiB for Firecracker and filesystem creation; a 256 MiB workload limit
caused the host memory cgroup to kill Firecracker before the 500 GiB disk was initialized.
Its completed record is retained. Normal devbox Pods omit that token and cannot
format a missing or damaged filesystem. The PVC and namespace are excluded from
Argo pruning and Application deletion. The root image, persistent home, Nix store,
Docker data, SSH host keys, and machine identity remain on the PVC.
Boot retains the selected root filesystem and the last one that completed setup;
older generations and interrupted extractions are removed. Shared home, Nix, and
Docker state are outside those directories and are not pruned.

If the initialization Job has already failed, its Pod template cannot be updated in place.
Wait for image publication and for Kargo to write the corrected manifest to
`kargo/codex-devbox`. Verify that Argo's desired revision renders both initializer memory
values as `2Gi`; merging the source change alone does not update that deployment branch.
For an approved recovery, pause only the `codex-devbox` Application with its preserved
`argocd.argoproj.io/skip-reconcile` annotation, stop the uninitialized devbox, and recreate
only the failed Job from that promoted manifest. Wait for the Job to complete before
restoring the devbox and Application reconciliation. Preserve the PVC and its initialization
token. A completed initialization Job must not be recreated.

## Install the personal environment

After merge, copy `dns.py` and `devices/nuc/pihole/pihole.toml` from that committed
revision to the NUC. Run `sudo python3 dns.py pihole.toml --apply` there, then verify
`dig @100.100.244.148 codex-turin.k8s.proompteng.ai` returns `100.100.244.183`.
The helper updates only the devbox host record and restarts Pi-hole once if needed.
Reapplying is a no-op. To change or roll back the address, commit the intended
record and rerun the same helper; other host records and Pi-hole settings are preserved.

After the GitOps rollout succeeds, verify the SSH host key against the key read
through the Kubernetes control channel. Add the concrete alias to the Mac's SSH
configuration:

```sshconfig
Host codex-turin
  HostName codex-turin.k8s.proompteng.ai
  User codex
  IdentityFile ~/.ssh/id_ed25519
```

Run the private seed transfer after the owner approves the credential destinations:

```bash
python3 services/devbox/seed.py codex-turin --github-auth --kube-context galactic-lan
```

The seed copies the host's user skills, memories, instructions, selected model
settings, and Git identity. Credential flags are opt-in. GitHub credentials travel
over SSH on standard input. Kubernetes transfer includes only the selected context.
The reusable images and Git repository never contain this personal state.
Codex authentication uses the desktop's supported remote sign-in flow.

Add `codex-turin` in the desktop app's Connections settings and open
`/home/codex/src/lab`. The first-boot service has already initialized the Codex daemon,
cloned the source revision used to build the image, installed the workspace
dependencies, and checked the repository toolchain. Existing checkouts are preserved.
`devbox-install-deps` first materializes the frozen dependency graph without scripts.
It then uses `npm rebuild` for the exact installed package versions reported by
`bun pm ls --all --trusted`, followed by Bun's normal workspace postinstall pass.
Each rebuild runs from the package's physical store entry so npm treats it as an
installed dependency. Running at the workspace root would treat Bun's symlinks as
linked source packages and run their package-author `prepare` scripts.
This keeps native build helpers available throughout compilation. A forced Bun
reinstall can remove `node-gyp` while a grammar's install script is using it.
The isolated dependency layout, Bun lockfile, and existing script trust policy
are preserved. An empty trusted list skips rebuilding, and an unrecognized list,
missing store entry, or failed native build stops setup.

## Verify development and persistence

```bash
ssh codex-turin devbox-verify
ssh codex-turin 'codex app-server daemon version; git -C ~/src/lab status --short --branch'
kubectl --context galactic-lan -n codex-devbox get pod codex-turin-0 -o wide
```

Run a real Codex desktop task against that remote checkout. Record the Pod's runtime
class, CPU and memory limits, image ID, and PVC UID. Before a requested restart,
write a marker in the persistent home. After restart, verify its contents, the PVC
UID, skills, memories, GitHub identity, Kubernetes identity, and daemon connection.

GitOps changes to `spec.replicas` stop and start the devbox without deleting storage.
Additional instances can use the same reviewed manifests through the Kubernetes
API, with their own namespace, disk, SSH identity, address, and initialization token.
Never reuse the existing disk's initialization Job or token for another workspace.
