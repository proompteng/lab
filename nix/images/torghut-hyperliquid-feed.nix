{
  pkgs,
  lib,
  repoRoot,
}:

import ./dorvud-jvm-service.nix {
  inherit pkgs lib repoRoot;
  serviceName = "torghut-hyperliquid-feed";
  imageName = "torghut-hyperliquid-feed";
  gradleProject = "hyperliquid-feed";
  mainClass = "ai.proompteng.dorvud.hyperliquid.HyperliquidFeedAppKt";
}
