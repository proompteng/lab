package ai.proompteng.flinkta.model;

import java.io.Serializable;

public class Quote implements Serializable {
  private String symbol;
  private long eventTs;
  private double bidPrice;
  private double askPrice;
  private double bidSize;
  private double askSize;
  private boolean finalFlag;

  public Quote() {}

  public Quote(String symbol, long eventTs, double bidPrice, double askPrice, double bidSize, double askSize, boolean finalFlag) {
    this.symbol = symbol;
    this.eventTs = eventTs;
    this.bidPrice = bidPrice;
    this.askPrice = askPrice;
    this.bidSize = bidSize;
    this.askSize = askSize;
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

  public double getBidPrice() {
    return bidPrice;
  }

  public void setBidPrice(double bidPrice) {
    this.bidPrice = bidPrice;
  }

  public double getAskPrice() {
    return askPrice;
  }

  public void setAskPrice(double askPrice) {
    this.askPrice = askPrice;
  }

  public double getBidSize() {
    return bidSize;
  }

  public void setBidSize(double bidSize) {
    this.bidSize = bidSize;
  }

  public double getAskSize() {
    return askSize;
  }

  public void setAskSize(double askSize) {
    this.askSize = askSize;
  }

  public boolean isFinalFlag() {
    return finalFlag;
  }

  public void setFinalFlag(boolean finalFlag) {
    this.finalFlag = finalFlag;
  }
}
