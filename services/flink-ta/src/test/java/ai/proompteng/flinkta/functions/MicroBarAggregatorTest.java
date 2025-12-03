package ai.proompteng.flinkta.functions;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.proompteng.flinkta.model.Trade;
import org.junit.jupiter.api.Test;

class MicroBarAggregatorTest {
  @Test
  void aggregatesTradesIntoMicroBarAcc() {
    MicroBarAggregator aggregator = new MicroBarAggregator();
    MicroBarAggregator.Accumulator acc = aggregator.createAccumulator();

    acc = aggregator.add(new Trade("AAPL", 1L, 10.0, 5, "t1", true), acc);
    acc = aggregator.add(new Trade("AAPL", 2L, 11.0, 7, "t2", true), acc);
    acc = aggregator.add(new Trade("AAPL", 3L, 9.5, 4, "t3", true), acc);

    MicroBarAggregator.Accumulator result = aggregator.getResult(acc);
    assertTrue(result.initialized);
    assertEquals(10.0, result.open, 1e-6);
    assertEquals(11.0, result.high, 1e-6);
    assertEquals(9.5, result.low, 1e-6);
    assertEquals(9.5, result.close, 1e-6);
    assertEquals(16.0, result.volume, 1e-6);
    double expectedVwap = (10.0 * 5 + 11.0 * 7 + 9.5 * 4) / 16.0;
    assertEquals(expectedVwap, result.pvSum / result.volume, 1e-6);
  }
}
