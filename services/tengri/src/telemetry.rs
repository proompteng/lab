use anyhow::Context as _;
use std::{env, sync::Arc, time::Duration};

use http::{HeaderMap, Request};
use opentelemetry::{
    KeyValue, global,
    propagation::Extractor,
    trace::{TraceContextExt, TracerProvider},
};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::{
    Resource,
    propagation::TraceContextPropagator,
    trace::{SdkTracerProvider, SpanData, SpanExporter},
};
use tracing::{Span, field};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::{EnvFilter, Layer, layer::SubscriberExt, util::SubscriberInitExt};

include!(concat!(env!("OUT_DIR"), "/rpc-paths.rs"));

fn technical_attribute(attribute: &KeyValue) -> bool {
    if attribute.key.as_str() == "http.request.method" {
        return matches!(&attribute.value, opentelemetry::Value::String(value) if matches!(value.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "CONNECT" | "TRACE"));
    }
    matches!(
        attribute.key.as_str(),
        "operation"
            | "db.system.name"
            | "http.response.status_code"
            | "rpc.grpc.status_code"
            | "sqlstate"
    )
}

fn error_events(metadata: &tracing::Metadata<'_>) -> sentry_tracing::EventFilter {
    match *metadata.level() {
        tracing::Level::ERROR => sentry_tracing::EventFilter::Event,
        _ => sentry_tracing::EventFilter::Ignore,
    }
}

#[derive(Debug)]
struct SanitizedExporter<E>(E);

impl<E: SpanExporter> SpanExporter for SanitizedExporter<E> {
    async fn export(&self, mut batch: Vec<SpanData>) -> opentelemetry_sdk::error::OTelSdkResult {
        for span in &mut batch {
            span.attributes.retain(technical_attribute);
            for event in &mut span.events.events {
                event.name = "application.event".into();
                event.attributes.retain(technical_attribute);
            }
            span.events
                .events
                .retain(|event| !event.attributes.is_empty());
            for link in &mut span.links.links {
                link.attributes.clear();
            }
            if matches!(span.status, opentelemetry::trace::Status::Error { .. }) {
                span.status = opentelemetry::trace::Status::error("Operation failed");
            }
        }
        self.0.export(batch).await
    }
    fn shutdown_with_timeout(&self, timeout: Duration) -> opentelemetry_sdk::error::OTelSdkResult {
        self.0.shutdown_with_timeout(timeout)
    }
    fn force_flush(&self) -> opentelemetry_sdk::error::OTelSdkResult {
        self.0.force_flush()
    }
    fn set_resource(&mut self, resource: &Resource) {
        self.0.set_resource(resource);
    }
}

pub struct Telemetry {
    _errors: sentry::ClientInitGuard,
    _traces: Option<SdkTracerProvider>,
}

const EXPORT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn init(service: &'static str) -> anyhow::Result<Telemetry> {
    global::set_text_map_propagator(TraceContextPropagator::new());
    let release = env::var("APP_SOURCE_REVISION").unwrap_or_else(|_| "development".into());
    let traces = env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        .ok()
        .map(|endpoint| {
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_http()
                .with_endpoint(endpoint)
                .with_timeout(EXPORT_TIMEOUT)
                .build()?;
            Ok::<_, anyhow::Error>(
                SdkTracerProvider::builder()
                    .with_batch_exporter(SanitizedExporter(exporter))
                    .with_resource(
                        Resource::builder_empty()
                            .with_attributes([
                                KeyValue::new("service.name", service),
                                KeyValue::new("service.namespace", "tengri"),
                                KeyValue::new("service.version", release.clone()),
                                KeyValue::new("deployment.environment.name", "production"),
                            ])
                            .build(),
                    )
                    .build(),
            )
        })
        .transpose()?;
    let tracer = traces.as_ref().map(|provider| provider.tracer(service));
    let mut options = sentry::ClientOptions::default();
    options.dsn = env::var("SENTRY_DSN")
        .ok()
        .map(|value| value.parse())
        .transpose()?;
    options.release = Some(release.into());
    options.environment = Some("production".into());
    options.send_default_pii = false;
    options.max_breadcrumbs = 0;
    options.before_send = Some(Arc::new(move |mut event| {
        let context = Span::current().context();
        let current = context.span();
        if current.span_context().is_valid() {
            event.tags.insert(
                "trace_id".into(),
                current.span_context().trace_id().to_string(),
            );
        }
        event.tags.insert("service".into(), service.into());
        for (context, tag) in [
            ("Rust Tracing Fields", "operation"),
            ("Rust Tracing Fields", "sqlstate"),
        ] {
            if let Some(sentry::protocol::Context::Other(fields)) = event.contexts.get(context)
                && let Some(value) = fields.get(tag).and_then(|value| value.as_str())
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
            {
                event.tags.insert(tag.into(), value.into());
            }
        }
        event.tags.remove("grpc_code");
        if let Some(sentry::protocol::Context::Other(fields)) =
            event.contexts.get("Rust Tracing Fields")
            && let Some(code) = fields.get("grpc_code").and_then(|value| value.as_i64())
            && (1..=16).contains(&code)
        {
            event.tags.insert("grpc_code".into(), code.to_string());
        }
        if let Some(sentry::protocol::Context::Other(location)) =
            event.contexts.get("Rust Tracing Location")
        {
            let file = location
                .get("file")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let line = location
                .get("line")
                .map(ToString::to_string)
                .unwrap_or_default();
            event.fingerprint = vec![service.into(), file.to_owned().into(), line.into()].into();
        }
        event.tags.retain(|key, _| {
            matches!(
                key.as_str(),
                "service" | "operation" | "sqlstate" | "trace_id" | "grpc_code"
            )
        });
        event.server_name = None;
        event.threads = Default::default();
        event.request = None;
        event.user = None;
        event.extra.clear();
        event.contexts.clear();
        event.breadcrumbs = Default::default();
        event.message = Some(
            event
                .tags
                .get("grpc_code")
                .and_then(|code| code.parse::<i32>().ok())
                .map(|code| format!("RPC operation failed ({:?})", tonic::Code::from_i32(code)))
                .unwrap_or_else(|| {
                    "Application operation failed; inspect the correlated trace".into()
                }),
        );
        for exception in &mut event.exception.values {
            exception.value = Some("Runtime message withheld".into());
            if let Some(stack) = &mut exception.stacktrace {
                for frame in &mut stack.frames {
                    frame.vars.clear();
                    frame.context_line = None;
                    frame.pre_context.clear();
                    frame.post_context.clear();
                }
            }
        }
        Some(event)
    }));
    let errors = sentry::init(options);
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().json().with_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        ))
        .with(tracer.map(|tracer| {
            tracing_opentelemetry::layer()
                .with_tracer(tracer)
                .with_filter(tracing_subscriber::filter::LevelFilter::INFO)
        }))
        .with(sentry_tracing::layer().event_filter(error_events))
        .try_init()?;
    Ok(Telemetry {
        _errors: errors,
        _traces: traces,
    })
}

struct Headers<'a>(&'a HeaderMap);

impl Extractor for Headers<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key)?.to_str().ok()
    }
    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|key| key.as_str()).collect()
    }
}

#[derive(Clone)]
pub struct RequestSpan;

impl<B> tower_http::trace::MakeSpan<B> for RequestSpan {
    fn make_span(&mut self, request: &Request<B>) -> Span {
        let path = request.uri().path();
        if matches!(path, "/livez" | "/readyz" | "/healthz" | "/metrics") {
            return Span::none();
        }
        let operation = RPC_PATHS
            .iter()
            .copied()
            .find(|candidate| *candidate == path)
            .or_else(|| {
                request
                    .extensions()
                    .get::<axum::extract::MatchedPath>()
                    .map(|path| path.as_str())
            })
            .unwrap_or("unmatched.request");
        let span = tracing::info_span!("request", otel.name = %operation, otel.kind = "server", operation = %operation,
            http.request.method = %request.method(), otel.status_code = field::Empty, http.response.status_code = field::Empty, rpc.grpc.status_code = field::Empty);
        let parent = global::get_text_map_propagator(|propagator| {
            propagator.extract(&Headers(request.headers()))
        });
        let _ = span.set_parent(parent);
        span
    }
}

pub fn inject<T>(request: &mut tonic::Request<T>) {
    let context = Span::current().context();
    global::get_text_map_propagator(|propagator| {
        let mut headers = std::collections::HashMap::new();
        propagator.inject_context(&context, &mut headers);
        for (key, value) in headers {
            if let (Ok(key), Ok(value)) = (
                key.parse::<tonic::metadata::MetadataKey<_>>(),
                value.parse(),
            ) {
                request.metadata_mut().insert(key, value);
            }
        }
    });
}

pub async fn response_trace_id(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let context = Span::current().context();
    let mut response = next.run(request).await;
    Span::current().record("http.response.status_code", response.status().as_u16());
    if response.status().is_server_error() {
        Span::current().record("otel.status_code", "ERROR");
    }
    if context.span().span_context().is_valid() {
        response.headers_mut().insert(
            "x-trace-id",
            context
                .span()
                .span_context()
                .trace_id()
                .to_string()
                .parse()
                .unwrap(),
        );
    }
    response
}

pub fn headers() -> HeaderMap {
    struct Carrier(HeaderMap);
    impl opentelemetry::propagation::Injector for Carrier {
        fn set(&mut self, key: &str, value: String) {
            if let (Ok(key), Ok(value)) = (key.parse::<http::header::HeaderName>(), value.parse()) {
                self.0.insert(key, value);
            }
        }
    }
    let mut carrier = Carrier(HeaderMap::new());
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&Span::current().context(), &mut carrier)
    });
    carrier.0
}

pub fn grpc_failure(
    failure: tower_http::classify::GrpcFailureClass,
    _latency: Duration,
    span: &Span,
) {
    let code = match failure {
        tower_http::classify::GrpcFailureClass::Code(code) => tonic::Code::from_i32(code.get()),
        tower_http::classify::GrpcFailureClass::Error(_) => tonic::Code::Unknown,
    };
    span.record("rpc.grpc.status_code", code as i64);
    span.record("otel.status_code", "ERROR");
    match code {
        tonic::Code::Cancelled
        | tonic::Code::InvalidArgument
        | tonic::Code::NotFound
        | tonic::Code::AlreadyExists
        | tonic::Code::PermissionDenied
        | tonic::Code::FailedPrecondition
        | tonic::Code::OutOfRange
        | tonic::Code::Unauthenticated => {
            tracing::info!(parent: span, grpc_code = code as i32, "RPC request rejected");
        }
        _ => tracing::error!(parent: span, grpc_code = code as i32, "RPC operation failed"),
    }
}

pub fn http_failure(
    _failure: tower_http::classify::ServerErrorsFailureClass,
    _latency: Duration,
    span: &Span,
) {
    span.record("otel.status_code", "ERROR");
    tracing::error!(parent: span, "HTTP operation failed");
}

impl Telemetry {
    pub fn verify(&self) -> anyhow::Result<serde_json::Value> {
        let client = sentry::Hub::current()
            .client()
            .ok_or_else(|| anyhow::anyhow!("GlitchTip is not configured"))?;
        anyhow::ensure!(client.is_enabled(), "GlitchTip is not configured");
        let provider = self
            ._traces
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("OTLP is not configured"))?;
        let span = tracing::info_span!("observability.verify", otel.kind = "internal");
        let (event_id, trace_id) = span.in_scope(|| {
            let event = sentry::protocol::Event {
                level: sentry::Level::Error,
                exception: vec![sentry::protocol::Exception {
                    ty: "SyntheticObservabilityCheck".into(),
                    value: Some("Controlled deployment verification".into()),
                    ..Default::default()
                }]
                .into(),
                ..Default::default()
            };
            let event_id = sentry::capture_event(event);
            let trace_id = Span::current()
                .context()
                .span()
                .span_context()
                .trace_id()
                .to_string();
            (event_id.to_string(), trace_id)
        });
        drop(span);
        anyhow::ensure!(
            trace_id != "00000000000000000000000000000000",
            "trace context is not initialized"
        );
        provider.force_flush().with_context(|| {
            format!("OTLP flush failed for trace {trace_id} and event {event_id}")
        })?;
        anyhow::ensure!(
            client.flush(Some(EXPORT_TIMEOUT)),
            "GlitchTip export did not flush for event {event_id} and trace {trace_id}"
        );
        Ok(
            serde_json::json!({"eventId": event_id, "traceId": trace_id, "release": env::var("APP_SOURCE_REVISION").unwrap_or_default()}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower_http::trace::MakeSpan;

    #[test]
    fn trace_exports_remove_dynamic_fields_and_unknown_rpc_paths() {
        #[derive(Clone, Debug)]
        struct Spans(Arc<std::sync::Mutex<Vec<SpanData>>>);
        impl SpanExporter for Spans {
            async fn export(
                &self,
                spans: Vec<SpanData>,
            ) -> opentelemetry_sdk::error::OTelSdkResult {
                self.0.lock().unwrap().extend(spans);
                Ok(())
            }
        }
        let exported = Spans(Arc::default());
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(SanitizedExporter(exported.clone()))
            .build();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("fixture")));
        tracing::subscriber::with_default(subscriber, || {
            let request = Request::builder()
                .uri("/proompteng.authz.v1.AuthorizationService/PRIVATE_SENTINEL")
                .method("PRIVATE_SENTINEL")
                .header("content-type", "application/grpc")
                .body(())
                .unwrap();
            let span = RequestSpan.make_span(&request);
            span.in_scope(|| {
                grpc_failure(
                    tower_http::classify::GrpcFailureClass::Code(14.try_into().unwrap()),
                    Duration::ZERO,
                    &span,
                );
                let nested = tracing::info_span!("db.policy.read", db.system.name = "postgresql", object.ref = "PRIVATE_SENTINEL");
                nested.in_scope(|| tracing::warn!(error = "PRIVATE_SENTINEL", sqlstate = "55P03", "database operation failed: PRIVATE_SENTINEL"));
                Span::current().set_status(opentelemetry::trace::Status::error("PRIVATE_SENTINEL"));
            });
        });
        provider.force_flush().unwrap();
        let spans = exported.0.lock().unwrap();
        assert_eq!(spans.len(), 2);
        assert!(
            spans
                .iter()
                .flat_map(|span| &span.attributes)
                .any(|attribute| {
                    attribute.key.as_str() == "rpc.grpc.status_code"
                        && attribute.value == opentelemetry::Value::I64(14)
                })
        );
        let data = format!("{spans:?}");
        assert!(
            !data.contains("PRIVATE_SENTINEL"),
            "dynamic data leaked into trace export"
        );
        assert!(data.contains("55P03"));
        assert!(data.contains("db.policy.read"));
        assert!(data.contains("postgresql"));
        assert!(RPC_PATHS.contains(&"/proompteng.authz.v1.AuthorizationService/Check"));
    }

    #[test]
    fn routine_warnings_and_rpc_rejections_do_not_emit_glitchtip_events() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Events(AtomicUsize);
        impl sentry::Transport for Events {
            fn send_envelope(&self, envelope: sentry::Envelope) {
                for item in envelope.items() {
                    if let sentry::protocol::EnvelopeItem::Event(event) = item {
                        assert!(!format!("{event:?}").contains("PRIVATE_SENTINEL"));
                        self.0.fetch_add(1, Ordering::SeqCst);
                    }
                }
            }
        }
        let events = Arc::new(Events(AtomicUsize::new(0)));
        let mut options = sentry::ClientOptions::default();
        options.dsn = Some(
            "https://0123456789abcdef0123456789abcdef@example.invalid/1"
                .parse()
                .unwrap(),
        );
        options.transport = Some(Arc::new(events.clone()));
        let client = Arc::new(sentry::Client::from_config(options));
        let hub = Arc::new(sentry::Hub::new(Some(client.clone()), Arc::default()));
        let subscriber =
            tracing_subscriber::registry().with(sentry_tracing::layer().event_filter(error_events));
        sentry::Hub::run(hub, || {
            tracing::subscriber::with_default(subscriber, || {
                tracing::warn!("shutdown signal received");
                tracing::info!("startup complete");
                tracing::error!("application operation failed");
                let mut expected = 1;
                for code in 1..=16 {
                    grpc_failure(
                        tower_http::classify::GrpcFailureClass::Code(code.try_into().unwrap()),
                        Duration::ZERO,
                        &Span::none(),
                    );
                    expected += usize::from(matches!(code, 2 | 4 | 8 | 10 | 12 | 13 | 14 | 15));
                    assert!(client.flush(Some(Duration::from_secs(3))));
                    assert_eq!(
                        events.0.load(Ordering::SeqCst),
                        expected,
                        "gRPC code {code}"
                    );
                }
                grpc_failure(
                    tower_http::classify::GrpcFailureClass::Error("PRIVATE_SENTINEL".into()),
                    Duration::ZERO,
                    &Span::none(),
                );
            });
        });
        assert!(client.flush(Some(Duration::from_secs(3))));
        assert_eq!(events.0.load(Ordering::SeqCst), 10);
    }

    #[tokio::test]
    async fn http_failure_emits_one_error_event() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tower::ServiceExt;
        use tracing::instrument::WithSubscriber;

        struct ErrorCount(Arc<AtomicUsize>);
        impl<S: tracing::Subscriber> Layer<S> for ErrorCount {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                if *event.metadata().level() == tracing::Level::ERROR {
                    self.0.fetch_add(1, Ordering::SeqCst);
                }
            }
        }

        let errors = Arc::new(AtomicUsize::new(0));
        let subscriber = tracing_subscriber::registry().with(ErrorCount(errors.clone()));
        let router = axum::Router::new()
            .route(
                "/fixture",
                axum::routing::get(|| async { http::StatusCode::SERVICE_UNAVAILABLE }),
            )
            .layer(axum::middleware::from_fn(response_trace_id))
            .layer(
                tower_http::trace::TraceLayer::new_for_http()
                    .make_span_with(RequestSpan)
                    .on_failure(http_failure),
            );
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/fixture")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .with_subscriber(subscriber)
            .await
            .unwrap();
        assert_eq!(response.status(), http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(errors.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn request_trace_parent_crosses_the_tonic_metadata_boundary() {
        global::set_text_map_propagator(TraceContextPropagator::new());
        let provider = SdkTracerProvider::builder().build();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("fixture")));
        tracing::subscriber::with_default(subscriber, || {
            let request = Request::builder()
                .uri("/proompteng.authz.v1.AuthorizationService/Check")
                .header(
                    "traceparent",
                    "00-11111111111111111111111111111111-2222222222222222-01",
                )
                .header("authorization", "PRIVATE_SENTINEL")
                .body(())
                .unwrap();
            let span = RequestSpan.make_span(&request);
            span.in_scope(|| {
                let mut outgoing = tonic::Request::new(());
                inject(&mut outgoing);
                let parent = outgoing
                    .metadata()
                    .get("traceparent")
                    .unwrap()
                    .to_str()
                    .unwrap();
                assert!(parent.starts_with("00-11111111111111111111111111111111-"));
                assert!(!parent.contains("2222222222222222"));
                assert!(outgoing.metadata().get("authorization").is_none());
            });
            assert!(
                RequestSpan
                    .make_span(&Request::builder().uri("/readyz").body(()).unwrap())
                    .is_disabled()
            );
        });
    }
}
