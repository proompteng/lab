const std = @import("std");
const builtin = @import("builtin");

// C bridge header: packages/temporal-bun-sdk/bruke/include/temporal-sdk-core-c-bridge.h
const c = @cImport({
    @cInclude("temporal-sdk-core-c-bridge.h");
});
pub const c_api = c;

fn assertOpaque(comptime T: type, comptime label: []const u8) void {
    const info = @typeInfo(T);
    const tag = std.meta.activeTag(info);
    const tag_name = @tagName(tag);
    if (!std.mem.eql(u8, tag_name, "Opaque") and !std.mem.eql(u8, tag_name, "opaque")) {
        @compileError(std.fmt.comptimePrint("{s} must remain opaque", .{label}));
    }
}

pub const CoreRuntime = opaque {};
pub const CoreClient = opaque {};
pub const CoreWorker = opaque {};

const RawRuntime = c.TemporalCoreRuntime;
const RawClient = c.TemporalCoreClient;
const RawWorker = c.TemporalCoreWorker;

comptime {
    assertOpaque(CoreRuntime, "CoreRuntime");
    assertOpaque(CoreClient, "CoreClient");
    assertOpaque(CoreWorker, "CoreWorker");
}

pub const Runtime = CoreRuntime;
pub const RuntimeOptions = c.TemporalCoreRuntimeOptions;
pub const TelemetryOptions = c.TemporalCoreTelemetryOptions;
pub const LoggingOptions = c.TemporalCoreLoggingOptions;
pub const MetricsOptions = c.TemporalCoreMetricsOptions;
pub const OpenTelemetryOptions = c.TemporalCoreOpenTelemetryOptions;
pub const PrometheusOptions = c.TemporalCorePrometheusOptions;
pub const OpenTelemetryMetricTemporality = c.TemporalCoreOpenTelemetryMetricTemporality;
pub const OpenTelemetryProtocol = c.TemporalCoreOpenTelemetryProtocol;
pub const MetricMeter = c.TemporalCoreMetricMeter;
pub const Metric = c.TemporalCoreMetric;
pub const MetricAttributes = c.TemporalCoreMetricAttributes;
pub const MetricAttribute = c.TemporalCoreMetricAttribute;
pub const MetricAttributeValue = c.TemporalCoreMetricAttributeValue;
pub const MetricAttributeValueType = c.TemporalCoreMetricAttributeValueType;
pub const MetricOptions = c.TemporalCoreMetricOptions;
pub const MetricKind = c.TemporalCoreMetricKind;
pub const metric_kind_counter_integer: MetricKind = @intCast(c.CounterInteger);
pub const metric_kind_gauge_integer: MetricKind = @intCast(c.GaugeInteger);
pub const metric_attr_type_string: MetricAttributeValueType = @intCast(c.String);

pub const Client = CoreClient;
pub const ClientOptions = c.TemporalCoreClientOptions;
pub const ClientConnectCallback = c.TemporalCoreClientConnectCallback;
pub const ClientTlsOptions = c.TemporalCoreClientTlsOptions;
pub const ClientRetryOptions = c.TemporalCoreClientRetryOptions;
pub const ClientKeepAliveOptions = c.TemporalCoreClientKeepAliveOptions;
pub const ClientHttpConnectProxyOptions = c.TemporalCoreClientHttpConnectProxyOptions;

pub const Worker = CoreWorker;
pub const WorkerReplayPusher = c.TemporalCoreWorkerReplayPusher;
pub const WorkerReplayPushResult = c.TemporalCoreWorkerReplayPushResult;
pub const WorkerVersioningStrategy = c.TemporalCoreWorkerVersioningStrategy;
pub const WorkerVersioningStrategyTag = c.TemporalCoreWorkerVersioningStrategy_Tag;
pub const WorkerTunerHolder = c.TemporalCoreTunerHolder;
pub const WorkerPollerBehavior = c.TemporalCorePollerBehavior;
pub const WorkerPollerBehaviorSimpleMaximum = c.TemporalCorePollerBehaviorSimpleMaximum;
pub const WorkerPollerBehaviorAutoscaling = c.TemporalCorePollerBehaviorAutoscaling;
pub const WorkerByteArrayRefArray = c.TemporalCoreByteArrayRefArray;

pub const RpcService = c.TemporalCoreRpcService;
pub const RpcCallOptions = c.TemporalCoreRpcCallOptions;
pub const ClientRpcCallCallback = c.TemporalCoreClientRpcCallCallback;
pub const CancellationToken = c.TemporalCoreCancellationToken;

inline fn toRuntime(raw: ?*RawRuntime) ?*Runtime {
    return if (raw) |ptr| @ptrCast(ptr) else null;
}

inline fn fromRuntime(runtime: ?*Runtime) ?*RawRuntime {
    return if (runtime) |ptr| @ptrCast(ptr) else null;
}

inline fn fromRuntimeNonNull(runtime: *Runtime) *RawRuntime {
    return @ptrCast(runtime);
}

inline fn toClient(raw: ?*RawClient) ?*Client {
    return if (raw) |ptr| @ptrCast(ptr) else null;
}

inline fn fromClient(client: ?*Client) ?*RawClient {
    return if (client) |ptr| @ptrCast(ptr) else null;
}

inline fn fromClientNonNull(client: *Client) *RawClient {
    return @ptrCast(client);
}

inline fn toWorker(raw: ?*RawWorker) ?*Worker {
    return if (raw) |ptr| @ptrCast(ptr) else null;
}

inline fn fromWorker(worker: ?*Worker) ?*RawWorker {
    return if (worker) |ptr| @ptrCast(ptr) else null;
}

inline fn fromWorkerNonNull(worker: *Worker) *RawWorker {
    return @ptrCast(worker);
}

inline fn toRawWorkerOptions(options: *const WorkerOptions) [*c]const c.TemporalCoreWorkerOptions {
    return @ptrCast(options);
}

pub const RuntimeOpaque = Runtime;
pub const ClientOpaque = Client;
pub const WorkerOpaque = Worker;

pub const ByteArray = c.TemporalCoreByteArray;
pub const ByteArrayRef = c.TemporalCoreByteArrayRef;
pub const MetadataRef = c.TemporalCoreMetadataRef;
pub const ByteBuf = ByteArray;
pub const ByteBufDestroyFn = *const fn (?*RuntimeOpaque, ?*const ByteBuf) callconv(.c) void;

pub const WorkerOptions = extern struct {
    namespace_: ByteArrayRef,
    task_queue: ByteArrayRef,
    versioning_strategy: WorkerVersioningStrategy,
    identity_override: ByteArrayRef,
    max_cached_workflows: u32,
    tuner: WorkerTunerHolder,
    no_remote_activities: bool,
    sticky_queue_schedule_to_start_timeout_millis: u64,
    max_heartbeat_throttle_interval_millis: u64,
    default_heartbeat_throttle_interval_millis: u64,
    max_activities_per_second: f64,
    max_task_queue_activities_per_second: f64,
    graceful_shutdown_period_millis: u64,
    workflow_task_poller_behavior: WorkerPollerBehavior,
    nonsticky_to_sticky_poll_ratio: f32,
    activity_task_poller_behavior: WorkerPollerBehavior,
    nexus_task_poller_behavior: WorkerPollerBehavior,
    nondeterminism_as_workflow_fail: bool,
    nondeterminism_as_workflow_fail_for_types: WorkerByteArrayRefArray,
};

comptime {
    std.debug.assert(@sizeOf(WorkerOptions) == 432);
    std.debug.assert(@alignOf(WorkerOptions) == @alignOf(c.TemporalCoreWorkerOptions));
}

pub const RuntimeOrFail = extern struct {
    runtime: ?*Runtime,
    fail: ?*const ByteArray,
};

comptime {
    std.debug.assert(@sizeOf(RuntimeOrFail) == @sizeOf(c.TemporalCoreRuntimeOrFail));
    std.debug.assert(@alignOf(RuntimeOrFail) == @alignOf(c.TemporalCoreRuntimeOrFail));
}

pub const WorkerOrFail = extern struct {
    worker: ?*Worker,
    fail: ?*const ByteArray,
};

comptime {
    std.debug.assert(@sizeOf(WorkerOrFail) == @sizeOf(c.TemporalCoreWorkerOrFail));
    std.debug.assert(@alignOf(WorkerOrFail) == @alignOf(c.TemporalCoreWorkerOrFail));
}

pub const WorkerReplayerOrFail = extern struct {
    worker: ?*Worker,
    worker_replay_pusher: ?*WorkerReplayPusher,
    fail: ?*const ByteArray,
};

comptime {
    std.debug.assert(@sizeOf(WorkerReplayerOrFail) == @sizeOf(c.TemporalCoreWorkerReplayerOrFail));
    std.debug.assert(@alignOf(WorkerReplayerOrFail) == @alignOf(c.TemporalCoreWorkerReplayerOrFail));
}

inline fn runtimeOrFailFromRaw(raw: c.TemporalCoreRuntimeOrFail) RuntimeOrFail {
    return .{
        .runtime = toRuntime(raw.runtime),
        .fail = raw.fail,
    };
}

inline fn workerOrFailFromRaw(raw: c.TemporalCoreWorkerOrFail) WorkerOrFail {
    return .{
        .worker = toWorker(raw.worker),
        .fail = raw.fail,
    };
}

inline fn workerReplayerOrFailFromRaw(raw: c.TemporalCoreWorkerReplayerOrFail) WorkerReplayerOrFail {
    return .{
        .worker = toWorker(raw.worker),
        .worker_replay_pusher = raw.worker_replay_pusher,
        .fail = raw.fail,
    };
}

const ArrayListManaged = std.array_list.Managed;

pub const ForwardedLog = c.TemporalCoreForwardedLog;
pub const ForwardedLogLevel = c.TemporalCoreForwardedLogLevel;
pub const ForwardedLogCallback = c.TemporalCoreForwardedLogCallback;

pub const WorkerCallback = c.TemporalCoreWorkerCallback;
pub const WorkerCompleteFn =
    *const fn (?*WorkerOpaque, ByteArrayRef, ?*anyopaque, WorkerCallback) callconv(.c) void;
pub const WorkerPollCallback = c.TemporalCoreWorkerPollCallback;
pub const WorkerPollFn =
    *const fn (?*WorkerOpaque, ?*anyopaque, WorkerPollCallback) callconv(.c) void;
pub const RuntimeByteArrayFreeFn =
    *const fn (?*RuntimeOpaque, ?*const ByteArray) callconv(.c) void;
pub const WorkerInitiateShutdownFn = *const fn (?*WorkerOpaque) callconv(.c) void;
pub const WorkerFinalizeShutdownFn =
    *const fn (?*WorkerOpaque, ?*anyopaque, WorkerCallback) callconv(.c) void;
pub const WorkerRecordHeartbeatFn =
    *const fn (?*WorkerOpaque, ByteArrayRef) callconv(.c) ?*const ByteArray;

const fallback_error_slice =
    "temporal-bun-bridge-zig: temporal core bridge is not linked"[0..];

const fallback_error_array = ByteArray{
    .data = fallback_error_slice.ptr,
    .size = fallback_error_slice.len,
    .cap = fallback_error_slice.len,
    .disable_free = true,
};

fn fallbackWorkerCompleteWorkflowActivation(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) callconv(.c) void {
    _ = worker;
    _ = completion;

    if (user_data == null) {
        return;
    }

    if (callback) |cb| {
        cb(user_data, &fallback_error_array);
    }
}

fn fallbackRuntimeByteArrayFree(runtime: ?*RuntimeOpaque, bytes: ?*const ByteArray) callconv(.c) void {
    _ = runtime;
    _ = bytes;
}

fn fallbackWorkerPollWorkflowActivation(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerPollCallback,
) callconv(.c) void {
    _ = worker;

    if (user_data == null) {
        return;
    }

    if (callback) |cb| {
        cb(user_data, null, &fallback_error_array);
    }
}

fn fallbackWorkerPollActivityTask(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerPollCallback,
) callconv(.c) void {
    _ = worker;

    if (callback) |cb| {
        cb(user_data, null, &fallback_error_array);
    }
}

fn fallbackWorkerCompleteActivityTask(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) callconv(.c) void {
    _ = worker;
    _ = completion;

    if (user_data == null) {
        return;
    }

    if (callback) |cb| {
        cb(user_data, &fallback_error_array);
    }
}

fn fallbackWorkerRecordActivityHeartbeat(
    worker: ?*WorkerOpaque,
    heartbeat: ByteArrayRef,
) callconv(.c) ?*const ByteArray {
    _ = worker;
    _ = heartbeat;
    return &fallback_error_array;
}

pub var worker_complete_workflow_activation: WorkerCompleteFn = fallbackWorkerCompleteWorkflowActivation;
pub var runtime_byte_array_free: RuntimeByteArrayFreeFn = fallbackRuntimeByteArrayFree;
pub var worker_poll_workflow_activation: WorkerPollFn = fallbackWorkerPollWorkflowActivation;
pub var worker_complete_activity_task: WorkerCompleteFn = fallbackWorkerCompleteActivityTask;
pub var worker_record_activity_heartbeat: WorkerRecordHeartbeatFn = fallbackWorkerRecordActivityHeartbeat;

pub fn registerTemporalCoreCallbacks(
    worker_complete: ?WorkerCompleteFn,
    byte_array_free: ?RuntimeByteArrayFreeFn,
    worker_poll: ?WorkerPollFn,
    activity_complete: ?WorkerCompleteFn,
    activity_heartbeat: ?WorkerRecordHeartbeatFn,
) void {
    worker_complete_workflow_activation =
        worker_complete orelse fallbackWorkerCompleteWorkflowActivation;
    runtime_byte_array_free = byte_array_free orelse fallbackRuntimeByteArrayFree;
    worker_poll_workflow_activation =
        worker_poll orelse fallbackWorkerPollWorkflowActivation;
    worker_complete_activity_task =
        activity_complete orelse fallbackWorkerCompleteActivityTask;
    worker_record_activity_heartbeat =
        activity_heartbeat orelse fallbackWorkerRecordActivityHeartbeat;
}

pub fn workerCompleteWorkflowActivation(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) void {
    worker_complete_workflow_activation(worker, completion, user_data, callback);
}

pub fn workerCompleteActivityTask(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) void {
    worker_complete_activity_task(worker, completion, user_data, callback);
}

pub fn runtimeByteArrayFree(runtime: ?*RuntimeOpaque, bytes: ?*const ByteArray) void {
    runtime_byte_array_free(runtime, bytes);
}

pub fn workerRecordActivityHeartbeat(
    worker: ?*WorkerOpaque,
    heartbeat: ByteArrayRef,
) ?*const ByteArray {
    return worker_record_activity_heartbeat(worker, heartbeat);
}

pub fn metricMeterNew(runtime: *RuntimeOpaque) ?*MetricMeter {
    ensureExternalApiInstalled();
    return c.temporal_core_metric_meter_new(fromRuntimeNonNull(runtime));
}

pub fn metricMeterFree(meter: ?*MetricMeter) void {
    if (meter) |ptr| {
        ensureExternalApiInstalled();
        c.temporal_core_metric_meter_free(ptr);
    }
}

pub fn metricAttributesNew(meter: *MetricMeter, attrs: []const MetricAttribute) ?*MetricAttributes {
    ensureExternalApiInstalled();
    if (attrs.len == 0) {
        return null;
    }
    return c.temporal_core_metric_attributes_new(meter, attrs.ptr, attrs.len);
}

pub fn metricAttributesFree(attrs: ?*MetricAttributes) void {
    if (attrs) |ptr| {
        ensureExternalApiInstalled();
        c.temporal_core_metric_attributes_free(ptr);
    }
}

pub fn metricNew(meter: *MetricMeter, options: *const MetricOptions) ?*Metric {
    ensureExternalApiInstalled();
    return c.temporal_core_metric_new(meter, options);
}

pub fn metricFree(metric: ?*Metric) void {
    if (metric) |ptr| {
        ensureExternalApiInstalled();
        c.temporal_core_metric_free(ptr);
    }
}

pub fn metricRecordInteger(metric: *const Metric, value: u64, attrs: ?*const MetricAttributes) void {
    ensureExternalApiInstalled();
    c.temporal_core_metric_record_integer(metric, value, attrs);
}

pub fn forwardedLogTarget(log: ?*const ForwardedLog) ByteArrayRef {
    return c.temporal_core_forwarded_log_target(log);
}

pub fn forwardedLogMessage(log: ?*const ForwardedLog) ByteArrayRef {
    return c.temporal_core_forwarded_log_message(log);
}

pub fn forwardedLogTimestampMillis(log: ?*const ForwardedLog) u64 {
    return c.temporal_core_forwarded_log_timestamp_millis(log);
}

pub fn forwardedLogFieldsJson(log: ?*const ForwardedLog) ByteArrayRef {
    return c.temporal_core_forwarded_log_fields_json(log);
}

const stub_runtime_or_fail = RuntimeOrFail{
    .runtime = null,
    .fail = &fallback_error_array,
};

const stub_worker_or_fail = WorkerOrFail{
    .worker = null,
    .fail = &fallback_error_array,
};

fn stubRuntimeNew(_options: *const RuntimeOptions) callconv(.c) RuntimeOrFail {
    _ = _options;
    return stub_runtime_or_fail;
}

fn stubRuntimeFree(_runtime: ?*Runtime) callconv(.c) void {
    _ = _runtime;
}

fn stubByteArrayFree(_runtime: ?*RuntimeOpaque, _bytes: ?*const ByteArray) callconv(.c) void {
    _ = _runtime;
    _ = _bytes;
}

fn stubClientConnect(
    user_runtime: ?*Runtime,
    _options: *const ClientOptions,
    user_data: ?*anyopaque,
    callback: ClientConnectCallback,
) callconv(.c) void {
    _ = user_runtime;
    _ = _options;
    if (callback) |cb| {
        cb(user_data, null, &fallback_error_array);
    }
}

fn stubClientFree(_client: ?*Client) callconv(.c) void {
    _ = _client;
}

fn stubClientUpdateMetadata(_client: ?*Client, _metadata: ByteArrayRef) callconv(.c) void {
    _ = _client;
    _ = _metadata;
}

fn stubClientUpdateApiKey(_client: ?*Client, _api_key: ByteArrayRef) callconv(.c) void {
    _ = _client;
    _ = _api_key;
}

fn stubClientRpcCall(
    _client: ?*Client,
    _options: *const RpcCallOptions,
    user_data: ?*anyopaque,
    callback: ClientRpcCallCallback,
) callconv(.c) void {
    _ = _client;
    _ = _options;
    if (callback) |cb| {
        cb(user_data, null, 0, &fallback_error_array, null);
    }
}

fn stubWorkerNew(_client: ?*Client, _options: *const WorkerOptions) callconv(.c) WorkerOrFail {
    _ = _client;
    _ = _options;
    return stub_worker_or_fail;
}

fn stubWorkerFree(_worker: ?*Worker) callconv(.c) void {
    _ = _worker;
}

fn stubWorkerPollActivityTask(
    worker: ?*Worker,
    user_data: ?*anyopaque,
    callback: WorkerPollCallback,
) callconv(.c) void {
    fallbackWorkerPollActivityTask(worker, user_data, callback);
}

fn stubWorkerInitiateShutdown(_worker: ?*Worker) callconv(.c) void {
    _ = _worker;
}

fn stubWorkerFinalizeShutdown(
    _worker: ?*Worker,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) callconv(.c) void {
    _ = _worker;
    if (callback) |cb| {
        cb(user_data, &fallback_error_array);
    }
}

fn stubWorkerReplayerNew(
    _runtime: ?*Runtime,
    _options: *const WorkerOptions,
) callconv(.c) WorkerReplayerOrFail {
    _ = _runtime;
    _ = _options;
    return .{
        .worker = null,
        .worker_replay_pusher = null,
        .fail = &fallback_error_array,
    };
}

fn stubWorkerReplayPush(
    _worker: ?*Worker,
    _pusher: ?*WorkerReplayPusher,
    _workflow_id: ByteArrayRef,
    _history: ByteArrayRef,
) callconv(.c) WorkerReplayPushResult {
    _ = _worker;
    _ = _pusher;
    _ = _workflow_id;
    _ = _history;
    return .{ .fail = &fallback_error_array };
}

fn stubWorkerReplayPusherFree(_pusher: ?*WorkerReplayPusher) callconv(.c) void {
    _ = _pusher;
}

fn runtimeNewBridge(options: *const RuntimeOptions) callconv(.c) RuntimeOrFail {
    return runtimeOrFailFromRaw(c.temporal_core_runtime_new(options));
}

fn runtimeFreeBridge(runtime: ?*Runtime) callconv(.c) void {
    if (fromRuntime(runtime)) |raw| {
        c.temporal_core_runtime_free(raw);
    }
}

fn runtimeByteArrayFreeBridge(runtime: ?*RuntimeOpaque, bytes: ?*const ByteArray) callconv(.c) void {
    if (runtime) |_| {
        c.temporal_core_byte_array_free(fromRuntime(runtime), bytes);
        return;
    }
    fallbackRuntimeByteArrayFree(runtime, bytes);
}

fn clientConnectBridge(
    runtime: ?*Runtime,
    options: *const ClientOptions,
    user_data: ?*anyopaque,
    callback: ClientConnectCallback,
) callconv(.c) void {
    c.temporal_core_client_connect(fromRuntime(runtime), options, user_data, callback);
}

fn clientFreeBridge(client: ?*Client) callconv(.c) void {
    if (fromClient(client)) |raw| {
        c.temporal_core_client_free(raw);
    }
}

fn clientUpdateMetadataBridge(client: ?*Client, metadata: ByteArrayRef) callconv(.c) void {
    c.temporal_core_client_update_metadata(fromClient(client), metadata);
}

fn clientUpdateApiKeyBridge(client: ?*Client, api_key: ByteArrayRef) callconv(.c) void {
    c.temporal_core_client_update_api_key(fromClient(client), api_key);
}

fn clientRpcCallBridge(
    client: ?*Client,
    options: *const RpcCallOptions,
    user_data: ?*anyopaque,
    callback: ClientRpcCallCallback,
) callconv(.c) void {
    c.temporal_core_client_rpc_call(fromClient(client), options, user_data, callback);
}

fn workerNewBridge(client: ?*Client, options: *const WorkerOptions) callconv(.c) WorkerOrFail {
    const raw_options = toRawWorkerOptions(options);
    return workerOrFailFromRaw(c.temporal_core_worker_new(fromClient(client), raw_options));
}

fn workerFreeBridge(worker: ?*Worker) callconv(.c) void {
    if (fromWorker(worker)) |raw| {
        c.temporal_core_worker_free(raw);
    }
}

fn workerPollWorkflowActivationBridge(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerPollCallback,
) callconv(.c) void {
    if (fromWorker(worker)) |raw| {
        c.temporal_core_worker_poll_workflow_activation(raw, user_data, callback);
        return;
    }
    fallbackWorkerPollWorkflowActivation(worker, user_data, callback);
}

fn workerPollActivityTaskBridge(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerPollCallback,
) callconv(.c) void {
    if (fromWorker(worker)) |raw| {
        c.temporal_core_worker_poll_activity_task(raw, user_data, callback);
        return;
    }
    fallbackWorkerPollActivityTask(worker, user_data, callback);
}

fn workerInitiateShutdownBridge(worker: ?*WorkerOpaque) callconv(.c) void {
    if (fromWorker(worker)) |raw| {
        c.temporal_core_worker_initiate_shutdown(raw);
    }
}

fn workerFinalizeShutdownBridge(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) callconv(.c) void {
    if (fromWorker(worker)) |raw| {
        c.temporal_core_worker_finalize_shutdown(raw, user_data, callback);
        return;
    }
    if (callback) |cb| {
        cb(user_data, &fallback_error_array);
    }
}

fn workerReplayerNewBridge(
    runtime: ?*Runtime,
    options: *const WorkerOptions,
) callconv(.c) WorkerReplayerOrFail {
    return workerReplayerOrFailFromRaw(
        c.temporal_core_worker_replayer_new(fromRuntime(runtime), toRawWorkerOptions(options)),
    );
}

fn workerReplayPushBridge(
    worker: ?*Worker,
    pusher: ?*WorkerReplayPusher,
    workflow_id: ByteArrayRef,
    history: ByteArrayRef,
) callconv(.c) WorkerReplayPushResult {
    if (fromWorker(worker)) |raw| {
        return c.temporal_core_worker_replay_push(raw, pusher, workflow_id, history);
    }
    return .{ .fail = &fallback_error_array };
}

fn workerReplayPusherFreeBridge(pusher: ?*WorkerReplayPusher) callconv(.c) void {
    if (pusher) |ptr| {
        c.temporal_core_worker_replay_pusher_free(ptr);
    }
}

fn workerCompleteWorkflowActivationBridge(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) callconv(.c) void {
    if (fromWorker(worker)) |raw| {
        c.temporal_core_worker_complete_workflow_activation(raw, completion, user_data, callback);
        return;
    }
    fallbackWorkerCompleteWorkflowActivation(worker, completion, user_data, callback);
}

fn workerCompleteActivityTaskBridge(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) callconv(.c) void {
    if (fromWorker(worker)) |raw| {
        c.temporal_core_worker_complete_activity_task(raw, completion, user_data, callback);
        return;
    }
    fallbackWorkerCompleteActivityTask(worker, completion, user_data, callback);
}

fn workerRecordActivityHeartbeatBridge(
    worker: ?*WorkerOpaque,
    heartbeat: ByteArrayRef,
) callconv(.c) ?*const ByteArray {
    if (fromWorker(worker)) |raw| {
        return c.temporal_core_worker_record_activity_heartbeat(raw, heartbeat);
    }
    return fallbackWorkerRecordActivityHeartbeat(worker, heartbeat);
}

pub const Api = struct {
    runtime_new: *const fn (*const RuntimeOptions) callconv(.c) RuntimeOrFail,
    runtime_free: *const fn (?*Runtime) callconv(.c) void,
    byte_array_free: RuntimeByteArrayFreeFn,
    client_connect: *const fn (?*Runtime, *const ClientOptions, ?*anyopaque, ClientConnectCallback) callconv(.c) void,
    client_free: *const fn (?*Client) callconv(.c) void,
    client_update_metadata: *const fn (?*Client, ByteArrayRef) callconv(.c) void,
    client_update_api_key: *const fn (?*Client, ByteArrayRef) callconv(.c) void,
    client_rpc_call: *const fn (?*Client, *const RpcCallOptions, ?*anyopaque, ClientRpcCallCallback) callconv(.c) void,
    worker_new: *const fn (?*Client, *const WorkerOptions) callconv(.c) WorkerOrFail,
    worker_free: *const fn (?*Worker) callconv(.c) void,
    worker_poll_workflow_activation: WorkerPollFn,
    worker_poll_activity_task: WorkerPollFn,
    /// Mirrors `temporal_core_worker_initiate_shutdown(worker)`; no user data or callback.
    worker_initiate_shutdown: WorkerInitiateShutdownFn,
    /// Mirrors `temporal_core_worker_finalize_shutdown(worker, user_data, callback)` and reuses `TemporalCoreWorkerCallback`.
    worker_finalize_shutdown: WorkerFinalizeShutdownFn,
    worker_replayer_new: *const fn (?*Runtime, *const WorkerOptions) callconv(.c) WorkerReplayerOrFail,
    worker_replay_push: *const fn (?*Worker, ?*WorkerReplayPusher, ByteArrayRef, ByteArrayRef) callconv(.c) WorkerReplayPushResult,
    worker_replay_pusher_free: *const fn (?*WorkerReplayPusher) callconv(.c) void,
};

pub const stub_api: Api = .{
    .runtime_new = stubRuntimeNew,
    .runtime_free = stubRuntimeFree,
    .byte_array_free = stubByteArrayFree,
    .client_connect = stubClientConnect,
    .client_free = stubClientFree,
    .client_update_metadata = stubClientUpdateMetadata,
    .client_update_api_key = stubClientUpdateApiKey,
    .client_rpc_call = stubClientRpcCall,
    .worker_new = stubWorkerNew,
    .worker_free = stubWorkerFree,
    .worker_poll_workflow_activation = fallbackWorkerPollWorkflowActivation,
    .worker_poll_activity_task = stubWorkerPollActivityTask,
    .worker_initiate_shutdown = stubWorkerInitiateShutdown,
    .worker_finalize_shutdown = stubWorkerFinalizeShutdown,
    .worker_replayer_new = stubWorkerReplayerNew,
    .worker_replay_push = stubWorkerReplayPush,
    .worker_replay_pusher_free = stubWorkerReplayPusherFree,
};

pub const extern_api: Api = .{
    .runtime_new = runtimeNewBridge,
    .runtime_free = runtimeFreeBridge,
    .byte_array_free = runtimeByteArrayFreeBridge,
    .client_connect = clientConnectBridge,
    .client_free = clientFreeBridge,
    .client_update_metadata = clientUpdateMetadataBridge,
    .client_update_api_key = clientUpdateApiKeyBridge,
    .client_rpc_call = clientRpcCallBridge,
    .worker_new = workerNewBridge,
    .worker_free = workerFreeBridge,
    .worker_poll_workflow_activation = workerPollWorkflowActivationBridge,
    .worker_poll_activity_task = workerPollActivityTaskBridge,
    .worker_initiate_shutdown = workerInitiateShutdownBridge,
    .worker_finalize_shutdown = workerFinalizeShutdownBridge,
    .worker_replayer_new = workerReplayerNewBridge,
    .worker_replay_push = workerReplayPushBridge,
    .worker_replay_pusher_free = workerReplayPusherFreeBridge,
};

pub var api: Api = stub_api;

var api_installed = std.atomic.Value(bool).init(false);

pub fn ensureExternalApiInstalled() void {
    if (!api_installed.swap(true, .seq_cst)) {
        api = extern_api;
        registerTemporalCoreCallbacks(
            workerCompleteWorkflowActivationBridge,
            runtimeByteArrayFreeBridge,
            workerPollWorkflowActivationBridge,
            workerCompleteActivityTaskBridge,
            workerRecordActivityHeartbeatBridge,
        );
    }
}

pub const SignalWorkflowError = error{
    NotFound,
    ClientUnavailable,
    Internal,
};

const signal_workflow_rpc = "SignalWorkflowExecution";

pub const CancelWorkflowError = error{
    NotFound,
    ClientUnavailable,
    Internal,
};

const cancel_workflow_rpc = "RequestCancelWorkflowExecution";

fn makeByteArrayRef(slice: []const u8) ByteArrayRef {
    return .{ .data = if (slice.len == 0) null else slice.ptr, .size = slice.len };
}

fn emptyByteArrayRef() ByteArrayRef {
    return .{ .data = null, .size = 0 };
}

fn writeVarint(buffer: *ArrayListManaged(u8), value: u64) !void {
    var remaining = value;
    while (true) {
        var byte: u8 = @intCast(remaining & 0x7F);
        remaining >>= 7;
        if (remaining != 0) {
            byte |= 0x80;
        }
        try buffer.append(byte);
        if (remaining == 0) break;
    }
}

fn writeTag(buffer: *ArrayListManaged(u8), field_number: u32, wire_type: u3) !void {
    const key = (@as(u64, field_number) << 3) | wire_type;
    try writeVarint(buffer, key);
}

fn appendLengthDelimited(buffer: *ArrayListManaged(u8), field_number: u32, bytes: []const u8) !void {
    try writeTag(buffer, field_number, 2);
    try writeVarint(buffer, bytes.len);
    try buffer.appendSlice(bytes);
}

fn appendString(buffer: *ArrayListManaged(u8), field_number: u32, value: []const u8) !void {
    try appendLengthDelimited(buffer, field_number, value);
}

fn appendBytes(buffer: *ArrayListManaged(u8), field_number: u32, value: []const u8) !void {
    try appendLengthDelimited(buffer, field_number, value);
}

fn encodeMetadataEntry(allocator: std.mem.Allocator, key: []const u8, value: []const u8) ![]u8 {
    var entry = ArrayListManaged(u8).init(allocator);
    defer entry.deinit();

    try appendString(&entry, 1, key);
    try appendBytes(&entry, 2, value);

    return entry.toOwnedSlice();
}

fn encodeJsonPayload(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    const json_bytes = try std.json.Stringify.valueAlloc(allocator, value, .{});
    defer allocator.free(json_bytes);

    var payload = ArrayListManaged(u8).init(allocator);
    defer payload.deinit();

    const metadata_entry = try encodeMetadataEntry(allocator, "encoding", "json/plain");
    defer allocator.free(metadata_entry);

    try appendLengthDelimited(&payload, 1, metadata_entry);
    try appendBytes(&payload, 2, json_bytes);

    return payload.toOwnedSlice();
}

fn encodePayloadsFromArray(allocator: std.mem.Allocator, array: *std.json.Array) !?[]u8 {
    if (array.items.len == 0) return null;

    var payloads = ArrayListManaged(u8).init(allocator);
    defer payloads.deinit();

    for (array.items) |item| {
        const payload_bytes = try encodeJsonPayload(allocator, item);
        defer allocator.free(payload_bytes);
        try appendLengthDelimited(&payloads, 1, payload_bytes);
    }

    const owned = try payloads.toOwnedSlice();
    const result: ?[]u8 = owned;
    return result;
}

fn encodeWorkflowExecution(
    allocator: std.mem.Allocator,
    workflow_id: []const u8,
    run_id: ?[]const u8,
) ![]u8 {
    var execution = ArrayListManaged(u8).init(allocator);
    defer execution.deinit();

    try appendString(&execution, 1, workflow_id);
    if (run_id) |value| {
        if (value.len != 0) {
            try appendString(&execution, 2, value);
        }
    }

    return execution.toOwnedSlice();
}

const SignalWorkflowRequestParts = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    run_id: ?[]const u8 = null,
    signal_name: []const u8,
    identity: ?[]const u8 = null,
    request_id: ?[]const u8 = null,
    args: ?*std.json.Array = null,
};

const CancelWorkflowRequestParts = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    run_id: ?[]const u8 = null,
    identity: ?[]const u8 = null,
    request_id: ?[]const u8 = null,
    first_execution_run_id: ?[]const u8 = null,
};

fn encodeSignalWorkflowRequest(
    allocator: std.mem.Allocator,
    params: SignalWorkflowRequestParts,
) ![]u8 {
    var request = ArrayListManaged(u8).init(allocator);
    defer request.deinit();

    try appendString(&request, 1, params.namespace);

    const execution_bytes = try encodeWorkflowExecution(allocator, params.workflow_id, params.run_id);
    defer allocator.free(execution_bytes);
    try appendLengthDelimited(&request, 2, execution_bytes);

    try appendString(&request, 3, params.signal_name);

    if (params.args) |array_ptr| {
        if (try encodePayloadsFromArray(allocator, array_ptr)) |payload_bytes| {
            defer allocator.free(payload_bytes);
            try appendLengthDelimited(&request, 4, payload_bytes);
        }
    }

    if (params.identity) |identity_slice| {
        if (identity_slice.len != 0) {
            try appendString(&request, 5, identity_slice);
        }
    }

    if (params.request_id) |request_id_slice| {
        if (request_id_slice.len != 0) {
            try appendString(&request, 6, request_id_slice);
        }
    }

    return request.toOwnedSlice();
}

fn encodeCancelWorkflowRequest(
    allocator: std.mem.Allocator,
    params: CancelWorkflowRequestParts,
) ![]u8 {
    var request = ArrayListManaged(u8).init(allocator);
    defer request.deinit();

    try appendString(&request, 1, params.namespace);

    const execution_bytes = try encodeWorkflowExecution(allocator, params.workflow_id, params.run_id);
    defer allocator.free(execution_bytes);
    try appendLengthDelimited(&request, 2, execution_bytes);

    if (params.identity) |identity_slice| {
        if (identity_slice.len != 0) {
            try appendString(&request, 3, identity_slice);
        }
    }

    if (params.request_id) |request_id_slice| {
        if (request_id_slice.len != 0) {
            try appendString(&request, 4, request_id_slice);
        }
    }

    if (params.first_execution_run_id) |first_slice| {
        if (first_slice.len != 0) {
            try appendString(&request, 5, first_slice);
        }
    }

    return request.toOwnedSlice();
}

const SignalWorkflowRpcContext = struct {
    wait_group: std.Thread.WaitGroup = .{},
    success: bool = false,
    status_code: u32 = 0,
};

fn signalWorkflowRpcCallback(
    user_data: ?*anyopaque,
    success: ?*const ByteArray,
    status_code: u32,
    failure_message: ?*const ByteArray,
    failure_details: ?*const ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*SignalWorkflowRpcContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    if (success) |ptr| {
        api.byte_array_free(null, ptr);
    }

    if (failure_message) |ptr| {
        api.byte_array_free(null, ptr);
    }

    if (failure_details) |ptr| {
        api.byte_array_free(null, ptr);
    }

    if (status_code == 0) {
        context.success = true;
        context.status_code = 0;
    } else {
        context.success = false;
        context.status_code = status_code;
    }
}

fn requireStringFieldGeneric(
    comptime ErrorType: type,
    object: *std.json.ObjectMap,
    key: []const u8,
) ErrorType![]const u8 {
    const value_ptr = object.getPtr(key) orelse return ErrorType.Internal;
    return switch (value_ptr.*) {
        .string => |s| {
            if (s.len == 0) return ErrorType.Internal;
            return s;
        },
        else => ErrorType.Internal,
    };
}

fn optionalStringFieldGeneric(
    comptime ErrorType: type,
    object: *std.json.ObjectMap,
    key: []const u8,
) ErrorType!?[]const u8 {
    if (object.getPtr(key)) |value_ptr| {
        return switch (value_ptr.*) {
            .string => |s| {
                if (s.len == 0) return null;
                return s;
            },
            .null => null,
            else => ErrorType.Internal,
        };
    }
    return null;
}

fn optionalArrayFieldGeneric(
    comptime ErrorType: type,
    object: *std.json.ObjectMap,
    key: []const u8,
) ErrorType!?*std.json.Array {
    if (object.getPtr(key)) |value_ptr| {
        return switch (value_ptr.*) {
            .array => |*arr| arr,
            .null => null,
            else => ErrorType.Internal,
        };
    }
    return null;
}

fn requireStringField(object: *std.json.ObjectMap, key: []const u8) SignalWorkflowError![]const u8 {
    return requireStringFieldGeneric(SignalWorkflowError, object, key);
}

fn optionalStringField(object: *std.json.ObjectMap, key: []const u8) SignalWorkflowError!?[]const u8 {
    return optionalStringFieldGeneric(SignalWorkflowError, object, key);
}

fn optionalArrayField(object: *std.json.ObjectMap, key: []const u8) SignalWorkflowError!?*std.json.Array {
    return optionalArrayFieldGeneric(SignalWorkflowError, object, key);
}

pub fn signalWorkflow(_client: ?*ClientOpaque, request_json: []const u8) SignalWorkflowError!void {
    if (_client == null) {
        return SignalWorkflowError.ClientUnavailable;
    }

    if (api.client_rpc_call == stub_api.client_rpc_call) {
        return SignalWorkflowError.ClientUnavailable;
    }

    const allocator = std.heap.c_allocator;

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, request_json, .{
        .ignore_unknown_fields = true,
    }) catch {
        return SignalWorkflowError.Internal;
    };
    defer parsed.deinit();

    const root = parsed.value;
    if (root != .object) {
        return SignalWorkflowError.Internal;
    }

    var object = root.object;

    const namespace_slice = requireStringField(&object, "namespace") catch {
        return SignalWorkflowError.Internal;
    };
    const workflow_id_slice = requireStringField(&object, "workflow_id") catch {
        return SignalWorkflowError.Internal;
    };
    const signal_name_slice = requireStringField(&object, "signal_name") catch {
        return SignalWorkflowError.Internal;
    };
    const run_id_slice = optionalStringField(&object, "run_id") catch {
        return SignalWorkflowError.Internal;
    };
    const identity_slice = optionalStringField(&object, "identity") catch {
        return SignalWorkflowError.Internal;
    };
    const request_id_slice = optionalStringField(&object, "request_id") catch {
        return SignalWorkflowError.Internal;
    };
    const args_array = optionalArrayField(&object, "args") catch {
        return SignalWorkflowError.Internal;
    };

    const params = SignalWorkflowRequestParts{
        .namespace = namespace_slice,
        .workflow_id = workflow_id_slice,
        .run_id = run_id_slice,
        .signal_name = signal_name_slice,
        .identity = identity_slice,
        .request_id = request_id_slice,
        .args = args_array,
    };

    const request_bytes = encodeSignalWorkflowRequest(allocator, params) catch {
        return SignalWorkflowError.Internal;
    };
    defer allocator.free(request_bytes);

    const request_slice: []const u8 = request_bytes;
    const client = _client.?;

    var context = SignalWorkflowRpcContext{};
    context.wait_group.start();

    var call_options = std.mem.zeroes(RpcCallOptions);
    call_options.service = 1; // Workflow service
    call_options.rpc = makeByteArrayRef(signal_workflow_rpc);
    call_options.req = makeByteArrayRef(request_slice);
    call_options.retry = true;
    call_options.metadata = emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    api.client_rpc_call(client, &call_options, &context, signalWorkflowRpcCallback);
    context.wait_group.wait();

    if (!context.success) {
        return switch (context.status_code) {
            5 => SignalWorkflowError.NotFound,
            14 => SignalWorkflowError.ClientUnavailable,
            else => SignalWorkflowError.Internal,
        };
    }
}

const CancelWorkflowRpcContext = struct {
    wait_group: std.Thread.WaitGroup = .{},
    success: bool = false,
    status_code: u32 = 0,
};

fn cancelWorkflowRpcCallback(
    user_data: ?*anyopaque,
    success: ?*const ByteArray,
    status_code: u32,
    failure_message: ?*const ByteArray,
    failure_details: ?*const ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*CancelWorkflowRpcContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    if (success) |ptr| {
        api.byte_array_free(null, ptr);
    }

    if (failure_message) |ptr| {
        api.byte_array_free(null, ptr);
    }

    if (failure_details) |ptr| {
        api.byte_array_free(null, ptr);
    }

    if (status_code == 0) {
        context.success = true;
        context.status_code = 0;
        return;
    }

    context.success = false;
    context.status_code = status_code;
}

pub fn cancelWorkflow(_client: ?*ClientOpaque, request_json: []const u8) CancelWorkflowError!void {
    if (_client == null) {
        return CancelWorkflowError.ClientUnavailable;
    }

    if (api.client_rpc_call == stub_api.client_rpc_call) {
        return CancelWorkflowError.ClientUnavailable;
    }

    const allocator = std.heap.c_allocator;

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, request_json, .{
        .ignore_unknown_fields = true,
    }) catch {
        return CancelWorkflowError.Internal;
    };
    defer parsed.deinit();

    const root = parsed.value;
    if (root != .object) {
        return CancelWorkflowError.Internal;
    }

    var object = root.object;

    const namespace_slice = requireStringFieldGeneric(CancelWorkflowError, &object, "namespace") catch {
        return CancelWorkflowError.Internal;
    };
    const workflow_id_slice = requireStringFieldGeneric(CancelWorkflowError, &object, "workflow_id") catch {
        return CancelWorkflowError.Internal;
    };
    const run_id_slice = optionalStringFieldGeneric(CancelWorkflowError, &object, "run_id") catch {
        return CancelWorkflowError.Internal;
    };
    const identity_slice = optionalStringFieldGeneric(CancelWorkflowError, &object, "identity") catch {
        return CancelWorkflowError.Internal;
    };
    const request_id_slice = optionalStringFieldGeneric(CancelWorkflowError, &object, "request_id") catch {
        return CancelWorkflowError.Internal;
    };
    const first_execution_run_id_slice =
        optionalStringFieldGeneric(CancelWorkflowError, &object, "first_execution_run_id") catch {
            return CancelWorkflowError.Internal;
        };

    const params = CancelWorkflowRequestParts{
        .namespace = namespace_slice,
        .workflow_id = workflow_id_slice,
        .run_id = run_id_slice,
        .identity = identity_slice,
        .request_id = request_id_slice,
        .first_execution_run_id = first_execution_run_id_slice,
    };

    const request_bytes = encodeCancelWorkflowRequest(allocator, params) catch {
        return CancelWorkflowError.Internal;
    };
    defer allocator.free(request_bytes);

    const client = _client.?;

    var context = CancelWorkflowRpcContext{};
    context.wait_group.start();

    var call_options = std.mem.zeroes(RpcCallOptions);
    call_options.service = 1; // Workflow service
    call_options.rpc = makeByteArrayRef(cancel_workflow_rpc);
    call_options.req = makeByteArrayRef(request_bytes);
    call_options.retry = true;
    call_options.metadata = emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    api.client_rpc_call(client, &call_options, &context, cancelWorkflowRpcCallback);
    context.wait_group.wait();

    if (!context.success) {
        return switch (context.status_code) {
            5 => CancelWorkflowError.NotFound,
            14 => CancelWorkflowError.ClientUnavailable,
            else => CancelWorkflowError.Internal,
        };
    }
}
