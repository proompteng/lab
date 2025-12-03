package ai.proompteng.flinkta.functions;

import ai.proompteng.flinkta.model.Trade;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.time.Time;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;

public class TradeDedupFunction extends KeyedProcessFunction<String, Trade, Trade> {
  private transient MapState<String, Long> seenTrades;
  private final long ttlMinutes;

  public TradeDedupFunction(long ttlMinutes) {
    this.ttlMinutes = ttlMinutes;
  }

  @Override
  public void open(Configuration parameters) throws Exception {
    StateTtlConfig ttlConfig = StateTtlConfig
        .newBuilder(Time.minutes(ttlMinutes))
        .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
        .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
        .build();

    MapStateDescriptor<String, Long> desc = new MapStateDescriptor<>(
        "trade-dedupe",
        TypeInformation.of(String.class),
        TypeInformation.of(Long.class));
    desc.enableTimeToLive(ttlConfig);
    seenTrades = getRuntimeContext().getMapState(desc);
  }

  @Override
  public void processElement(Trade trade, Context ctx, Collector<Trade> out) throws Exception {
    if (trade.getTradeId() == null) {
      out.collect(trade);
      return;
    }
    if (seenTrades.contains(trade.getTradeId())) {
      return;
    }
    seenTrades.put(trade.getTradeId(), trade.getEventTs());
    out.collect(trade);
  }
}
