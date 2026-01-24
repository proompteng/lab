# Investigation: Firecracker native runtime on Talos (ryzen)

Date: 2026-01-24
Node: 192.168.1.194
Goal: Restore Talos boot + enable native Firecracker runtime (`kata-fc`) alongside Cloud Hypervisor (`kata-clh`).

## What changed (repo)
- Added Firecracker system extension + installer build script.
- Added `kata-clh` RuntimeClass + containerd runtime config (cloud-hypervisor).
- Updated kata-fc config path to `/usr/local/share/kata-containers/configuration-fc.toml`.
- Updated runbooks with strict timing (scratch file before kata-fc), kubelet bootstrap note, and extension build flow.

## Images built
- Firecracker extension: `registry.ide-newton.ts.net/lab/talos-ext-firecracker:v1.12.1-fc2`
- Installer image: `registry.ide-newton.ts.net/lab/installer-firecracker:v1.12.1-fc2`

## Talos actions
- Observed repeated error:
  - `error writing kubelet PKI: open /etc/kubernetes/bootstrap-kubeconfig: read-only file system`
- Machine config contains `/etc/kubernetes/.keep`, but the file was not created and `/etc/kubernetes` remained read-only.
- Ran `talosctl reset -n 192.168.1.194 --graceful=false --reboot` to reinstall from scratch.
- After reset, node did not respond to ping or `talosctl --insecure` yet (host down / no route).

## Local artifacts (not committed)
- `/tmp/ryzen-machineconfig.yaml`: full machine config (includes kata-fc config).
- `/tmp/ryzen-machineconfig-pre-kata.yaml`: same config with kata-fc blockfile entries removed (for pre-scratch boot).

## Next steps (when node is reachable)
1) Apply pre-kata config in maintenance mode (no kata-fc yet):
   ```bash
   talosctl apply-config --insecure -n 192.168.1.194 \
     -f /tmp/ryzen-machineconfig-pre-kata.yaml --mode=reboot
   ```
2) Boot cluster, install Argo CD, and sync `argocd/kata-containers-ryzen` so the
   blockfile scratch file is created.
3) Verify `/var/mnt/blockfile-scratch/containerd-blockfile/scratch` exists.
4) Apply kata-fc config (blockfile + runtimes):
   ```bash
   talosctl apply-config -n 192.168.1.194 -e 192.168.1.194 \
     -f /tmp/ryzen-machineconfig.yaml --mode=reboot
   ```
5) Verify runtimeclasses and run a kata-fc test pod; confirm firecracker socket/processes.
