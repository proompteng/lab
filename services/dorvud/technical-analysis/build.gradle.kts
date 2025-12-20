import org.gradle.api.file.DuplicatesStrategy
import org.gradle.api.tasks.compile.JavaCompile
import org.gradle.jvm.tasks.Jar
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  application
  kotlin("plugin.serialization")
}

kotlin {
  jvmToolchain(21)
}

dependencies {
  val serializationVersion = "1.7.3"
  val coroutinesVersion = "1.9.0"
  val kafkaVersion = "4.1.0"
  val koinVersion = "3.5.6"
  val ktorVersion = "2.3.12"
  val ta4jVersion = "0.16"
  val micrometerVersion = "1.13.5"
  val logbackVersion = "1.5.12"
  val kotlinLoggingVersion = "6.0.4"
  val avroVersion = "1.11.3"
  val testcontainersVersion = "2.0.2"
  val kotestVersion = "5.9.1"

  implementation(project(":platform"))

  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:$serializationVersion")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
  implementation("org.apache.kafka:kafka-clients:$kafkaVersion")
  implementation("io.insert-koin:koin-core:$koinVersion")
  implementation("io.insert-koin:koin-ktor:$koinVersion")
  implementation("io.insert-koin:koin-logger-slf4j:$koinVersion")
  implementation("com.typesafe:config:1.4.3")
  implementation("org.ta4j:ta4j-core:$ta4jVersion")
  implementation("io.ktor:ktor-server-netty:$ktorVersion")
  implementation("io.ktor:ktor-server-call-logging:$ktorVersion")
  implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
  implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
  implementation("io.ktor:ktor-server-core:$ktorVersion")
  implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
  implementation("io.ktor:ktor-server-metrics-micrometer:$ktorVersion")
  implementation("io.ktor:ktor-server-default-headers:$ktorVersion")
  implementation("io.ktor:ktor-server-auto-head-response:$ktorVersion")
  implementation("io.micrometer:micrometer-registry-prometheus:$micrometerVersion")
  implementation("io.github.oshai:kotlin-logging-jvm:$kotlinLoggingVersion")
  implementation("ch.qos.logback:logback-classic:$logbackVersion")
  implementation("org.apache.avro:avro:$avroVersion")

  testImplementation(kotlin("test"))
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:$coroutinesVersion")
  testImplementation("io.mockk:mockk:1.13.12")
  testImplementation("io.kotest:kotest-assertions-core:$kotestVersion")
  testImplementation("io.insert-koin:koin-test:$koinVersion")
  testImplementation("io.insert-koin:koin-test-junit5:$koinVersion")
  testImplementation("org.junit.jupiter:junit-jupiter-params:5.11.3")

  val testContainersBom = platform("org.testcontainers:testcontainers-bom:$testcontainersVersion")
  testImplementation(testContainersBom)
  testImplementation("org.testcontainers:testcontainers-kafka")
  testImplementation("org.testcontainers:testcontainers-junit-jupiter")
}

application {
  mainClass.set("ai.proompteng.dorvud.ta.MainKt")
}

sourceSets {
  val integrationTest by creating {
    compileClasspath += sourceSets.main.get().output
    compileClasspath += configurations.testRuntimeClasspath.get()
    runtimeClasspath += output
    runtimeClasspath += compileClasspath
    kotlin.srcDir("src/integrationTest/kotlin")
    resources.srcDir("src/integrationTest/resources")
  }
}

configurations {
  named("integrationTestImplementation") {
    extendsFrom(configurations.testImplementation.get())
  }
  named("integrationTestRuntimeOnly") {
    extendsFrom(configurations.testRuntimeOnly.get())
  }
}

tasks {
  withType<Test> {
    useJUnitPlatform()
  }

  register<Test>("integrationTest") {
    description = "Runs integration tests."
    group = "verification"
    testClassesDirs = sourceSets["integrationTest"].output.classesDirs
    classpath = sourceSets["integrationTest"].runtimeClasspath
    shouldRunAfter("test")
    systemProperty("DOCKER_API_VERSION", "1.52")
    systemProperty("docker.api.version", "1.52")
  }

  named<ProcessResources>("processIntegrationTestResources") {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
  }

  register<Jar>("shadowJar") {
    group = "build"
    archiveClassifier.set("all")
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    manifest { attributes["Main-Class"] = "ai.proompteng.dorvud.ta.MainKt" }
    from(sourceSets.main.get().output)
    dependsOn(configurations.runtimeClasspath)
    from({
      configurations.runtimeClasspath
        .get()
        .filter { it.name.endsWith(".jar") }
        .map { zipTree(it) }
    })
  }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
  compilerOptions.jvmTarget.set(JvmTarget.JVM_21)
}

tasks.withType<JavaCompile> {
  options.release.set(21)
}
