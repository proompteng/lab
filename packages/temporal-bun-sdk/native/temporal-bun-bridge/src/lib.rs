use std::collections::HashMap;
use std::convert::TryFrom;
use std::ffi::c_void;
use std::mem::take;
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread;

use base64::{engine::general_purpose, Engine as _};
use prost::Message;
use prost_wkt_types::Duration as ProtoDuration;
use serde::Deserialize;
use temporal_client::{
    tonic::IntoRequest, ClientOptionsBuilder, ClientTlsConfig, ConfiguredClient, Namespace,
    RetryClient, TemporalServiceClient, TlsConfig, WorkflowService,
};
use temporal_sdk_core::{CoreRuntime, TokioRuntimeBuilder};
use temporal_sdk_core_api::telemetry::TelemetryOptions;
use temporal_sdk_core_protos::temporal::api::common::v1::{
    Header, Memo, Payload, Payloads, RetryPolicy, SearchAttributes, WorkflowExecution, WorkflowType,
};
use temporal_sdk_core_protos::temporal::api::enums::v1::{
    QueryRejectCondition, TaskQueueKind, WorkflowExecutionStatus,
};
use temporal_sdk_core_protos::temporal::api::query::v1::WorkflowQuery;
use temporal_sdk_core_protos::temporal::api::taskqueue::v1::TaskQueue;
use temporal_sdk_core_protos::temporal::api::workflowservice::v1::{
    QueryWorkflowRequest, SignalWithStartWorkflowExecutionRequest, StartWorkflowExecutionRequest,
    TerminateWorkflowExecutionRequest,
};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

mod byte_array;
mod error;
mod pending;

type PendingClientHandle = pending::PendingResult<ClientHandle>;

#[repr(C)]
pub struct RuntimeHandle {
    runtime: Arc<CoreRuntime>,
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

struct StartWorkflowDefaults<'a> {
    namespace: &'a str,
    identity: &'a str,
}

struct QueryWorkflowDefaults<'a> {
    namespace: &'a str,
}

struct StartWorkflowResponseInfo {
    workflow_id: String,
    namespace: String,
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

struct TerminateWorkflowDefaults<'a> {
    namespace: &'a str,
    identity: &'a str,
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
        let _ = Box::from_raw(handle as *mut RuntimeHandle);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn temporal_bun_runtime_update_telemetry(
    _runtime_ptr: *mut c_void,
    _options_ptr: *const u8,
    _options_len: usize,
) -> i32 {
    // TODO(codex): Configure telemetry exporters (Prometheus, OTLP) via CoreRuntime once the plan in
    // docs/ffi-surface.md is implemented.
    error::set_error("temporal_bun_runtime_update_telemetry is not implemented yet".to_string());
    -1
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

fn extract_bearer_token(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    let (scheme, token) = trimmed.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") {
        let token = token.trim();
        if token.is_empty() {
            None
        } else {
            Some(token)
        }
    } else {
        None
    }
}

fn normalize_metadata_headers(
    raw_headers: HashMap<String, String>,
) -> Result<(HashMap<String, String>, Option<String>), BridgeError> {
    let mut normalized: HashMap<String, String> = HashMap::with_capacity(raw_headers.len());
    let mut bearer: Option<String> = None;

    for (key, value) in raw_headers.into_iter() {
        let trimmed_key = key.trim();
        if trimmed_key.is_empty() {
            return Err(BridgeError::InvalidMetadata("header keys must be non-empty".into()));
        }

        let lower_key = trimmed_key.to_ascii_lowercase();
        if normalized.contains_key(&lower_key)
            || (lower_key == "authorization" && bearer.is_some())
        {
            return Err(BridgeError::InvalidMetadata(format!(
                "duplicate header key '{lower_key}'",
            )));
        }

        let trimmed_value = value.trim();
        if trimmed_value.is_empty() {
            return Err(BridgeError::InvalidMetadata(format!(
                "header '{lower_key}' must have a non-empty value",
            )));
        }

        if lower_key == "authorization" {
            if let Some(token) = extract_bearer_token(trimmed_value) {
                bearer = Some(token.to_string());
                continue;
            }
        }

        normalized.insert(lower_key, trimmed_value.to_string());
    }

    Ok((normalized, bearer))
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
        match tls_config_from_payload(tls_payload) {
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

    let (normalized, bearer_token) = match normalize_metadata_headers(raw_headers) {
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

    let defaults = StartWorkflowDefaults {
        namespace: &client_handle.namespace,
        identity: &client_handle.identity,
    };

    let (request, response_info) = match build_start_workflow_request(payload, defaults) {
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

    let bytes = match json_bytes(&response_body) {
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
    let defaults = QueryWorkflowDefaults {
        namespace: &default_namespace,
    };

    let request = match build_query_workflow_request(payload, defaults) {
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

            let value = decode_query_result(response.query_result)?;
            json_bytes(&value)
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

    let defaults = TerminateWorkflowDefaults {
        namespace: &client_handle.namespace,
        identity: &client_handle.identity,
    };

    let request = match build_terminate_workflow_request(payload, defaults) {
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
    _client_ptr: *mut c_void,
    _payload_ptr: *const u8,
    _payload_len: usize,
) -> *mut pending::PendingByteArray {
    // TODO(codex): Implement cancellation via WorkflowService::request_cancel_workflow_execution (docs/ffi-surface.md).
    error::set_error("temporal_bun_client_cancel_workflow is not implemented yet".to_string());
    std::ptr::null_mut()
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

    let defaults = StartWorkflowDefaults {
        namespace: &client_handle.namespace,
        identity: &client_handle.identity,
    };

    let (request, response_info) = match build_signal_with_start_request(payload, defaults) {
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

    let bytes = match json_bytes(&response_body) {
        Ok(bytes) => bytes,
        Err(err) => return into_string_error(err) as *mut byte_array::ByteArray,
    };

    byte_array::ByteArray::from_vec(bytes)
}

fn encode_payload(value: serde_json::Value) -> Result<Payload, BridgeError> {
    let data =
        serde_json::to_vec(&value).map_err(|err| BridgeError::PayloadEncode(err.to_string()))?;
    let mut metadata = HashMap::new();
    metadata.insert("encoding".to_string(), b"json/plain".to_vec());
    Ok(Payload { metadata, data })
}

fn encode_payloads_from_vec(values: Vec<serde_json::Value>) -> Result<Payloads, BridgeError> {
    let mut encoded = Vec::with_capacity(values.len());
    for value in values {
        encoded.push(encode_payload(value)?);
    }
    Ok(Payloads { payloads: encoded })
}

fn build_start_workflow_request(
    payload: StartWorkflowRequestPayload,
    defaults: StartWorkflowDefaults,
) -> Result<(StartWorkflowExecutionRequest, StartWorkflowResponseInfo), BridgeError> {
    let StartWorkflowRequestPayload {
        namespace,
        workflow_id,
        workflow_type,
        task_queue,
        args,
        memo,
        search_attributes,
        headers,
        cron_schedule,
        request_id,
        identity,
        workflow_execution_timeout_ms,
        workflow_run_timeout_ms,
        workflow_task_timeout_ms,
        retry_policy,
    } = payload;

    let namespace = namespace.unwrap_or_else(|| defaults.namespace.to_string());
    let identity = identity.unwrap_or_else(|| defaults.identity.to_string());
    let request_id = request_id.unwrap_or_else(|| Uuid::new_v4().to_string());

    let mut request = StartWorkflowExecutionRequest {
        namespace: namespace.clone(),
        workflow_id: workflow_id.clone(),
        workflow_type: Some(WorkflowType {
            name: workflow_type,
        }),
        task_queue: Some(TaskQueue {
            name: task_queue,
            kind: TaskQueueKind::Normal as i32,
            normal_name: String::new(),
        }),
        identity,
        request_id,
        ..Default::default()
    };

    if let Some(values) = args {
        let mut encoded = Vec::with_capacity(values.len());
        for value in values {
            encoded.push(encode_payload(value)?);
        }
        request.input = Some(Payloads { payloads: encoded });
    }

    match encode_payload_map(memo)? {
        Some(fields) => request.memo = Some(Memo { fields }),
        None => {}
    }

    match encode_payload_map(search_attributes)? {
        Some(fields) => {
            request.search_attributes = Some(SearchAttributes {
                indexed_fields: fields,
            });
        }
        None => {}
    }

    match encode_payload_map(headers)? {
        Some(fields) => request.header = Some(Header { fields }),
        None => {}
    }

    if let Some(schedule) = cron_schedule {
        request.cron_schedule = schedule;
    }

    if let Some(ms) = workflow_execution_timeout_ms {
        request.workflow_execution_timeout = Some(duration_from_millis(ms));
    }

    if let Some(ms) = workflow_run_timeout_ms {
        request.workflow_run_timeout = Some(duration_from_millis(ms));
    }

    if let Some(ms) = workflow_task_timeout_ms {
        request.workflow_task_timeout = Some(duration_from_millis(ms));
    }

    if let Some(policy) = retry_policy {
        request.retry_policy = Some(encode_retry_policy(policy)?);
    }

    let response_info = StartWorkflowResponseInfo {
        workflow_id,
        namespace,
    };

    Ok((request, response_info))
}

fn build_terminate_workflow_request(
    payload: TerminateWorkflowRequestPayload,
    defaults: TerminateWorkflowDefaults,
) -> Result<TerminateWorkflowExecutionRequest, BridgeError> {
    let TerminateWorkflowRequestPayload {
        namespace,
        workflow_id,
        run_id,
        first_execution_run_id,
        reason,
        details,
    } = payload;

    let namespace = namespace.unwrap_or_else(|| defaults.namespace.to_string());

    let mut request = TerminateWorkflowExecutionRequest {
        namespace,
        identity: defaults.identity.to_string(),
        workflow_execution: Some(WorkflowExecution {
            workflow_id,
            run_id: run_id.unwrap_or_default(),
        }),
        reason: reason.unwrap_or_default(),
        first_execution_run_id: first_execution_run_id.unwrap_or_default(),
        ..Default::default()
    };

    if let Some(values) = details {
        request.details = Some(encode_payloads_from_vec(values)?);
    }

    Ok(request)
}

fn build_signal_with_start_request(
    payload: SignalWithStartRequestPayload,
    defaults: StartWorkflowDefaults,
) -> Result<
    (
        SignalWithStartWorkflowExecutionRequest,
        StartWorkflowResponseInfo,
    ),
    BridgeError,
> {
    let SignalWithStartRequestPayload {
        start,
        signal_name,
        signal_args,
    } = payload;

    let (mut start_request, response_info) = build_start_workflow_request(start, defaults)?;

    let mut request = SignalWithStartWorkflowExecutionRequest {
        namespace: response_info.namespace.clone(),
        workflow_id: response_info.workflow_id.clone(),
        signal_name,
        ..Default::default()
    };

    request.workflow_type = start_request.workflow_type.take();
    request.task_queue = start_request.task_queue.take();
    request.input = start_request.input.take();
    request.identity = take(&mut start_request.identity);
    request.request_id = take(&mut start_request.request_id);
    request.workflow_execution_timeout = start_request.workflow_execution_timeout.take();
    request.workflow_run_timeout = start_request.workflow_run_timeout.take();
    request.workflow_task_timeout = start_request.workflow_task_timeout.take();
    request.retry_policy = start_request.retry_policy.take();
    request.memo = start_request.memo.take();
    request.search_attributes = start_request.search_attributes.take();
    request.header = start_request.header.take();
    request.cron_schedule = take(&mut start_request.cron_schedule);

    let mut encoded_signal = Vec::with_capacity(signal_args.len());
    for value in signal_args {
        encoded_signal.push(encode_payload(value)?);
    }
    request.signal_input = Some(Payloads {
        payloads: encoded_signal,
    });

    Ok((request, response_info))
}

fn build_query_workflow_request(
    payload: QueryWorkflowRequestPayload,
    defaults: QueryWorkflowDefaults,
) -> Result<QueryWorkflowRequest, BridgeError> {
    let QueryWorkflowRequestPayload {
        namespace,
        workflow_id,
        run_id,
        first_execution_run_id: _,
        query_name,
        args,
    } = payload;

    if workflow_id.trim().is_empty() {
        return Err(BridgeError::InvalidRequest(
            "workflow_id cannot be empty for query".to_string(),
        ));
    }

    if query_name.trim().is_empty() {
        return Err(BridgeError::InvalidRequest(
            "query_name cannot be empty".to_string(),
        ));
    }

    let namespace = namespace.unwrap_or_else(|| defaults.namespace.to_string());

    let mut encoded_args = Vec::new();
    if let Some(values) = args {
        for value in values {
            encoded_args.push(encode_payload(value)?);
        }
    }

    let query = WorkflowQuery {
        query_type: query_name,
        query_args: Some(Payloads {
            payloads: encoded_args,
        }),
        header: None,
    };

    let execution = WorkflowExecution {
        workflow_id,
        run_id: run_id.unwrap_or_default(),
    };

    Ok(QueryWorkflowRequest {
        namespace,
        execution: Some(execution),
        query: Some(query),
        query_reject_condition: QueryRejectCondition::None as i32,
    })
}

fn decode_query_result(payloads: Option<Payloads>) -> Result<serde_json::Value, BridgeError> {
    match payloads {
        Some(payloads) => {
            let mut values = Vec::with_capacity(payloads.payloads.len());
            for payload in payloads.payloads {
                values.push(decode_payload(payload)?);
            }

            match values.len() {
                0 => Ok(serde_json::Value::Null),
                1 => Ok(values.into_iter().next().unwrap()),
                _ => Ok(serde_json::Value::Array(values)),
            }
        }
        None => Ok(serde_json::Value::Null),
    }
}

fn decode_payload(payload: Payload) -> Result<serde_json::Value, BridgeError> {
    let encoding = payload
        .metadata
        .get("encoding")
        .map(|bytes| String::from_utf8_lossy(bytes).to_string())
        .ok_or_else(|| {
            BridgeError::ResponseEncode("missing payload encoding metadata".to_string())
        })?;

    if !encoding.to_ascii_lowercase().contains("json") {
        return Err(BridgeError::ResponseEncode(format!(
            "unsupported payload encoding: {encoding}",
        )));
    }

    serde_json::from_slice(&payload.data)
        .map_err(|err| BridgeError::ResponseEncode(err.to_string()))
}

fn encode_payload_map(
    map: Option<HashMap<String, serde_json::Value>>,
) -> Result<Option<HashMap<String, Payload>>, BridgeError> {
    match map {
        Some(entries) => {
            if entries.is_empty() {
                return Ok(None);
            }
            let mut encoded = HashMap::with_capacity(entries.len());
            for (key, value) in entries {
                encoded.insert(key, encode_payload(value)?);
            }
            Ok(Some(encoded))
        }
        None => Ok(None),
    }
}

fn encode_retry_policy(payload: RetryPolicyPayload) -> Result<RetryPolicy, BridgeError> {
    let mut policy = RetryPolicy::default();
    if let Some(ms) = payload.initial_interval_ms {
        policy.initial_interval = Some(duration_from_millis(ms));
    }
    if let Some(ms) = payload.maximum_interval_ms {
        policy.maximum_interval = Some(duration_from_millis(ms));
    }
    if let Some(attempts) = payload.maximum_attempts {
        policy.maximum_attempts = attempts;
    }
    if let Some(coefficient) = payload.backoff_coefficient {
        policy.backoff_coefficient = coefficient;
    }
    if let Some(errors) = payload.non_retryable_error_types {
        policy.non_retryable_error_types = errors;
    }
    Ok(policy)
}

fn tls_config_from_payload(payload: ClientTlsConfigPayload) -> Result<TlsConfig, BridgeError> {
    let ClientTlsConfigPayload {
        server_root_ca_cert,
        client_cert,
        client_private_key,
        server_name_override,
        client_cert_pair,
    } = payload;

    let mut tls = TlsConfig::default();

    if let Some(server_root_ca) = server_root_ca_cert {
        let bytes = decode_base64(&server_root_ca).map_err(|err| {
            BridgeError::InvalidTlsConfig(format!("invalid serverRootCACertificate/server_root_ca_cert: {err}"))
        })?;
        tls.server_root_ca_cert = Some(bytes);
    }

    if let Some(pair) = client_cert_pair {
        let cert = decode_base64(&pair.crt).map_err(|err| {
            BridgeError::InvalidTlsConfig(format!("invalid clientCertPair.crt: {err}"))
        })?;
        let key = decode_base64(&pair.key).map_err(|err| {
            BridgeError::InvalidTlsConfig(format!("invalid clientCertPair.key: {err}"))
        })?;
        tls.client_tls_config = Some(ClientTlsConfig {
            client_cert: cert,
            client_private_key: key,
        });
    } else {
        match (client_cert, client_private_key) {
            (Some(cert_b64), Some(key_b64)) => {
                let cert = decode_base64(&cert_b64).map_err(|err| {
                    BridgeError::InvalidTlsConfig(format!("invalid client_cert/clientCert: {err}"))
                })?;
                let key = decode_base64(&key_b64).map_err(|err| {
                    BridgeError::InvalidTlsConfig(format!("invalid client_private_key/clientPrivateKey: {err}"))
                })?;
                tls.client_tls_config = Some(ClientTlsConfig {
                    client_cert: cert,
                    client_private_key: key,
                });
            }
            (None, None) => {}
            _ => {
                return Err(BridgeError::InvalidTlsConfig(
                    "client_cert/clientCert and client_private_key/clientPrivateKey must both be provided"
                        .to_string(),
                ));
            }
        }
    }

    if let Some(server_name) = server_name_override {
        if !server_name.is_empty() {
            tls.domain = Some(server_name);
        }
    }

    Ok(tls)
}

fn decode_base64(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    general_purpose::STANDARD.decode(value)
}

fn json_bytes<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, BridgeError> {
    serde_json::to_vec(value).map_err(|err| BridgeError::ResponseEncode(err.to_string()))
}

fn duration_from_millis(ms: u64) -> ProtoDuration {
    ProtoDuration {
        seconds: (ms / 1_000) as i64,
        nanos: ((ms % 1_000) * 1_000_000) as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn byte_array_new_round_trips_large_payload() {
        byte_array::clear_pool();

        let len = 8 * 1024 * 1024;
        let mut payload = vec![0u8; len];
        for (idx, byte) in payload.iter_mut().enumerate() {
            *byte = (idx % 251) as u8;
        }

        let array_ptr = temporal_bun_byte_array_new(payload.as_ptr(), payload.len());
        assert!(!array_ptr.is_null());

        unsafe {
            let array = &*array_ptr;
            assert_eq!(array.len, payload.len());
            let slice = std::slice::from_raw_parts(array.ptr, array.len);
            assert_eq!(slice, payload.as_slice());
        }

        temporal_bun_byte_array_free(array_ptr);
        assert_eq!(byte_array::pool_len(), 1);
    }

    #[test]
    fn byte_array_new_reuses_pooled_buffers() {
        byte_array::clear_pool();
        assert_eq!(byte_array::pool_len(), 0);

        let payload_a = vec![1u8; 1024];
        let array_a = temporal_bun_byte_array_new(payload_a.as_ptr(), payload_a.len());
        let (ptr_a, cap_a) = unsafe {
            let array = &*array_a;
            (array.ptr, array.cap)
        };
        temporal_bun_byte_array_free(array_a);
        assert_eq!(byte_array::pool_len(), 1);

        let payload_b = vec![2u8; payload_a.len()];
        let array_b = temporal_bun_byte_array_new(payload_b.as_ptr(), payload_b.len());
        let (ptr_b, cap_b) = unsafe {
            let array = &*array_b;
            (array.ptr, array.cap)
        };
        assert_eq!(byte_array::pool_len(), 0);
        assert_eq!(ptr_a, ptr_b);
        assert_eq!(cap_a, cap_b);

        temporal_bun_byte_array_free(array_b);
        assert_eq!(byte_array::pool_len(), 1);
    }

    #[test]
    fn config_from_raw_parses_defaults() {
        let json = br#"{"address":"http://localhost:7233","namespace":"default"}"#;
        let cfg = config_from_raw(json.as_ptr(), json.len()).expect("config parsed");
        assert_eq!(cfg.address, "http://localhost:7233");
        assert_eq!(cfg.namespace, "default");
    }

    #[test]
    fn config_from_raw_errors_on_missing_payload() {
        let err = config_from_raw(std::ptr::null(), 0).unwrap_err();
        assert!(matches!(err, BridgeError::MissingConfig));
    }

    #[test]
    fn request_from_raw_validates_payload() {
        let json = br#"{"namespace":"test"}"#;
        let payload: DescribeNamespaceRequestPayload =
            request_from_raw(json.as_ptr(), json.len()).expect("parsed request");
        assert_eq!(payload.namespace, "test");

        let invalid =
            request_from_raw::<DescribeNamespaceRequestPayload>(br"{}".as_ptr(), 2).unwrap_err();
        assert!(matches!(invalid, BridgeError::InvalidRequest(_)));
    }

    #[test]
    fn tls_config_from_payload_decodes_components() {
        let payload = ClientTlsConfigPayload {
            server_root_ca_cert: Some(general_purpose::STANDARD.encode(b"ROOT")),
            client_cert: Some(general_purpose::STANDARD.encode(b"CERT")),
            client_private_key: Some(general_purpose::STANDARD.encode(b"KEY")),
            server_name_override: Some("server.test".to_string()),
            client_cert_pair: None,
        };

        let tls = tls_config_from_payload(payload).expect("parsed tls config");
        assert_eq!(tls.server_root_ca_cert, Some(b"ROOT".to_vec()));
        assert_eq!(tls.domain.as_deref(), Some("server.test"));
        let client = tls.client_tls_config.expect("client tls");
        assert_eq!(client.client_cert, b"CERT");
        assert_eq!(client.client_private_key, b"KEY");
    }

    #[test]
    fn tls_config_from_payload_errors_without_key_pair() {
        let payload = ClientTlsConfigPayload {
            server_root_ca_cert: None,
            client_cert: Some(general_purpose::STANDARD.encode(b"CERT")),
            client_private_key: None,
            server_name_override: None,
            client_cert_pair: None,
        };

        let err = tls_config_from_payload(payload).unwrap_err();
        assert!(matches!(err, BridgeError::InvalidTlsConfig(_)));
    }

    #[test]
    fn build_start_workflow_request_applies_defaults() {
        let payload = StartWorkflowRequestPayload {
            namespace: None,
            workflow_id: "wf-123".to_string(),
            workflow_type: "ExampleWorkflow".to_string(),
            task_queue: "prix".to_string(),
            args: None,
            memo: None,
            search_attributes: None,
            headers: None,
            cron_schedule: None,
            request_id: None,
            identity: None,
            workflow_execution_timeout_ms: None,
            workflow_run_timeout_ms: None,
            workflow_task_timeout_ms: None,
            retry_policy: None,
        };

        let defaults = StartWorkflowDefaults {
            namespace: "default",
            identity: "worker-1",
        };

        let (request, info) =
            build_start_workflow_request(payload, defaults).expect("build request");
        assert_eq!(request.namespace, "default");
        assert_eq!(request.identity, "worker-1");
        assert_eq!(request.workflow_id, "wf-123");
        assert_eq!(request.task_queue.unwrap().name, "prix");
        assert!(request.workflow_execution_timeout.is_none());
        assert!(request.workflow_run_timeout.is_none());
        assert!(request.workflow_task_timeout.is_none());
        assert!(request.retry_policy.is_none());
        assert_eq!(info.workflow_id, "wf-123");
        assert_eq!(info.namespace, "default");
    }

    #[test]
    fn build_start_workflow_request_encodes_payloads_timeouts_and_policy() {
        let args = vec![json!("hello"), json!({ "count": 2 })];
        let memo = HashMap::from([(String::from("note"), json!("memo"))]);
        let headers = HashMap::from([(String::from("auth"), json!("bearer"))]);
        let search = HashMap::from([(String::from("env"), json!("dev"))]);

        let payload = StartWorkflowRequestPayload {
            namespace: Some("analytics".to_string()),
            workflow_id: "wf-xyz".to_string(),
            workflow_type: "ExampleWorkflow".to_string(),
            task_queue: "prix".to_string(),
            args: Some(args),
            memo: Some(memo),
            search_attributes: Some(search),
            headers: Some(headers),
            cron_schedule: Some("*/5 * * * *".to_string()),
            request_id: Some("req-1".to_string()),
            identity: Some("custom-worker".to_string()),
            workflow_execution_timeout_ms: Some(1_500),
            workflow_run_timeout_ms: Some(2_000),
            workflow_task_timeout_ms: Some(750),
            retry_policy: Some(RetryPolicyPayload {
                initial_interval_ms: Some(2_500),
                maximum_interval_ms: Some(10_000),
                maximum_attempts: Some(3),
                backoff_coefficient: Some(2.0),
                non_retryable_error_types: Some(vec!["Fatal".to_string()]),
            }),
        };

        let defaults = StartWorkflowDefaults {
            namespace: "default",
            identity: "worker-1",
        };

        let (request, info) =
            build_start_workflow_request(payload, defaults).expect("build request");

        let inputs = request.input.expect("payloads").payloads;
        assert_eq!(inputs.len(), 2);
        assert_eq!(request.identity, "custom-worker");
        assert_eq!(request.namespace, "analytics");
        assert_eq!(info.namespace, "analytics");
        assert_eq!(request.cron_schedule, "*/5 * * * *");

        let execution_timeout = request
            .workflow_execution_timeout
            .expect("execution timeout");
        assert_eq!(execution_timeout.seconds, 1);
        assert_eq!(execution_timeout.nanos, 500_000_000);

        let run_timeout = request.workflow_run_timeout.expect("run timeout");
        assert_eq!(run_timeout.seconds, 2);
        assert_eq!(run_timeout.nanos, 0);

        let task_timeout = request.workflow_task_timeout.expect("task timeout");
        assert_eq!(task_timeout.seconds, 0);
        assert_eq!(task_timeout.nanos, 750_000_000);

        let retry = request.retry_policy.expect("retry policy");
        let initial_interval = retry.initial_interval.expect("initial interval");
        assert_eq!(initial_interval.seconds, 2);
        assert_eq!(initial_interval.nanos, 500_000_000);
        let maximum_interval = retry.maximum_interval.expect("maximum interval");
        assert_eq!(maximum_interval.seconds, 10);
        assert_eq!(maximum_interval.nanos, 0);
        assert_eq!(retry.maximum_attempts, 3);
        assert_eq!(retry.backoff_coefficient, 2.0);
        assert_eq!(retry.non_retryable_error_types, vec!["Fatal".to_string()]);

        let memo_fields = request.memo.unwrap().fields;
        assert!(memo_fields.contains_key("note"));
        let header_fields = request.header.unwrap().fields;
        assert!(header_fields.contains_key("auth"));
        let search_fields = request.search_attributes.unwrap().indexed_fields;
        assert!(search_fields.contains_key("env"));
    }

    #[test]
    fn build_terminate_workflow_request_applies_defaults() {
        let payload = TerminateWorkflowRequestPayload {
            namespace: None,
            workflow_id: "wf-terminate".to_string(),
            run_id: None,
            first_execution_run_id: None,
            reason: None,
            details: None,
        };

        let defaults = TerminateWorkflowDefaults {
            namespace: "default",
            identity: "worker-1",
        };

        let request = build_terminate_workflow_request(payload, defaults).expect("request");
        assert_eq!(request.namespace, "default");
        assert_eq!(request.identity, "worker-1");
        assert_eq!(request.reason, "");
        assert_eq!(request.first_execution_run_id, "");
        assert!(request.details.is_none());

        let execution = request.workflow_execution.expect("execution");
        assert_eq!(execution.workflow_id, "wf-terminate");
        assert_eq!(execution.run_id, "");
    }

    #[test]
    fn build_terminate_workflow_request_encodes_reason_and_details() {
        let payload = TerminateWorkflowRequestPayload {
            namespace: Some("analytics".to_string()),
            workflow_id: "terminate-me".to_string(),
            run_id: Some("run-123".to_string()),
            first_execution_run_id: Some("run-initial".to_string()),
            reason: Some("done".to_string()),
            details: Some(vec![json!("cleanup"), json!({ "ok": true })]),
        };

        let defaults = TerminateWorkflowDefaults {
            namespace: "fallback",
            identity: "worker-2",
        };

        let request = build_terminate_workflow_request(payload, defaults).expect("request");
        assert_eq!(request.namespace, "analytics");
        assert_eq!(request.identity, "worker-2");
        assert_eq!(request.reason, "done");
        assert_eq!(request.first_execution_run_id, "run-initial");

        let execution = request.workflow_execution.expect("execution");
        assert_eq!(execution.workflow_id, "terminate-me");
        assert_eq!(execution.run_id, "run-123");

        let details = request.details.expect("details");
        let decoded: Vec<serde_json::Value> = details
            .payloads
            .iter()
            .map(|payload| {
                serde_json::from_slice::<serde_json::Value>(&payload.data).expect("json")
            })
            .collect();
        assert_eq!(decoded, vec![json!("cleanup"), json!({ "ok": true })]);
        for payload in details.payloads {
            assert_eq!(
                payload.metadata.get("encoding"),
                Some(&b"json/plain".to_vec())
            );
        }
    }

    #[test]
    fn temporal_bun_client_terminate_workflow_sets_error_for_invalid_handle() {
        let status =
            temporal_bun_client_terminate_workflow(std::ptr::null_mut(), std::ptr::null(), 0);
        assert_eq!(status, -1);

        let mut len: usize = 0;
        let ptr = error::take_error(&mut len as *mut usize);
        assert!(len > 0);
        assert!(!ptr.is_null());

        let message = unsafe { std::slice::from_raw_parts(ptr, len) };
        let message = std::str::from_utf8(message).expect("utf8");
        assert!(message.contains("invalid client handle"));

        unsafe {
            error::free_error(ptr as *mut u8, len);
        }
    }

    #[test]
    fn normalize_metadata_headers_lowercases_and_extracts_bearer() {
        let headers = HashMap::from([
            (String::from("Authorization"), String::from(" Bearer super-secret ")),
            (String::from("X-Custom"), String::from(" value ")),
        ]);

        let (normalized, bearer) =
            normalize_metadata_headers(headers).expect("headers normalized");

        assert_eq!(
            normalized.get("x-custom"),
            Some(&"value".to_string())
        );
        assert!(!normalized.contains_key("authorization"));
        assert_eq!(bearer.as_deref(), Some("super-secret"));
    }

    #[test]
    fn normalize_metadata_headers_preserves_non_bearer_authorization() {
        let headers = HashMap::from([(String::from("Authorization"), String::from("Basic abc"))]);

        let (normalized, bearer) =
            normalize_metadata_headers(headers).expect("headers normalized");

        assert_eq!(normalized.get("authorization"), Some(&"Basic abc".to_string()));
        assert_eq!(bearer, None);
    }

    #[test]
    fn normalize_metadata_headers_rejects_invalid_input() {
        let dup_headers = HashMap::from([
            (String::from("Foo"), String::from("one")),
            (String::from("foo"), String::from("two")),
        ]);
        let duplicate_err = normalize_metadata_headers(dup_headers).unwrap_err();
        assert!(matches!(
            duplicate_err,
            BridgeError::InvalidMetadata(message) if message.contains("duplicate header key")
        ));

        let empty_key = HashMap::from([(String::from("   "), String::from("value"))]);
        let err = normalize_metadata_headers(empty_key).unwrap_err();
        assert!(matches!(
            err,
            BridgeError::InvalidMetadata(message) if message.contains("non-empty")
        ));

        let empty_value = HashMap::from([(String::from("auth"), String::from("   "))]);
        let err = normalize_metadata_headers(empty_value).unwrap_err();
        assert!(matches!(
            err,
            BridgeError::InvalidMetadata(message)
                if message.contains("must have a non-empty value")
        ));
    }

    #[test]
    fn extract_bearer_token_handles_case_insensitive_scheme() {
        assert_eq!(extract_bearer_token("Bearer abc"), Some("abc"));
        assert_eq!(extract_bearer_token("bearer  abc"), Some("abc"));
        assert_eq!(extract_bearer_token("Basic abc"), None);
        assert_eq!(extract_bearer_token("Bearer   "), None);
    }

    #[test]
    fn build_signal_with_start_request_merges_components() {
        let payload = SignalWithStartRequestPayload {
            start: StartWorkflowRequestPayload {
                namespace: Some("custom".to_string()),
                workflow_id: "wf-789".to_string(),
                workflow_type: "SampleWorkflow".to_string(),
                task_queue: "primary".to_string(),
                args: Some(vec![json!("payload")]),
                memo: None,
                search_attributes: None,
                headers: None,
                cron_schedule: Some("0 * * * *".to_string()),
                request_id: Some("req-123".to_string()),
                identity: Some("client-id".to_string()),
                workflow_execution_timeout_ms: Some(1_000),
                workflow_run_timeout_ms: Some(2_000),
                workflow_task_timeout_ms: Some(500),
                retry_policy: Some(RetryPolicyPayload {
                    initial_interval_ms: Some(500),
                    ..Default::default()
                }),
            },
            signal_name: "notify".to_string(),
            signal_args: vec![json!({"event": "start"})],
        };

        let defaults = StartWorkflowDefaults {
            namespace: "default",
            identity: "default-id",
        };

        let (request, info) =
            build_signal_with_start_request(payload, defaults).expect("built request");

        assert_eq!(info.workflow_id, "wf-789");
        assert_eq!(info.namespace, "custom");
        assert_eq!(request.namespace, "custom");
        assert_eq!(request.workflow_id, "wf-789");
        assert_eq!(request.signal_name, "notify");
        assert_eq!(request.identity, "client-id");
        assert_eq!(request.request_id, "req-123");
        assert_eq!(request.cron_schedule, "0 * * * *");

        let start_payloads = request.input.expect("start payloads").payloads;
        assert_eq!(start_payloads.len(), 1);
        let start_value: serde_json::Value =
            serde_json::from_slice(&start_payloads[0].data).expect("decode start payload");
        assert_eq!(start_value, json!("payload"));

        let signal_payloads = request.signal_input.expect("signal payloads").payloads;
        assert_eq!(signal_payloads.len(), 1);
        let signal_value: serde_json::Value =
            serde_json::from_slice(&signal_payloads[0].data).expect("decode signal payload");
        assert_eq!(signal_value, json!({"event": "start"}));

        let execution_timeout = request
            .workflow_execution_timeout
            .expect("execution timeout");
        assert_eq!(execution_timeout.seconds, 1);
        assert_eq!(execution_timeout.nanos, 0);

        let run_timeout = request.workflow_run_timeout.expect("run timeout");
        assert_eq!(run_timeout.seconds, 2);
        assert_eq!(run_timeout.nanos, 0);

        let task_timeout = request.workflow_task_timeout.expect("task timeout");
        assert_eq!(task_timeout.seconds, 0);
        assert_eq!(task_timeout.nanos, 500_000_000);

        let retry = request.retry_policy.expect("retry policy");
        let initial_interval = retry.initial_interval.expect("initial interval");
        assert_eq!(initial_interval.seconds, 0);
        assert_eq!(initial_interval.nanos, 500_000_000);
    }
}
