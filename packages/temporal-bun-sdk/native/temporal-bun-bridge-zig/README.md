## temporal-bun-bridge-zig

This project houses the Zig implementation of the Temporal Bun native bridge. The build now links the vendored
Temporal Rust static archives (`temporal-sdk-core`, client, API, and protos), so the resulting shared library can run
the Temporal runtime without depending on the Rust bridge at load time.

### Prerequisites
- Zig 0.15.x or newer on your `PATH` (`zig version` should succeed).
- Rust toolchain (`cargo`, `rustup`) plus the targets we ship: `aarch64-apple-darwin`, `x86_64-apple-darwin`,
  `aarch64-unknown-linux-gnu`, and `x86_64-unknown-linux-gnu`. Install them with:
  ```bash
  rustup target add aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu
  ```
- Protobuf headers available on the host (Homebrew `protobuf` or `apt install libprotobuf-dev`) so `cbindgen` can build
  the Temporal C headers during vendoring.

The helper script `packages/temporal-bun-sdk/scripts/run-with-rust-toolchain.ts` verifies most of these requirements
and can bootstrap the Rust toolchain automatically in CI.

### Building the Zig bridge
- Single target builds (debug or release) re-use Zig’s build graph:
  ```bash
  bun run packages/temporal-bun-sdk/scripts/run-with-rust-toolchain.ts -- \
    zig build -Doptimize=Debug --build-file packages/temporal-bun-sdk/native/temporal-bun-bridge-zig/build.zig
  bun run packages/temporal-bun-sdk/scripts/run-with-rust-toolchain.ts -- \
    zig build -Doptimize=ReleaseFast --build-file packages/temporal-bun-sdk/native/temporal-bun-bridge-zig/build.zig
  ```
  The install step stages artifacts in `zig-out/lib/<platform>/<arch>/libtemporal_bun_bridge_zig.<dylib|so>` (the path
  derives from the resolved Zig target). Override the relative install destination with `-Dinstall-subpath=<dir/file>`
  when you need a custom layout.
- Multi-target bundling drives the cross-compiles used by the published package:
  ```bash
  TEMPORAL_BUN_SDK_USE_ZIG=1 pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig:bundle
  pnpm --filter @proompteng/temporal-bun-sdk run package:native:zig
  ```
  The bundle script iterates through the supported Zig triples, ensures the right Rust archives are built via `cargo
  rustc`, and leaves the staged `.dylib`/`.so` files inside `dist/native/<platform>/<arch>/`.

### Troubleshooting
- `cargo rustc` fails with “target not found”: run the `rustup target add` command above.
- Missing protobuf headers on macOS: `brew install protobuf` (the toolchain script scans Homebrew prefixes).
- Linux release builds failing to link `libunwind`: install `libunwind-dev` (Ubuntu/Debian) or ensure `libunwind` is
  present in the container image.
