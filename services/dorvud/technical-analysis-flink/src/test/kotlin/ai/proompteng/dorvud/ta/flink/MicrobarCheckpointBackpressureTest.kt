package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
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
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertTrue

class MicrobarCheckpointBackpressureTest {
  @Test
  fun `microbar timer burst checkpoints before a slow downstream drains`() {
    emitted.set(0)
    firstOutput = CountDownLatch(1)
    val directory = Files.createTempDirectory("microbar-checkpoints-")
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
        assertTrue(firstOutput.await(15, TimeUnit.SECONDS), "production microbar timers must start firing")
        repeat(2) {
          val checkpoint = cluster.triggerCheckpoint(graph.jobID).get(10, TimeUnit.SECONDS)
          assertTrue(checkpoint.startsWith("file:"))
          assertTrue(emitted.get() < 10_000, "checkpoint must complete during the timer burst")
        }
        cluster.cancelJob(graph.jobID).get(10, TimeUnit.SECONDS)
      }
    } finally {
      directory.toFile().deleteRecursively()
    }
  }

  private class TradeInput : MapFunction<Long, RecordedTrade> {
    override fun map(value: Long): RecordedTrade {
      if (value > 10_000) Thread.sleep(10)
      val time = Instant.parse("2026-09-11T13:30:00Z").plusSeconds(value.coerceAtMost(10_001))
      return RecordedTrade(
        Envelope(time, time, "iex", "trades", "AAPL", value, TradePayload(100.0, 1.0, time)),
        "trades",
        0,
        value,
      )
    }
  }

  private class LargeOutput : MapFunction<Envelope<MicroBarPayload>, String> {
    override fun map(value: Envelope<MicroBarPayload>): String {
      emitted.incrementAndGet()
      firstOutput.countDown()
      return "${value.seq}:" + "x".repeat(16_000)
    }
  }

  private class SlowOutput : MapFunction<String, String> {
    override fun map(value: String): String {
      Thread.sleep(5)
      return value
    }
  }

  companion object {
    private val emitted = AtomicInteger()
    private var firstOutput = CountDownLatch(1)
  }
}
