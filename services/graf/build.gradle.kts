import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jlleitschuh.gradle.ktlint.reporter.ReporterType

plugins {
  kotlin("jvm") version "2.2.21"
  kotlin("plugin.serialization") version "2.2.21"
  application
  id("org.jlleitschuh.gradle.ktlint") version "13.1.0"
  id("org.jetbrains.kotlinx.kover") version "0.9.3"
}

val ktorVersion = "3.3.2"
val logbackVersion = "1.5.20"
val neo4jJavaDriverVersion = "6.0.2"
val coroutinesVersion = "1.10.2"
val kotlinLoggingVersion = "3.0.5"
val jacksonVersion = "2.18.1"

application {
  mainClass.set("ai.proompteng.graf.ApplicationKt")
  applicationDefaultJvmArgs = listOf("-Dio.ktor.deployment.watch=false")
}

repositories {
  mavenCentral()
}

kotlin {
  jvmToolchain {
    languageVersion.set(JavaLanguageVersion.of(21))
  }
  compilerOptions {
    jvmTarget.set(JvmTarget.JVM_21)
  }
}

dependencies {
  implementation(platform("io.opentelemetry:opentelemetry-bom:1.56.0"))
  implementation("io.ktor:ktor-server-core-jvm:$ktorVersion")
  implementation("io.ktor:ktor-server-netty:$ktorVersion")
  implementation("io.ktor:ktor-server-call-logging:$ktorVersion")
  implementation("io.ktor:ktor-server-call-id:$ktorVersion")
  implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
  implementation("io.ktor:ktor-server-auth:$ktorVersion")
  implementation("io.ktor:ktor-server-cors:$ktorVersion")
  implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
  implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
  implementation("ch.qos.logback:logback-classic:$logbackVersion")
  implementation("org.neo4j.driver:neo4j-java-driver:$neo4jJavaDriverVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
  implementation("io.github.microutils:kotlin-logging-jvm:$kotlinLoggingVersion")
  implementation("io.ktor:ktor-client-core:$ktorVersion")
  implementation("io.ktor:ktor-client-cio:$ktorVersion")
  implementation("io.ktor:ktor-client-content-negotiation:$ktorVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.0")
  implementation("io.temporal:temporal-sdk:1.28.3")
  implementation("io.minio:minio:8.6.0")
  implementation("com.fasterxml.jackson.module:jackson-module-kotlin:$jacksonVersion")
  implementation("io.opentelemetry:opentelemetry-sdk")
  implementation("io.opentelemetry:opentelemetry-sdk-metrics")
  implementation("io.opentelemetry:opentelemetry-sdk-logs")
  implementation("io.opentelemetry:opentelemetry-exporter-otlp")
  implementation("io.opentelemetry:opentelemetry-semconv:1.30.1-alpha")
  implementation("io.opentelemetry:opentelemetry-extension-kotlin")
  implementation("io.opentelemetry.instrumentation:opentelemetry-ktor-3.0:2.21.0-alpha")
  implementation("net.logstash.logback:logstash-logback-encoder:9.0")

  testImplementation("io.ktor:ktor-server-test-host:$ktorVersion")
  testImplementation("org.jetbrains.kotlin:kotlin-test:2.2.21")
  testImplementation("io.temporal:temporal-testing:1.28.3")
  testImplementation("io.mockk:mockk:1.13.6")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:$coroutinesVersion")
  testImplementation("io.ktor:ktor-client-mock:$ktorVersion")
}

tasks.test {
  useJUnitPlatform()
}

ktlint {
  version.set("1.7.1")
  debug.set(false)
  android.set(false)
  outputToConsole.set(true)

  reporters {
    reporter(ReporterType.PLAIN)
  }

  filter {
    exclude("**/build/**")
    exclude("**/generated/**")
  }
}
