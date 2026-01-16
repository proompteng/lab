# Deprecated: configuration-agents

This Crossplane configuration package has been retired in favor of the native Agents CRDs
installed by `charts/agents`. It is retained only for historical reference and should **not**
be installed in clusters that run native Agents CRDs.

Use `docs/agents/crossplane-migration.md` to migrate existing Crossplane claims to the native
CRDs, and remove `configuration-agents` from GitOps manifests.
