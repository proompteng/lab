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
