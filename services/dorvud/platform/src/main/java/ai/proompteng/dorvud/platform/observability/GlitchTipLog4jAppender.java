package ai.proompteng.dorvud.platform.observability;

import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.Filter;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.apache.logging.log4j.core.config.plugins.Plugin;
import org.apache.logging.log4j.core.config.plugins.PluginAttribute;
import org.apache.logging.log4j.core.config.plugins.PluginElement;
import org.apache.logging.log4j.core.config.plugins.PluginFactory;

@Plugin(name = "DorvudGlitchTip", category = "Core", elementType = "appender", printObject = true)
public final class GlitchTipLog4jAppender extends AbstractAppender {
  private GlitchTipLog4jAppender(String name, Filter filter) {
    super(name, filter, null, true, Property.EMPTY_ARRAY);
  }

  @PluginFactory
  public static GlitchTipLog4jAppender create(
      @PluginAttribute("name") String name, @PluginElement("Filter") Filter filter) {
    return new GlitchTipLog4jAppender(name, filter);
  }

  @Override
  public void start() {
    ErrorTracking.initialize();
    super.start();
  }

  @Override
  public void append(LogEvent event) {
    if (event.getLevel().isMoreSpecificThan(Level.ERROR)) {
      ErrorTracking.capture(event.getThrown(), event.getLoggerName());
    }
  }
}
