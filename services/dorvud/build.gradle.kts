import org.gradle.api.tasks.testing.Test
import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension

plugins {
  kotlin("jvm") version "2.2.21" apply false
  kotlin("plugin.serialization") version "2.2.21" apply false
}

subprojects {
  apply(plugin = "org.jetbrains.kotlin.jvm")

  group = "ai.proompteng.dorvud"
  version = "0.1.0-SNAPSHOT"

  repositories {
    mavenCentral()
  }

  extensions.configure<KotlinJvmProjectExtension> {
    jvmToolchain {
      languageVersion.set(JavaLanguageVersion.of(21))
    }
    compilerOptions {
      jvmTarget.set(JvmTarget.JVM_21)
    }
  }

  dependencies {
    add("implementation", kotlin("stdlib"))
    add("testImplementation", kotlin("test"))
  }

  tasks.withType<Test> {
    useJUnitPlatform()
  }
}
