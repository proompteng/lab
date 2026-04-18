# Saigak Bumba Qwen Hard Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-migrate `saigak` and `bumba` from the old coder + 0.6B embedding setup to tuned `Qwen3-30B-A3B` completions and `Qwen3-Embedding-8B` embeddings, with no fallbacks or legacy models left behind.

**Architecture:** `saigak` becomes the single source of truth for two stable Ollama aliases: one tuned general Qwen completion model and one `8B` embedding model constrained to the existing `1024`-dimension Atlas schema. `bumba` keeps its existing Temporal workflow shape but gets a refactored model config/request boundary so completion tuning, embedding dimensions, and deployment pins are explicit and testable.

**Tech Stack:** Bun/TypeScript, Temporal, Ollama, KubeVirt, Argo CD, Kubernetes, Qwen 3, pgvector

---

### Task 1: Update Saigak Desired State

**Files:**
- Create: `services/saigak/config/models/qwen3-main-30b-a3b.modelfile`
- Create: `services/saigak/config/models/qwen3-embedding-8b.modelfile`
- Modify: `services/saigak/scripts/install.sh`
- Modify: `services/saigak/config/ollama.env`
- Modify: `argocd/applications/saigak/cloud-init-secret.yaml`

- [ ] Replace legacy model aliases with two stable aliases only.
- [ ] Tune Ollama context/loading settings for a 24 GB 3090 so `Qwen3-30B-A3B` is not artificially capped at `8K`.
- [ ] Ensure provisioning pulls `qwen3:30b-a3b` and `qwen3-embedding:8b`, creates the new aliases, and deletes the old aliases/tags.

### Task 2: Refactor Bumba Model Boundary

**Files:**
- Modify: `services/bumba/src/activities/index.ts`
- Modify: `services/bumba/src/activities/index.test.ts`
- Modify: `services/bumba/README.md`

- [ ] Split model-facing config logic into smaller helpers for completion defaults, completion request tuning, embedding defaults, and Ollama embedding request construction.
- [ ] Change self-hosted defaults to the new `saigak` aliases.
- [ ] For completions, stop forcing greedy decode and explicitly set Qwen-friendly non-thinking controls.
- [ ] For embeddings, pass `dimensions` through the Ollama `/api/embed` path so `Qwen3-Embedding-8B` can stay on the existing `1024`-dimension schema.

### Task 3: Hard-Cut Bumba Deployment

**Files:**
- Modify: `argocd/applications/bumba/deployment.yaml`

- [ ] Update deployment env to pin only the new completion and embedding aliases.
- [ ] Keep embedding dimension explicit at `1024` to preserve Atlas/Jangar schema compatibility.
- [ ] Remove all old model env values from desired state.

### Task 4: Roll Out and Verify

**Files:**
- Modify: `services/saigak/README.md`

- [ ] Apply the `saigak` desired-state changes and provision the new models on the live VM.
- [ ] Verify the new aliases directly with Ollama API calls.
- [ ] Roll `bumba`, run targeted tests, then run a forced enrichment smoke test.
- [ ] Delete old Ollama models from the live VM after cutover verification.
