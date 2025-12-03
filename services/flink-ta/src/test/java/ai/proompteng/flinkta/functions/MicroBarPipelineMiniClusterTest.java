package ai.proompteng.flinkta.functions;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.proompteng.flinkta.model.TaBar;
import ai.proompteng.flinkta.model.Trade;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.restartstrategy.RestartStrategies;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.windowing.assigners.TumblingEventTimeWindows;
import org.apache.flink.streaming.api.windowing.time.Time;
import org.apache.flink.util.CloseableIterator;
import org.junit.jupiter.api.Test;

class MicroBarPipelineMiniClusterTest {
  @Test
  void aggregatesAndEmitsSingleWindow() throws Exception {
    StreamExecutionEnvironment env = StreamExecutionEnvironment.createLocalEnvironment();
    env.setRestartStrategy(RestartStrategies.noRestart());
    env.getCheckpointConfig().disableCheckpointing();
    env.setParallelism(1);

    List<Trade> trades = List.of(
        new Trade("AAPL", 1_000L, 10.0, 1.0, "t1", true),
        new Trade("AAPL", 1_500L, 11.0, 2.0, "t2", true),
        new Trade("AAPL", 1_800L, 9.5, 3.0, "t3", true));

    var tradeStream = env
        .fromCollection(trades)
        .assignTimestampsAndWatermarks(WatermarkStrategy
            .<Trade>forBoundedOutOfOrderness(Duration.ofMillis(200))
            .withTimestampAssigner((trade, ts) -> trade.getEventTs()));

    DataStream<TaBar> bars = tradeStream
        .keyBy(Trade::getSymbol)
        .window(TumblingEventTimeWindows.of(Time.seconds(1)))
        .allowedLateness(Time.milliseconds(200))
        .aggregate(new MicroBarAggregator(), new MicroBarWindowFunction());

    List<TaBar> results = new ArrayList<>();
    try (CloseableIterator<TaBar> iterator = bars.executeAndCollect()) {
      while (iterator.hasNext()) {
        results.add(iterator.next());
      }
    }

    assertTrue(results.size() >= 1);
    int totalTrades = results.stream().mapToInt(TaBar::getTradeCount).sum();
    assertEquals(trades.size(), totalTrades);
  }
}
