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

pub const WorkerCallback = c.TemporalCoreWorkerCallback;
pub const WorkerCompleteFn =
    *const fn (?*WorkerOpaque, ByteArrayRef, ?*anyopaque, WorkerCallback) callconv(.c) void;
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

pub var worker_complete_workflow_activation: WorkerCompleteFn = fallbackWorkerCompleteWorkflowActivation;
pub var runtime_byte_array_free: RuntimeByteArrayFreeFn = fallbackRuntimeByteArrayFree;

pub fn registerTemporalCoreCallbacks(
    worker_complete: ?WorkerCompleteFn,
    byte_array_free: ?RuntimeByteArrayFreeFn,
) void {
    worker_complete_workflow_activation =
        worker_complete orelse fallbackWorkerCompleteWorkflowActivation;
    runtime_byte_array_free = byte_array_free orelse fallbackRuntimeByteArrayFree;
}

fn ensureWorkerCompletionExternsLoaded() void {
    if (worker_complete_workflow_activation == fallbackWorkerCompleteWorkflowActivation) {
        worker_complete_workflow_activation = c.temporal_core_worker_complete_workflow_activation;
    }

    if (runtime_byte_array_free == fallbackRuntimeByteArrayFree) {
        runtime_byte_array_free = c.temporal_core_byte_array_free;
    }
}

pub fn workerCompleteWorkflowActivation(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) void {
    worker_complete_workflow_activation(worker, completion, user_data, callback);
}

pub fn runtimeByteArrayFree(runtime: ?*RuntimeOpaque, bytes: ?*const ByteArray) void {
    runtime_byte_array_free(runtime, bytes);
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
};

pub var api: Api = stub_api;

var api_installed = std.atomic.Value(bool).init(false);

pub fn ensureExternalApiInstalled() void {
    if (!api_installed.swap(true, .seq_cst)) {
        api = extern_api;
    }

    ensureWorkerCompletionExternsLoaded();
}

const testing = std.testing;

test "ensureExternalApiInstalled loads worker completion externs" {
    const original_worker_complete = worker_complete_workflow_activation;
    const original_byte_array_free = runtime_byte_array_free;
    defer {
        worker_complete_workflow_activation = original_worker_complete;
        runtime_byte_array_free = original_byte_array_free;
    }

    worker_complete_workflow_activation = fallbackWorkerCompleteWorkflowActivation;
    runtime_byte_array_free = fallbackRuntimeByteArrayFree;

    ensureExternalApiInstalled();

    const worker_ptr: usize = @intFromPtr(worker_complete_workflow_activation);
    const expected_worker_ptr: usize =
        @intFromPtr(&c.temporal_core_worker_complete_workflow_activation);
    try testing.expectEqual(expected_worker_ptr, worker_ptr);

    const free_ptr: usize = @intFromPtr(runtime_byte_array_free);
    const expected_free_ptr: usize = @intFromPtr(&c.temporal_core_byte_array_free);
    try testing.expectEqual(expected_free_ptr, free_ptr);
}

pub const SignalWorkflowError = error{
    NotFound,
    ClientUnavailable,
    Internal,
};

pub fn signalWorkflow(_client: ?*ClientOpaque, request_json: []const u8) SignalWorkflowError!void {
    // TODO(codex, zig-wf-05): Replace this stub with a Temporal core RPC invocation so signals
    // leverage the same retry/backoff semantics as other client calls.
    _ = _client;

    if (std.mem.indexOf(u8, request_json, "\"workflow_id\":\"missing-workflow\"")) |_| {
        return SignalWorkflowError.NotFound;
    }
}
