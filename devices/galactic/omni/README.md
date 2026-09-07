# Galactic Omni cluster template

`cluster-template.yaml` is the authoritative, secret-redacted Omni template for the existing three-control-plane
`galactic` cluster. It preserves every imported machine patch, removes the stale imported `machine.install.image`
overrides so Omni can derive installers from schematics, and references the Elauwit Image Factory registry patch.

The template targets Talos 1.14.0 and Kubernetes 1.37.0 through Omni 1.11. Complete the Talos phase and its workload
acceptance before syncing the Kubernetes change. The Talos-only template from the preceding release commit retains
Kubernetes 1.36.4 for that phase. Each
Machine's `install.diskSelector` selects its verified system-disk serial, replacing the imported `machine.install.disk`
field while preserving the other install options. See the [release procedure](../releases/README.md) for artifact
verification, rolling upgrades, acceptance, and recovery. Control-plane upgrades use `maxParallelism: 1`; individual
control-plane locks are unsupported.

Do not sync the checked-in file directly. Its six placeholders must be rendered into a temporary mode-`0600` file.
Either provide `GALACTIC_TAILSCALE_AUTH_KEY` and `GALACTIC_OMNI_JOIN_TOKEN`, or extract the existing values from a fresh
mode-`0600` live export:

```bash
umask 077
omnictl cluster template export -c galactic \
  --include-kernel-args \
  --output /tmp/galactic-cluster-template.raw.yaml \
  --force

bun devices/galactic/omni/render-template.ts \
  --secrets-from /tmp/galactic-cluster-template.raw.yaml \
  --output /tmp/galactic-cluster-template.rendered.yaml

omnictl cluster template validate \
  --file /tmp/galactic-cluster-template.rendered.yaml
```

The renderer also copies the non-secret `image-factory-registry.yaml` sidecar next to the rendered template so Omni
can resolve the relative patch reference.

Review the sync before applying it:

```bash
omnictl cluster template sync \
  --file /tmp/galactic-cluster-template.rendered.yaml \
  --dry-run \
  --verbose
```

During the original Image Factory handoff, the first sync applied only `image-factory-registry.yaml` and removed the
three stale installer-image overrides. For a future staged extension change, wait
for those configuration updates to finish before adding any `systemExtensions` list. Then add the custom extension to
one `kind: Machine` document at a time. A new rollout uses Ryzen, Turin, Altra order; a resumed rollout finishes the
already-started machine before changing another. Rerender, validate, dry-run, and sync each phase. The control-plane
`upgradeStrategy` remains rolling with `maxParallelism: 1`.

`systemExtensions` is a customization request, not immutable artifact proof. Image Factory hashes the ordered request
into a schematic ID, while the catalog can later resolve an extension name to a new digest. The same schematic ID and
Talos version may therefore still address a cached installer built from an older catalog. Before each sync, use the
artifact identity gate in `docs/runbooks/talos-latest-upgrade-plan.md` to tie the exact generated installer to the
signed Kata digest. `MachineUpgradeStatus: machine is up to date`, a matching schematic ID, and extension version
`4.1.0` prove convergence to that installer; they do not prove which extension digest built it.

When a reviewed cache rebuild changes the installer manifest digest but leaves both the schematic ID and Talos version
unchanged, Omni has no desired-state difference and correctly creates no new machine task. Do not mutate the template
or fake a version change to force one. After proving there is no active Omni operation, use only the target-specific,
already-drained same-schematic replacement procedure in `docs/runbooks/talos-latest-upgrade-plan.md`, then return to
Omni ownership and the normal runtime-acceptance sequence.

Omni's normal lifecycle cordons and drains before the installer reboot, then `FinalizeReboot` uncordons the Kubernetes
node after it returns. That automatic uncordon means the installer transport finished; it is not Kata acceptance. The
operator must immediately apply a separate runtime-validation cordon and keep the node
`Ready,SchedulingDisabled` until QEMU, Cloud Hypervisor, Firecracker, and Dragonball have all passed the runbook's
guest and host-side checks. Do not manually uncordon a node with incomplete artifact identity or runtime proof, and do
not add the next machine's extension while the current phase is incomplete.

The Image Factory endpoint is intentionally plain HTTP on the isolated Elauwit provider LAN. This works only because
the cluster template first installs an explicit `RegistryMirrorConfig` whose `name` exactly matches the installer
reference host, including port. Talos honors that mirror for its own installer pull as well as containerd pulls. A
direct pull of the same host without the mirror defaults to HTTPS and is not an equivalent test.

Never commit the raw or rendered templates. Delete both temporary files after the operation. The full preflight,
runtime proof, and rollback procedure is in `docs/runbooks/talos-latest-upgrade-plan.md`.

## PodCIDR maintenance checks

Turin and Altra have re-registered with distinct `/23` PodCIDRs. The template sets both to `maxPods: 500` and requests
`/23` allocations for newly registered Nodes. Apply each target's 500-pod cap through the render, validate, dry-run,
and Omni sync procedure above after its network and storage acceptance. Changing the allocation mask does not resize
existing Nodes' immutable PodCIDRs.

Use the migrated gate after applying both caps:

```bash
python3 devices/galactic/omni/podcidr_preflight.py --node turin --migrated
python3 devices/galactic/omni/podcidr_preflight.py --node talos-192-168-1-85 --migrated
```

The command uses only the `galactic-lan` Kubernetes context. It checks the reviewed three-node membership, readiness,
distinct allocator `/23` blocks, current pod addresses, Ceph monitor/OSD/PG recovery, and active/standby CephFS MDS
placement on separate hosts. `--migrated` requires both a `/23` PodCIDR and a 500-pod cap. Without that flag, the
preparation gate requires a 250-pod cap; retain that cap during any future Node re-registration until network and
storage acceptance. Exit code 1 means a failed gate; exit code 2 means live evidence could not be established.
A peer's existing address-capacity mismatch is reported separately as a warning.

For a future Node re-registration, first merge a template change lowering only the selected target from 500 to 250.
Export fresh live credentials, render the changed template, validate it, inspect the Omni sync dry run, and sync it
using the commands above. Verify the target's `.status.capacity.pods` is `250` before running the preparation gate or
draining. After its replacement `/23` network and storage pass acceptance, merge the target's return to 500 and repeat
the render, validate, dry-run, and sync sequence before running the migrated gate and capacity test.

Passing these checks does not prove workload continuity, data backups, disk identity, GPU or Kata operation, or
authorize a drain. Verify those conditions in the reviewed maintenance procedure. In particular, a Kubernetes etcd
snapshot does not back up application volumes, and node membership changes must preserve the existing OSD identities.

The [Turin and Altra maintenance procedure](../../../docs/runbooks/galactic-turin-podcidr-23-migration-plan.md)
records the rehearsed Node re-registration, workload availability decision, restoration, and recovery sequence.
`podcidr_patch.py` renders temporary Omni patches from a drained target's snapshots; `podcidr_cleanup.py` performs
the guarded CNI cleanup inside the maintenance static pod. Neither tool authorizes a production drain or a Talos reset.
The cleanup waits for asynchronous bridge detachment and fails if ports remain owned; it never removes attached ports.

Check the gate's failure cases with:

```bash
python3 -m unittest discover -s devices/galactic/omni -p 'test_podcidr_*.py' -v
ruff check devices/galactic/omni/podcidr_*.py devices/galactic/omni/test_podcidr_*.py
ruff format --check devices/galactic/omni/podcidr_*.py devices/galactic/omni/test_podcidr_*.py
```
