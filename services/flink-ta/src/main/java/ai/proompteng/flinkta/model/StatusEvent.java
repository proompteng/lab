package ai.proompteng.flinkta.model;

import java.io.Serializable;

public class StatusEvent implements Serializable {
  public enum Level { INFO, WARN, ERROR }

  private String component;
  private Level level;
  private String message;
  private long eventTs;
  private long ingestTs;

  public StatusEvent() {}

  public StatusEvent(String component, Level level, String message, long eventTs, long ingestTs) {
    this.component = component;
    this.level = level;
    this.message = message;
    this.eventTs = eventTs;
    this.ingestTs = ingestTs;
  }

  public String getComponent() { return component; }
  public void setComponent(String component) { this.component = component; }
  public Level getLevel() { return level; }
  public void setLevel(Level level) { this.level = level; }
  public String getMessage() { return message; }
  public void setMessage(String message) { this.message = message; }
  public long getEventTs() { return eventTs; }
  public void setEventTs(long eventTs) { this.eventTs = eventTs; }
  public long getIngestTs() { return ingestTs; }
  public void setIngestTs(long ingestTs) { this.ingestTs = ingestTs; }
}
