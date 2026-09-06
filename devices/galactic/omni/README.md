# Galactic Omni cluster template

`cluster-template.yaml` is the authoritative, secret-redacted Omni template for the existing three-control-plane
`galactic` cluster. It preserves every imported machine patch, removes the stale imported `machine.install.image`
overrides so Omni can derive installers from schematics, and references the Elauwit Image Factory registry patch.

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

The first sync applies only `image-factory-registry.yaml` and removes the three stale installer-image overrides. Wait
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

Run the read-only address and storage gate immediately before each node's maintenance:

```bash
python3 devices/galactic/omni/podcidr_preflight.py --node turin
python3 devices/galactic/omni/podcidr_preflight.py --node talos-192-168-1-85
```

The command uses only the `galactic-lan` Kubernetes context. It checks the reviewed three-node membership, readiness,
distinct allocator `/23` blocks, current pod addresses, Ceph monitor/OSD/PG recovery, and active/standby CephFS MDS
placement on separate hosts. It requires a 250-pod cap on the maintenance target. After migration, add `--migrated`
to require both a `/23` PodCIDR and a 500-pod cap. Exit code 1 means a failed gate; exit code 2 means live evidence
could not be established. A peer's existing address-capacity mismatch is reported separately as a warning.

Passing these checks does not prove workload continuity, data backups, disk identity, GPU or Kata operation, or
authorize a drain. Verify those conditions in the reviewed maintenance procedure. In particular, a Kubernetes etcd
snapshot does not back up application volumes, and node membership changes must preserve the existing OSD identities.

Check the gate's failure cases with:

```bash
python3 -m unittest discover -s devices/galactic/omni -p test_podcidr_preflight.py -v
ruff check devices/galactic/omni/podcidr_preflight.py devices/galactic/omni/test_podcidr_preflight.py
ruff format --check devices/galactic/omni/podcidr_preflight.py devices/galactic/omni/test_podcidr_preflight.py
```
