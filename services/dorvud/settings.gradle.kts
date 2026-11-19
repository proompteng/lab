rootProject.name = "dorvud"

include(
  "platform",
  "technical-analysis",
  "websockets",
  "flink-integration",
  "technical-analysis-flink",
  "hyperliquid-feed",
  "webull-feed",
)

dependencyResolutionManagement {
  repositories {
    mavenCentral()
  }
}
