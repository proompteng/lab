package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SubscriptionQualificationTest {
  private val symbols = (1..16).map { "S${it.toString().padStart(2, '0')}" }
  private val candidates = symbols.drop(7)
  private val baseline = mapOf("trades" to symbols.take(7), "quotes" to symbols.take(7), "bars" to symbols)
  private val target = mapOf("trades" to symbols, "quotes" to symbols, "bars" to symbols)
  private val candidateMemberships = mapOf("trades" to candidates, "quotes" to candidates)

  private fun qualification() =
    SubscriptionQualification(
      baseline,
      candidates,
      acknowledgementTimeoutMs = 100,
      observationDurationMs = 60,
      maximumProviderAgeMs = 20,
      maximumQueueDelayMs = 5,
    )

  private fun start(
    q: SubscriptionQualification,
    now: Long = 1000,
  ): Long {
    val generation = q.sessionOpened(now)
    assertEquals(SubscriptionQualificationCommand.Add(candidateMemberships), q.onAcknowledgement(generation, baseline, now, true))
    assertTrue(q.snapshot().attempted)
    return generation
  }

  private fun cover(
    q: SubscriptionQualification,
    generation: Long,
    now: Long,
  ) {
    for ((channel, universe) in target) {
      for (symbol in universe) q.observe(generation, channel, symbol, now - 1, now, now + 1, true, true)
    }
  }

  @Test
  fun `complete16channel acknowledgement and continuous active coverage qualify only after baseline rollback`() {
    val q = qualification()
    val generation = start(q)
    assertNull(q.onAcknowledgement(generation, target, 1001, true))
    assertFalse(q.snapshot().qualified)
    for (time in listOf(1002L, 1017L, 1032L, 1047L, 1060L)) cover(q, generation, time)
    assertEquals(SubscriptionQualificationCommand.Remove(candidateMemberships), q.tick(generation, 1061, true))
    assertFalse(q.snapshot().qualified)
    assertFalse(q.snapshot().baselineRestored)
    assertNull(q.onAcknowledgement(generation, baseline, 1062, true))
    val status = q.snapshot()
    assertTrue(status.qualified)
    assertTrue(status.baselineRestored)
    assertTrue(status.incompleteSymbolsByChannel.isEmpty())
    assertEquals(48, status.observations.values.sumOf { it.size })
    assertEquals(16, status.acknowledgedSymbolsByChannel.getValue("bars").size)
    val proof = assertNotNull(status.completedProof)
    assertEquals(generation, proof.generation)
    assertEquals(1001L, proof.candidateAcknowledgedAtMs)
    assertEquals(1061L, proof.observationCompletedAtMs)
    assertEquals(1062L, proof.baselineRestoredAtMs)
    assertNull(q.tick(generation, 5000, true))
  }

  @Test
  fun `outside regular session exact baseline arms without spending the one amendment`() {
    val q = qualification()
    val generation = q.sessionOpened(1000)
    assertNull(q.onAcknowledgement(generation, baseline, 1000, false))
    assertEquals("armed-waiting-regular-session", q.snapshot().phase)
    assertFalse(q.snapshot().attempted)
    assertNull(q.tick(generation, 1100, false))
    assertEquals(SubscriptionQualificationCommand.Add(candidateMemberships), q.tick(generation, 1200, true))
    assertNull(q.tick(generation, 1201, true))
  }

  @Test
  fun `405 while amendment pending latches failure and preserves all prior bars without reconnect`() {
    val q = qualification()
    val generation = start(q)
    assertTrue(q.onProviderError(generation, 405, 1001))
    assertEquals("provider-rejected-405", q.snapshot().outcome)
    assertTrue(q.snapshot().baselineRestored)
    assertFalse(q.snapshot().qualified)
    assertEquals(baseline, q.snapshot().acknowledgedSymbolsByChannel)
    assertNull(q.tick(generation, 5000, true))
    assertFalse(q.onProviderError(generation, 405, 5001))
    assertEquals("closed", q.snapshot().phase)
    assertEquals("provider-rejected-405", q.snapshot().outcome)
    q.sessionClosed(generation, 5002)
    val next = q.sessionOpened(6000)
    assertNull(q.onAcknowledgement(next, baseline, 6001, true))
    assertEquals("provider-rejected-405", q.snapshot().outcome)
    assertFalse(q.snapshot().qualified)
  }

  @Test
  fun `partial acknowledgement removes only added quote trade memberships then requires full baseline`() {
    val q = qualification()
    val generation = start(q)
    val partial = target + ("quotes" to symbols.take(8))
    val remove = assertIs<SubscriptionQualificationCommand.Remove>(q.onAcknowledgement(generation, partial, 1001, true))
    assertEquals(candidateMemberships, remove.symbolsByChannel)
    assertFalse("bars" in remove.symbolsByChannel)
    assertNull(q.onAcknowledgement(generation, baseline, 1002, true))
    assertTrue(q.snapshot().baselineRestored)
    assertFalse(q.snapshot().qualified)
    assertEquals("candidate-acknowledgement-incomplete", q.snapshot().outcome)
    assertNull(q.tick(generation, 5000, true))
  }

  @Test
  fun `candidate timeout late ACK and missing rollback ACK close coherently without a second amendment`() {
    val q = qualification()
    val generation = start(q)
    assertEquals(100L, q.nextWakeDelayMs(generation, 1000))
    assertEquals(SubscriptionQualificationCommand.Remove(candidateMemberships), q.tick(generation, 1100, true))
    assertIs<SubscriptionQualificationCommand.Close>(q.onAcknowledgement(generation, target, 1101, true))
    val next = q.sessionOpened(1200)
    assertNull(q.onAcknowledgement(next, baseline, 1200, true))
    assertTrue(q.snapshot().baselineRestored)
    assertNull(q.tick(next, 9999, true))

    val other = qualification()
    val second = start(other)
    assertIs<SubscriptionQualificationCommand.Remove>(other.tick(second, 1100, true))
    assertIs<SubscriptionQualificationCommand.Close>(other.tick(second, 1200, true))
    assertEquals("baseline-rollback-timeout", other.snapshot().outcome)
  }

  @Test
  fun `disconnect before candidate ACK latches attempt and ignores old generation acknowledgements and observations`() {
    val q = qualification()
    val generation = start(q)
    q.sessionClosed(generation, 1001)
    val next = q.sessionOpened(1002)
    assertNull(q.onAcknowledgement(next, baseline, 1003, true))
    assertNull(q.onAcknowledgement(generation, target, 1004, true))
    cover(q, generation, 1010)
    assertEquals(next, q.snapshot().generation)
    assertTrue(q.snapshot().observations.isEmpty())
    assertFalse(q.snapshot().qualified)
    assertNull(q.tick(next, 5000, true))
  }

  @Test
  fun `slow client error is never swallowed as subscription rejection`() {
    val q = qualification()
    val generation = start(q)
    assertFalse(q.onProviderError(generation, 407, 1001))
    assertEquals("closed", q.snapshot().phase)
    assertFalse(q.snapshot().baselineRestored)
  }

  @Test
  fun `silence is unproved coverage and never an entitlement denial`() {
    val q = qualification()
    val generation = start(q)
    q.onAcknowledgement(generation, target, 1001, true)
    assertIs<SubscriptionQualificationCommand.Remove>(q.tick(generation, 1061, true))
    q.onAcknowledgement(generation, baseline, 1062, true)
    assertEquals("coverage-unproved", q.snapshot().outcome)
    assertEquals(target, q.snapshot().incompleteSymbolsByChannel)
    assertFalse(q.snapshot().qualified)
  }

  @Test
  fun `out of window callbacks cannot qualify or poison the bounded window`() {
    val q = qualification()
    val generation = start(q)
    q.onAcknowledgement(generation, target, 1001, true)
    for (time in listOf(1002L, 1017L, 1032L, 1047L, 1060L)) cover(q, generation, time)
    q.observe(generation, "quotes", candidates.first(), null, 1061, 1062, false, false)
    q.tick(generation, 1062, true)
    q.onAcknowledgement(generation, baseline, 1063, true)
    assertTrue(q.snapshot().qualified)

    val late = qualification()
    val next = start(late)
    late.onAcknowledgement(next, target, 1001, true)
    cover(late, next, 1062)
    late.tick(next, 1063, true)
    late.onAcknowledgement(next, baseline, 1064, true)
    assertFalse(late.snapshot().qualified)
    assertTrue(late.snapshot().observations.isEmpty())
  }

  @Test
  fun `invalid source timestamp queue delay clock regression or session transition prevents qualification`() {
    val bad =
      listOf<(SubscriptionQualification, Long) -> Unit>(
        { q, g -> q.observe(g, "quotes", candidates.first(), null, 1020, 1021, true, true) },
        { q, g -> q.observe(g, "quotes", candidates.first(), 990, 1020, 1021, true, true) },
        { q, g -> q.observe(g, "quotes", candidates.first(), 1019, 1020, 1026, true, true) },
        { q, g -> q.observe(g, "quotes", candidates.first(), 1019, 1020, 1019, true, true) },
        { q, g -> q.observe(g, "quotes", candidates.first(), 1019, 1020, 1021, false, true) },
        { q, g -> q.observe(g, "quotes", candidates.first(), 1019, 1020, 1021, true, false) },
      )
    for (inject in bad) {
      val q = qualification()
      val generation = start(q)
      q.onAcknowledgement(generation, target, 1001, true)
      for (time in listOf(1002L, 1017L, 1032L, 1047L, 1060L)) {
        cover(q, generation, time)
        if (time == 1017L) inject(q, generation)
      }
      q.tick(generation, 1061, true)
      q.onAcknowledgement(generation, baseline, 1062, true)
      assertFalse(q.snapshot().qualified)
    }
  }

  @Test
  fun `reconnect preserves completed historical proof but never refreshes its coverage`() {
    val q = qualification()
    val generation = start(q)
    q.onAcknowledgement(generation, target, 1001, true)
    for (time in listOf(1002L, 1017L, 1032L, 1047L, 1060L)) cover(q, generation, time)
    q.tick(generation, 1061, true)
    q.onAcknowledgement(generation, baseline, 1062, true)
    val proof = assertNotNull(q.snapshot().completedProof)
    q.sessionClosed(generation, 1100)
    val next = q.sessionOpened(1200)
    q.onAcknowledgement(next, baseline, 1201, true)
    cover(q, generation, 1202)
    assertFalse(q.snapshot().qualified)
    assertTrue(q.snapshot().observations.isEmpty())
    assertEquals(proof, q.snapshot().completedProof)
    assertEquals(generation, q.snapshot().completedProof?.generation)
    assertTrue(q.isCandidate("quotes", candidates.first()))
    assertTrue(q.isCandidate("trades", candidates.first()))
    assertFalse(q.isCandidate("bars", candidates.first()))
    assertEquals("qualified", q.snapshot().outcome)
  }

  @Test
  fun `backward clocks close pending acknowledgement observation and rollback without extending receive waits`() {
    for (phase in listOf("candidate", "observation", "rollback")) {
      for (viaAcknowledgement in listOf(false, true)) {
        val q = qualification()
        val generation = start(q)
        val startedAt =
          when (phase) {
            "observation" -> {
              q.onAcknowledgement(generation, target, 1010, true)
              1010L
            }
            "rollback" -> {
              q.tick(generation, 1100, true)
              1100L
            }
            else -> 1000L
          }
        assertEquals(1L, q.nextWakeDelayMs(generation, startedAt - 1))
        val command =
          if (viaAcknowledgement) {
            q.onAcknowledgement(generation, baseline, startedAt - 1, true)
          } else {
            q.tick(generation, startedAt - 1, true)
          }
        assertIs<SubscriptionQualificationCommand.Close>(command)
        assertEquals("qualification-clock-regressed", q.snapshot().outcome)
        assertFalse(q.snapshot().qualified)
        assertNull(q.tick(generation, startedAt + 1000, true))
      }
    }
  }

  @Test
  fun `two complete minute bars plus provider allowance avoid a false failure at the first minute boundary`() {
    val q = SubscriptionQualification(baseline, candidates)
    val acknowledgedAt = 60_000L
    val generation = start(q, acknowledgedAt)
    assertNull(q.onAcknowledgement(generation, target, acknowledgedAt, true))
    assertEquals(130_000L, q.nextWakeDelayMs(generation, acknowledgedAt))
    val quoteAndTradeOffsets = (0L until 130_000L step 5000L).toList()
    val barOffsets = listOf(62_000L, 122_000L)
    for (offset in (quoteAndTradeOffsets + barOffsets).distinct().sorted()) {
      val receivedAt = acknowledgedAt + offset
      if (offset in quoteAndTradeOffsets) {
        for (channel in listOf("quotes", "trades")) {
          for (symbol in symbols) q.observe(generation, channel, symbol, receivedAt - 1, receivedAt, receivedAt + 1, true, true)
        }
      }
      if (offset in barOffsets) {
        val minuteStartedAt = acknowledgedAt + (offset / 60_000L - 1) * 60_000L
        for (symbol in symbols) q.observe(generation, "bars", symbol, minuteStartedAt, receivedAt, receivedAt + 1, true, true)
      }
      // The first complete bars have not arrived at the old 60-second cutoff.
      assertNull(q.tick(generation, receivedAt + 1, true))
      assertFalse(q.snapshot().qualified)
    }
    assertNull(q.tick(generation, acknowledgedAt + 129_999L, true))
    assertEquals(
      SubscriptionQualificationCommand.Remove(candidateMemberships),
      q.tick(generation, acknowledgedAt + 130_000L, true),
    )
    assertFalse(q.snapshot().qualified)
    assertNull(q.onAcknowledgement(generation, baseline, acknowledgedAt + 130_001L, true))
    val proof = assertNotNull(q.snapshot().completedProof)
    assertTrue(q.snapshot().qualified)
    assertEquals(acknowledgedAt + 130_000L, proof.observationCompletedAtMs)
    assertTrue(
      proof.observations
        .getValue("bars")
        .values
        .all { it.usableSamples == 2L },
    )
    assertTrue(
      proof.observations
        .getValue("bars")
        .values
        .all { it.firstReceivedAtMs == acknowledgedAt + 62_000L },
    )
    assertTrue(
      proof.observations
        .getValue("bars")
        .values
        .all { it.latestProviderAtMs == acknowledgedAt + 60_000L },
    )

    val shorterProviderAllowance = SubscriptionQualification(baseline, candidates, maximumProviderAgeMs = 5000)
    val next = start(shorterProviderAllowance, acknowledgedAt)
    shorterProviderAllowance.onAcknowledgement(next, target, acknowledgedAt, true)
    assertEquals(125_000L, shorterProviderAllowance.nextWakeDelayMs(next, acknowledgedAt))
  }

  @Test
  fun `admitted membership excludes candidate quote trades unknown symbols and unrequested channels`() {
    val q = qualification()
    for (symbol in candidates) {
      assertFalse(q.isAdmitted("quotes", symbol))
      assertFalse(q.isAdmitted("trades", symbol))
      assertTrue(q.isAdmitted("bars", symbol))
    }
    assertTrue(q.isAdmitted("quotes", symbols.first()))
    assertTrue(q.isAdmitted("trades", symbols.first()))
    for (channel in listOf("quotes", "trades", "bars", "updatedBars")) assertFalse(q.isAdmitted(channel, "XYZ"))
    assertFalse(q.isAdmitted("updatedBars", symbols.first()))
  }

  @Test
  fun `small backward jumps inside candidate observation or rollback phases cannot extend membership deadlines`() {
    for (phase in listOf("candidate", "observation", "rollback")) {
      for (viaAcknowledgement in listOf(false, true)) {
        val q = qualification()
        val generation = start(q)
        val startedAt =
          when (phase) {
            "observation" -> {
              q.onAcknowledgement(generation, target, 1010, true)
              1010L
            }
            "rollback" -> {
              q.tick(generation, 1100, true)
              1100L
            }
            else -> 1000L
          }
        assertNull(q.tick(generation, startedAt + 5, true))
        assertEquals(1L, q.nextWakeDelayMs(generation, startedAt + 3))
        val command =
          if (viaAcknowledgement) {
            q.onAcknowledgement(generation, baseline, startedAt + 3, true)
          } else {
            q.tick(generation, startedAt + 3, true)
          }
        assertIs<SubscriptionQualificationCommand.Close>(command)
        assertEquals("qualification-clock-regressed", q.snapshot().outcome)
        assertFalse(q.snapshot().qualified)
        val next = q.sessionOpened(startedAt - 10)
        assertNull(q.onAcknowledgement(next, baseline, startedAt - 9, true))
        assertEquals(next, q.snapshot().generation)
        assertTrue(q.snapshot().baselineRestored)
        assertFalse(q.snapshot().qualified)
      }
    }
  }

  @Test
  fun `observation clock regression stays latched until a control step closes even after time recovers`() {
    val q = qualification()
    val generation = start(q)
    q.onAcknowledgement(generation, target, 1010, true)
    q.observe(generation, "quotes", candidates.first(), 1014, 1015, 1015, true, true)
    q.observe(generation, "quotes", candidates.first(), 1012, 1013, 1013, true, true)
    assertEquals(1L, q.nextWakeDelayMs(generation, 1016))
    assertIs<SubscriptionQualificationCommand.Close>(q.tick(generation, 1016, true))
    assertEquals("qualification-clock-regressed", q.snapshot().outcome)
    assertEquals(
      1L,
      q
        .snapshot()
        .observations
        .getValue("quotes")
        .getValue(candidates.first())
        .usableSamples,
    )
    assertFalse(q.snapshot().qualified)

    val pending = qualification()
    val next = start(pending)
    assertNull(pending.tick(next, 1005, true))
    assertFalse(pending.onProviderError(next, 405, 1003))
    assertEquals("qualification-clock-regressed", pending.snapshot().outcome)
    assertEquals("closed", pending.snapshot().phase)
  }

  @Test
  fun `finished rejected or qualified trials never reconnect the admitted baseline on later clock corrections`() {
    val rejected = qualification()
    val rejectedGeneration = start(rejected)
    assertTrue(rejected.onProviderError(rejectedGeneration, 405, 1001))
    assertNull(rejected.nextWakeDelayMs(rejectedGeneration, 900))
    assertNull(rejected.tick(rejectedGeneration, 900, true))
    assertNull(rejected.onAcknowledgement(rejectedGeneration, baseline, 901, true))
    assertTrue(rejected.snapshot().baselineRestored)
    assertEquals("provider-rejected-405", rejected.snapshot().outcome)

    val qualified = qualification()
    val qualifiedGeneration = start(qualified)
    qualified.onAcknowledgement(qualifiedGeneration, target, 1001, true)
    for (time in listOf(1002L, 1017L, 1032L, 1047L, 1060L)) cover(qualified, qualifiedGeneration, time)
    qualified.tick(qualifiedGeneration, 1061, true)
    qualified.onAcknowledgement(qualifiedGeneration, baseline, 1062, true)
    val proof = assertNotNull(qualified.snapshot().completedProof)
    assertNull(qualified.nextWakeDelayMs(qualifiedGeneration, 900))
    assertNull(qualified.tick(qualifiedGeneration, 900, true))
    assertNull(qualified.onAcknowledgement(qualifiedGeneration, baseline, 901, true))
    assertTrue(qualified.snapshot().baselineRestored)
    assertEquals(proof, qualified.snapshot().completedProof)
  }
}
