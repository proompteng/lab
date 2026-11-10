# Reconstruct CosmosAlpha acceptance inputs

The original task-local Python environment, provider directories and TOML files are not required to reconstruct a new functional acceptance. Use the pinned author source and original public data, record the resulting runtime, and freeze a separate experiment. This procedure does not recover the unavailable TOML bytes or relabel a previous trial.

## Source and environment

Use Python 3.12.9 and author commit `237f0a56895fd295542e202be8f62be48d6e9995`. Apply the five patches listed in [the frozen experiment](cosmosalpha-frozen-experiment.md#prepare-and-freeze), in that order, before installing the package. All 101 installed assets must reproduce inventory `651a11dfc78f75893051ae809e27979365e2bda11b1a294eb7027deb9d8524a9`; the runner verifies this before freeze and execution.

The [Linux dependency snapshot](evidence/2026-11-09-cosmosalpha-root-acceptance/requirements-linux.txt) records the resolved environment used for this acceptance, including NumPy 2.5.4, pandas 2.3.3, Qlib 0.9.7, LightGBM 4.7.0 and SciPy 1.18.1. Install those pins into an isolated environment, then install the repaired author package without changing dependencies:

```sh
uv venv --python 3.12.9 "$cosmos_venv"
uv pip install --python "$cosmos_venv/bin/python" \
  -r docs/bayn/evidence/2026-11-09-cosmosalpha-root-acceptance/requirements-linux.txt
uv pip install --python "$cosmos_venv/bin/python" --no-deps "$cosmos_author_root"
```

On the Nix-based agents-shell host, the standalone Python executable needs that host's existing glibc loader. The preparation changed only the task-owned executable's interpreter with checksum-verified patchelf 0.19.3.0 and supplied the existing GCC, zlib, zstd, bzip2 and OpenSSL library directories to the task process. No system library, shared Python installation or credential was modified. Record the Python executable, loader and native-library hashes with the runtime receipt. Other hosts should use their own supported Python 3.12 environment and retain a distinct platform identity.

Before preparing full data, import the Qlib LightGBM factory and portfolio risk analysis and run the 36 native source, prompt and candidate-binding regressions. The native contract check later also performs a synthetic LightGBM fit and prediction. Import success alone is not evidence of successful model fitting.

Verify the actual import before freezing a repaired source. Resolve `cosmosalpha.__file__` and `cosmosalpha.pipeline.mcts.controller.__file__`; both must belong to the selected repaired source root. The controller SHA-256 for this inventory is `0f8f9a3f8d370fc867c585ee740f703b93596de89044026318f14a76c27498c6`. Retain the resolved paths, byte hash, executable and Python version, then bind that receipt to the resulting experiment ID and plan hash. A new process with an explicit repaired-source `PYTHONPATH` can reuse the pinned dependency environment while preserving the old installed source for earlier experiments.

## Recover the original data

Download `data.zip` from [Zenodo record 23857833](https://zenodo.org/records/23857833/files/data.zip?download=1), as linked by the pinned author's README. Require all three recorded values before extraction:

| Check         | Expected value                                                     |
| ------------- | ------------------------------------------------------------------ |
| Bytes         | 536128200                                                          |
| Publisher MD5 | `2453b7658b82a7ac208c4a739350c437`                                 |
| SHA-256       | `fbe16e9e555562a6d9d4943628aa1dcddd87afcb0be545d7891b08f9cb8882c7` |

Reject absolute archive paths and parent-directory traversal. Check every member's CRC before extraction. The verified archive has 120,263 members under `qlib_bin`, `qlib_exposure_bin` and `qlib_mask_bin`. Preserve their bytes and metadata; sparse fields and unknown industries retain their original values. The [input-source contract](cosmosalpha-input-sources-2026-11-07.md) explains their scientific limits and attribution.

Store the raw bundle, providers, requests and experiment outputs in a retained research directory outside disposable managed worktrees. Keep the source checkout and installed environment owned by the executing session. Do not inspect another subject's managed worktree to recover old inputs.

## Rebuild the two TOML inputs

Start from the pinned author's `configs/graph_experiment.toml` and `configs/lightgbm_integration.example.toml`. Their SHA-256 values are:

| Author input | SHA-256                                                            |
| ------------ | ------------------------------------------------------------------ |
| Graph        | `ca130f4c8f87c5a32cf7df1580dbb6872955f0e7fc0d67f9887cd72bb66a65d2` |
| LightGBM     | `129c7f9283edb51d902349f486925146d0ffbe5dcf5e7f79b393b2a5821da4ba` |

Run this from the lab repository with `cosmos_author_root`, `cosmos_data_root` and a fresh `cosmos_input_root` set to the selected directories:

```sh
python3 - "$cosmos_author_root" "$cosmos_data_root" "$cosmos_input_root" <<'PY'
import hashlib
from pathlib import Path
import sys
import tomllib

sys.path.insert(0, "packages/scripts/src/bayn")
from cosmosalpha_experiment import write_toml

author, data, output = (Path(p).resolve() for p in sys.argv[1:])
expected = {
    "graph_experiment.toml":
        "ca130f4c8f87c5a32cf7df1580dbb6872955f0e7fc0d67f9887cd72bb66a65d2",
    "lightgbm_integration.example.toml":
        "129c7f9283edb51d902349f486925146d0ffbe5dcf5e7f79b393b2a5821da4ba",
}
configs = []
for name, sha256 in expected.items():
    content = (author / "configs" / name).read_bytes()
    if hashlib.sha256(content).hexdigest() != sha256:
        raise ValueError("Unexpected author configuration: " + name)
    config = tomllib.loads(content.decode())
    for role, directory in (
        ("market", "qlib_bin"),
        ("exposure", "qlib_exposure_bin"),
        ("mask", "qlib_mask_bin"),
    ):
        provider = data / directory
        if not provider.is_dir():
            raise ValueError("Missing provider: " + str(provider))
        config["qlib"][role]["provider_uri"] = str(provider)
    configs.append(config)
configs[0]["llm"]["timeout_seconds"] = 300
configs[0]["llm"]["max_output_tokens"] = 20000
output.mkdir()
write_toml(output / "native-graph.toml", configs[0])
write_toml(output / "native-lightgbm.toml", configs[1])
PY
```

These are the complete input changes from the author examples: the three provider locations in both files, Graph transport timeout from 60 to 300 seconds, and Graph's global output cap from 12,000 to 20,000 tokens. The latter preserves the documented self-hosted ceiling; individual stages retain their lower native limits. The longer transport timeout changes request waiting, not the request or completion-token allowances.

Freeze then applies its existing, independently audited transformations: self-hosted route and sampling profile, four workers, fixed seeds, Graph/MCTS/no-Flow settings, shared budgets, storage locations and complete-pool LightGBM bindings. It does not change the chronological segments, feature/evaluator formulas, minimum cross-section, coverage gates or zero-cost native portfolio assumptions. Record both the author-file hashes and generated-file hashes.

## Generate, freeze and admit

Create the request from [calendar-target generation](cosmosalpha-calendar-targets.md#reproduce) using the recovered market and mask providers. Regenerate targets in a fresh directory and require target identity `685c34e9aaa5f2c9d0d6d2ef380039ace15abd4b47235152102c23da6263e07e` and CSV SHA-256 `806a92ffe7ce0bee3917883ba0b70b1fd93378708b719fe625b91f936de5bda1`.

Use an experiment request with `kind = "acceptance"` and the reconstructed TOMLs. Follow the [freeze, native-check, run and audit commands](cosmosalpha-frozen-experiment.md). Freeze independently recomputes all 1,165,440 targets and verifies the original close/mask rows consumed by both native snapshots. A saved PASS from another experiment cannot substitute for this admission.

The acceptance retains the existing per-arm allowances: four evaluable factors, 16 requested proposal slots, 80 physical requests, 800,000 completion tokens and at most 20,000 output tokens per request. Its three arms share seed 20260823. Confirm no other execution owns the selected output directory before starting. Keep failed and unfinished requests, unknown usage and exhausted allowances; do not resume or top up a failed acceptance.

When the shell transport has a shorter command timeout than the experiment, use one process supervisor with a fixed outer deadline and immutable owner, process and terminal receipts. The reconstructed acceptance uses a 5,400-second wall ceiling, followed by a 30-second termination grace period. The supervisor survives a transport call ending, but does not resume after a host restart. Reconnect to the acknowledged process; never relaunch to obtain a status update. Preserve exact copies of the four runner files listed in the plan before changing source registration for a subsequent experiment.

After all three pools and fits finish, run both `verify_cosmosalpha_downstream.py` and `check_cosmosalpha_downstream.py` against the retained outputs. Report source/target admission, actual requests, pool completion, model completion and independent numerical verification separately. A successful functional acceptance does not authorize or establish completion of a scientific matrix. It does not establish industry point-in-time validity or a costed trading edge.
