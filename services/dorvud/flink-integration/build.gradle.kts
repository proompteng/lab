import org.gradle.api.file.DuplicatesStrategy
import org.gradle.jvm.tasks.Jar

description = "Flink integration for Dorvud (Kafka round-trip sample)"

val flinkVersion = "2.1.1"
val kafkaConnectorVersion = "4.0.1-2.0"

dependencies {
  add("implementation", "org.apache.flink:flink-streaming-java:$flinkVersion")
  add("implementation", "org.apache.flink:flink-clients:$flinkVersion")
  add("implementation", "org.apache.flink:flink-connector-kafka:$kafkaConnectorVersion")
  add("implementation", "org.apache.flink:flink-metrics-prometheus:$flinkVersion")
}

tasks.withType<Jar> {
  archiveBaseName.set("flink-kafka-roundtrip")
}

tasks.register<Jar>("uberJar") {
  group = "build"
  archiveFileName.set("flink-kafka-roundtrip-all.jar")
  duplicatesStrategy = DuplicatesStrategy.EXCLUDE

  from(sourceSets.main.get().output)
  dependsOn(configurations.runtimeClasspath)
  from({
    configurations.runtimeClasspath.get().filter { it.name.endsWith(".jar") }.map { file ->
      if (file.isDirectory) file else zipTree(file)
    }
  })
}
