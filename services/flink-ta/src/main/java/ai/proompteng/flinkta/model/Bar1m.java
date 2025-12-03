package ai.proompteng.flinkta.model;

import java.io.Serializable;

public class Bar1m implements Serializable {
  private String symbol;
  private long eventTs;
  private double open;
  private double high;
  private double low;
  private double close;
  private double volume;
  private boolean finalFlag;

  public Bar1m() {}

  public Bar1m(String symbol, long eventTs, double open, double high, double low, double close, double volume, boolean finalFlag) {
    this.symbol = symbol;
    this.eventTs = eventTs;
    this.open = open;
    this.high = high;
    this.low = low;
    this.close = close;
    this.volume = volume;
    this.finalFlag = finalFlag;
  }

  public String getSymbol() {
    return symbol;
  }

  public void setSymbol(String symbol) {
    this.symbol = symbol;
  }

  public long getEventTs() {
    return eventTs;
  }

  public void setEventTs(long eventTs) {
    this.eventTs = eventTs;
  }

  public double getOpen() {
    return open;
  }

  public void setOpen(double open) {
    this.open = open;
  }

  public double getHigh() {
    return high;
  }

  public void setHigh(double high) {
    this.high = high;
  }

  public double getLow() {
    return low;
  }

  public void setLow(double low) {
    this.low = low;
  }

  public double getClose() {
    return close;
  }

  public void setClose(double close) {
    this.close = close;
  }

  public double getVolume() {
    return volume;
  }

  public void setVolume(double volume) {
    this.volume = volume;
  }

  public boolean isFinalFlag() {
    return finalFlag;
  }

  public void setFinalFlag(boolean finalFlag) {
    this.finalFlag = finalFlag;
  }
}
