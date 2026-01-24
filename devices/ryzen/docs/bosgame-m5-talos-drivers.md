# Bosgame M5 (Ryzen AI Max+ 395) - Talos driver notes

Last reviewed: 2026-01-24

## What this device is (vendor + AMD)

- Bosgame lists the M5 AI Mini Desktop with AMD Ryzen AI Max+ 395 and Radeon 8060S,
  up to 128GB LPDDR5X-8000, dual PCIe 4.0 M.2 slots, USB4 ports, HDMI 2.1, DisplayPort 2.1,
  SD 4.0, and 2.5GbE LAN.
  https://bosgamepc.com/products/bosgame-m5-ai-mini-desktop-ryzen-ai-max-395-128gb-2tb
- AMD specs for Ryzen AI Max+ 395: 16 cores / 32 threads, 3.0 GHz base, up to 5.1 GHz boost,
  80 MB cache, Radeon 8060S (40 graphics cores), 50 TOPS NPU, and 45-120W cTDP.
  https://www.amd.com/en/newsroom/press-releases/2025-1-6-amd-unveils-its-most-advanced-ai-pc-portfolio.html
- SKU note: Bosgame's product page says "No WiFi module" for this model, while third-party
  coverage of the M5 mentions Wi-Fi 7 and Bluetooth 5.2. Treat Wi-Fi/BT as SKU-dependent
  and verify the actual unit before assuming support.
  https://bosgamepc.com/products/bosgame-m5-ai-mini-desktop-ryzen-ai-max-395-128gb-2tb
  https://www.techradar.com/computing/mini-pcs/bosgame-teases-its-amd-ryzen-ai-max-395-mini-pc-with-128gb-of-ram-for-usd1999

## Vendor driver package inventory (Windows)

Bosgame's download center lists these driver packages for the M5:
- Chipset
- Graphics
- Audio
- Wi-Fi
- Bluetooth
- LAN
- Card reader
- ACP
- Camera
- Radeon Software
- DRTM
- Performance button

Source:
https://www.bosgamepc.com/pages/bosgamepc-downloader?view=m5-1

## Talos driver/extension implications

Talos is immutable: drivers are delivered via system extensions, and extensions only activate
on install/upgrade.
https://www.talos.dev/latest/talos-guides/configuration/system-extensions/

Talos 1.9+ removed AMDGPU from the base image; AMDGPU now requires system extensions.
https://www.talos.dev/v1.9/introduction/whats-new/#removed-amdgpu-from-the-base-image

### Required for Ryzen AI Max+ 395 GPU

The Talos AMD GPU guide indicates AMD GPU support requires these official extensions:
- siderolabs/amdgpu
- siderolabs/amd-ucode

The guide also lists required kernel arguments for newer AMD platforms (including AI Max / Strix Halo).
Confirm the exact args needed for your Talos version and apply them if required.
https://docs.siderolabs.com/talos/v1.11/configure-your-talos-cluster/hardware-and-drivers/amd-gpu

## Action checklist (Talos)

1. Confirm Talos version on the node.
2. Build or select a Talos installer image that includes the required extensions.
3. Apply updated machine config and perform install/upgrade so extensions activate.
4. Verify extensions are active: `talosctl get extensions`.
5. Validate GPU availability from workloads or runtime logs.

## Open questions (verify on this unit)

- Actual Wi-Fi/BT module present? (SKU variations in sources.)
- NIC chipset for driver mapping.
- Any additional devices (card reader, camera, audio) you need in Talos.
