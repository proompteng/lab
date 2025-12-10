rootProject.name = "dorvud"

include("platform", "technical-analysis", "websockets", "flink-integration", "technical-analysis-flink")

dependencyResolutionManagement {
  repositories {
    mavenCentral()
  }
}
