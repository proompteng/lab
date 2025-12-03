package ai.proompteng.flinkta.functions;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.proompteng.flinkta.model.Quote;
import ai.proompteng.flinkta.model.TaBar;
import ai.proompteng.flinkta.model.TaSignal;
import java.util.List;
import org.junit.jupiter.api.Test;

class IndicatorsCalculatorTest {
  @Test
  void computesIndicatorsAcrossBars() {
    IndicatorsCalculator calculator = new IndicatorsCalculator();
    Quote quote = new Quote("AAPL", 0L, 100.0, 100.2, 10, 12, true);

    List<Double> closes = List.of(100.0, 100.5, 101.0, 101.5, 102.0, 101.5, 101.0, 100.8,
        101.2, 101.8, 102.5, 102.8, 103.0, 103.2, 103.5);

    TaSignal latest = null;
    long windowStart = 0L;
    for (double close : closes) {
      TaBar bar = new TaBar(
          "AAPL",
          windowStart + 1000,
          windowStart + 1000,
          windowStart / 1000,
          true,
          windowStart,
          windowStart + 1000,
          close,
          close + 0.1,
          close - 0.1,
          close,
          1000,
          close,
          5);
      latest = calculator.apply(bar, quote);
      windowStart += 1000;
    }

    assertEquals("AAPL", latest.getSymbol());
    assertTrue(latest.getEma12() > 0);
    assertTrue(latest.getEma26() > 0);
    assertTrue(latest.getRsi14() > 0 && latest.getRsi14() <= 100);
    assertTrue(latest.getBollUpper() > latest.getBollLower());
    assertTrue(latest.getRealizedVolatility() >= 0);
  }
}
