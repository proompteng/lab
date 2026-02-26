package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NotReadyLivenessGateTest {
  @Test
  fun `liveness stays healthy while readiness has not failed`() {
    var now = 1_000L
    val gate = NotReadyLivenessGate(killAfterMs = 5_000) { now }

    assertFalse(gate.shouldFailLiveness())
    now += 60_000
    assertFalse(gate.shouldFailLiveness())
  }

  @Test
  fun `liveness fails after readiness remains not-ready beyond threshold`() {
    var now = 1_000L
    val gate = NotReadyLivenessGate(killAfterMs = 5_000) { now }

    gate.recordReadiness(false)
    now += 4_999
    assertFalse(gate.shouldFailLiveness())
    now += 1
    assertTrue(gate.shouldFailLiveness())
  }

  @Test
  fun `ready transition clears not-ready timer`() {
    var now = 1_000L
    val gate = NotReadyLivenessGate(killAfterMs = 5_000) { now }

    gate.recordReadiness(false)
    now += 3_000
    gate.recordReadiness(true)
    now += 10_000
    assertFalse(gate.shouldFailLiveness())

    gate.recordReadiness(false)
    now += 5_000
    assertTrue(gate.shouldFailLiveness())
  }
}
