import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  id("io.quarkus") version "3.8.3"
  kotlin("jvm") version "2.2.20"
  kotlin("plugin.serialization") version "2.2.20"
  kotlin("plugin.allopen") version "2.2.20"
  id("org.jlleitschuh.gradle.ktlint") version "13.1.0"
  id("org.jetbrains.kotlinx.kover") version "0.9.3"
}

val coroutinesVersion = "1.10.2"
val neo4jJavaDriverVersion = "6.0.2"
val kotlinLoggingVersion = "3.0.5"
val jacksonVersion = "2.18.1"
val minioVersion = "8.6.0"
val temporalVersion = "1.28.3"

kotlin {
  jvmToolchain {
    languageVersion.set(JavaLanguageVersion.of(21))
  }
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_21)
  }
}

allOpen {
  annotation("jakarta.enterprise.context.ApplicationScoped")
  annotation("jakarta.inject.Singleton")
  annotation("io.quarkus.runtime.QuarkusMain")
  annotation("jakarta.ws.rs.Path")
  annotation("jakarta.ws.rs.ext.Provider")
}

dependencies {
  implementation(enforcedPlatform("io.quarkus.platform:quarkus-bom:3.8.3"))
  implementation(platform("io.opentelemetry:opentelemetry-bom:1.56.0"))
  implementation("io.quarkus:quarkus-kotlin:3.8.3")
  implementation("io.quarkus:quarkus-resteasy-reactive:3.8.3")
  implementation("io.quarkus:quarkus-resteasy-reactive-kotlin-serialization:3.8.3")
  implementation("io.quarkus:quarkus-arc:3.8.3")

  implementation("org.neo4j.driver:neo4j-java-driver:$neo4jJavaDriverVersion")
  implementation("io.minio:minio:$minioVersion")
  implementation("io.temporal:temporal-sdk:$temporalVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-jdk8:$coroutinesVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.0")
  implementation("com.fasterxml.jackson.module:jackson-module-kotlin:$jacksonVersion")
  implementation("io.opentelemetry:opentelemetry-sdk")
  implementation("io.opentelemetry:opentelemetry-sdk-metrics")
  implementation("io.opentelemetry:opentelemetry-sdk-logs")
  implementation("io.opentelemetry:opentelemetry-exporter-otlp")
  implementation("io.opentelemetry:opentelemetry-semconv:1.30.1-alpha")
  implementation("io.opentelemetry:opentelemetry-extension-kotlin")
  implementation("net.logstash.logback:logstash-logback-encoder:9.0")
  implementation("io.github.microutils:kotlin-logging-jvm:$kotlinLoggingVersion")

  testImplementation("io.quarkus:quarkus-junit5")
  testImplementation("org.jetbrains.kotlin:kotlin-test:2.2.20")
  testImplementation("io.temporal:temporal-testing:$temporalVersion")
  testImplementation("io.mockk:mockk:1.13.6")
  testImplementation("com.squareup.okhttp3:mockwebserver:4.11.0")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:$coroutinesVersion")
}

tasks {
  test {
    useJUnitPlatform()
  }
}

ktlint {
  version.set("1.7.1")
  debug.set(false)
  android.set(false)
  outputToConsole.set(true)

  reporters {
    reporter(org.jlleitschuh.gradle.ktlint.reporter.ReporterType.PLAIN)
  }

  filter {
    exclude("**/build/**")
    exclude("**/generated/**")
  }
}
