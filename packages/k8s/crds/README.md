# Vendored CRDs

`traefik-41.0.1.yaml` is the `IngressRoute` CRD from the official Traefik Helm chart version `41.0.1`. Only this CRD
is vendored because it is the only Traefik custom resource currently synthesized by `@proompteng/k8s`.

Reproduce the vendored file from the official chart repository:

```sh
helm show crds traefik --repo https://traefik.github.io/charts --version 41.0.1 \
  | sed -n '3909,4398p' \
  | sed '${/^$/d;}' \
  > packages/k8s/crds/traefik-41.0.1.yaml
```

Verify its contents:

```text
SHA-256: 6c78d0550ca4dcce238b4a6b470f7e98b8ca834a02b5103b5c29e2dbdc05ad8a
```
