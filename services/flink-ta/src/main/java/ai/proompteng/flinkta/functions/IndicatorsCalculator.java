package ai.proompteng.flinkta.functions;

import ai.proompteng.flinkta.model.TaBar;
import ai.proompteng.flinkta.model.TaSignal;
import ai.proompteng.flinkta.model.Quote;
import java.io.Serializable;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Stateful calculator for common TA indicators maintained per symbol.
 */
public class IndicatorsCalculator implements Serializable {
  private static final int RSI_PERIOD = 14;
  private static final int BOLL_PERIOD = 20;
  private static final int VWAP_ROLLING_PERIOD = 20;
  private static final int MACD_SIGNAL_PERIOD = 9;

  private static final double ALPHA_EMA12 = 2.0 / (12 + 1);
  private static final double ALPHA_EMA26 = 2.0 / (26 + 1);
  private static final double ALPHA_MACD_SIGNAL = 2.0 / (MACD_SIGNAL_PERIOD + 1);

  private static final double DAYS_PER_YEAR = 252d;
  private static final double SECONDS_PER_TRADING_DAY = 23400d; // 6.5 hours
  private static final double ANNUALIZATION = Math.sqrt(DAYS_PER_YEAR * SECONDS_PER_TRADING_DAY);

  private double ema12;
  private double ema26;
  private double macdSignal;
  private double avgGain;
  private double avgLoss;
  private Double lastClose;

  private final Deque<Double> bollValues = new ArrayDeque<>();
  private double bollSum;
  private double bollSumSq;

  private final Deque<double[]> vwapRollingWindow = new ArrayDeque<>(); // [pv, vol]
  private double rollingPvSum;
  private double rollingVolSum;

  private final Deque<Double> returnsWindow = new ArrayDeque<>();
  private double returnsSumSq;

  private double sessionPvSum;
  private double sessionVolSum;

  public TaSignal apply(TaBar bar, Quote latestQuote) {
    TaSignal signal = new TaSignal(bar.getSymbol());
    signal.setEventTs(bar.getEventTs());
    signal.setIngestTs(bar.getIngestTs());
    signal.setSeq(bar.getSeq());
    signal.setFinalFlag(bar.isFinalFlag());
    signal.setWindowStart(bar.getWindowStart());
    signal.setWindowEnd(bar.getWindowEnd());
    signal.setOpen(bar.getOpen());
    signal.setHigh(bar.getHigh());
    signal.setLow(bar.getLow());
    signal.setClose(bar.getClose());
    signal.setVolume(bar.getVolume());
    signal.setVwap(bar.getVwap());
    signal.setSpreadBps(bar.getSpreadBps());
    signal.setImbalance(bar.getImbalance());
    signal.setSourceSeq(bar.getSourceSeq());

    Double prevClose = this.lastClose;

    updateEma(bar.getClose());
    signal.setEma12(ema12);
    signal.setEma26(ema26);

    double macd = ema12 - ema26;
    macdSignal = macdSignal == 0d ? macd : macdSignal + ALPHA_MACD_SIGNAL * (macd - macdSignal);
    signal.setMacd(macd);
    signal.setMacdSignal(macdSignal);
    signal.setMacdHist(macd - macdSignal);

    updateRsi(bar.getClose());
    signal.setRsi14(currentRsi());

    updateBollinger(bar.getClose());
    signal.setBollMid(currentBollMid());
    signal.setBollUpper(currentBollUpper());
    signal.setBollLower(currentBollLower());

    updateSessionVwap(bar.getVwap(), bar.getVolume());
    signal.setVwapSession(sessionVwap());

    updateRollingVwap(bar.getVwap(), bar.getVolume());
    signal.setVwapRolling(rollingVwap());

    updateRealizedVolatility(prevClose, bar.getClose());
    signal.setRealizedVolatility(realizedVol());

    if (latestQuote != null) {
      double mid = (latestQuote.getAskPrice() + latestQuote.getBidPrice()) / 2.0;
      if (mid > 0) {
        double spreadBps = (latestQuote.getAskPrice() - latestQuote.getBidPrice()) / mid * 10000.0;
        signal.setSpreadBps(spreadBps);
      }
      double denom = latestQuote.getBidSize() + latestQuote.getAskSize();
      if (denom > 0) {
        signal.setImbalance((latestQuote.getBidSize() - latestQuote.getAskSize()) / denom);
      }
    }

    return signal;
  }

  private void updateEma(double close) {
    if (ema12 == 0d) {
      ema12 = close;
    } else {
      ema12 = ema12 + ALPHA_EMA12 * (close - ema12);
    }

    if (ema26 == 0d) {
      ema26 = close;
    } else {
      ema26 = ema26 + ALPHA_EMA26 * (close - ema26);
    }
  }

  private void updateRsi(double close) {
    if (lastClose == null) {
      lastClose = close;
      return;
    }
    double change = close - lastClose;
    double gain = Math.max(change, 0);
    double loss = Math.max(-change, 0);

    if (avgGain == 0d && avgLoss == 0d) {
      avgGain = gain;
      avgLoss = loss;
    } else {
      avgGain = ((avgGain * (RSI_PERIOD - 1)) + gain) / RSI_PERIOD;
      avgLoss = ((avgLoss * (RSI_PERIOD - 1)) + loss) / RSI_PERIOD;
    }
    lastClose = close;
  }

  private double currentRsi() {
    if (avgLoss == 0d) {
      return avgGain == 0d ? 50d : 100d;
    }
    double rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  private void updateBollinger(double close) {
    bollValues.addLast(close);
    bollSum += close;
    bollSumSq += close * close;
    if (bollValues.size() > BOLL_PERIOD) {
      Double removed = bollValues.removeFirst();
      bollSum -= removed;
      bollSumSq -= removed * removed;
    }
  }

  private double currentBollMid() {
    if (bollValues.isEmpty()) {
      return 0d;
    }
    return bollSum / bollValues.size();
  }

  private double currentBollUpper() {
    if (bollValues.isEmpty()) {
      return 0d;
    }
    double mean = currentBollMid();
    double variance = (bollSumSq / bollValues.size()) - (mean * mean);
    double std = Math.sqrt(Math.max(variance, 0d));
    return mean + 2 * std;
  }

  private double currentBollLower() {
    if (bollValues.isEmpty()) {
      return 0d;
    }
    double mean = currentBollMid();
    double variance = (bollSumSq / bollValues.size()) - (mean * mean);
    double std = Math.sqrt(Math.max(variance, 0d));
    return mean - 2 * std;
  }

  private void updateSessionVwap(double vwap, double volume) {
    sessionPvSum += vwap * volume;
    sessionVolSum += volume;
  }

  private double sessionVwap() {
    if (sessionVolSum <= 0) {
      return 0d;
    }
    return sessionPvSum / sessionVolSum;
  }

  private void updateRollingVwap(double vwap, double volume) {
    vwapRollingWindow.addLast(new double[] {vwap * volume, volume});
    rollingPvSum += vwap * volume;
    rollingVolSum += volume;
    if (vwapRollingWindow.size() > VWAP_ROLLING_PERIOD) {
      double[] removed = vwapRollingWindow.removeFirst();
      rollingPvSum -= removed[0];
      rollingVolSum -= removed[1];
    }
  }

  private double rollingVwap() {
    if (rollingVolSum <= 0) {
      return 0d;
    }
    return rollingPvSum / rollingVolSum;
  }

  private void updateRealizedVolatility(Double previousClose, double close) {
    if (previousClose == null || previousClose == 0d) {
      return;
    }
    double ret = Math.log(close / previousClose);
    returnsWindow.addLast(ret);
    returnsSumSq += ret * ret;
    if (returnsWindow.size() > 120) { // ~2 minutes
      double removed = returnsWindow.removeFirst();
      returnsSumSq -= removed * removed;
    }
  }

  private double realizedVol() {
    if (returnsWindow.isEmpty()) {
      return 0d;
    }
    double variance = returnsSumSq / returnsWindow.size();
    return Math.sqrt(Math.max(variance, 0d)) * ANNUALIZATION;
  }
}
