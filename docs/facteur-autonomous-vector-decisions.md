# Facteur Autonomous Vector Strategy Decisions (2025-10-30)

## Context

Recent research into self-improving retrieval systems highlighted several architectural opportunities for Facteur’s autonomous roadmap:

- **Self-RAG** introduces reflection tokens so an agent can decide when to retrieve, critique its own answer, and feed the feedback loop back into the retriever.[^self-rag]
- **Self-Routing RAG** teaches an LLM to choose between parametric knowledge and external retrieval per request, reducing unnecessary vector queries while improving quality.[^self-routing]
- **Self-Supervised Faithfulness Optimisation (SSFO)** builds preference pairs from retrieved vs. non-retrieved answers, enabling faithful fine-tuning without manual labels.[^ssfo]
- **REFINE** combines multiple embedding models with synthetic data to boost recall on domain-specific corpora while guarding against regression when switching domains.[^refine]
- **Reflexion/“Self-Reflection” agents** persist episodic feedback in a vector store to improve future decision-making across iterative tasks.[^reflexion]
- **Swift-Hydra anomaly framework** demonstrates continuous synthetic anomaly generation plus vector storage to harden detectors for safety-critical systems.[^swift-hydra]
- **SuperRAG** shows how logging ranking decisions (kept vs. discarded documents) can improve future retrieval quality through reinforcement signals.[^superrag]

## Decisions

### D1 – Persist Agent Reflections in Vector Memory

- **What**: Store every planning/implementation reflection (critiques, rationale, failure notes) as embeddings tied to `task_runs`.
- **Why**: Enables Self-RAG-style retrieval of prior lessons before new work begins, increasing factuality and reusability of past fixes.[^self-rag][^reflexion]
- **Action**: Create the `reflections` table (vector column + metadata) and update implementation agents to append reflections after each run.

### D2 – Add Retrieval Router Feedback Loop

- **What**: Instrument the orchestrator to log when retrieval was skipped vs. invoked, then fine-tune a router to minimize redundant ANN calls.
- **Why**: Self-Routing RAG cuts cost/latency while preserving accuracy by training the model to choose the right knowledge source.[^self-routing]
- **Action**: Capture router decisions in `policy_checks` (key `retrieval.router`) and schedule monthly review retraining using accumulated telemetry.

### D3 – Continuous Faithfulness Tuning via SSFO

- **What**: Nightly job builds preference pairs (with/without retrieved context) from stored runs and applies SSFO/DPO fine-tuning to the response model.
- **Why**: Improves grounding without human labels, keeping automation trusted as content drifts.[^ssfo]
- **Action**: Persist generated pairs under `artifacts` (`type = 'ssfo_pair'`) and track completion in `run_events` for observability.

### D4 – Domain-Adaptive Embedding Refreshes

- **What**: Use REFINE to blend multiple embeddings and synthetic data when onboarding new domains (e.g., infra runbooks vs. product specs).
- **Why**: Boosts recall in cold-start domains while maintaining general performance.[^refine]
- **Action**: Version reflection embeddings via the `reflections.embedding_version` column and store REFINE configuration metadata in `metadata` JSON for reproducibility.

### D5 – Synthetic Incident Expansion for Observability

- **What**: Generate synthetic anomalies and embed them alongside real incidents to improve detectors, inspired by Swift-Hydra.
- **Why**: Keeps anomaly detection robust despite sparse real failures.[^swift-hydra]
- **Action**: New `policy_checks` entries (`anomaly.synthetic`) capture detector accuracy before/after retraining; schedule quarterly synthetic refreshes.

### D6 – Retrieval Feedback Logging

- **What**: Record which documents the re-ranker kept or dropped, and reuse that signal to improve future scoring similar to SuperRAG.
- **Why**: Creates a reinforcement signal for the vector store, improving relevance over time.[^superrag]
- **Action**: Add `artifacts` entries (`type = 'retrieval_decision_log'`) per task run and feed them into ranking fine-tunes during D3.

## Tracking

- Add a “Vector Strategy” section to the Facteur progress template summarizing adoption status of D1–D6.
- Report monthly on: reflection reuse rate, router skip ratio, faithfulness delta, embedding recall improvements, anomaly detector precision, retrieval relevance gains.

## References

[^self-rag]: [Self-RAG: Self-Reflective Retrieval-Augmented Generation](https://selfrag.github.io/)

[^self-routing]: [Self-Routing RAG](https://arxiv.org/abs/2504.01018)

[^ssfo]: [Self-Supervised Faithfulness Optimization](https://arxiv.org/abs/2508.17225)

[^refine]: [REFINE: Fused Embeddings for Retrieval](https://arxiv.org/abs/2410.12890)

[^reflexion]: [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)

[^swift-hydra]: [Swift-Hydra: Safe RL for Autonomous Driving](https://arxiv.org/abs/2503.06413)

[^superrag]: [Microsoft SuperRAG Technical Overview](https://techcommunity.microsoft.com/blog/azure-ai-services-blog/superrag-%E2%80%93-how-to-achieve-higher-accuracy-with-retrieval-augmented-generation/4139004)
