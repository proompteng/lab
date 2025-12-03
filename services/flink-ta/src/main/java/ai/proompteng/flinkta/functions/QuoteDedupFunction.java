package ai.proompteng.flinkta.functions;

import ai.proompteng.flinkta.model.Quote;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.time.Time;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;

public class QuoteDedupFunction extends KeyedProcessFunction<String, Quote, Quote> {
  private transient MapState<Long, Boolean> seenQuotes;
  private final long ttlMinutes;

  public QuoteDedupFunction(long ttlMinutes) {
    this.ttlMinutes = ttlMinutes;
  }

  @Override
  public void open(Configuration parameters) throws Exception {
    StateTtlConfig ttlConfig = StateTtlConfig
        .newBuilder(Time.minutes(ttlMinutes))
        .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
        .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
        .build();

    MapStateDescriptor<Long, Boolean> desc = new MapStateDescriptor<>(
        "quote-dedupe",
        TypeInformation.of(Long.class),
        TypeInformation.of(Boolean.class));
    desc.enableTimeToLive(ttlConfig);
    seenQuotes = getRuntimeContext().getMapState(desc);
  }

  @Override
  public void processElement(Quote quote, Context ctx, Collector<Quote> out) throws Exception {
    long key = quote.getEventTs();
    if (seenQuotes.contains(key)) {
      return;
    }
    seenQuotes.put(key, Boolean.TRUE);
    out.collect(quote);
  }
}
