import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jlleitschuh.gradle.ktlint.reporter.ReporterType

plugins {
  kotlin("jvm") version "2.2.21"
  kotlin("plugin.serialization") version "2.2.21"
  application
  id("org.jlleitschuh.gradle.ktlint") version "13.1.0"
}

val ktorVersion = "3.3.2"
val logbackVersion = "1.5.20"
val neo4jJavaDriverVersion = "6.0.2"
val coroutinesVersion = "1.10.2"
val kotlinLoggingVersion = "3.0.5"

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
  implementation("io.ktor:ktor-server-core-jvm:$ktorVersion")
  implementation("io.ktor:ktor-server-netty:$ktorVersion")
  implementation("io.ktor:ktor-server-call-logging:$ktorVersion")
  implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
  implementation("io.ktor:ktor-server-auth:$ktorVersion")
  implementation("io.ktor:ktor-server-cors:$ktorVersion")
  implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
  implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
  implementation("ch.qos.logback:logback-classic:$logbackVersion")
  implementation("org.neo4j.driver:neo4j-java-driver:$neo4jJavaDriverVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
  implementation("io.github.microutils:kotlin-logging-jvm:$kotlinLoggingVersion")

  testImplementation("io.ktor:ktor-server-tests-jvm:$ktorVersion")
  testImplementation("org.jetbrains.kotlin:kotlin-test:2.2.21")
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

tasks.test {
  useJUnitPlatform()
}
