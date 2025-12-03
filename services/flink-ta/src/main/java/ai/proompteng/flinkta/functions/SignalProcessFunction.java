package ai.proompteng.flinkta.functions;

import ai.proompteng.flinkta.model.Quote;
import ai.proompteng.flinkta.model.TaBar;
import ai.proompteng.flinkta.model.TaSignal;
import java.io.Serializable;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.time.Time;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.co.KeyedCoProcessFunction;
import org.apache.flink.util.Collector;

public class SignalProcessFunction extends KeyedCoProcessFunction<String, TaBar, Quote, TaSignal> implements Serializable {
  private transient ValueState<IndicatorsCalculator> indicatorState;
  private transient ValueState<Quote> latestQuoteState;

  @Override
  public void open(Configuration parameters) throws Exception {
    StateTtlConfig ttl = StateTtlConfig
        .newBuilder(Time.hours(12))
        .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
        .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
        .build();

    ValueStateDescriptor<IndicatorsCalculator> calcDesc = new ValueStateDescriptor<>(
        "indicator-state",
        TypeInformation.of(IndicatorsCalculator.class));
    calcDesc.enableTimeToLive(ttl);
    indicatorState = getRuntimeContext().getState(calcDesc);

    ValueStateDescriptor<Quote> quoteDesc = new ValueStateDescriptor<>(
        "latest-quote",
        TypeInformation.of(Quote.class));
    quoteDesc.enableTimeToLive(ttl);
    latestQuoteState = getRuntimeContext().getState(quoteDesc);
  }

  @Override
  public void processElement1(TaBar bar, Context ctx, Collector<TaSignal> out) throws Exception {
    IndicatorsCalculator calculator = indicatorState.value();
    if (calculator == null) {
      calculator = new IndicatorsCalculator();
    }
    Quote latestQuote = latestQuoteState.value();
    TaSignal signal = calculator.apply(bar, latestQuote);
    indicatorState.update(calculator);
    out.collect(signal);
  }

  @Override
  public void processElement2(Quote quote, Context ctx, Collector<TaSignal> out) throws Exception {
    latestQuoteState.update(quote);
  }
}
