package ai.proompteng.graf.telemetry

import com.google.protobuf.ByteString
import io.opentelemetry.api.baggage.propagation.W3CBaggagePropagator
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.metrics.DoubleHistogram
import io.opentelemetry.api.metrics.LongCounter
import io.opentelemetry.api.metrics.Meter
import io.opentelemetry.api.trace.Span
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.api.trace.Tracer
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator
import io.opentelemetry.context.Context
import io.opentelemetry.context.Scope
import io.opentelemetry.context.propagation.ContextPropagators
import io.opentelemetry.context.propagation.TextMapGetter
import io.opentelemetry.context.propagation.TextMapPropagator
import io.opentelemetry.context.propagation.TextMapSetter
import io.opentelemetry.exporter.otlp.http.logs.OtlpHttpLogRecordExporter
import io.opentelemetry.exporter.otlp.http.metrics.OtlpHttpMetricExporter
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.logs.SdkLoggerProvider
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessor
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.metrics.export.PeriodicMetricReader
import io.opentelemetry.sdk.resources.Resource
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor
import io.temporal.api.common.v1.Payload
import io.temporal.common.context.ContextPropagator
import java.time.Duration
import java.util.Locale
import java.util.function.Supplier

private const val DEFAULT_METRIC_EXPORT_INTERVAL_MS = 10_000L
private val DEFAULT_TRACE_ENDPOINT = "http://localhost:4318/v1/traces"
private val DEFAULT_METRIC_ENDPOINT = "http://localhost:4318/v1/metrics"
private val DEFAULT_LOG_ENDPOINT = "http://localhost:4318/v1/logs"

object GrafTelemetry {
  private val serviceName = System.getenv("OTEL_SERVICE_NAME")?.takeIf { it.isNotBlank() } ?: "graf"
  private val serviceNamespace =
    System.getenv("OTEL_SERVICE_NAMESPACE")?.takeIf { it.isNotBlank() } ?: "graf"
  private val serviceVersion = System.getenv("GRAF_VERSION")?.takeIf { it.isNotBlank() } ?: "dev"
  private val headerSupplier: Supplier<Map<String, String>> = Supplier { parseHeaders() }
  private val resource = Resource.getDefault().merge(Resource.create(buildResourceAttributes()))
  private val sampler = samplerFromEnv()
  private val spanExporter = buildSpanExporter()
  private val tracerProvider =
    SdkTracerProvider
      .builder()
      .setSampler(sampler)
      .setResource(resource)
      .addSpanProcessor(BatchSpanProcessor.builder(spanExporter).build())
      .build()
  private val metricExporter = buildMetricExporter()
  private val metricReader =
    PeriodicMetricReader.builder(metricExporter).setInterval(Duration.ofMillis(metricExportInterval())).build()
  private val meterProvider =
    SdkMeterProvider
      .builder()
      .setResource(resource)
      .registerMetricReader(metricReader)
      .build()
  private val logExporter = buildLogExporter()
  private val loggerProvider =
    SdkLoggerProvider
      .builder()
      .setResource(resource)
      .addLogRecordProcessor(BatchLogRecordProcessor.builder(logExporter).build())
      .build()
  private val openTelemetrySdk =
    OpenTelemetrySdk
      .builder()
      .setTracerProvider(tracerProvider)
      .setMeterProvider(meterProvider)
      .setLoggerProvider(loggerProvider)
      .setPropagators(
        ContextPropagators.create(
          TextMapPropagator.composite(
            W3CTraceContextPropagator.getInstance(),
            W3CBaggagePropagator.getInstance(),
          ),
        ),
      ).buildAndRegisterGlobal()

  val openTelemetry: OpenTelemetrySdk
    get() = openTelemetrySdk
  val tracer: Tracer = openTelemetry.getTracer("ai.proompteng.graf")
  val meter: Meter = openTelemetry.getMeter("ai.proompteng.graf")

  private val httpRequestCounter: LongCounter =
    meter
      .counterBuilder("graf_http_server_requests_count")
      .setDescription("total HTTP requests")
      .setUnit("1")
      .build()

  private val httpRequestDuration: DoubleHistogram =
    meter
      .histogramBuilder("graf_http_server_request_duration_ms")
      .setDescription("HTTP request latency")
      .setUnit("ms")
      .build()

  private val neo4jWriteCounter: LongCounter =
    meter
      .counterBuilder("graf_neo4j_write_count")
      .setDescription("Neo4j write operations")
      .setUnit("1")
      .build()

  private val neo4jWriteLatency: DoubleHistogram =
    meter
      .histogramBuilder("graf_neo4j_write_duration_ms")
      .setDescription("Neo4j write latency")
      .setUnit("ms")
      .build()

  private val batchSizeHistogram: DoubleHistogram =
    meter
      .histogramBuilder("graf_graph_batch_size")
      .setDescription("Payload batch size")
      .setUnit("1")
      .build()

  private val graphBatchDuration: DoubleHistogram =
    meter
      .histogramBuilder("graf_graph_batch_duration_ms")
      .setDescription("Full batch execution latency")
      .setUnit("ms")
      .build()

  private val graphBatchRecords: LongCounter =
    meter
      .counterBuilder("graf_graph_batch_records_total")
      .setDescription("Records processed per graph batch")
      .setUnit("1")
      .build()

  private val workflowCounter: LongCounter =
    meter
      .counterBuilder("graf_codex_workflows_started")
      .setDescription("Codex workflow launches")
      .setUnit("1")
      .build()

  private val artifactFetchLatency: DoubleHistogram =
    meter
      .histogramBuilder("graf_artifact_fetch_duration_ms")
      .setDescription("MinIO artifact fetch latency")
      .setUnit("ms")
      .build()

  fun shutdown() {
    openTelemetrySdk.close()
  }

  suspend fun <T> withSpan(
    name: String,
    attributes: Attributes = Attributes.empty(),
    block: suspend () -> T,
  ): T {
    val span = tracer.spanBuilder(name).setAllAttributes(attributes).startSpan()
    span.makeCurrent().use {
      return try {
        block()
      } catch (error: Throwable) {
        span.recordException(error)
        span.setStatus(StatusCode.ERROR)
        throw error
      } finally {
        span.end()
      }
    }
  }

  fun recordHttpRequest(
    method: String,
    statusCode: Int,
    durationMs: Long,
    route: String,
  ) {
    val attributes =
      Attributes
        .builder()
        .put(AttributeKey.stringKey("http.method"), method)
        .put(AttributeKey.longKey("http.status_code"), statusCode.toLong())
        .put(AttributeKey.stringKey("http.route"), route)
        .build()
    httpRequestCounter.add(1, attributes)
    httpRequestDuration.record(durationMs.toDouble(), attributes)
  }

  fun recordNeo4jWrite(
    durationMs: Long,
    operation: String,
    database: String?,
  ) {
    val attributes = Attributes.builder().put(AttributeKey.stringKey("db.operation"), operation)
    database?.let { attributes.put(AttributeKey.stringKey("db.name"), it) }
    val attrs = attributes.build()
    neo4jWriteCounter.add(1, attrs)
    neo4jWriteLatency.record(durationMs.toDouble(), attrs)
  }

  fun recordBatchSize(
    batchSize: Int,
    _artifactId: String?,
    researchSource: String?,
  ) {
    val builder =
      Attributes
        .builder()
        .put(AttributeKey.longKey("graf.batch.size"), batchSize.toLong())
    researchSource?.let { builder.put(AttributeKey.stringKey("research.source"), it) }
    val attributes = builder.build()
    batchSizeHistogram.record(batchSize.toDouble(), attributes)
  }

  fun recordGraphBatch(
    durationMs: Long,
    recordCount: Int,
    operation: String,
    artifactId: String?,
    researchSource: String?,
  ) {
    val attributes =
      Attributes
        .builder()
        .put(AttributeKey.stringKey("graf.batch.operation"), operation)
        .put(AttributeKey.longKey("graf.batch.record.count"), recordCount.toLong())
        .apply {
          artifactId?.let { put(AttributeKey.stringKey("artifact.id"), it) }
          researchSource?.let { put(AttributeKey.stringKey("research.source"), it) }
        }
        .build()
    graphBatchDuration.record(durationMs.toDouble(), attributes)
    graphBatchRecords.add(recordCount.toLong(), attributes)
  }

  fun recordWorkflowLaunch(
    _artifactKey: String,
    _codexWorkflow: String,
    _metadata: Map<String, String>,
  ) {
    workflowCounter.add(1)
  }

  fun recordArtifactFetch(
    durationMs: Long,
    _reference: String,
    bucket: String,
  ) {
    val attrs =
      Attributes
        .builder()
        .put(AttributeKey.stringKey("artifact.bucket"), bucket)
        .build()
    artifactFetchLatency.record(durationMs.toDouble(), attrs)
  }

  fun currentTraceId(): String? {
    val spanContext = Span.current().spanContext
    return spanContext.traceId.takeIf { spanContext.isValid }
  }

  fun currentSpanId(): String? {
    val spanContext = Span.current().spanContext
    return spanContext.spanId.takeIf { spanContext.isValid }
  }

  fun openTelemetryContextPropagator(): ContextPropagator = OpenTelemetryContextPropagator(openTelemetry)

  private fun buildSpanExporter(): OtlpHttpSpanExporter =
    OtlpHttpSpanExporter
      .builder()
      .setEndpoint(endpointForSignal("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", DEFAULT_TRACE_ENDPOINT))
      .setTimeout(Duration.ofSeconds(10))
      .setHeaders(headerSupplier)
      .build()

  private fun buildMetricExporter(): OtlpHttpMetricExporter =
    OtlpHttpMetricExporter
      .builder()
      .setEndpoint(endpointForSignal("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", DEFAULT_METRIC_ENDPOINT))
      .setTimeout(Duration.ofSeconds(10))
      .setHeaders(headerSupplier)
      .build()

  private fun buildLogExporter(): OtlpHttpLogRecordExporter =
    OtlpHttpLogRecordExporter
      .builder()
      .setEndpoint(endpointForSignal("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", DEFAULT_LOG_ENDPOINT))
      .setTimeout(Duration.ofSeconds(10))
      .setHeaders(headerSupplier)
      .build()

  private fun endpointForSignal(
    signal: String,
    fallback: String,
  ): String {
    val explicit = System.getenv(signal)
    if (!explicit.isNullOrBlank()) {
      return explicit
    }
    return System.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")?.takeIf(String::isNotBlank) ?: fallback
  }

  private fun metricExportInterval(): Long =
    System.getenv("OTEL_METRIC_EXPORT_INTERVAL")?.toLongOrNull() ?: DEFAULT_METRIC_EXPORT_INTERVAL_MS

  private fun buildResourceAttributes(): Attributes {
    val builder = Attributes.builder()
    builder.put(AttributeKey.stringKey("service.name"), serviceName)
    builder.put(AttributeKey.stringKey("service.namespace"), serviceNamespace)
    builder.put(AttributeKey.stringKey("service.version"), serviceVersion)
    parseResourceAttributes().forEach { (key, value) -> builder.put(AttributeKey.stringKey(key), value) }
    return builder.build()
  }

  private fun parseResourceAttributes(): Map<String, String> =
    System
      .getenv("OTEL_RESOURCE_ATTRIBUTES")
      ?.split(',')
      ?.mapNotNull { part ->
        part.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0].trim() to it[1].trim() }
      }?.filter { it.first.isNotEmpty() && it.second.isNotEmpty() }
      ?.toMap()
      ?: emptyMap()

  private fun samplerFromEnv(): io.opentelemetry.sdk.trace.samplers.Sampler {
    val samplerName = System.getenv("OTEL_TRACES_SAMPLER")?.lowercase(Locale.getDefault()) ?: "parentbased_traceidratio"
    val samplerArg = System.getenv("OTEL_TRACES_SAMPLER_ARG")?.toDoubleOrNull() ?: 0.2
    return when (samplerName) {
      "always_off" ->
        io.opentelemetry.sdk.trace.samplers.Sampler
          .alwaysOff()
      "always_on" ->
        io.opentelemetry.sdk.trace.samplers.Sampler
          .alwaysOn()
      "traceidratio", "ratio" ->
        io.opentelemetry.sdk.trace.samplers.Sampler
          .traceIdRatioBased(samplerArg)
      "parentbased", "parentbased_traceidratio" ->
        io.opentelemetry.sdk.trace.samplers.Sampler.parentBased(
          io.opentelemetry.sdk.trace.samplers.Sampler
            .traceIdRatioBased(samplerArg),
        )
      else ->
        io.opentelemetry.sdk.trace.samplers.Sampler.parentBased(
          io.opentelemetry.sdk.trace.samplers.Sampler
            .traceIdRatioBased(samplerArg),
        )
    }
  }

  private fun parseHeaders(): Map<String, String> =
    System
      .getenv("OTEL_EXPORTER_OTLP_HEADERS")
      ?.split(',')
      ?.mapNotNull { raw ->
        raw.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0].trim() to it[1].trim() }
      }?.filter { it.first.isNotBlank() && it.second.isNotBlank() }
      ?.associate { it.first to it.second }
      ?: emptyMap()
}

private class OpenTelemetryContextPropagator(
  private val openTelemetry: OpenTelemetrySdk,
) : ContextPropagator {
  private val propagator = openTelemetry.propagators.textMapPropagator
  private val scopeHolder = ThreadLocal<Scope?>()

  override fun getName(): String = "openTelemetry"

  override fun serializeContext(current: Any): Map<String, Payload> {
    val context = (current as? Context) ?: Context.current()
    val carrier = mutableMapOf<String, String>()
    propagator.inject(context, carrier, setter)
    return carrier.mapValues { (_, value) -> Payload.newBuilder().setData(ByteString.copyFromUtf8(value)).build() }
  }

  override fun deserializeContext(carrier: Map<String, Payload>): Any {
    val headerMap = carrier.mapValues { (_, payload) -> payload.data.toStringUtf8() }
    return propagator.extract(Context.root(), headerMap, getter)
  }

  override fun getCurrentContext(): Any = Context.current()

  override fun setCurrentContext(value: Any) {
    scopeHolder.get()?.close()
    val context = value as? Context
    scopeHolder.set(context?.makeCurrent())
  }

  companion object {
    private val setter =
      object : TextMapSetter<MutableMap<String, String>> {
        override fun set(
          carrier: MutableMap<String, String>?,
          key: String,
          value: String,
        ) {
          carrier?.put(key, value)
        }
      }

    private val getter =
      object : TextMapGetter<Map<String, String>> {
        override fun keys(carrier: Map<String, String>): MutableIterable<String> = carrier.keys.toMutableList()

        override fun get(
          carrier: Map<String, String>?,
          key: String,
        ): String? = carrier?.get(key)
      }
  }
}
