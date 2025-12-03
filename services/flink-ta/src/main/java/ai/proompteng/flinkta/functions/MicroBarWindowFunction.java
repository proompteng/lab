package ai.proompteng.flinkta.functions;

import ai.proompteng.flinkta.model.TaBar;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.time.Time;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.windowing.ProcessWindowFunction;
import org.apache.flink.streaming.api.windowing.windows.TimeWindow;
import org.apache.flink.util.Collector;

public class MicroBarWindowFunction extends ProcessWindowFunction<MicroBarAggregator.Accumulator, TaBar, String, TimeWindow> {
  private transient ValueState<Long> sequenceState;

  @Override
  public void open(Configuration parameters) throws Exception {
    StateTtlConfig ttlConfig = StateTtlConfig
        .newBuilder(Time.hours(1))
        .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
        .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
        .build();
    ValueStateDescriptor<Long> desc = new ValueStateDescriptor<>("bar-seq", TypeInformation.of(Long.class));
    desc.enableTimeToLive(ttlConfig);
    sequenceState = getRuntimeContext().getState(desc);
  }

  @Override
  public void process(String key, Context context, Iterable<MicroBarAggregator.Accumulator> elements, Collector<TaBar> out) throws Exception {
    MicroBarAggregator.Accumulator acc = elements.iterator().next();
    long nextSeq = sequenceState.value() == null ? 1L : sequenceState.value() + 1L;
    sequenceState.update(nextSeq);

    double vwap = acc.volume > 0 ? acc.pvSum / acc.volume : acc.close;
    long windowStart = context.window().getStart();
    long windowEnd = context.window().getEnd();

    TaBar bar = new TaBar(
        key,
        windowEnd,
        System.currentTimeMillis(),
        nextSeq,
        acc.finalFlag,
        windowStart,
        windowEnd,
        acc.open,
        acc.high,
        acc.low,
        acc.close,
        acc.volume,
        vwap,
        acc.tradeCount);
    bar.setSourceSeq(acc.sourceSeq);
    out.collect(bar);
  }
}
