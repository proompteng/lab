# Rune native decisions

Rune serves typed `choice`, `score`, and `noul` decisions at
`http://rune.rune.svc.cluster.local:8080/v1/decisions`. It uses the native Surogate engine on Turin's
RTX PRO 6000 Blackwell. There is one physical GPU; its Kubernetes time slices do not provide
separate memory allocations. Plex remains on that card.

## Reproducible inputs

| Input                  | Identity                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine                 | [invergent-ai/surogate at 4888528abcfdcd36e2f4a6a1ffa0262b67683c66](https://github.com/invergent-ai/surogate/tree/4888528abcfdcd36e2f4a6a1ffa0262b67683c66)               |
| Engine archive SHA-256 | `8c37dfa3b1695fcd60ca9374a8e17bf3a2c224220db2401867f9829442be33fa`                                                                                                        |
| Checkpoint             | [Surogate/rune-26b-a4b-GGUF at c6b360d47895bb77bdf3805a13ee5a5557ab1921](https://huggingface.co/Surogate/rune-26b-a4b-GGUF/tree/c6b360d47895bb77bdf3805a13ee5a5557ab1921) |
| Served model ID        | `rune-v3-c6b360d47895`                                                                                                                                                    |
| Device compilation     | CUDA 13.0.2, SM 120a                                                                                                                                                      |
| Decision temperature   | `2`, the publisher's text recommendation                                                                                                                                  |

Despite its repository name, this checkpoint contains Rune v3 BF16 safetensors. The pinned engine
prepares its native `groupwise-int` artifact, including W8 matrices. BF16 source weights and BF16 KV
cache do not imply every runtime matrix remains BF16. Record the native conversion receipt and
evaluate the deployed answers before accepting Bayn's model migration.

`model-source.json` selects the repository, immutable revision, served ID, and filenames.
`lock_model.py` generates `model-lock.json` from that exact revision. The runtime downloads only
those public files without credentials and checks their byte counts and SHA-256 digests before
starting the engine. An incomplete download never becomes a cache entry. A corrupt cached file
blocks startup and remains available for diagnosis.

Regenerate the manifests and dependency lock from the repository root:

```sh
python3 services/rune/lock_model.py
uv pip compile services/rune/requirements.in --python-version 3.12 --universal \
  --index-url https://pypi.org/simple --emit-index-url --generate-hashes --no-cache \
  -o services/rune/requirements.txt
```

Python's CPU Torch wheel performs checkpoint preparation. The compiled CUDA engine performs
inference. The image does not install Surogate's training stack or rely on a released wheel with
different engine code.
The two Linux Torch wheels use explicit publisher URLs. All other Python packages come from
PyPI, so the installer cannot substitute a different index's same-version wheel.
The build and runtime share that locked Python environment. Upstream's CMake configuration
requires Torch and ICU for its speech targets even when only the decision server is compiled.

`patches/cpu-expert-architecture.patch` limits upstream's x86 AVX compiler flags to x86 hosts and
guards four Q4/Q5 dispatch calls whose VNNI implementations exist only on x86. Arm64 uses the
existing scalar arithmetic. The image checks generic host compilation before the CUDA build and
runs upstream's CPU expert numerical tests on both architectures. The patch changes architecture
selection; it does not change expert arithmetic or GPU kernels.

`patches/decisions-fp-contract.patch` disables fused multiply-add contraction in the host
decision-protocol source and the independent arithmetic reference in its temperature test.
Their score accumulation must preserve the separate multiplication and
addition rounding used by the independent Python reference. ARM64 otherwise differs by one bit
on two golden scores. The existing exact protocol assertions and golden answers remain unchanged;
GPU kernel compilation is unaffected.

The build pins NCCL development headers to `2.28.3-1+cuda13.0`, matching the base image's runtime.
It also pins the upstream build's otherwise floating Minja dependency to
`143465ab2f924f7729a8ca5313a12fb83a106d6d` and verifies its archive SHA-256 before applying
Surogate's own template-parser patches.

## Runtime and API

The process verifies its model files, prepares the pinned engine's artifact on CPU, and replaces
itself with `surogate-engine`. Model data and prepared artifacts are stored on a retained 128 GiB
volume using Turin's existing `local-path-turin-nvme-intel` class. The default local-path class can
also select the disk used by CI scratch volumes. The pinned source and native tensor layouts total
about 75 GiB before artifact headers and frontend resources. The 128 GiB claim and existing 100 GiB
ledger claim fit the Intel disk's measured 237 GiB filesystem. Local-path does not enforce quotas;
check free space before retaining another model or engine revision.
The Deployment uses `Recreate` so two processes do not write that
volume or compete for model memory during rollout. The native memory limit is 85,000 MiB.

The initial configuration has a 32,768-token context ceiling and total KV capacity, eight active
sequences, eight pending requests, and a five-second pending timeout. The native server performs
one attempt. A non-finite result returns an error immediately. Bayn must retain its own complete
HTTP request deadline; the server's pending timeout does not bound active GPU execution.

Clients send the exact served model ID, verified state, typed questions, and `thinking: false`.
A `noul` question must include both `true` and `false` criteria. Clients validate the full native
response, including model/provider identity, question vocabulary, finite normalized probabilities,
derived scores/confidence, and usage. The endpoint's `usage.cost: 0` describes API billing, not
the GPU's operating cost. No hosted provider or alternate endpoint is a fallback.

The Service is internal. NetworkPolicy admits requests from Bayn and Rune pods. It has no public
Ingress or Tailscale endpoint. The pod has no mounted Kubernetes service-account token. Model
downloads use public HTTPS; inference does not call TypeSafe.

## Validation and delivery

```sh
cd services/rune
python3 -m unittest -v test_runtime.py
ruff check .
ruff format --check .
docker build --target test -t rune-proof .
```

The image build compiles the pinned engine and runs its model-free decisions, decisions-v1 golden,
thinking-contract and CPU expert numerical tests. A CUDA driver stub is used only for loading
those CPU tests during the build. It is not installed as a runtime driver. The final image also tests model-cache failure
handling and imports the actual checkpoint converters. These checks do not prove GPU inference.

The `Rune images` workflow first exports the compiled native targets to the build cache, then
runs all native and runtime tests on amd64 and arm64. A test failure retains the compilation cache
but still blocks the tested image and every release step. Proof and release artifacts include the workflow
run and attempt, so failed-job retries retain earlier evidence without colliding with immutable artifacts.
Image tags and Kargo discovery remain bound to the source revision and workflow run. On `main`, the workflow publishes and signs the
immutable index, uploads validation receipts, then exposes the run-qualified Kargo discovery tag.
Platform uploads use the runner's existing `regctl`, with one request at a time and 4 MiB chunks.
The registry serializes blob writes and limits each upload to 1 MiB/s; concurrent whole-layer
uploads can leave another architecture's upload initiation waiting beyond its client deadline.
Bounded chunks release the writer between requests. The job uses a temporary client configuration,
preserves verified TLS and existing Docker credentials, and checks the published platform's config
digest against the tested local image before proceeding. Shared registry limits remain unchanged.
The `rune` Warehouse and Stage promote that digest to `kargo/rune`. Argo consumes only that branch.
The `unpromoted` image in the source manifests cannot serve requests before the first promotion.
Follow [release automation](../../docs/release-automation.md); do not deploy a locally built image.

First installation downloads about 52 GB and prepares the native artifact. Startup allows three
hours and Kargo waits up to four hours for that initial rollout. Existing Bayn request deadlines
remain unchanged. Root ApplicationSet enrollment follows the repository's approval rule when the
root Argo Application is manual.

After promotion, prove the exact image and model revision, successful native choice/score/noul
requests, cold and warm latency, concurrent requests, cancellation, malformed requests, and loss
of service. Keep Bayn's active provider unchanged until those gates pass and its complete native
integration is delivered. Restore a proven Rune Freight through Kargo if a later release fails.
Retain the model PVC during rollback and keep Bayn fail-closed when Rune is unavailable.

Deployment, Bayn integration, probability calibration on retained trading outcomes, and profitable
prospective trading are separate acceptance results. The publisher's temperature and general
benchmarks are not Bayn calibration or evidence of trading edge.
