use std::collections::HashMap;
use std::convert::TryFrom;
use std::ffi::c_void;
use std::net::SocketAddr;
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use prost::Message;
use serde::Deserialize;
use temporal_client::{
    tonic::IntoRequest, ClientOptionsBuilder, ConfiguredClient, Namespace, RetryClient,
    TemporalServiceClient, WorkflowService,
};
use temporal_sdk_core::{
    telemetry::{build_otlp_metric_exporter, start_prometheus_metric_exporter},
    CoreRuntime, TokioRuntimeBuilder,
};
use temporal_sdk_core_api::telemetry::{
    metrics::CoreMeter, HistogramBucketOverrides, MetricTemporality, OtelCollectorOptionsBuilder,
    OtlpProtocol, PrometheusExporterOptions, PrometheusExporterOptionsBuilder, TelemetryOptions,
};
use temporal_sdk_core_protos::temporal::api::enums::v1::WorkflowExecutionStatus;
use thiserror::Error;
use tokio::task::AbortHandle;
use url::Url;

mod byte_array;
mod error;
mod metadata;
mod pending;
mod request;

type PendingClientHandle = pending::PendingResult<ClientHandle>;

#[repr(C)]
pub struct RuntimeHandle {
    runtime: Arc<CoreRuntime>,
    prometheus_abort: Option<AbortHandle>,
    prometheus_config: Option<PrometheusTelemetryPayload>,
}

#[repr(C)]
pub struct ClientHandle {
    runtime: Arc<CoreRuntime>,
    client: RetryClient<ConfiguredClient<TemporalServiceClient>>,
    namespace: String,
    identity: String,
}

#[derive(Debug, Deserialize)]
struct ClientConfig {
    address: String,
    namespace: String,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default)]
    client_version: Option<String>,
    #[serde(default, alias = "apiKey")]
    api_key: Option<String>,
    #[serde(default, alias = "allowInsecureTls")]
    allow_insecure_tls: Option<bool>,
    #[serde(default)]
    tls: Option<ClientTlsConfigPayload>,
}

#[derive(Clone, Debug, Deserialize)]
struct ClientTlsConfigPayload {
    #[serde(default, alias = "serverRootCACertificate")]
    server_root_ca_cert: Option<String>,
    #[serde(default, alias = "clientCert")]
    client_cert: Option<String>,
    #[serde(default, alias = "clientPrivateKey")]
    client_private_key: Option<String>,
    #[serde(default, alias = "serverNameOverride")]
    server_name_override: Option<String>,
    #[serde(default, alias = "clientCertPair", alias = "client_cert_pair")]
    client_cert_pair: Option<ClientCertPairPayload>,
}

#[derive(Debug, Deserialize)]
struct DescribeNamespaceRequestPayload {
    namespace: String,
}

#[derive(Debug, Deserialize)]
struct StartWorkflowRequestPayload {
    #[serde(default)]
    namespace: Option<String>,
    workflow_id: String,
    workflow_type: String,
    task_queue: String,
    #[serde(default)]
    args: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    memo: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    search_attributes: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    headers: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    cron_schedule: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    workflow_execution_timeout_ms: Option<u64>,
    #[serde(default)]
    workflow_run_timeout_ms: Option<u64>,
    #[serde(default)]
    workflow_task_timeout_ms: Option<u64>,
    #[serde(default)]
    retry_policy: Option<RetryPolicyPayload>,
}

#[derive(Debug, Deserialize)]
struct SignalWithStartRequestPayload {
    #[serde(flatten)]
    start: StartWorkflowRequestPayload,
    signal_name: String,
    #[serde(default)]
    signal_args: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
struct RetryPolicyPayload {
    #[serde(default)]
    initial_interval_ms: Option<u64>,
    #[serde(default)]
    maximum_interval_ms: Option<u64>,
    #[serde(default)]
    maximum_attempts: Option<i32>,
    #[serde(default)]
    backoff_coefficient: Option<f64>,
    #[serde(default)]
    non_retryable_error_types: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct QueryWorkflowRequestPayload {
    #[serde(default)]
    namespace: Option<String>,
    workflow_id: String,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    first_execution_run_id: Option<String>,
    query_name: String,
    #[serde(default)]
    args: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryUpdatePayload {
    metrics: MetricsExporterPayload,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum MetricsExporterPayload {
    Prometheus(PrometheusTelemetryPayload),
    Otlp(OtlpTelemetryPayload),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrometheusTelemetryPayload {
    bind_address: String,
    #[serde(default)]
    global_tags: HashMap<String, String>,
    #[serde(default)]
    counters_total_suffix: bool,
    #[serde(default)]
    unit_suffix: bool,
    #[serde(default)]
    use_seconds_for_durations: bool,
    #[serde(default)]
    histogram_bucket_overrides: HashMap<String, Vec<f64>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OtlpTelemetryPayload {
    url: String,
    #[serde(default)]
    protocol: Option<OtlpProtocolTag>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    metric_periodicity_ms: Option<u64>,
    #[serde(default)]
    metric_temporality: Option<MetricTemporalityTag>,
    #[serde(default)]
    global_tags: HashMap<String, String>,
    #[serde(default)]
    use_seconds_for_durations: bool,
    #[serde(default)]
    histogram_bucket_overrides: HashMap<String, Vec<f64>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MetricTemporalityTag {
    Cumulative,
    Delta,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OtlpProtocolTag {
    Http,
    Grpc,
}

impl From<MetricTemporalityTag> for MetricTemporality {
    fn from(value: MetricTemporalityTag) -> Self {
        match value {
            MetricTemporalityTag::Cumulative => MetricTemporality::Cumulative,
            MetricTemporalityTag::Delta => MetricTemporality::Delta,
        }
    }
}

impl From<OtlpProtocolTag> for OtlpProtocol {
    fn from(value: OtlpProtocolTag) -> Self {
        match value {
            OtlpProtocolTag::Http => OtlpProtocol::Http,
            OtlpProtocolTag::Grpc => OtlpProtocol::Grpc,
        }
    }
}

#[derive(Debug, Deserialize)]
struct TerminateWorkflowRequestPayload {
    #[serde(default)]
    namespace: Option<String>,
    workflow_id: String,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    first_execution_run_id: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    details: Option<Vec<serde_json::Value>>,
}

#[derive(Clone, Debug, Deserialize)]
struct ClientCertPairPayload {
    #[serde(alias = "client_cert")]
    crt: String,
    #[serde(alias = "client_private_key")]
    key: String,
}

#[derive(Debug, Error)]
enum BridgeError {
    #[error("invalid runtime handle")]
    InvalidRuntimeHandle,
    #[error("invalid client handle")]
    InvalidClientHandle,
    #[error("missing configuration payload")]
    MissingConfig,
    #[error("failed to parse client configuration: {0}")]
    InvalidConfig(String),
    #[error("failed to parse request payload: {0}")]
    InvalidRequest(String),
    #[error("failed to parse Temporal address: {0}")]
    InvalidAddress(String),
    #[error("Temporal client initialization failed: {0}")]
    ClientInit(String),
    #[error("Temporal request failed: {0}")]
    ClientRequest(String),
    #[error("failed to encode payload: {0}")]
    PayloadEncode(String),
    #[error("failed to encode response payload: {0}")]
    ResponseEncode(String),
    #[error("invalid TLS configuration: {0}")]
    InvalidTlsConfig(String),
    #[error("invalid client metadata: {0}")]
    InvalidMetadata(String),
    #[error("invalid telemetry configuration: {0}")]
    InvalidTelemetry(String),
    #[error("failed to configure telemetry exporters: {0}")]
    TelemetryConfiguration(String),
    #[error("runtime is currently in use; telemetry configuration cannot be updated")]
    RuntimeInUse,
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_runtime_new(
    _options_ptr: *const u8,
    _options_len: usize,
) -> *mut c_void {
    match CoreRuntime::new(TelemetryOptions::default(), TokioRuntimeBuilder::default()) {
        Ok(runtime) => {
            let handle = RuntimeHandle {
                runtime: Arc::new(runtime),
                prometheus_abort: None,
                prometheus_config: None,
            };
            Box::into_raw(Box::new(handle)) as *mut c_void
        }
        Err(err) => {
            error::set_error(format!("failed to initialize Temporal runtime: {err}"));
            std::ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_runtime_free(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }

    unsafe {
        let mut handle = Box::from_raw(handle as *mut RuntimeHandle);
        if let Some(task) = handle.prometheus_abort.take() {
            task.abort();
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_runtime_update_telemetry(
    runtime_ptr: *mut c_void,
    options_ptr: *const u8,
    options_len: usize,
) -> i32 {
    let handle = match runtime_handle_mut_from_ptr(runtime_ptr) {
        Ok(handle) => handle,
        Err(err) => {
            error::set_error(err.to_string());
            return -1;
        }
    };

    let payload = match request_from_raw::<TelemetryUpdatePayload>(options_ptr, options_len) {
        Ok(payload) => payload,
        Err(err) => {
            error::set_error(err.to_string());
            return -1;
        }
    };

    match configure_runtime_telemetry(handle, payload) {
        Ok(()) => 0,
        Err(err) => {
            error::set_error(err.to_string());
            -1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_runtime_set_logger(
    _runtime_ptr: *mut c_void,
    _callback_ptr: *mut c_void,
) -> i32 {
    // TODO(codex): Wire native Core logging into Bun callbacks per docs/ffi-surface.md.
    error::set_error("temporal_bun_runtime_set_logger is not implemented yet".to_string());
    -1
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_error_message(len_out: *mut usize) -> *const u8 {
    error::take_error(len_out)
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_error_free(ptr: *mut u8, len: usize) {
    unsafe { error::free_error(ptr, len) }
}

fn runtime_from_ptr(ptr: *mut c_void) -> Result<Arc<CoreRuntime>, BridgeError> {
    if ptr.is_null() {
        return Err(BridgeError::InvalidRuntimeHandle);
    }

    let runtime = unsafe { &*(ptr as *mut RuntimeHandle) };
    Ok(runtime.runtime.clone())
}

fn runtime_handle_mut_from_ptr<'a>(ptr: *mut c_void) -> Result<&'a mut RuntimeHandle, BridgeError> {
    if ptr.is_null() {
        return Err(BridgeError::InvalidRuntimeHandle);
    }
    Ok(unsafe { &mut *(ptr as *mut RuntimeHandle) })
}

fn configure_runtime_telemetry(
    handle: &mut RuntimeHandle,
    payload: TelemetryUpdatePayload,
) -> Result<(), BridgeError> {
    match payload.metrics {
        MetricsExporterPayload::Prometheus(config) => configure_prometheus(handle, config),
        MetricsExporterPayload::Otlp(config) => configure_otlp(handle, config),
    }
}

fn ensure_runtime_exclusive(handle: &mut RuntimeHandle) -> Result<(), BridgeError> {
    if Arc::get_mut(&mut handle.runtime).is_some() {
        Ok(())
    } else {
        Err(BridgeError::RuntimeInUse)
    }
}

fn with_runtime<T>(
    handle: &mut RuntimeHandle,
    f: impl FnOnce(&mut CoreRuntime) -> Result<T, BridgeError>,
) -> Result<T, BridgeError> {
    let runtime = Arc::get_mut(&mut handle.runtime).ok_or(BridgeError::RuntimeInUse)?;
    let _subscriber_guard = runtime
        .telemetry()
        .trace_subscriber()
        .map(|sub| tracing::subscriber::set_default(sub));
    let _tokio_guard = runtime.tokio_handle().enter();
    f(runtime)
}

fn configure_prometheus(
    handle: &mut RuntimeHandle,
    config: PrometheusTelemetryPayload,
) -> Result<(), BridgeError> {
    ensure_runtime_exclusive(handle)?;
    let options = build_prometheus_options(&config)?;

    let previous_config = handle.prometheus_config.clone();
    let previous_abort = handle.prometheus_abort.take();

    if let Some(task) = previous_abort {
        task.abort();
    }

    let abort_handle = match with_runtime(handle, move |runtime| {
        let exporter = start_prometheus_metric_exporter(options).map_err(|err| {
            BridgeError::TelemetryConfiguration(format!(
                "failed to start Prometheus exporter: {err}"
            ))
        })?;
        runtime
            .telemetry_mut()
            .attach_late_init_metrics(exporter.meter.clone());
        Ok::<AbortHandle, BridgeError>(exporter.abort_handle)
    }) {
        Ok(handle) => handle,
        Err(err) => {
            if let Some(prev_config) = previous_config {
                if let Err(rollback_err) = restart_prometheus(handle, &prev_config) {
                    return Err(BridgeError::TelemetryConfiguration(format!(
                        "failed to start Prometheus exporter: {err}; rollback failed: {rollback_err}"
                    )));
                }
            }
            return Err(err);
        }
    };

    handle.prometheus_abort = Some(abort_handle);
    handle.prometheus_config = Some(config);
    Ok(())
}

fn build_prometheus_options(
    config: &PrometheusTelemetryPayload,
) -> Result<PrometheusExporterOptions, BridgeError> {
    let socket_addr: SocketAddr = config.bind_address.parse().map_err(|err| {
        BridgeError::InvalidTelemetry(format!("invalid Prometheus bind address: {err}"))
    })?;

    let mut builder = PrometheusExporterOptionsBuilder::default();
    builder
        .socket_addr(socket_addr)
        .global_tags(config.global_tags.clone())
        .counters_total_suffix(config.counters_total_suffix)
        .unit_suffix(config.unit_suffix)
        .use_seconds_for_durations(config.use_seconds_for_durations)
        .histogram_bucket_overrides(HistogramBucketOverrides {
            overrides: config.histogram_bucket_overrides.clone(),
        });

    builder.build().map_err(|err| {
        BridgeError::InvalidTelemetry(format!("failed to build Prometheus options: {err}"))
    })
}

fn restart_prometheus(
    handle: &mut RuntimeHandle,
    config: &PrometheusTelemetryPayload,
) -> Result<(), BridgeError> {
    let options = build_prometheus_options(config)?;
    let abort_handle = with_runtime(handle, move |runtime| {
        let exporter = start_prometheus_metric_exporter(options).map_err(|err| {
            BridgeError::TelemetryConfiguration(format!(
                "failed to restart Prometheus exporter: {err}"
            ))
        })?;
        runtime
            .telemetry_mut()
            .attach_late_init_metrics(exporter.meter.clone());
        Ok::<AbortHandle, BridgeError>(exporter.abort_handle)
    })?;

    handle.prometheus_abort = Some(abort_handle);
    handle.prometheus_config = Some(config.clone());

    Ok(())
}

fn configure_otlp(
    handle: &mut RuntimeHandle,
    config: OtlpTelemetryPayload,
) -> Result<(), BridgeError> {
    let mut builder = OtelCollectorOptionsBuilder::default();
    let url = Url::parse(&config.url).map_err(|err| {
        BridgeError::InvalidTelemetry(format!("invalid OTLP collector URL: {err}"))
    })?;
    builder
        .url(url)
        .headers(config.headers.clone())
        .use_seconds_for_durations(config.use_seconds_for_durations)
        .global_tags(config.global_tags.clone())
        .histogram_bucket_overrides(HistogramBucketOverrides {
            overrides: config.histogram_bucket_overrides.clone(),
        });

    if let Some(period_ms) = config.metric_periodicity_ms {
        if period_ms == 0 {
            return Err(BridgeError::InvalidTelemetry(
                "otlp.metricPeriodicityMs must be greater than zero".to_string(),
            ));
        }
        builder.metric_periodicity(Duration::from_millis(period_ms));
    }

    if let Some(temporality) = config.metric_temporality {
        builder.metric_temporality(temporality.into());
    }

    if let Some(protocol) = config.protocol {
        builder.protocol(protocol.into());
    }

    let options = builder.build().map_err(|err| {
        BridgeError::InvalidTelemetry(format!("failed to build OTLP options: {err}"))
    })?;

    with_runtime(handle, move |runtime| {
        let exporter = build_otlp_metric_exporter(options).map_err(|err| {
            BridgeError::TelemetryConfiguration(format!("failed to start OTLP exporter: {err}"))
        })?;
        let meter: Arc<dyn CoreMeter + 'static> = Arc::new(exporter);
        runtime.telemetry_mut().attach_late_init_metrics(meter);
        Ok(())
    })?;

    if let Some(task) = handle.prometheus_abort.take() {
        task.abort();
    }
    handle.prometheus_config = None;

    Ok(())
}

fn config_from_raw(ptr: *const u8, len: usize) -> Result<ClientConfig, BridgeError> {
    if ptr.is_null() || len == 0 {
        return Err(BridgeError::MissingConfig);
    }

    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    serde_json::from_slice(bytes).map_err(|err| BridgeError::InvalidConfig(err.to_string()))
}

fn request_from_raw<T>(ptr: *const u8, len: usize) -> Result<T, BridgeError>
where
    T: for<'de> Deserialize<'de>,
{
    if ptr.is_null() || len == 0 {
        return Err(BridgeError::InvalidRequest("empty payload".to_owned()));
    }

    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    serde_json::from_slice(bytes).map_err(|err| BridgeError::InvalidRequest(err.to_string()))
}

fn into_string_error(err: BridgeError) -> *mut c_void {
    error::set_error(err.to_string());
    std::ptr::null_mut()
}

fn client_from_ptr(ptr: *mut c_void) -> Result<&'static ClientHandle, BridgeError> {
    if ptr.is_null() {
        return Err(BridgeError::InvalidClientHandle);
    }
    Ok(unsafe { &*(ptr as *mut ClientHandle) })
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_connect_async(
    runtime_ptr: *mut c_void,
    config_ptr: *const u8,
    config_len: usize,
) -> *mut PendingClientHandle {
    let runtime = match runtime_from_ptr(runtime_ptr) {
        Ok(runtime) => runtime,
        Err(err) => return into_string_error(err) as *mut PendingClientHandle,
    };

    let config = match config_from_raw(config_ptr, config_len) {
        Ok(config) => config,
        Err(err) => return into_string_error(err) as *mut PendingClientHandle,
    };

    let url = match Url::parse(&config.address) {
        Ok(url) => url,
        Err(err) => {
            return into_string_error(BridgeError::InvalidAddress(err.to_string()))
                as *mut PendingClientHandle
        }
    };

    let identity = config
        .identity
        .unwrap_or_else(|| format!("temporal-bun-sdk-{}", std::process::id()));
    let client_name = config
        .client_name
        .unwrap_or_else(|| "temporal-bun-sdk".to_string());
    let client_version = config
        .client_version
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    let mut builder = ClientOptionsBuilder::default();
    builder
        .target_url(url)
        .client_name(client_name)
        .client_version(client_version)
        .identity(identity.clone());
    let _allow_insecure_tls = config.allow_insecure_tls.unwrap_or(false);

    if let Some(api_key) = config.api_key.clone() {
        builder.api_key(Some(api_key));
    }

    if let Some(tls_payload) = config.tls.clone() {
        match metadata::tls_config_from_payload(tls_payload) {
            Ok(tls_cfg) => {
                builder.tls_cfg(tls_cfg);
            }
            Err(err) => return into_string_error(err) as *mut PendingClientHandle,
        }
    }

    let options = match builder.build() {
        Ok(options) => options,
        Err(err) => {
            return into_string_error(BridgeError::ClientInit(err.to_string()))
                as *mut PendingClientHandle
        }
    };

    let namespace = config.namespace;
    let runtime_clone = runtime.clone();
    let identity_clone = identity.clone();
    let (tx, rx) = channel();

    thread::spawn(move || {
        let result = runtime_clone.tokio_handle().block_on(async move {
            match options.connect_no_namespace(None).await {
                Ok(client) => Ok(ClientHandle {
                    runtime: runtime_clone.clone(),
                    client,
                    namespace,
                    identity: identity_clone.clone(),
                }),
                Err(err) => Err(BridgeError::ClientInit(err.to_string()).to_string()),
            }
        });

        let _ = tx.send(result);
    });

    Box::into_raw(Box::new(PendingClientHandle::new(rx)))
}
#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_free(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }

    unsafe {
        let _ = Box::from_raw(handle as *mut ClientHandle);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_update_headers(
    client_ptr: *mut c_void,
    headers_ptr: *const u8,
    headers_len: usize,
) -> i32 {
    let client_handle = match client_from_ptr(client_ptr) {
        Ok(client) => client,
        Err(err) => {
            error::set_error(err.to_string());
            return -1;
        }
    };

    let raw_headers: HashMap<String, String> = match request_from_raw(headers_ptr, headers_len) {
        Ok(headers) => headers,
        Err(err) => {
            error::set_error(err.to_string());
            return -1;
        }
    };

    let (normalized, bearer_token) = match metadata::normalize_metadata_headers(raw_headers) {
        Ok(result) => result,
        Err(err) => {
            error::set_error(err.to_string());
            return -1;
        }
    };
    let configured = client_handle.client.get_client();

    if let Err(err) = configured.set_headers(normalized) {
        error::set_error(BridgeError::InvalidMetadata(err.to_string()).to_string());
        return -1;
    }

    match bearer_token {
        Some(auth) => {
            configured.set_api_key(Some(auth));
        }
        None => {
            configured.set_api_key(None);
        }
    }

    0
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_pending_client_poll(ptr: *mut PendingClientHandle) -> i32 {
    if ptr.is_null() {
        error::set_error("invalid pending handle".to_string());
        return -1;
    }

    let pending = unsafe { &*ptr };

    match pending.poll() {
        pending::PendingState::Pending => 0,
        pending::PendingState::ReadyOk => 1,
        pending::PendingState::ReadyErr(err) => {
            error::set_error(err);
            -1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_pending_client_consume(
    ptr: *mut PendingClientHandle,
) -> *mut c_void {
    if ptr.is_null() {
        error::set_error("invalid pending handle".to_string());
        return std::ptr::null_mut();
    }

    let pending = unsafe { &*ptr };

    match pending.take_result() {
        Some(Ok(handle)) => Box::into_raw(Box::new(handle)) as *mut c_void,
        Some(Err(err)) => {
            error::set_error(err);
            std::ptr::null_mut()
        }
        None => {
            error::set_error("pending result not ready".to_string());
            std::ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_pending_client_free(ptr: *mut PendingClientHandle) {
    if ptr.is_null() {
        return;
    }

    unsafe {
        let _ = Box::from_raw(ptr);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_describe_namespace_async(
    client_ptr: *mut c_void,
    payload_ptr: *const u8,
    payload_len: usize,
) -> *mut pending::PendingByteArray {
    let client_handle = match client_from_ptr(client_ptr) {
        Ok(client) => client,
        Err(err) => return into_string_error(err) as *mut pending::PendingByteArray,
    };

    let payload =
        match request_from_raw::<DescribeNamespaceRequestPayload>(payload_ptr, payload_len) {
            Ok(payload) => payload,
            Err(err) => {
                return into_string_error(BridgeError::InvalidRequest(err.to_string()))
                    as *mut pending::PendingByteArray
            }
        };

    let runtime = client_handle.runtime.clone();
    let client = client_handle.client.clone();
    let namespace = payload.namespace;

    let (tx, rx) = channel();

    thread::spawn(move || {
        let result = runtime.tokio_handle().block_on(async move {
            let mut inner = client.clone();
            let request = Namespace::Name(namespace).into_describe_namespace_request();
            WorkflowService::describe_namespace(&mut inner, request.into_request())
                .await
                .map(|resp| resp.into_inner().encode_to_vec())
                .map_err(|err| BridgeError::ClientRequest(err.to_string()).to_string())
        });

        let _ = tx.send(result);
    });

    Box::into_raw(Box::new(pending::PendingByteArray::new(rx)))
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_start_workflow(
    client_ptr: *mut c_void,
    payload_ptr: *const u8,
    payload_len: usize,
) -> *mut byte_array::ByteArray {
    let client_handle = match client_from_ptr(client_ptr) {
        Ok(client) => client,
        Err(err) => return into_string_error(err) as *mut byte_array::ByteArray,
    };

    let payload = match request_from_raw::<StartWorkflowRequestPayload>(payload_ptr, payload_len) {
        Ok(payload) => payload,
        Err(err) => {
            return into_string_error(BridgeError::InvalidRequest(err.to_string()))
                as *mut byte_array::ByteArray
        }
    };

    let defaults = request::StartWorkflowDefaults {
        namespace: &client_handle.namespace,
        identity: &client_handle.identity,
    };

    let (request, response_info) = match request::build_start_workflow_request(payload, defaults) {
        Ok(result) => result,
        Err(err) => return into_string_error(err) as *mut byte_array::ByteArray,
    };

    let runtime = client_handle.runtime.clone();
    let client = client_handle.client.clone();

    let response = runtime.tokio_handle().block_on(async move {
        let mut inner = client.clone();
        WorkflowService::start_workflow_execution(&mut inner, request.into_request()).await
    });

    let response = match response {
        Ok(resp) => resp.into_inner(),
        Err(err) => {
            return into_string_error(BridgeError::ClientRequest(err.to_string()))
                as *mut byte_array::ByteArray
        }
    };

    let response_body = serde_json::json!({
        "runId": response.run_id,
        "workflowId": response_info.workflow_id,
        "namespace": response_info.namespace,
    });

    let bytes = match request::json_bytes(&response_body) {
        Ok(bytes) => bytes,
        Err(err) => return into_string_error(err) as *mut byte_array::ByteArray,
    };

    byte_array::ByteArray::from_vec(bytes)
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_byte_array_new(
    ptr: *const u8,
    len: usize,
) -> *mut byte_array::ByteArray {
    // TODO(codex): Optimize zero-copy transfers once native bridge exposes shared buffers (docs/ffi-surface.md).
    if ptr.is_null() || len == 0 {
        return byte_array::ByteArray::empty();
    }
    let mut buffer = byte_array::take(len);
    unsafe {
        std::ptr::copy_nonoverlapping(ptr, buffer.as_mut_ptr(), len);
        buffer.set_len(len);
    }
    byte_array::ByteArray::from_vec(buffer)
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_byte_array_free(ptr: *mut byte_array::ByteArray) {
    if ptr.is_null() {
        return;
    }

    unsafe {
        let mut ba = Box::from_raw(ptr);
        if !ba.ptr.is_null() && ba.cap > 0 {
            let buffer = Vec::from_raw_parts(ba.ptr, ba.len, ba.cap);
            byte_array::recycle(buffer);
            ba.ptr = std::ptr::null_mut();
            ba.len = 0;
            ba.cap = 0;
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_pending_byte_array_poll(ptr: *mut pending::PendingByteArray) -> i32 {
    if ptr.is_null() {
        error::set_error("invalid pending handle".to_string());
        return -1;
    }

    let pending = unsafe { &*ptr };

    match pending.poll() {
        pending::PendingState::Pending => 0,
        pending::PendingState::ReadyOk => 1,
        pending::PendingState::ReadyErr(err) => {
            error::set_error(err);
            -1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_pending_byte_array_consume(
    ptr: *mut pending::PendingByteArray,
) -> *mut byte_array::ByteArray {
    if ptr.is_null() {
        error::set_error("invalid pending handle".to_string());
        return std::ptr::null_mut();
    }

    let pending = unsafe { &*ptr };

    match pending.take_result() {
        Some(Ok(bytes)) => byte_array::ByteArray::from_vec(bytes),
        Some(Err(err)) => {
            error::set_error(err);
            std::ptr::null_mut()
        }
        None => {
            error::set_error("pending result not ready".to_string());
            std::ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_pending_byte_array_free(ptr: *mut pending::PendingByteArray) {
    if ptr.is_null() {
        return;
    }

    unsafe {
        let _ = Box::from_raw(ptr);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_signal(
    _client_ptr: *mut c_void,
    _payload_ptr: *const u8,
    _payload_len: usize,
) -> *mut pending::PendingByteArray {
    // TODO(codex): Implement workflow signal bridge invoking WorkflowService::signal_workflow_execution (docs/ffi-surface.md).
    error::set_error("temporal_bun_client_signal is not implemented yet".to_string());
    std::ptr::null_mut()
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_query_workflow(
    client_ptr: *mut c_void,
    payload_ptr: *const u8,
    payload_len: usize,
) -> *mut pending::PendingByteArray {
    let client_handle = match client_from_ptr(client_ptr) {
        Ok(client) => client,
        Err(err) => return into_string_error(err) as *mut pending::PendingByteArray,
    };

    let payload = match request_from_raw::<QueryWorkflowRequestPayload>(payload_ptr, payload_len) {
        Ok(payload) => payload,
        Err(err) => {
            return into_string_error(BridgeError::InvalidRequest(err.to_string()))
                as *mut pending::PendingByteArray
        }
    };

    let default_namespace = client_handle.namespace.clone();
    let defaults = request::QueryWorkflowDefaults {
        namespace: &default_namespace,
    };

    let request = match request::build_query_workflow_request(payload, defaults) {
        Ok(request) => request,
        Err(err) => return into_string_error(err) as *mut pending::PendingByteArray,
    };

    let runtime = client_handle.runtime.clone();
    let client = client_handle.client.clone();

    let (tx, rx) = channel();

    thread::spawn(move || {
        let result = runtime.tokio_handle().block_on(async move {
            let mut inner = client.clone();
            let response =
                WorkflowService::query_workflow(&mut inner, request.into_request()).await;

            let response = match response {
                Ok(resp) => resp.into_inner(),
                Err(err) => return Err(BridgeError::ClientRequest(err.to_string())),
            };

            if let Some(rejected) = response.query_rejected {
                let status = WorkflowExecutionStatus::try_from(rejected.status)
                    .map(|s| format!("{s:?}"))
                    .unwrap_or_else(|_| format!("UNKNOWN({})", rejected.status));
                return Err(BridgeError::ClientRequest(format!(
                    "workflow query rejected: execution status {status}",
                )));
            }

            let value = request::decode_query_result(response.query_result)?;
            request::json_bytes(&value)
        });

        let outcome = result.map_err(|err| err.to_string());
        let _ = tx.send(outcome);
    });

    Box::into_raw(Box::new(pending::PendingByteArray::new(rx)))
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_terminate_workflow(
    client_ptr: *mut c_void,
    payload_ptr: *const u8,
    payload_len: usize,
) -> i32 {
    let client_handle = match client_from_ptr(client_ptr) {
        Ok(client) => client,
        Err(err) => {
            error::set_error(err.to_string());
            return -1;
        }
    };

    let payload =
        match request_from_raw::<TerminateWorkflowRequestPayload>(payload_ptr, payload_len) {
            Ok(payload) => payload,
            Err(err) => {
                error::set_error(err.to_string());
                return -1;
            }
        };

    let defaults = request::TerminateWorkflowDefaults {
        namespace: &client_handle.namespace,
        identity: &client_handle.identity,
    };

    let request = match request::build_terminate_workflow_request(payload, defaults) {
        Ok(request) => request,
        Err(err) => {
            error::set_error(err.to_string());
            return -1;
        }
    };

    let runtime = client_handle.runtime.clone();
    let client = client_handle.client.clone();

    let result = runtime.tokio_handle().block_on(async move {
        let mut inner = client.clone();
        WorkflowService::terminate_workflow_execution(&mut inner, request.into_request()).await
    });

    match result {
        Ok(_) => 0,
        Err(err) => {
            error::set_error(
                BridgeError::ClientRequest(format!("{}: {}", err.code(), err.message()))
                    .to_string(),
            );
            -1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_cancel_workflow(
    client_ptr: *mut c_void,
    payload_ptr: *const u8,
    payload_len: usize,
) -> *mut pending::PendingByteArray {
    let client_handle = match ClientHandle::from_ptr(client_ptr) {
        Some(handle) => handle,
        None => {
            error::set_error("temporal_bun_client_cancel_workflow received null client".to_string());
            return std::ptr::null_mut();
        }
    };

    let payload = unsafe { std::slice::from_raw_parts(payload_ptr, payload_len) };

    let request = match cancel::CancelWorkflowRequest::from_json(payload) {
        Ok(req) => req,
        Err(err) => {
            error::set_error(err);
            return std::ptr::null_mut();
        }
    };

    cancel::dispatch_cancel(client_handle, request)
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_client_signal_with_start(
    client_ptr: *mut c_void,
    payload_ptr: *const u8,
    payload_len: usize,
) -> *mut byte_array::ByteArray {
    let client_handle = match client_from_ptr(client_ptr) {
        Ok(client) => client,
        Err(err) => return into_string_error(err) as *mut byte_array::ByteArray,
    };

    let payload = match request_from_raw::<SignalWithStartRequestPayload>(payload_ptr, payload_len)
    {
        Ok(payload) => payload,
        Err(err) => {
            return into_string_error(BridgeError::InvalidRequest(err.to_string()))
                as *mut byte_array::ByteArray
        }
    };

    let defaults = request::StartWorkflowDefaults {
        namespace: &client_handle.namespace,
        identity: &client_handle.identity,
    };

    let (request, response_info) = match request::build_signal_with_start_request(payload, defaults)
    {
        Ok(result) => result,
        Err(err) => return into_string_error(err) as *mut byte_array::ByteArray,
    };

    let runtime = client_handle.runtime.clone();
    let client = client_handle.client.clone();

    let response = runtime.tokio_handle().block_on(async move {
        let mut inner = client.clone();
        WorkflowService::signal_with_start_workflow_execution(&mut inner, request.into_request())
            .await
    });

    let response = match response {
        Ok(resp) => resp.into_inner(),
        Err(err) => {
            return into_string_error(BridgeError::ClientRequest(err.to_string()))
                as *mut byte_array::ByteArray
        }
    };

    let response_body = serde_json::json!({
        "runId": response.run_id,
        "workflowId": response_info.workflow_id,
        "namespace": response_info.namespace,
    });

    let bytes = match request::json_bytes(&response_body) {
        Ok(bytes) => bytes,
        Err(err) => return into_string_error(err) as *mut byte_array::ByteArray,
    };

    byte_array::ByteArray::from_vec(bytes)
}

#[cfg(test)]
mod tests;
