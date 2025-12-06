plugins {
  kotlin("plugin.serialization")
  application
}

dependencies {
  val ktorVersion = "2.3.12"
  val coroutinesVersion = "1.9.0"
  val kotlinLoggingVersion = "3.0.5"

  implementation(project(":platform"))
  implementation("io.ktor:ktor-client-core:$ktorVersion")
  implementation("io.ktor:ktor-client-cio:$ktorVersion")
  implementation("io.ktor:ktor-client-websockets:$ktorVersion")
  implementation("io.ktor:ktor-client-content-negotiation:$ktorVersion")
  implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
  implementation("io.ktor:ktor-server-core:$ktorVersion")
  implementation("io.ktor:ktor-server-cio:$ktorVersion")
  implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
  implementation("io.ktor:ktor-server-call-logging:$ktorVersion")
  implementation("io.github.cdimascio:dotenv-kotlin:6.5.1")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
  implementation("io.github.microutils:kotlin-logging-jvm:$kotlinLoggingVersion")

  testImplementation("io.mockk:mockk:1.13.12")
  testImplementation("io.ktor:ktor-client-mock:$ktorVersion")
  testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
}

application {
  mainClass.set("ai.proompteng.dorvud.ws.ForwarderAppKt")
}
