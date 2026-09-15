{
  pkgs,
  lib,
  repoRoot,
}:

import ./dorvud-jvm-service.nix {
  inherit pkgs lib repoRoot;
  serviceName = "torghut-ws";
  imageName = "torghut-ws";
  gradleProject = "websockets";
  mainClass = "ai.proompteng.dorvud.ws.ForwarderAppKt";
}
