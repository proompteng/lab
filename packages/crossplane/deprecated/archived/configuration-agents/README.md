# Archived: configuration-agents (Crossplane)

This Crossplane configuration package has been retired in favor of the native Agents CRDs
installed by `charts/agents`. It is retained only for historical reference and should **not**
be installed in clusters that run native Agents CRDs. The CRDs in this package conflict with
`agents.proompteng.ai` native CRDs and will prevent the chart from installing cleanly.

Use `docs/agents/crossplane-migration.md` to migrate existing Crossplane claims to the native
CRDs, and remove `configuration-agents` from GitOps manifests.
