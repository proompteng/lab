{
  pkgs,
  lib,
  repoRoot,
}:

import ./dorvud-jvm-service.nix {
  inherit pkgs lib repoRoot;
  serviceName = "torghut-webull-feed";
  imageName = "torghut-webull-feed";
  gradleProject = "webull-feed";
  mainClass = "ai.proompteng.dorvud.webull.WebullFeedAppKt";
}
