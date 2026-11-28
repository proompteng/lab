package ai.proompteng.dorvud.platform.observability;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.ThrowableProxy;
import ch.qos.logback.core.AppenderBase;

public final class GlitchTipLogbackAppender extends AppenderBase<ILoggingEvent> {
  @Override
  public void start() {
    ErrorTracking.initialize();
    super.start();
  }

  @Override
  protected void append(ILoggingEvent event) {
    if (!event.getLevel().isGreaterOrEqual(Level.ERROR)) return;
    Throwable error = event.getThrowableProxy() instanceof ThrowableProxy proxy ? proxy.getThrowable() : null;
    ErrorTracking.capture(error, event.getLoggerName());
  }
}
