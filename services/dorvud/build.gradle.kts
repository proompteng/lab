import org.gradle.api.JavaVersion
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.tasks.compile.JavaCompile
import org.gradle.api.tasks.testing.Test
import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.jlleitschuh.gradle.ktlint.KtlintExtension
import org.jlleitschuh.gradle.ktlint.reporter.ReporterType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension

plugins {
  kotlin("jvm") version "2.3.0" apply false
  kotlin("plugin.serialization") version "2.3.0" apply false
  id("org.jlleitschuh.gradle.ktlint") version "14.0.1" apply false
}

subprojects {
  apply(plugin = "org.jetbrains.kotlin.jvm")
  apply(plugin = "org.jlleitschuh.gradle.ktlint")

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

  extensions.configure<JavaPluginExtension> {
    toolchain {
      languageVersion.set(JavaLanguageVersion.of(21))
    }
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
  }

  dependencies {
    add("implementation", kotlin("stdlib"))
    add("testImplementation", kotlin("test"))
  }

  tasks.withType<Test> {
    useJUnitPlatform()
  }

  tasks.withType<JavaCompile> {
    options.release.set(21)
  }

  extensions.configure<KtlintExtension> {
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
}
