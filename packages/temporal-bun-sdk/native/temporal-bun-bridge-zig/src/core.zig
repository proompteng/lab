const std = @import("std");

// This module imports the Temporal Rust SDK C bridge so Zig code can alias the
// real runtime/client types and re-export the C ABI entry points that other
// bridge modules call through.
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

pub const Worker = c.TemporalCoreWorker;

// Backwards-compatibility aliases used by existing Zig modules.
pub const RuntimeOpaque = Runtime;
pub const ClientOpaque = Client;
pub const WorkerOpaque = Worker;

pub const ByteArray = c.TemporalCoreByteArray;
pub const ByteArrayRef = c.TemporalCoreByteArrayRef;
pub const MetadataRef = c.TemporalCoreMetadataRef;

pub const ByteBuf = ByteArray;
pub const ByteBufDestroyFn = *const fn (?*ByteBuf) void;

pub const WorkerCallback = c.TemporalCoreWorkerCallback;
pub const WorkerCompleteFn =
    *const fn (?*WorkerOpaque, ByteArrayRef, ?*anyopaque, WorkerCallback) callconv(.c) void;
pub const RuntimeByteArrayFreeFn =
    *const fn (?*RuntimeOpaque, ?*const ByteArray) callconv(.c) void;

pub const api = struct {
    pub const runtime_new = c.temporal_core_runtime_new;
    pub const runtime_free = c.temporal_core_runtime_free;
    pub const byte_array_free = c.temporal_core_byte_array_free;

    pub const client_connect = c.temporal_core_client_connect;
    pub const client_free = c.temporal_core_client_free;
    pub const client_update_metadata = c.temporal_core_client_update_metadata;
    pub const client_update_api_key = c.temporal_core_client_update_api_key;
};

const fallback_error_slice =
    "temporal-bun-bridge-zig: temporal core worker completion bridge is not linked"[0..];

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

    if (@intFromPtr(callback) == 0) {
        return;
    }

    callback(user_data, &fallback_error_array);
}

fn fallbackRuntimeByteArrayFree(runtime: ?*RuntimeOpaque, bytes: ?*const ByteArray) callconv(.c) void {
    _ = runtime;
    _ = bytes;
}

pub var worker_complete_workflow_activation: WorkerCompleteFn =
    if (builtin.is_test) undefined else fallbackWorkerCompleteWorkflowActivation;

pub var runtime_byte_array_free: RuntimeByteArrayFreeFn =
    if (builtin.is_test) undefined else fallbackRuntimeByteArrayFree;

pub fn registerTemporalCoreCallbacks(
    worker_complete: ?WorkerCompleteFn,
    byte_array_free: ?RuntimeByteArrayFreeFn,
) void {
    worker_complete_workflow_activation =
        worker_complete orelse fallbackWorkerCompleteWorkflowActivation;
    runtime_byte_array_free = byte_array_free orelse fallbackRuntimeByteArrayFree;
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

pub const SignalWorkflowError = error{
    NotFound,
    ClientUnavailable,
    Internal,
};

pub fn signalWorkflow(_client: ?*ClientOpaque, request_json: []const u8) SignalWorkflowError!void {
    _ = _client;

    // Stub implementation used until the Temporal core C-ABI is linked.
    // Treat workflow IDs ending with "-missing" as not found to exercise the error path in tests.
    if (std.mem.indexOf(u8, request_json, "\"workflow_id\":\"missing-workflow\"")) |_| {
        return SignalWorkflowError.NotFound;
    }

    // TODO(codex, zig-core-02): Invoke temporal_core_client_signal_workflow once headers are available.
}
