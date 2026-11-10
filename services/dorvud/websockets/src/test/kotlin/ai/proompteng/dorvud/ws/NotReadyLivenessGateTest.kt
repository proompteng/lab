package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NotReadyLivenessGateTest {
  @Test
  fun `channel starvation keeps readiness false without restarting an authenticated forwarder`() {
    var now = 1_000L
    val gate = NotReadyLivenessGate(killAfterMs = 120_000) { now }
    val error =
      ReadinessClassifier.readinessErrorClassForGates(
        ready = false,
        gates = ReadinessGates(alpacaWs = true, kafka = true, tradeUpdates = true, marketDataChannels = false),
        alpacaErrorClass = null,
        kafkaErrorClass = null,
        tradeUpdatesErrorClass = null,
        fallbackErrorClass = ReadinessErrorClass.MarketDataChannelStarvation,
      )
    assertEquals(ReadinessErrorClass.MarketDataChannelStarvation, error)
    gate.recordReadiness(ready = false, livenessFailureEligible = requireNotNull(error).shouldEscalateToLivenessFailure())
    now += 300_000
    assertFalse(gate.shouldFailLiveness())

    gate.recordReadiness(ready = false, livenessFailureEligible = ReadinessErrorClass.KafkaProduce.shouldEscalateToLivenessFailure())
    now += 120_000
    assertTrue(gate.shouldFailLiveness())
  }

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

  @Test
  fun `non-restartable not-ready transition clears liveness timer`() {
    var now = 1_000L
    val gate = NotReadyLivenessGate(killAfterMs = 5_000) { now }

    gate.recordReadiness(false)
    now += 3_000
    gate.recordReadiness(false, livenessFailureEligible = false)
    now += 10_000
    assertFalse(gate.shouldFailLiveness())

    gate.recordReadiness(false)
    now += 5_000
    assertTrue(gate.shouldFailLiveness())
  }
}
