plugins {
  kotlin("plugin.serialization")
  application
}

dependencies {
  implementation(project(":platform"))
  implementation("org.eclipse.paho:org.eclipse.paho.client.mqttv3:1.2.5")
  implementation("io.ktor:ktor-server-core:2.3.12")
  implementation("io.ktor:ktor-server-cio:2.3.12")
}

application {
  mainClass.set("ai.proompteng.dorvud.webull.WebullFeedAppKt")
}
