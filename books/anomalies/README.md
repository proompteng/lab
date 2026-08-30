# Anomalies — Deno Kernel Notebook

This folder hosts a TypeScript-first anomaly detection walkthrough designed to run in
JupyterLab using the [Deno Jupyter kernel](https://docs.deno.com/runtime/manual/tools/jupyter).

## Contents

- `anomalies.ipynb` — self-contained notebook that fabricates QBO-style journal entries, engineers 16 features, and trains an Isolation Forest to flag suspect activity.
- `illustration.svg` — data-flow schematic for documentation or presentations.
- `scenarios.md` — breakdown of the four synthetic anomaly modes seeded in the notebook plus downstream playbooks.

## Prerequisites

1. Install Deno **v1.45.4** or newer.
2. Install the kernel once per machine:

   ```bash
   deno jupyter --unstable --install
   ```

3. Launch JupyterLab pointing at this workspace:

   ```bash
   jupyter lab
   ```

4. From the notebook launcher, pick the **Deno** kernel (language: TypeScript).

The notebook loads Observable Plot and D3 from jsDelivr/CDN (`https://cdn.jsdelivr.net/...`), so no npm install is required. Ensure
network access is available on the first execution so Deno can cache the modules.

## Notebook highlights

- Defines QBO journal, line, and account scaffolding directly in TypeScript.
- Synthesizes realistic ledger entries with doc number sequences, classes, locations, entities, and multi-currency scenarios.
- Engineers a 16-dimensional feature vector that mixes sequence auditing, balance integrity, participation ratios, memo heuristics, and FX flags.
- Trains a custom Isolation Forest (150 trees, sample size 220, seed `90210`), projects features onto a 2D PCA plane, and visualizes anomalies with an interactive D3 scatter plus an HTML summary table.
- Captures a precision@25 snapshot so you can gauge how the seeded anomalies rank before dialing in a production threshold (default `qboThreshold = 0.62`).

## Engineered feature catalog

The synthetic generator produces one row per journal entry with these 16 TypeScript-enforced features:

- `doc_number_length` — characters in the journal number for catching format drift.
- `doc_sequence_gap` — observed minus expected suffix; duplicates dip negative, skipped numbers spike positive.
- `day_of_month` and `month_index` — calendar placement for seasonality analysis.
- `is_month_end` — binary flag for entries dated on or after day 28.
- `line_count` — total number of lines (tax add-ons included).
- `unique_accounts` — count of distinct account names referenced.
- `total_debit` — USD-normalized debit total (exchange rate applied for CAD/EUR/GBP).
- `imbalance` — absolute debit-credit delta to surface unbalanced postings.
- `avg_line_amount` and `std_line_amount` — magnitude and dispersion across journal lines.
- `ar_line_ratio` and `ap_line_ratio` — share of lines tied to AR/AP ledgers.
- `class_coverage` — percentage of lines retaining a `classRef`.
- `memo_length` — characters in the memo string.
- `foreign_currency_flag` — `1` when the journal is booked outside USD.

## Synthetic anomaly modes

`generateQboJournalEntries` injects four repeatable red-flag scenarios while keeping the remainder of the population clean:

1. **Doc number reuse** — replays the previous sequence number so `doc_sequence_gap = -1` even though the rest of the entry looks normal.
2. **Sequence jump** — skips three numbers (`doc_sequence_gap = +3`) to mimic back-dated inserts or missing paperwork.
3. **FX imbalance** — forces a non-USD currency and suppresses the credit leg, driving `imbalance` and `foreign_currency_flag` upward together.
4. **Manual reclass spike** — tags the entry as an adjustment, stretches memo length, and bolts on a large `Deferred Revenue` credit line, increasing line count, variance, and imbalance.

Tune these levers via `createQboFeatureDataset({ entries, anomalyRatio, foreignCurrencyShare, seed, ... })` when replaying real journal exports so your Isolation Forest sees a familiar mix of edge cases.

## Extending the prototype

- Replace the synthetic generator with actual QBO exports (JournalEntry JSON/CSV) and reuse the feature pipeline.
- Tune Isolation Forest hyperparameters (`nTrees`, `sampleSize`, `heightLimit`) to hit your finance team’s precision/recall targets.
- Export the anomaly table to CSV for monthly close reviews or feed scores into downstream alerting.
- Add per-feature attribution (e.g., SHAP) or enrichment (e.g., amount buckets, department tags) to support investigations.

## Verification checklist

- Launch the notebook with the Deno kernel and run each cell sequentially.
- Confirm the generated ledger produces balanced entries except for intentionally injected anomalies.
- Verify the D3 scatter highlights seeded anomalies and large scores with heavier outlines.
- Inspect precision@k metrics and adjust thresholds before rolling into production workflows.
