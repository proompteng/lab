# Galactic Kubernetes Access

This runbook documents the current operator access paths for the Talos-based
`galactic` Kubernetes cluster.

## Current endpoints

Keep exactly two local `kubectl` contexts for normal operator use:

| Context              | API server                     | Use                                                            |
| -------------------- | ------------------------------ | -------------------------------------------------------------- |
| `galactic-lan`       | `https://100.100.244.141:6443` | Provider-managed LAN path. Use this when on the local network. |
| `galactic-tailscale` | `https://100.94.129.1:6443`    | Tailnet path. Use this when off-LAN with Tailscale connected.  |

The live node layer currently has three Ready Kubernetes nodes:

| Kubernetes node name  | Current internal IP | Role          |
| --------------------- | ------------------- | ------------- |
| `talos-192-168-1-194` | `100.100.244.141`   | control plane |
| `talos-192-168-1-85`  | `100.100.244.142`   | control plane |
| `turin`               | `100.100.244.171`   | control plane |

The node names still contain the original `192.168.1.*` addresses, but those
names are not the current LAN reachability source. Do not use old
`192.168.1.*` addresses for current kube API access unless a separate live
reachability check proves that path has returned.

MetalLB is on the same provider-managed LAN. The current reserved addresses are
`100.100.244.180` for Plex, `100.100.244.181` for the shared Traefik/Forgejo
edge, and `100.100.244.182` for Istio ingress.

## Rebuild local kubeconfig contexts

The contexts should share the same admin user credential and differ only by
cluster endpoint:

```bash
kubectl config set-cluster galactic-lan \
  --server=https://100.100.244.141:6443

kubectl config set-cluster galactic-tailscale \
  --server=https://100.94.129.1:6443

kubectl config set-context galactic-lan \
  --cluster=galactic-lan \
  --user=galactic-admin \
  --namespace=torghut

kubectl config set-context galactic-tailscale \
  --cluster=galactic-tailscale \
  --user=galactic-admin \
  --namespace=agents
```

If recreating the cluster entries from scratch, copy the existing certificate
authority data from a known-good `galactic` kubeconfig instead of bypassing TLS
verification.

After editing, remove stale contexts and clusters that point at old addresses:

```bash
kubectl config get-contexts
kubectl config delete-context <stale-context>
kubectl config delete-cluster <stale-cluster>
```

## Verify both paths

Run the same checks against both contexts:

```bash
kubectl --context galactic-lan get nodes -o wide
kubectl --context galactic-lan get --raw='/readyz?verbose'

kubectl --context galactic-tailscale get nodes -o wide
kubectl --context galactic-tailscale get --raw='/readyz?verbose'
```

Expected shape:

1. Both contexts list the same two Ready nodes.
1. `talos-192-168-1-194` reports internal IP `100.100.244.141`.
1. `talos-192-168-1-85` reports internal IP `100.100.244.142`.
1. `/readyz?verbose` ends with `readyz check passed`.

If the LAN context works but the tailnet context does not, verify local
Tailscale state first:

```bash
tailscale status
tailscale ping 100.94.129.1
```

Then verify the API path directly:

```bash
nc -vz 100.94.129.1 6443
kubectl --context galactic-tailscale get --raw=/readyz
```

## Talos access

The current local `talosctl` context targets the tailnet node endpoints:

```text
100.94.129.1
100.84.102.56
```

Use read-only checks before making Talos changes:

```bash
talosctl config info
talosctl health
talosctl -n 100.94.129.1 get machinestatus -o yaml
talosctl -n 100.84.102.56 get machinestatus -o yaml
```

Do not reboot, reset, or reapply Talos machine configs as part of access repair
unless the live evidence shows that the Kubernetes and Talos APIs are both
healthy enough for the requested change and the operator explicitly approved
the state-changing action.

## Reseal `agents/codex-auth`

`agents` uses one `codex-auth` Secret with the `auth.json` key. The GitOps
source is:

```text
argocd/applications/agents/codex-auth-sealedsecret.yaml
```

To reseal from this host without printing the secret:

```bash
kubectl --context galactic-lan -n agents get secret codex-auth -o yaml \
  | yq 'del(.metadata.ownerReferences)' \
  | kubeseal \
      --controller-name=sealed-secrets \
      --controller-namespace=sealed-secrets \
      --format=yaml \
  | yq 'del(.spec.template.type)' \
  > argocd/applications/agents/codex-auth-sealedsecret.yaml
```

Verify the output shape, not the secret value:

```bash
yq '.metadata.name, .metadata.namespace, (.spec.encryptedData | keys)' \
  argocd/applications/agents/codex-auth-sealedsecret.yaml
```

Expected output:

```text
codex-auth
agents
- auth.json
```
