import org.gradle.api.file.DuplicatesStrategy
import org.gradle.api.tasks.compile.JavaCompile
import org.gradle.jvm.tasks.Jar

plugins {
  kotlin("jvm")
  kotlin("plugin.serialization")
}

description = "Flink job for torghut technical analysis"

val flinkVersion = "2.2.1"
val kafkaConnectorVersion = "5.0.0-2.2"
val jdbcConnectorVersion = "4.1.0-2.2"
val serializationVersion = "1.7.3"
val logbackVersion = "1.5.12"
val clickhouseJdbcVersion = "0.9.5"

configurations.configureEach {
  resolutionStrategy.capabilitiesResolution.withCapability("org.lz4:lz4-java") {
    selectHighestVersion()
  }
}

dependencies {
  implementation(project(":platform"))
  implementation(project(":technical-analysis"))

  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:$serializationVersion")

  implementation("org.apache.flink:flink-streaming-java:$flinkVersion")
  implementation("org.apache.flink:flink-clients:$flinkVersion")
  implementation("org.apache.flink:flink-connector-base:$flinkVersion")
  implementation("org.apache.flink:flink-connector-kafka:$kafkaConnectorVersion")
  implementation("org.apache.flink:flink-connector-jdbc-core:$jdbcConnectorVersion")
  implementation("org.apache.flink:flink-metrics-prometheus:$flinkVersion")
  implementation("org.apache.kafka:kafka-clients:4.2.0") {
    version { strictly("4.2.0") }
    because("Use the connector's client API instead of the legacy Confluent 7.5.4-ccs artifact.")
  }

  implementation("org.ta4j:ta4j-core:0.16")
  implementation("com.clickhouse:clickhouse-jdbc:$clickhouseJdbcVersion")
  implementation("ch.qos.logback:logback-classic:$logbackVersion")

  testImplementation(kotlin("test"))
}

tasks.withType<Jar> { archiveBaseName.set("technical-analysis-flink") }

tasks.register<Jar>("uberJar") {
  group = "build"
  archiveFileName.set("technical-analysis-flink-all.jar")
  duplicatesStrategy = DuplicatesStrategy.EXCLUDE

  from(sourceSets.main.get().output)
  dependsOn(configurations.runtimeClasspath)
  from({
    configurations.runtimeClasspath.get().filter { it.name.endsWith(".jar") }.map { file ->
      if (file.isDirectory) file else zipTree(file)
    }
  })

  manifest { attributes["Main-Class"] = "ai.proompteng.dorvud.ta.flink.FlinkTechnicalAnalysisJobKt" }
}

tasks.withType<Test> {
  useJUnitPlatform()
  systemProperty("writeMarketFeatureFixture", providers.gradleProperty("writeMarketFeatureFixture").orElse("false").get())
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
  compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
}

tasks.withType<JavaCompile> {
  options.release.set(21)
}
