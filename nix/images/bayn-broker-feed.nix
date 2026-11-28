{
  pkgs,
  lib,
  repoRoot,
}:

import ./dorvud-jvm-service.nix {
  inherit pkgs lib repoRoot;
  serviceName = "bayn-broker-feed";
  gradleProject = "websockets";
  mainClass = "ai.proompteng.dorvud.ws.BrokerFeedMain";
}
