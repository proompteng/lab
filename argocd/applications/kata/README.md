# Kata

Argo CD application `kata` owns the four cluster-scoped Kata `RuntimeClass` objects and the long-running Nanoagent
runtime canaries in namespace `kata`. The ApplicationSet creates and labels the namespace; this package must not render
a `Namespace` object.

Node runtime binaries and containerd handler configuration are supplied separately by the installed Talos extension in
`devices/galactic/extensions/kata`. Moving or syncing this package does not install, replace, or upgrade that extension.

Render locally with:

```bash
kustomize build argocd/applications/kata
```
