# Bayn Dev-Split GPU/TPU Research Harness (Colab AI Ultra + Galactic Blackwell)

Run vectorized Purged CPCV and multi-cost sweeps on Google Colab AI Ultra GPUs/TPUs or Galactic's local 8x RTX PRO 6000 Blackwell GPUs (`turin`) without ever exporting Bayn's sealed holdout (`2024-01-02` onward) or committing `.ipynb` notebooks / multi-MB dumps.

## Safety Contract

- **Dev-split boundary:** `export-dev-cube.ts` hard-enforces `date <= 2023-12-29` (`splits.validation.last`) and fails closed with a typed `DevCubeExportError` before creating or writing `--out-dir` if any row or `--dev-cutoff` enters the sealed holdout (`>= 2024-01-02`).
- **Digest verification:** `sweep_cpcv_gpu.py` verifies `MANIFEST.json` (`schemaVersion == "bayn.colab-dev-cube.v1"`), every cube file's SHA-256 digest and byte size, and every row's date before running any trials.
- **Immutable artifacts:** Never modify `freeze.json` or frozen manifests. Never commit `.ipynb` files, cube tarballs, or credentials; commit only the compact `<50 KB` `experiment_receipt.json` (or compile its winning parameters directly into TypeScript).

## 1. Export Dev-Split Cube on Galactic

Export strictly `2016-01-04` through `2023-12-29` from Bayn's content-addressed Rook-Ceph archive (or a local mirror):

```sh
# From Rook-Ceph agents-artifacts (requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in env)
bun services/bayn/tools/export-dev-cube.ts \
  --out-dir /tmp/bayn-dev-cube \
  --dev-cutoff 2023-12-29 \
  --format jsonl.gz

# Optional: include 5-minute RTH dev-split bars (blind 2016-2023 archive only)
bun services/bayn/tools/export-dev-cube.ts \
  --out-dir /tmp/bayn-dev-cube \
  --format jsonl.gz \
  --include-intraday

# Offline / local content-addressed mirror mode
bun services/bayn/tools/export-dev-cube.ts \
  --out-dir /tmp/bayn-dev-cube \
  --mirror-dir /var/cache/bayn-research-mirror
```

This writes gzipped cube files plus a deterministic `/tmp/bayn-dev-cube/MANIFEST.json`.

## 2. Run Vectorized Purged CPCV Sweep (Colab AI Ultra or Local Blackwell)

### Option A: Google Colab AI Ultra (`google-colab-cli` / `colab-mcp`)

Upload only `/tmp/bayn-dev-cube` and `services/bayn/colab/sweep_cpcv_gpu.py` to an A100/H100/L4/TPU runtime and download only the compact `<50 KB` `experiment_receipt.json`:

```sh
# Upload dev-split cube and script to Colab runtime via google-colab-cli (or colab-mcp upload)
google-colab-cli upload /tmp/bayn-dev-cube /content/bayn-dev-cube
google-colab-cli upload services/bayn/colab/sweep_cpcv_gpu.py /content/sweep_cpcv_gpu.py

# Execute GPU-accelerated Purged CPCV sweep (auto-detects CUDA / XLA TPU)
google-colab-cli exec -- \
  python3 /content/sweep_cpcv_gpu.py \
    --cube-dir /content/bayn-dev-cube \
    --out /content/experiment_receipt.json \
    --device auto \
    --groups 6 \
    --test-groups 2 \
    --purge 20 \
    --embargo 5 \
    --top-n 5

# Fetch only the <50 KB auditable receipt back to Galactic
google-colab-cli download /content/experiment_receipt.json /tmp/experiment_receipt.json
```

### Option B: Local Galactic Blackwell GPU (`turin`, 8x RTX PRO 6000)

```sh
CUDA_VISIBLE_DEVICES=0 python3 services/bayn/colab/sweep_cpcv_gpu.py \
  --cube-dir /tmp/bayn-dev-cube \
  --out /tmp/experiment_receipt.json \
  --device cuda \
  --groups 6 \
  --test-groups 2 \
  --purge 20 \
  --embargo 5 \
  --top-n 5
```

For deterministic CPU reproduction (e.g. CI or verification without CUDA), pass `--device cpu`.

## 3. Compile Winning Plateau Candidate into Bayn Strategy TypeScript

Inspect `/tmp/experiment_receipt.json` and confirm:

- `schemaVersion == "bayn.colab-cpcv-receipt.v1"` and `devCutoff == "2023-12-29"`,
- top candidate passes plateau robustness (`plateau.medianNeighborSharpe`), DSR haircut (`dsr.dsr5bp`, `dsr.dsr10bp`), cost-surface resilience across `[2, 5, 10, 15]` bp, and decorrelation / marginal Sharpe lift against `B0`/`F4`/`O1`.

Encode the selected `topCandidates[0].parameters` (`lookbackDays`, `volWindowDays`, `entryZScore`, `rebalanceCadenceDays`, `topK`, `targetVol`, `longOnly`) as pure, immutable TypeScript rules under `services/bayn/src/strategy/<sleeve>/policy.ts` (never load JSON strategy files at runtime) with colocated unit tests, then commit the Bayn source changes before running the holdout gate.

## 4. Single-Shot Sealed-Holdout Verification on Galactic

Run the two-step `--develop` -> `--score <receipt>` protocol on Galactic so the sealed holdout (`2024-01-02` to `2026-11-25`) is opened **once** against the committed, content-addressed development receipt:

```sh
# Step 1: Lock the committed candidate on dev split only and print its 64-hex development receipt
bun services/bayn/tools/research-noise-area-v4.ts --develop

# Step 2: Single-shot sealed-holdout scoring against the exact development receipt
bun services/bayn/tools/research-noise-area-v4.ts --score <64-hex-development-receipt>
```

Remove `/tmp/bayn-dev-cube` and `/tmp/experiment_receipt.json` once the research run is archived.
