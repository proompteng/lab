# Kata

Argo CD application `kata` owns the four cluster-scoped Kata `RuntimeClass` objects. The ApplicationSet creates and
labels namespace `kata`; this package must not render a `Namespace` object or permanent runtime canary workloads.

Runtime proof is a bounded acceptance operation using an explicitly created Pod or Job. It must be removed when the
proof completes rather than restored as a DaemonSet or other continuously scheduled workload.

Node runtime binaries and containerd handler configuration are supplied separately by the installed Talos extension in
`devices/galactic/extensions/kata`. Moving or syncing this package does not install, replace, or upgrade that extension.

Render locally with:

```bash
kustomize build argocd/applications/kata
```
