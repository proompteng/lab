plugins {
  kotlin("plugin.serialization")
}

dependencies {
  val serializationVersion = "1.7.3"
  api("org.jetbrains.kotlinx:kotlinx-serialization-json:$serializationVersion")
}
