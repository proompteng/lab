package ai.proompteng.dorvud.ta.flink

import org.slf4j.LoggerFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.test.assertFailsWith

class RetryHelperTest {
  private val logger = LoggerFactory.getLogger("retry-helper-test")

  @Test
  fun `executeWithRetry succeeds after transient failures`() {
    var attempts = 0
    val sleeps = mutableListOf<Long>()

    executeWithRetry(
      maxAttempts = 5,
      retryDelayMs = 7,
      strict = true,
      logger = logger,
      operationName = "test operation",
      sleep = { sleeps.add(it) },
    ) {
      attempts += 1
      if (attempts < 3) {
        throw RuntimeException("temporary failure")
      }
    }

    assertEquals(3, attempts)
    assertEquals(listOf(7L, 7L), sleeps)
  }

  @Test
  fun `executeWithRetry throws in strict mode after max attempts`() {
    var attempts = 0
    val sleeps = mutableListOf<Long>()

    val error =
      assertFailsWith<IllegalStateException> {
        executeWithRetry(
          maxAttempts = 3,
          retryDelayMs = 11,
          strict = true,
          logger = logger,
          operationName = "test operation",
          sleep = { sleeps.add(it) },
        ) {
          attempts += 1
          throw RuntimeException("permanent failure")
        }
      }

    assertEquals(3, attempts)
    assertEquals(listOf(11L, 11L), sleeps)
    assertTrue(error.message?.contains("3 attempts") == true)
    assertIs<RuntimeException>(error.cause)
  }

  @Test
  fun `executeWithRetry does not throw in non strict mode after max attempts`() {
    var attempts = 0
    val sleeps = mutableListOf<Long>()

    executeWithRetry(
      maxAttempts = 2,
      retryDelayMs = 5,
      strict = false,
      logger = logger,
      operationName = "test operation",
      sleep = { sleeps.add(it) },
    ) {
      attempts += 1
      throw RuntimeException("permanent failure")
    }

    assertEquals(2, attempts)
    assertEquals(listOf(5L), sleeps)
  }

  @Test
  fun `executeWithRetry clamps maxAttempts to one`() {
    var attempts = 0

    executeWithRetry(
      maxAttempts = 0,
      retryDelayMs = 100,
      strict = false,
      logger = logger,
      operationName = "test operation",
      sleep = { _ -> error("sleep should not run for single attempt") },
    ) {
      attempts += 1
      throw RuntimeException("permanent failure")
    }

    assertEquals(1, attempts)
  }
}
