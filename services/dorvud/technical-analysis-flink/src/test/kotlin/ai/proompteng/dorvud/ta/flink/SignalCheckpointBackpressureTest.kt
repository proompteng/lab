package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.QuotePayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.MapFunction
import org.apache.flink.api.common.typeinfo.TypeHint
import org.apache.flink.api.common.typeinfo.TypeInformation
import org.apache.flink.api.common.typeinfo.Types
import org.apache.flink.configuration.CheckpointingOptions
import org.apache.flink.configuration.Configuration
import org.apache.flink.runtime.minicluster.MiniCluster
import org.apache.flink.runtime.minicluster.MiniClusterConfiguration
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.streaming.api.functions.sink.v2.DiscardingSink
import java.nio.file.Files
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertTrue

class SignalCheckpointBackpressureTest {
  @Test
  fun `retained signal corrections checkpoint while the downstream is backpressured`() {
    emitted.set(0)
    lastOutputMillis.set(0)
    seeded = CountDownLatch(1)
    correctionOutput = CountDownLatch(1)
    val directory = Files.createTempDirectory("signal-checkpoints-")
    val configuration =
      Configuration().apply {
        setString("rest.bind-port", "0")
        set(CheckpointingOptions.CHECKPOINTS_DIRECTORY, directory.toUri().toString())
        set(CheckpointingOptions.ENABLE_UNALIGNED, true)
        set(CheckpointingOptions.ENABLE_UNALIGNED_INTERRUPTIBLE_TIMERS, true)
      }
    val env = StreamExecutionEnvironment.getExecutionEnvironment(configuration)
    env.parallelism = 2
    env.enableCheckpointing(3_600_000)
    val start = Instant.parse("2026-09-11T13:30:00Z")
    val seededBars =
      env
        .fromSequence(1, Long.MAX_VALUE)
        .setParallelism(1)
        .map(SeedInput())
        .returns(TypeInformation.of(object : TypeHint<Envelope<MicroBarPayload>>() {}))
        .setParallelism(1)
    val bars =
      env
        .fromSequence(1, Long.MAX_VALUE)
        .setParallelism(1)
        .map(TradeInput())
        .returns(TypeInformation.of(RecordedTrade::class.java))
        .assignTimestampsAndWatermarks(
          WatermarkStrategy
            .forMonotonousTimestamps<RecordedTrade>()
            .withTimestampAssigner { value, _ -> value.envelope.eventTs.toEpochMilli() },
        ).keyBy { it.envelope.symbol }
        .transform("microbars", TypeInformation.of(object : TypeHint<Envelope<MicroBarPayload>>() {}), MicrobarOperator())
        .union(seededBars)
    val quotes =
      seededBars
        .map { bar ->
          Envelope(bar.ingestTs, bar.eventTs, "iex", "quotes", "AAPL", bar.seq, QuotePayload(100.0, 10.0, 101.0, 10.0, bar.eventTs))
        }.returns(TypeInformation.of(object : TypeHint<Envelope<QuotePayload>>() {}))
    bars
      .keyBy { it.symbol }
      .connect(quotes.keyBy { it.symbol })
      .process(TaSignalsFunction(FlinkTaConfig.fromEnv(), Duration.ofSeconds(1), SignalBarTimestampAnchor.END, false))
      .map(LargeOutput())
      .returns(Types.STRING)
      .rebalance()
      .map(SlowOutput())
      .returns(Types.STRING)
      .sinkTo(DiscardingSink())
    val graph = env.streamGraph.jobGraph
    try {
      MiniCluster(
        MiniClusterConfiguration
          .Builder()
          .setConfiguration(configuration)
          .setNumTaskManagers(2)
          .setNumSlotsPerTaskManager(2)
          .build(),
      ).use { cluster ->
        cluster.start()
        cluster.submitJob(graph).get(15, TimeUnit.SECONDS)
        assertTrue(correctionOutput.await(15, TimeUnit.SECONDS), "production signal corrections must start")
        repeat(2) {
          val checkpoint = cluster.triggerCheckpoint(graph.jobID).get(10, TimeUnit.SECONDS)
          assertTrue(checkpoint.startsWith("file:"))
          assertTrue(
            lastOutputMillis.get() < start.plusSeconds(10_000).toEpochMilli(),
            "checkpoint must complete before the final rebuilt bar",
          )
        }
        cluster.cancelJob(graph.jobID).get(10, TimeUnit.SECONDS)
      }
    } finally {
      directory.toFile().deleteRecursively()
    }
  }

  private class SeedInput : MapFunction<Long, Envelope<MicroBarPayload>> {
    override fun map(value: Long): Envelope<MicroBarPayload> {
      if (value > 400) Thread.sleep(10)
      val index = value.coerceAtMost(400)
      val time = Instant.parse("2026-09-11T13:30:00Z").plusSeconds(index)
      return Envelope(time, time, "iex", "bars", "AAPL", index, MicroBarPayload(100.0, 100.0, 100.0, 100.0, 1.0, 100.0, 1, time))
    }
  }

  private class TradeInput : MapFunction<Long, RecordedTrade> {
    override fun map(value: Long): RecordedTrade {
      check(seeded.await(15, TimeUnit.SECONDS)) { "canonical signal history must be seeded" }
      if (value > 10_000) Thread.sleep(10)
      val revision = value.coerceAtMost(10_001)
      val start = Instant.parse("2026-09-11T13:30:00Z")
      val time = start.plusSeconds(revision)
      val price = 100.0 + revision
      return RecordedTrade(
        Envelope(time, time, "iex", "trades", "AAPL", revision, TradePayload(price, 1.0, time)),
        "trades",
        0,
        revision,
      )
    }
  }

  private class LargeOutput : MapFunction<Envelope<TaSignalsPayload>, String> {
    override fun map(value: Envelope<TaSignalsPayload>): String {
      val count = emitted.incrementAndGet()
      lastOutputMillis.accumulateAndGet(value.eventTs.toEpochMilli(), ::maxOf)
      if (count >= 400) seeded.countDown()
      if (count >= 800) correctionOutput.countDown()
      return "${value.seq}:" + "x".repeat(16_000)
    }
  }

  private class SlowOutput : MapFunction<String, String> {
    override fun map(value: String): String {
      Thread.sleep(1)
      return value
    }
  }

  companion object {
    private val emitted = AtomicInteger()
    private val lastOutputMillis = AtomicLong()
    private var seeded = CountDownLatch(1)
    private var correctionOutput = CountDownLatch(1)
  }
}
