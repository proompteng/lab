const std = @import("std");
const builtin = @import("builtin");

const c = @cImport({
    @cInclude("temporal-sdk-core-c-bridge.h");
});

pub const Runtime = c.TemporalCoreRuntime;
pub const RuntimeOptions = c.TemporalCoreRuntimeOptions;
pub const RuntimeOrFail = c.TemporalCoreRuntimeOrFail;
pub const TelemetryOptions = c.TemporalCoreTelemetryOptions;
pub const LoggingOptions = c.TemporalCoreLoggingOptions;
pub const MetricsOptions = c.TemporalCoreMetricsOptions;
pub const OpenTelemetryOptions = c.TemporalCoreOpenTelemetryOptions;
pub const PrometheusOptions = c.TemporalCorePrometheusOptions;
pub const OpenTelemetryMetricTemporality = c.TemporalCoreOpenTelemetryMetricTemporality;
pub const OpenTelemetryProtocol = c.TemporalCoreOpenTelemetryProtocol;

pub const Client = c.TemporalCoreClient;
pub const ClientOptions = c.TemporalCoreClientOptions;
pub const ClientConnectCallback = c.TemporalCoreClientConnectCallback;
pub const ClientTlsOptions = c.TemporalCoreClientTlsOptions;
pub const ClientRetryOptions = c.TemporalCoreClientRetryOptions;
pub const ClientKeepAliveOptions = c.TemporalCoreClientKeepAliveOptions;
pub const ClientHttpConnectProxyOptions = c.TemporalCoreClientHttpConnectProxyOptions;

pub const Worker = c.TemporalCoreWorker;
pub const WorkerOptions = c.TemporalCoreWorkerOptions;
pub const WorkerOrFail = c.TemporalCoreWorkerOrFail;
pub const WorkerVersioningStrategy = c.TemporalCoreWorkerVersioningStrategy;
pub const WorkerVersioningStrategyTag = c.TemporalCoreWorkerVersioningStrategy_Tag;
pub const WorkerTunerHolder = c.TemporalCoreTunerHolder;
pub const WorkerPollerBehavior = c.TemporalCorePollerBehavior;
pub const WorkerByteArrayRefArray = c.TemporalCoreByteArrayRefArray;

pub const RpcService = c.TemporalCoreRpcService;
pub const RpcCallOptions = c.TemporalCoreRpcCallOptions;
pub const ClientRpcCallCallback = c.TemporalCoreClientRpcCallCallback;
pub const CancellationToken = c.TemporalCoreCancellationToken;

pub const RuntimeOpaque = Runtime;
pub const ClientOpaque = Client;
pub const WorkerOpaque = Worker;

pub const ByteArray = c.TemporalCoreByteArray;
pub const ByteArrayRef = c.TemporalCoreByteArrayRef;
pub const MetadataRef = c.TemporalCoreMetadataRef;
pub const ByteBuf = ByteArray;
pub const ByteBufDestroyFn = *const fn (?*RuntimeOpaque, ?*const ByteBuf) callconv(.c) void;

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
};

pub const extern_api: Api = .{
    .runtime_new = c.temporal_core_runtime_new,
    .runtime_free = c.temporal_core_runtime_free,
    .byte_array_free = c.temporal_core_byte_array_free,
    .client_connect = c.temporal_core_client_connect,
    .client_free = c.temporal_core_client_free,
    .client_update_metadata = c.temporal_core_client_update_metadata,
    .client_update_api_key = c.temporal_core_client_update_api_key,
    .client_rpc_call = c.temporal_core_client_rpc_call,
    .worker_new = c.temporal_core_worker_new,
    .worker_free = c.temporal_core_worker_free,
    .worker_poll_workflow_activation = c.temporal_core_worker_poll_workflow_activation,
    .worker_poll_activity_task = c.temporal_core_worker_poll_activity_task,
    .worker_initiate_shutdown = c.temporal_core_worker_initiate_shutdown,
    .worker_finalize_shutdown = c.temporal_core_worker_finalize_shutdown,
};

pub var api: Api = stub_api;

var api_installed = std.atomic.Value(bool).init(false);

pub fn ensureExternalApiInstalled() void {
    if (!api_installed.swap(true, .seq_cst)) {
        api = extern_api;
        registerTemporalCoreCallbacks(
            c.temporal_core_worker_complete_workflow_activation,
            c.temporal_core_byte_array_free,
            c.temporal_core_worker_poll_workflow_activation,
            c.temporal_core_worker_complete_activity_task,
            c.temporal_core_worker_record_activity_heartbeat,
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
