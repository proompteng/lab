# Headlamp Image

This directory builds the repo-owned Headlamp image used by
`argocd/applications/headlamp`.

It intentionally pins the upstream source to `kubernetes-sigs/headlamp`
`v0.40.1` and enables the frontend websocket multiplexer at build time with
`REACT_APP_ENABLE_WEBSOCKET_MULTIPLEXER=true`.

The stock upstream image leaves the multiplexer disabled by default, which
causes the UI to open legacy direct `/clusters/...?...watch=1` websocket
connections. That path is where the private-host OIDC websocket auth was
failing in this cluster.

This build also applies a local upstream patch from `patches/` that changes the
backend multiplexer to consume Kubernetes watch streams over authenticated HTTP
instead of trying to websocket-upgrade kube watch URLs directly. The matching
regression test is exercised by `scripts/test-upstream.sh` and in
`.github/workflows/headlamp-ci.yml`.
