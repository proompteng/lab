import org.gradle.api.tasks.compile.JavaCompile
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  kotlin("plugin.serialization")
}

kotlin {
  jvmToolchain(21)
}

dependencies {
  val serializationVersion = "1.7.3"
  val coroutinesVersion = "1.9.0"
  val kafkaVersion = "4.1.0"
  val micrometerVersion = "1.13.5"
  val logbackVersion = "1.5.12"
  val kotlinLoggingVersion = "3.0.5"

  api("org.apache.kafka:kafka-clients:$kafkaVersion")
  api("org.jetbrains.kotlinx:kotlinx-serialization-json:$serializationVersion")
  api("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
  api("io.micrometer:micrometer-core:$micrometerVersion")
  api("io.micrometer:micrometer-registry-prometheus:$micrometerVersion")

  implementation("com.typesafe:config:1.4.3")
  implementation("io.github.microutils:kotlin-logging-jvm:$kotlinLoggingVersion")
  implementation("ch.qos.logback:logback-classic:$logbackVersion")

  testImplementation("io.mockk:mockk:1.13.12")
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
  compilerOptions.jvmTarget.set(JvmTarget.JVM_21)
}

tasks.withType<JavaCompile> {
  options.release.set(21)
}
