package ai.proompteng.graf.telemetry

@Target(AnnotationTarget.FUNCTION, AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class GrafRouteTemplate(val value: String)
