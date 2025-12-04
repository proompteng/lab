rootProject.name = "dorvud"

include("platform", "technical-analysis", "websockets", "flink-integration")

dependencyResolutionManagement {
  repositories {
    mavenCentral()
  }
}
