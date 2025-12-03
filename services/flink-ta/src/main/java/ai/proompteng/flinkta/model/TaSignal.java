package ai.proompteng.flinkta.model;

import java.io.Serializable;

public class TaSignal implements Serializable {
  private String symbol;
  private long eventTs;
  private long ingestTs;
  private long seq;
  private boolean finalFlag;
  private long windowStart;
  private long windowEnd;
  private double open;
  private double high;
  private double low;
  private double close;
  private double volume;
  private double vwap;
  private double ema12;
  private double ema26;
  private double macd;
  private double macdSignal;
  private double macdHist;
  private double rsi14;
  private double bollMid;
  private double bollUpper;
  private double bollLower;
  private double vwapSession;
  private double vwapRolling;
  private Double spreadBps;
  private Double imbalance;
  private double realizedVolatility;
  private String sourceSeq;

  public TaSignal() {}

  public TaSignal(String symbol) {
    this.symbol = symbol;
  }

  public String getSymbol() { return symbol; }
  public void setSymbol(String symbol) { this.symbol = symbol; }
  public long getEventTs() { return eventTs; }
  public void setEventTs(long eventTs) { this.eventTs = eventTs; }
  public long getIngestTs() { return ingestTs; }
  public void setIngestTs(long ingestTs) { this.ingestTs = ingestTs; }
  public long getSeq() { return seq; }
  public void setSeq(long seq) { this.seq = seq; }
  public boolean isFinalFlag() { return finalFlag; }
  public void setFinalFlag(boolean finalFlag) { this.finalFlag = finalFlag; }
  public long getWindowStart() { return windowStart; }
  public void setWindowStart(long windowStart) { this.windowStart = windowStart; }
  public long getWindowEnd() { return windowEnd; }
  public void setWindowEnd(long windowEnd) { this.windowEnd = windowEnd; }
  public double getOpen() { return open; }
  public void setOpen(double open) { this.open = open; }
  public double getHigh() { return high; }
  public void setHigh(double high) { this.high = high; }
  public double getLow() { return low; }
  public void setLow(double low) { this.low = low; }
  public double getClose() { return close; }
  public void setClose(double close) { this.close = close; }
  public double getVolume() { return volume; }
  public void setVolume(double volume) { this.volume = volume; }
  public double getVwap() { return vwap; }
  public void setVwap(double vwap) { this.vwap = vwap; }
  public double getEma12() { return ema12; }
  public void setEma12(double ema12) { this.ema12 = ema12; }
  public double getEma26() { return ema26; }
  public void setEma26(double ema26) { this.ema26 = ema26; }
  public double getMacd() { return macd; }
  public void setMacd(double macd) { this.macd = macd; }
  public double getMacdSignal() { return macdSignal; }
  public void setMacdSignal(double macdSignal) { this.macdSignal = macdSignal; }
  public double getMacdHist() { return macdHist; }
  public void setMacdHist(double macdHist) { this.macdHist = macdHist; }
  public double getRsi14() { return rsi14; }
  public void setRsi14(double rsi14) { this.rsi14 = rsi14; }
  public double getBollMid() { return bollMid; }
  public void setBollMid(double bollMid) { this.bollMid = bollMid; }
  public double getBollUpper() { return bollUpper; }
  public void setBollUpper(double bollUpper) { this.bollUpper = bollUpper; }
  public double getBollLower() { return bollLower; }
  public void setBollLower(double bollLower) { this.bollLower = bollLower; }
  public double getVwapSession() { return vwapSession; }
  public void setVwapSession(double vwapSession) { this.vwapSession = vwapSession; }
  public double getVwapRolling() { return vwapRolling; }
  public void setVwapRolling(double vwapRolling) { this.vwapRolling = vwapRolling; }
  public Double getSpreadBps() { return spreadBps; }
  public void setSpreadBps(Double spreadBps) { this.spreadBps = spreadBps; }
  public Double getImbalance() { return imbalance; }
  public void setImbalance(Double imbalance) { this.imbalance = imbalance; }
  public double getRealizedVolatility() { return realizedVolatility; }
  public void setRealizedVolatility(double realizedVolatility) { this.realizedVolatility = realizedVolatility; }
  public String getSourceSeq() { return sourceSeq; }
  public void setSourceSeq(String sourceSeq) { this.sourceSeq = sourceSeq; }
}
