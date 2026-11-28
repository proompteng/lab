{
  pkgs,
  lib,
  repoRoot,
  bun,
  nodejs,
  repoRevision ? "dirty",
}:

import ./bun-workspace-service.nix {
  inherit pkgs lib repoRoot bun nodejs;
  serviceName = "proompteng";
  packageName = "landing";
  depsHash = {
    x86_64-linux = "sha256-zB/iet9jU36jNtCE62fIHA9WPS2s80Sr8MsvVpg/a28=";
    aarch64-linux = "sha256-aUwfaid4OYVNUeKlByheymxyZ37oSKgCbAk1hDQcI84=";
  };
  dependencyClosure = "bunCache";
  installFilters = [
    "@proompteng/source"
    "@proompteng/backend"
    "@proompteng/design"
    "landing"
  ];
  sourcePaths = [
    "apps/landing"
    "packages/backend"
    "packages/design"
    "services/tengri/proto"
    "services/tengri/migrations"
    "services/tengri/fixtures"
  ];
  buildCommands = [
    "bun --cwd=apps/landing run prebuild"
    "(cd apps/landing && node node_modules/next/dist/bin/next build --webpack)"
  ];
  runtimeInstallPhase = ''
    cp -R "$TMPDIR/work/apps/landing/.next/standalone/." "$out/app/"
    mkdir -p "$out/app/apps/landing/.next/static" "$out/app/apps/landing/public"
    cp -R "$TMPDIR/work/apps/landing/.next/static/." "$out/app/apps/landing/.next/static/"
    if [ -d "$TMPDIR/work/apps/landing/public" ]; then
      cp -R "$TMPDIR/work/apps/landing/public/." "$out/app/apps/landing/public/"
    fi
    # Node resolves the standalone server inside the immutable Nix store. Point its cache at the writable volume.
    rm -rf "$out/app/apps/landing/.next/cache"
    ln -s /var/cache/proompteng "$out/app/apps/landing/.next/cache"
    mkdir -p "$out/app/services/tengri/proto"
    cp -R "$TMPDIR/work/services/tengri/proto/." "$out/app/services/tengri/proto/"
    mkdir -p "$out/app/services/tengri/migrations"
    cp -R "$TMPDIR/work/services/tengri/migrations/." "$out/app/services/tengri/migrations/"
  '';
  command = [
    "node"
    "server.js"
  ];
  workingDir = "/app/apps/landing";
  env = [
    "APP_SOURCE_REVISION=${repoRevision}"
    "PORT=3000"
    "HOSTNAME=0.0.0.0"
    "TENGRI_PROTO_PATH=/app/services/tengri/proto/proompteng/runtime/v1/microvm.proto"
  ];
  extraContents = [
    nodejs
  ];
  exposedPorts = {
    "3000/tcp" = { };
  };
}
