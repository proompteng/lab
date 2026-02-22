# NUC device configuration

This directory describes services hosted on the NUC at `192.168.1.130`.

- `nginx-proxy-manager/` — Docker compose bundle and data snapshot for Nginx Proxy Manager.
- `k8s-api-lb/` — HAProxy TCP load balancer for the Talos/Kubernetes API (`:6443`) on the LAN.

## Sunshine + Moonlight (remote desktop/streaming)

As of `2026-02-21`, remote desktop on this host uses Sunshine (Moonlight client).

### Current working layout

- VNC/XRDP were removed for daily use; Sunshine is the active remote desktop path.
- Sunshine is bound to `DISPLAY=:1` (headless session), not `:0`.
- The headless desktop stack is:
  - `headless-xorg.service` (dummy Xorg display)
  - `headless-gnome.service` (GNOME session on `:1`)
  - `sunshine.service` (stream host)

### Host configuration files

- `/home/kalmyk/.config/systemd/user/headless-xorg.service`
- `/home/kalmyk/.config/systemd/user/headless-gnome.service`
- `/home/kalmyk/.config/systemd/user/sunshine.service.d/override.conf`
- `/home/kalmyk/.config/xorg-dummy.conf`
- `/home/kalmyk/.config/sunshine/sunshine.conf`

### Known behavior and troubleshooting

- Black screen risk:
  - If Sunshine is switched to `DISPLAY=:0` while no physical/virtual monitor is attached, Moonlight can show black screen.
  - Recovery is to restore Sunshine to `DISPLAY=:1` and run the headless Xorg + GNOME user services.
- Input fix:
  - `Xvfb` caused mouse/keyboard passthrough failures.
  - `Xorg` dummy session on `:1` is required so Sunshine virtual input devices attach correctly.
- Performance note:
  - Headless GNOME on dummy Xorg may render via software (`llvmpipe`), which can be laggy for video-heavy workloads.
  - Better smoothness generally requires a real/virtual display sink that allows full GPU-accelerated desktop rendering.

### Quick verification commands (run on NUC as `kalmyk`)

- `systemctl --user is-active headless-xorg.service headless-gnome.service sunshine.service`
- `DISPLAY=:1 xrandr -q | head -n 20`
- `DISPLAY=:1 xinput --list | grep -i passthrough`
