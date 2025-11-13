import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  id("io.quarkus") version "3.29.2"
  kotlin("jvm") version "2.2.21"
  kotlin("plugin.serialization") version "2.2.21"
  id("org.jlleitschuh.gradle.ktlint") version "14.0.1"
  id("org.jetbrains.kotlinx.kover") version "0.9.3"
}

val coroutinesVersion = "1.10.2"
val neo4jJavaDriverVersion = "6.0.2"
val kotlinLoggingVersion = "3.0.5"
val jacksonVersion = "2.20.1"
val minioVersion = "8.6.0"
val temporalVersion = "1.31.0"
val koinVersion = "4.1.1"

kotlin {
  jvmToolchain {
    languageVersion.set(JavaLanguageVersion.of(21))
  }
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_21)
  }
}

dependencies {
  implementation(enforcedPlatform("io.quarkus.platform:quarkus-bom:3.29.2"))
  implementation(platform("io.opentelemetry:opentelemetry-bom:1.56.0"))
  implementation("io.quarkus:quarkus-kotlin")
  implementation("io.quarkus:quarkus-rest")
  implementation("io.quarkus:quarkus-rest-kotlin")
  implementation("io.quarkus:quarkus-rest-kotlin-serialization")

  implementation("org.neo4j.driver:neo4j-java-driver:$neo4jJavaDriverVersion")
  implementation("io.minio:minio:$minioVersion")
  implementation("io.temporal:temporal-sdk:$temporalVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-jdk8:$coroutinesVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
  implementation("com.fasterxml.jackson.module:jackson-module-kotlin:$jacksonVersion")
  implementation("io.opentelemetry:opentelemetry-sdk")
  implementation("io.opentelemetry:opentelemetry-sdk-metrics")
  implementation("io.opentelemetry:opentelemetry-sdk-logs")
  implementation("io.opentelemetry:opentelemetry-exporter-otlp")
  implementation("io.opentelemetry:opentelemetry-extension-kotlin")
  implementation("net.logstash.logback:logstash-logback-encoder:9.0")
  implementation("io.github.microutils:kotlin-logging-jvm:$kotlinLoggingVersion")
  implementation("io.insert-koin:koin-core:$koinVersion")
  implementation("io.insert-koin:koin-logger-slf4j:$koinVersion")

  testImplementation("io.quarkus:quarkus-junit5")
  testImplementation("org.jetbrains.kotlin:kotlin-test:2.2.21")
  testImplementation("io.temporal:temporal-testing:$temporalVersion")
  testImplementation("io.mockk:mockk:1.13.12")
  testImplementation("com.squareup.okhttp3:mockwebserver:5.3.0")
  testImplementation("com.squareup.okhttp3:okhttp:5.3.0")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:$coroutinesVersion")
  testImplementation("io.insert-koin:koin-test:$koinVersion")
  testImplementation("io.insert-koin:koin-test-junit5:$koinVersion")
}

tasks {
  test {
    useJUnitPlatform()
    environment("NEO4J_URI", "bolt://localhost:7687")
    environment("NEO4J_PASSWORD", "changeme")
    environment("NEO4J_USER", "neo4j")
    environment("MINIO_ENDPOINT", "http://localhost:9000")
    environment("MINIO_BUCKET", "graf-test")
    environment("MINIO_ACCESS_KEY", "graf-access")
    environment("MINIO_SECRET_KEY", "graf-secret")
    environment("GRAF_API_BEARER_TOKENS", "graf-test-token")
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
