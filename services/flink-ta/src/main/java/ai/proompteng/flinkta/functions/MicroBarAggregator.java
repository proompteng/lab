package ai.proompteng.flinkta.functions;

import ai.proompteng.flinkta.model.Trade;
import org.apache.flink.api.common.functions.AggregateFunction;

public class MicroBarAggregator implements AggregateFunction<Trade, MicroBarAggregator.Accumulator, MicroBarAggregator.Accumulator> {
  public static class Accumulator {
    public double open;
    public double high;
    public double low;
    public double close;
    public double volume;
    public double pvSum;
    public int tradeCount;
    public boolean initialized;
    public boolean finalFlag = true;
    public String sourceSeq;
  }

  @Override
  public Accumulator createAccumulator() {
    return new Accumulator();
  }

  @Override
  public Accumulator add(Trade value, Accumulator acc) {
    if (!acc.initialized) {
      acc.open = value.getPrice();
      acc.high = value.getPrice();
      acc.low = value.getPrice();
      acc.initialized = true;
    } else {
      acc.high = Math.max(acc.high, value.getPrice());
      acc.low = Math.min(acc.low, value.getPrice());
    }
    acc.close = value.getPrice();
    acc.volume += value.getSize();
    acc.pvSum += value.getPrice() * value.getSize();
    acc.tradeCount += 1;
    acc.finalFlag = acc.finalFlag && value.isFinalFlag();
    acc.sourceSeq = value.getTradeId();
    return acc;
  }

  @Override
  public Accumulator getResult(Accumulator acc) {
    return acc;
  }

  @Override
  public Accumulator merge(Accumulator a, Accumulator b) {
    Accumulator merged = new Accumulator();
    if (a.initialized && b.initialized) {
      merged.open = a.open; // preserve first open ordering is undefined in merge
    } else if (a.initialized) {
      merged.open = a.open;
    } else if (b.initialized) {
      merged.open = b.open;
    }
    merged.high = Math.max(a.high, b.high);
    merged.low = a.low == 0 ? b.low : (b.low == 0 ? a.low : Math.min(a.low, b.low));
    merged.close = b.initialized ? b.close : a.close;
    merged.volume = a.volume + b.volume;
    merged.pvSum = a.pvSum + b.pvSum;
    merged.tradeCount = a.tradeCount + b.tradeCount;
    merged.initialized = a.initialized || b.initialized;
    merged.finalFlag = a.finalFlag && b.finalFlag;
    merged.sourceSeq = b.sourceSeq != null ? b.sourceSeq : a.sourceSeq;
    return merged;
  }
}
