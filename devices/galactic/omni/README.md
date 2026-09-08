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
