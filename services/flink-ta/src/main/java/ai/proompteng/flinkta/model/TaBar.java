package ai.proompteng.flinkta.model;

import java.io.Serializable;

public class TaBar implements Serializable {
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
  private int tradeCount;
  private Double spreadBps;
  private Double imbalance;
  private String sourceSeq;

  public TaBar() {}

  public TaBar(
      String symbol,
      long eventTs,
      long ingestTs,
      long seq,
      boolean finalFlag,
      long windowStart,
      long windowEnd,
      double open,
      double high,
      double low,
      double close,
      double volume,
      double vwap,
      int tradeCount) {
    this.symbol = symbol;
    this.eventTs = eventTs;
    this.ingestTs = ingestTs;
    this.seq = seq;
    this.finalFlag = finalFlag;
    this.windowStart = windowStart;
    this.windowEnd = windowEnd;
    this.open = open;
    this.high = high;
    this.low = low;
    this.close = close;
    this.volume = volume;
    this.vwap = vwap;
    this.tradeCount = tradeCount;
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
  public int getTradeCount() { return tradeCount; }
  public void setTradeCount(int tradeCount) { this.tradeCount = tradeCount; }
  public Double getSpreadBps() { return spreadBps; }
  public void setSpreadBps(Double spreadBps) { this.spreadBps = spreadBps; }
  public Double getImbalance() { return imbalance; }
  public void setImbalance(Double imbalance) { this.imbalance = imbalance; }
  public String getSourceSeq() { return sourceSeq; }
  public void setSourceSeq(String sourceSeq) { this.sourceSeq = sourceSeq; }
}
