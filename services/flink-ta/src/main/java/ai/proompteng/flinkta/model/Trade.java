package ai.proompteng.flinkta.model;

import java.io.Serializable;

public class Trade implements Serializable {
  private String symbol;
  private long eventTs;
  private double price;
  private double size;
  private String tradeId;
  private boolean finalFlag;
  private String sourceSeq;

  public Trade() {}

  public Trade(String symbol, long eventTs, double price, double size, String tradeId, boolean finalFlag) {
    this.symbol = symbol;
    this.eventTs = eventTs;
    this.price = price;
    this.size = size;
    this.tradeId = tradeId;
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

  public double getPrice() {
    return price;
  }

  public void setPrice(double price) {
    this.price = price;
  }

  public double getSize() {
    return size;
  }

  public void setSize(double size) {
    this.size = size;
  }

  public String getTradeId() {
    return tradeId;
  }

  public void setTradeId(String tradeId) {
    this.tradeId = tradeId;
  }

  public boolean isFinalFlag() {
    return finalFlag;
  }

  public void setFinalFlag(boolean finalFlag) {
    this.finalFlag = finalFlag;
  }

  public String getSourceSeq() {
    return sourceSeq;
  }

  public void setSourceSeq(String sourceSeq) {
    this.sourceSeq = sourceSeq;
  }

  @Override
  public String toString() {
    return "Trade{" +
        "symbol='" + symbol + '\'' +
        ", eventTs=" + eventTs +
        ", price=" + price +
        ", size=" + size +
        ", tradeId='" + tradeId + '\'' +
        ", finalFlag=" + finalFlag +
        '}';
  }
}
