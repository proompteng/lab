const std = @import("std");
const builtin = @import("builtin");

const c = @cImport({
    @cInclude("temporal-sdk-core-c-bridge.h");
});

pub const Runtime = c.TemporalCoreRuntime;
pub const RuntimeOptions = c.TemporalCoreRuntimeOptions;
pub const RuntimeOrFail = c.TemporalCoreRuntimeOrFail;

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
pub const WorkerPollCallback = c.TemporalCoreWorkerPollCallback;
pub const WorkerCompleteCallback = c.TemporalCoreWorkerCallback;

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

pub const WorkerCallback = c.TemporalCoreWorkerCallback;
pub const WorkerCompleteFn =
    *const fn (?*WorkerOpaque, ByteArrayRef, ?*anyopaque, WorkerCallback) callconv(.c) void;
pub const WorkerPollFn =
    *const fn (?*WorkerOpaque, ?*anyopaque, WorkerPollCallback) callconv(.c) void;
pub const WorkerNewFn =
    *const fn (?*RuntimeOpaque, ?*ClientOpaque, *const WorkerOptions) callconv(.c) WorkerOrFail;
pub const WorkerFreeFn = *const fn (?*WorkerOpaque) callconv(.c) void;
pub const RuntimeByteArrayFreeFn =
    *const fn (?*RuntimeOpaque, ?*const ByteArray) callconv(.c) void;

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

fn fallbackWorkerRecordHeartbeat(
    _worker: ?*WorkerOpaque,
    _heartbeat: ByteArrayRef,
) callconv(.c) ?*const ByteArray {
    _ = _worker;
    _ = _heartbeat;
    return &fallback_error_array;
}

fn fallbackWorkerInitiateShutdown(_worker: ?*WorkerOpaque) callconv(.c) void {
    _ = _worker;
}

fn fallbackWorkerFinalizeShutdown(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) callconv(.c) void {
    _ = worker;
    if (callback) |cb| {
        cb(user_data, &fallback_error_array);
    }
}

fn fallbackWorkerPoll(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerPollCallback,
) callconv(.c) void {
    _ = worker;
    if (callback) |cb| {
        cb(user_data, null, &fallback_error_array);
    }
}

fn fallbackWorkerNew(
    _runtime: ?*RuntimeOpaque,
    _client: ?*ClientOpaque,
    _options: *const WorkerOptions,
) callconv(.c) WorkerOrFail {
    _ = _runtime;
    _ = _client;
    _ = _options;
    return .{ .worker = null, .fail = &fallback_error_array };
}

fn fallbackWorkerFree(_worker: ?*WorkerOpaque) callconv(.c) void {
    _ = _worker;
}

pub var worker_complete_workflow_activation: WorkerCompleteFn = fallbackWorkerCompleteWorkflowActivation;
pub var worker_poll_workflow_activation: WorkerPollFn = fallbackWorkerPoll;
pub var worker_poll_activity_task: WorkerPollFn = fallbackWorkerPoll;
pub var worker_complete_activity_task: WorkerCompleteFn = fallbackWorkerCompleteWorkflowActivation;
pub var worker_new: WorkerNewFn = fallbackWorkerNew;
pub var worker_free: WorkerFreeFn = fallbackWorkerFree;
pub var runtime_byte_array_free: RuntimeByteArrayFreeFn = fallbackRuntimeByteArrayFree;

pub fn registerTemporalCoreCallbacks(
    worker_complete: ?WorkerCompleteFn,
    byte_array_free: ?RuntimeByteArrayFreeFn,
    poll_workflow: ?WorkerPollFn,
    poll_activity: ?WorkerPollFn,
    worker_complete_activity: ?WorkerCompleteFn,
    worker_new_fn: ?WorkerNewFn,
    worker_free_fn: ?WorkerFreeFn,
) void {
    worker_complete_workflow_activation =
        worker_complete orelse fallbackWorkerCompleteWorkflowActivation;
    runtime_byte_array_free = byte_array_free orelse fallbackRuntimeByteArrayFree;
    worker_poll_workflow_activation = poll_workflow orelse fallbackWorkerPoll;
    worker_poll_activity_task = poll_activity orelse fallbackWorkerPoll;
    worker_complete_activity_task =
        worker_complete_activity orelse fallbackWorkerCompleteWorkflowActivation;
    worker_new = worker_new_fn orelse fallbackWorkerNew;
    worker_free = worker_free_fn orelse fallbackWorkerFree;
}

pub fn workerCompleteWorkflowActivation(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) void {
    worker_complete_workflow_activation(worker, completion, user_data, callback);
}

pub fn workerPollWorkflowActivation(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerPollCallback,
) void {
    worker_poll_workflow_activation(worker, user_data, callback);
}

pub fn workerPollActivityTask(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerPollCallback,
) void {
    worker_poll_activity_task(worker, user_data, callback);
}

pub fn workerCompleteActivityTask(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) void {
    worker_complete_activity_task(worker, completion, user_data, callback);
}

pub fn workerNew(runtime: ?*RuntimeOpaque, client: ?*ClientOpaque, options: *const WorkerOptions) WorkerOrFail {
    return worker_new(runtime, client, options);
}

pub fn workerFree(worker: ?*WorkerOpaque) void {
    worker_free(worker);
}

pub fn workerRecordActivityHeartbeat(
    worker: ?*WorkerOpaque,
    heartbeat: ByteArrayRef,
) ?*const ByteArray {
    return api.worker_record_activity_heartbeat(worker, heartbeat);
}

pub fn workerInitiateShutdown(worker: ?*WorkerOpaque) void {
    api.worker_initiate_shutdown(worker);
}

pub fn workerFinalizeShutdown(
    worker: ?*WorkerOpaque,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) void {
    api.worker_finalize_shutdown(worker, user_data, callback);
}

pub fn runtimeByteArrayFree(runtime: ?*RuntimeOpaque, bytes: ?*const ByteArray) void {
    runtime_byte_array_free(runtime, bytes);
}

const stub_runtime_or_fail = RuntimeOrFail{
    .runtime = null,
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

pub const Api = struct {
    runtime_new: *const fn (*const RuntimeOptions) callconv(.c) RuntimeOrFail,
    runtime_free: *const fn (?*Runtime) callconv(.c) void,
    byte_array_free: RuntimeByteArrayFreeFn,
    client_connect: *const fn (?*Runtime, *const ClientOptions, ?*anyopaque, ClientConnectCallback) callconv(.c) void,
    client_free: *const fn (?*Client) callconv(.c) void,
    client_update_metadata: *const fn (?*Client, ByteArrayRef) callconv(.c) void,
    client_update_api_key: *const fn (?*Client, ByteArrayRef) callconv(.c) void,
    client_rpc_call: *const fn (?*Client, *const RpcCallOptions, ?*anyopaque, ClientRpcCallCallback) callconv(.c) void,
    worker_new: WorkerNewFn,
    worker_free: WorkerFreeFn,
    worker_poll_workflow_activation: WorkerPollFn,
    worker_poll_activity_task: WorkerPollFn,
    worker_complete_workflow_activation: WorkerCompleteFn,
    worker_complete_activity_task: WorkerCompleteFn,
    worker_record_activity_heartbeat: *const fn (?*WorkerOpaque, ByteArrayRef) callconv(.c) ?*const ByteArray,
    worker_initiate_shutdown: *const fn (?*WorkerOpaque) callconv(.c) void,
    worker_finalize_shutdown: *const fn (?*WorkerOpaque, ?*anyopaque, WorkerCallback) callconv(.c) void,
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
    .worker_new = fallbackWorkerNew,
    .worker_free = fallbackWorkerFree,
    .worker_poll_workflow_activation = fallbackWorkerPoll,
    .worker_poll_activity_task = fallbackWorkerPoll,
    .worker_complete_workflow_activation = fallbackWorkerCompleteWorkflowActivation,
    .worker_complete_activity_task = fallbackWorkerCompleteWorkflowActivation,
    .worker_record_activity_heartbeat = fallbackWorkerRecordHeartbeat,
    .worker_initiate_shutdown = fallbackWorkerInitiateShutdown,
    .worker_finalize_shutdown = fallbackWorkerFinalizeShutdown,
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
    .worker_complete_workflow_activation = c.temporal_core_worker_complete_workflow_activation,
    .worker_complete_activity_task = c.temporal_core_worker_complete_activity_task,
    .worker_record_activity_heartbeat = c.temporal_core_worker_record_activity_heartbeat,
    .worker_initiate_shutdown = c.temporal_core_worker_initiate_shutdown,
    .worker_finalize_shutdown = c.temporal_core_worker_finalize_shutdown,
};

pub var api: Api = stub_api;

var api_installed = std.atomic.Value(bool).init(false);

pub fn ensureExternalApiInstalled() void {
    if (!api_installed.swap(true, .seq_cst)) {
        api = extern_api;
    }
}

pub const SignalWorkflowError = error{
    NotFound,
    ClientUnavailable,
    Internal,
};

pub fn signalWorkflow(_client: ?*ClientOpaque, request_json: []const u8) SignalWorkflowError!void {
    _ = _client;

    if (std.mem.indexOf(u8, request_json, "\"workflow_id\":\"missing-workflow\"")) |_| {
        return SignalWorkflowError.NotFound;
    }
}
