# Nix OCI build runner storage

[The reusable workflow](../../.github/workflows/nix-oci-build-common.yml) has one boolean input, `tmpfs`, defaulting
to `false`. It selects `arc-{amd64,arm64}-tmpfs` for both archive jobs when true; otherwise they use the 64 GiB
Ceph RBD scratch on `arc-{amd64,arm64}`. Index publication stays on `arc-amd64`. There is no size or large-runner input.

Standard tmpfs has 16 GiB of scratch, including a seed budget of 4 GiB, and its pages count against the runner's
18 GiB memory limit. The matrix covers all 34 calls in 24 workflows. Sizes below are the larger of the AMD64 and
ARM64 samples from the linked runs: unpacked Nix substitutions, Attic NAR sizes for dependency/runtime outputs, or
compressed registry layers. They are not peak scratch or memory measurements.

## New standard tmpfs opt-ins

| Workflow                                   | Jobs or image               | Sizing evidence                                                                                                                                                                    |
| ------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bumba-ci.yml`                             | Bumba                       | Scoped Bun dependencies (303 MiB) and [314 MiB runtime tree](https://github.com/proompteng/lab/actions/runs/45102716936).                                                          |
| `froussard-ci.yml`                         | Froussard                   | Scoped Bun dependencies (277 MiB) and [280 MiB runtime tree](https://github.com/proompteng/lab/actions/runs/46078110457).                                                          |
| `headlamp-ci.yml`                          | PR and publication archives | [1.06 GiB substituted](https://github.com/proompteng/lab/actions/runs/44689119539), 584 MiB npm cache, 67 MiB Go vendor tree. Browser downloads disabled and frontend heap capped. |
| `hermes-toolchain-build-push.yml`          | Hermes toolchain            | Prebuilt CLI tools and one Python wheel; [209 MiB Nix archive](https://github.com/proompteng/lab/actions/runs/43977388464).                                                        |
| `oirat-ci.yml`                             | Oirat                       | Scoped Bun dependencies (116 MiB) and [118 MiB runtime tree](https://github.com/proompteng/lab/actions/runs/45102717052).                                                          |
| `product-nix-images.yml`                   | Docs                        | [886 MiB Bun cache, 69 MiB standalone runtime](https://github.com/proompteng/lab/actions/runs/44933406093).                                                                        |
| `product-nix-images.yml`                   | Synthesis                   | [611 MiB Bun cache, 616 MiB runtime tree](https://github.com/proompteng/lab/actions/runs/46091607630).                                                                             |
| `sag-build-push.yaml`                      | Sag                         | [561 MiB Bun cache, 569 MiB runtime tree](https://github.com/proompteng/lab/actions/runs/45912210810). Codex CLI is prebuilt.                                                      |
| `symphony-build-push.yaml`                 | Symphony                    | [307 MiB Bun cache, 256 MiB runtime tree](https://github.com/proompteng/lab/actions/runs/45912210845). Tools, including Codex CLI, are prebuilt.                                   |
| `torghut-build-push.yaml`                  | Torghut                     | [301 MiB venv](https://github.com/proompteng/lab/actions/runs/45131869626) from a fresh uv install. The CUDA extra is not selected.                                                |
| `torghut-hyperliquid-feed-build-push.yaml` | Hyperliquid feed            | [1.89 GiB substituted, 39 MiB runtime tree](https://github.com/proompteng/lab/actions/runs/41616078226). Same scoped Dorvud Gradle builder as Torghut WS.                          |
| `torghut-notebook-build-push.yaml`         | Torghut Notebook            | [407 MiB venv](https://github.com/proompteng/lab/actions/runs/46089370869). Only the CPU `notebook-runtime` group, not Torch/CUDA.                                                 |
| `torghut-ta-build-push.yaml`               | Flink technical analysis    | [Up to 2.63 GiB substituted in a build attempt](https://github.com/proompteng/lab/actions/runs/46077220873), with pinned Flink base, 160 MiB app layer, and 1 GiB Gradle heap.     |
| `torghut-webull-feed-build-push.yaml`      | Webull feed                 | Same scoped Dorvud Gradle builder as Hyperliquid and Torghut WS; [191 MiB compressed](https://github.com/proompteng/lab/actions/runs/43653777036).                                 |

## Keep on Ceph RBD

| Workflow                    | Jobs or image              | Reason                                                                                                                                                                           |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arc-runner-build-push.yml` | ARC runner                 | [1.47 GiB compressed](https://github.com/proompteng/lab/actions/runs/46094264681). Repacks a runner and its CI tools; keep building the tmpfs seed independent of tmpfs.         |
| `attic-build-push.yaml`     | Validation and publication | [2.65 GiB substituted](https://github.com/proompteng/lab/actions/runs/44886688127) before compiling and testing the patched Rust server.                                         |
| `jangar-build-push.yaml`    | Jangar                     | [2.06 GiB compressed](https://github.com/proompteng/lab/actions/runs/46080974530). Native Node addon, large Nitro build, IDE, JDK, and other tools.                              |
| `ofz.yaml`                  | Ofz                        | [97 MiB compressed](https://github.com/proompteng/lab/actions/runs/45912210881) excludes the Cargo compile/test tree and native TLS build.                                       |
| `opencode-ci.yml`           | OpenCode PR image          | [1.96 GiB compressed](https://github.com/proompteng/lab/actions/runs/46092873500). Compiler and Rust toolchains plus the Relay Rust build on cache misses.                       |
| `product-nix-images.yml`    | App                        | [1.23 GiB Bun archive, 1.28 GiB runtime tree](https://github.com/proompteng/lab/actions/runs/45125794245). The build restores the archive and copies the installed dependencies. |
| `product-nix-images.yml`    | Proompteng                 | [1.33 GiB Bun cache](https://github.com/proompteng/lab/actions/runs/45912211013) copied before the Next/Webpack build.                                                           |
| `relay.yml`                 | Relay                      | [34 MiB compressed](https://github.com/proompteng/lab/actions/runs/46088129587), but compiles and tests Rust with native TLS dependencies on cache misses.                       |

Restate is not a caller: its Rust builds and fault tests use BuildKit on the Ceph-backed labels directly. Before moving
a deferred build, measure cold-job scratch and memory peaks on both architectures, including compiler and package
caches, duplicate trees, and archive publication. If an opted-in job runs out of scratch or memory, remove
`tmpfs: true` from that caller to return it to Ceph RBD.

## Existing opt-ins (unchanged)

- `agents-build-push.yml`: controller, control plane, shell, and Codex runner. Push and dispatch default to tmpfs;
  dispatch can still select Ceph RBD.
- `bayn-build-push.yml`: Bayn, research, and broker-feed cohort.
- `opencode-build-push.yml`: release build; the PR image remains on Ceph RBD.
- `signal-publisher-build-push.yml`: signal publisher.
- `torghut-ws-build-push.yaml`: Torghut WS.
