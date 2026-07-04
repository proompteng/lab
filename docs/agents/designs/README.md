# Agents Design Archive

Status: Historical design and handoff archive.

This directory contains dated design proposals, accepted handoffs, and architecture notes for the Agents/Jangar control
plane. These files are valuable for rationale, but they are not automatically current implementation authority.

For current behavior, start with:

- `docs/agents/README.md`
- `services/jangar/README.md`
- `charts/agents/**`
- `argocd/applications/agents/**`
- current CRDs and controller code under `services/jangar/**`
- live Argo/Kubernetes/CI readback

Design files in this directory should be read as snapshots unless the file explicitly states that it is current and
points to live desired state plus validation evidence. When a design conflicts with code, GitOps, or runtime status,
code/GitOps/runtime status wins.

Use `docs/documentation-authority.md` as the repository-wide authority model.
