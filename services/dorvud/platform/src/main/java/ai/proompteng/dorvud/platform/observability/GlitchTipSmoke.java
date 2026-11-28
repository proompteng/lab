package ai.proompteng.dorvud.platform.observability;

import io.sentry.Sentry;
import org.slf4j.LoggerFactory;

public final class GlitchTipSmoke {
  private GlitchTipSmoke() {}

  public static void main(String[] args) {
    var logger = LoggerFactory.getLogger(GlitchTipSmoke.class);
    if (!ErrorTracking.initialize()) throw new IllegalStateException("GlitchTip smoke requires its configured DSN");
    logger.error("Synthetic GlitchTip logging integration smoke", new IllegalStateException("Synthetic GlitchTip smoke"));
    logger.error("Synthetic GlitchTip log-only integration smoke");
    Sentry.flush(3000);
    Sentry.close();
  }
}
