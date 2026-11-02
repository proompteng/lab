package ai.proompteng.dorvud.platform.observability;

import io.sentry.Sentry;
import io.sentry.SentryEvent;
import io.sentry.SentryLevel;
import io.sentry.SentryOptions;
import io.sentry.protocol.Message;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class ErrorTracking {
  private static final Set<String> COMPONENT_LOGGERS = Set.of(
      "market-data-archive", "market-feature-archive", "technical-market-features", "rolling-market-features",
      "crypto-market-features", "crypto-market-feature-archive", "crypto-market-data-archive",
      "options-ta-clickhouse", "ta-clickhouse", "parse-envelope", "parse-bars1m", "microbars", "ta-signals", "torghut-ta");
  private static boolean initialized;

  private ErrorTracking() {}

  public static synchronized boolean initialize() {
    if (initialized) return true;
    SentryOptions options = options(System.getenv());
    if (options == null) return false;
    Sentry.init(options);
    initialized = true;
    return true;
  }

  static SentryOptions options(Map<String, String> env) {
    String dsn = env.getOrDefault("DORVUD_GLITCHTIP_DSN", "").trim();
    if (dsn.isEmpty()) return null;
    URI endpoint;
    try {
      endpoint = URI.create(dsn);
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException("Dorvud GlitchTip DSN must use the internal ingestion service");
    }
    if (!"http".equals(endpoint.getScheme())
        || !"glitchtip-web.glitchtip.svc.cluster.local".equals(endpoint.getHost())
        || endpoint.getPort() != 80
        || endpoint.getRawQuery() != null
        || endpoint.getRawFragment() != null
        || endpoint.getUserInfo() == null
        || !endpoint.getUserInfo().matches("[0-9a-f]{32}")
        || !endpoint.getPath().matches("/[1-9][0-9]*")) {
      throw new IllegalArgumentException("Dorvud GlitchTip DSN must use the internal ingestion service");
    }
    String service = env.get("DORVUD_ERROR_SERVICE");
    if (service == null || !Set.of("torghut-ws", "torghut-ta", "market-data-archive").contains(service)) {
      throw new IllegalArgumentException("Dorvud error tracking requires a known service role");
    }
    String revision = env.get("torghut-ws".equals(service) ? "TORGHUT_WS_COMMIT" : "TORGHUT_TA_COMMIT");
    SentryOptions options = new SentryOptions();
    options.setDsn(dsn);
    if (revision != null && revision.matches("[0-9a-f]{40}")) options.setRelease(revision);
    options.setEnvironment("production");
    options.getDataCollection().setUserInfo(false);
    options.setEnableExternalConfiguration(false);
    options.setEnableAutoSessionTracking(false);
    options.setTracesSampleRate(0.0);
    options.setProfileSessionSampleRate(0.0);
    options.getLogs().setEnabled(false);
    options.setMaxBreadcrumbs(0);
    options.setBeforeBreadcrumb((breadcrumb, hint) -> null);
    options.setFlushTimeoutMillis(3000);
    options.setShutdownTimeoutMillis(3000);
    options.setBeforeSend((event, hint) -> sanitize(event, service));
    return options;
  }

  public static void capture(Throwable error, String logger) {
    if (!initialize()) return;
    SentryEvent event = error == null ? new SentryEvent() : new SentryEvent(error);
    event.setLevel(SentryLevel.ERROR);
    event.setLogger(logger);
    Sentry.captureEvent(event);
  }

  static SentryEvent sanitize(SentryEvent event, String service) {
    String logger = event.getLogger();
    if (logger == null
        || (!COMPONENT_LOGGERS.contains(logger)
            && !logger.matches("(?:ai\\.proompteng\\.dorvud|org\\.apache|com\\.clickhouse|io\\.netty)\\.[A-Za-z_$][A-Za-z0-9_$.]{0,180}"))) {
      logger = "unknown";
    }
    event.setLogger(logger);
    Message message = new Message();
    message.setFormatted("Dorvud application error");
    event.setMessage(message);
    event.setUser(null);
    event.setRequest(null);
    event.setExtras(null);
    event.setBreadcrumbs(null);
    event.setThreads(null);
    event.setThrowable(null);
    event.setTransaction(null);
    event.setUnknown(null);
    event.getContexts().clear();
    event.setTags(Map.of("service", service, "namespace", "torghut", "logger", logger));
    event.setFingerprints(List.of("{{ default }}", service, logger));
    if (event.getExceptions() != null) {
      for (var exception : event.getExceptions()) {
        exception.setValue("Message withheld: potentially sensitive runtime data");
        exception.setUnknown(null);
        if (exception.getMechanism() != null) exception.getMechanism().setData(null);
        if (exception.getStacktrace() == null || exception.getStacktrace().getFrames() == null) continue;
        for (var frame : exception.getStacktrace().getFrames()) {
          frame.setVars(null);
          frame.setContextLine(null);
          frame.setPreContext(null);
          frame.setPostContext(null);
          frame.setUnknown(null);
        }
      }
    }
    return event;
  }
}
