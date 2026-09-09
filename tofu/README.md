# OpenTofu stacks

Status: Current stack index.

Run OpenTofu only from an explicitly selected stack after verifying its current owner, backend, and intended target. The
repository intentionally has no generic root `tf:plan`, `tf:apply`, or `tf:destroy` aliases.

## Current

- `tofu/tailscale/**`: Tailscale infrastructure. Follow `tofu/tailscale/README.md` and its scoped wrapper.

## Ownership pending verification

- `tofu/cloudflare/**`: a Cloudflare zone resource without a checked-in backend or current operator runbook. Do not
  plan, apply, or import it until account ownership, remote state, and the intended management boundary are verified.

## Legacy pending verification

- `tofu/harvester/**`: former Harvester VM fleet.
- `tofu/rancher/**`: former Rancher/K3s management surface.

Do not plan, apply, destroy, or import either legacy stack until its remote state and any live/external consumers are
verified. Their bounded retirement is tracked in `docs/repository-cleanup-todo.md`.
