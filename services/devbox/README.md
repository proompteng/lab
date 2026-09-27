# Lab development microVM

`codex-turin` is a persistent lab workstation on Turin with 8 vCPUs and 64 GiB RAM.
The Argo Application `devbox` owns its StatefulSet using `kata-dragonball`.
The Kubernetes namespace remains `codex-devbox` to preserve the existing 500 GiB
raw-block PVC, access Secret, and LAN SSH address.

Dragonball runs the development image directly through inline virtio-fs. The Kata
agent mounts the persistent ext4 disk at `/persist`. The entrypoint binds persistent
home, Nix store, Docker and containerd data, and workstation metadata before starting systemd as
PID 1. SSH host keys and machine identity also survive Pod replacement. The
container is privileged inside its guest so systemd, Docker, Nix, and Codex's Linux
sandbox can work. No host directories, containerd socket, or Kubernetes service
account credential are exposed to the devbox.

Readiness uses the guest's internal HTTP endpoint on port 8080. It requires setup
to finish and both SSH and Docker to be active. The LAN Service exposes only SSH.
Systemd delegates cgroup v2 subtrees for Docker; the installed Kata agent cannot
add `kubectl exec` processes to that non-leaf cgroup. Use SSH for administration.
HTTP probes avoid that exec limitation while checking the same guest services.
Docker and containerd data both use the ext4 disk because overlayfs snapshots
cannot use the image's virtio-fs filesystem as their writable backing store.

## Deliver an image

The `Codex devbox` workflow builds and exercises one development image on both
native architectures, then publishes a signed immutable index. The release receipt
must upload successfully before the Kargo discovery tag is exposed. Publication
uses the shared Docker retry helper and the registry's 5 MiB/s single bulk writer.

The `devbox` Warehouse and Stage bind the image to its source commit and successful
workflow run. Kargo updates `argocd/applications/devbox` on `kargo/devbox`; the
`devbox` Application follows that branch. The source template on `main` retains an
inert unpublished image reference. Image updates replace the Pod, so schedule
updates when running development commands can be interrupted.

The `devbox-initialize` Job alone carries the disk initialization token. The
patched Kata agent creates ext4 only on a new, blank device. A matching consumed
token on an existing ext4 disk only checks the filesystem; missing ext4 after token
consumption is rejected. Normal workstation Pods omit the token and cannot format
a missing or damaged filesystem. The PVC and namespace are protected against Argo
pruning and Application deletion.

## Migrate the existing workstation

Install the migration hold before merging the rename. The root manifest enables
automatic pruning even when the live root has been paused. Keep the existing
namespace, PVC UID, access Secret, and Service address throughout:

1. Confirm root automatic sync is disabled before the merge. Record its original
   setting if a pause is needed. Add a temporary `ignoreApplicationDifferences`
   rule to `platform`, scoped by name to `codex-devbox`, for `/metadata/finalizers`,
   `/spec/syncPolicy/automated`, and the `argocd.argoproj.io/skip-reconcile`
   annotation. This prevents ApplicationSet from undoing the migration hold.
2. Set that annotation to `true`, disable the old Application's automatic sync,
   terminate its pending operation, and remove its resource-deletion finalizer.
   Scale its StatefulSet to zero and wait for the old Pod to terminate. Recheck
   that the hold survives ApplicationSet reconciliation before merging.
3. After the reviewed merge, sync the Kargo configuration and only the `platform`
   ApplicationSet from the root Application. The committed ApplicationSet replaces
   the old entry with `devbox` and removes the temporary ignore rule. The old
   Application now has no deletion finalizer and leaves its workloads intact.
4. Let Kargo discover the successfully published image and promote it to `kargo/devbox`. Verify the
   generated revision, image digest, and `kata-dragonball` runtime before Argo sync.
   If the Application was recreated after promotion, re-promote the same Freight.
5. The new initializer checks the retained ext4 disk using its original provisioning token.
   Verify the PVC UID and SSH identity before and after replacement.
6. After the workstation passes development and persistence checks, delete the old
   completed `codex-turin-initialize` Job, orphaned release ConfigMaps, obsolete
   controller revisions, and old `codex-devbox` delivery objects. Delete only the
   retired `/persist/roots` extraction cache after checking it has no mounts.
   Preserve `/persist/home`, `/persist/nix`, `/persist/docker`, `/persist/ssh`,
   `/persist/machine`, `/persist/containerd`, and `/persist/metadata`.
   Restore the root's original automatic-sync setting if it was paused for migration.

The old launcher, rootfs image subscription, archive extraction, chroot exec
wrapper, and root-generation pruning are removed. Rollback uses a previously
verified Dragonball image through Kargo; the broken old runtime is not a fallback.

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
`/home/codex/src/lab`.
The image contains the version-pinned official standalone Codex installation under
the user's persistent home. It can bootstrap the daemon without a device login.
The first-boot service initializes the daemon, clones the source revision used to
build the image, installs workspace dependencies, and checks the repository toolchain.
Existing checkouts are preserved.
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
