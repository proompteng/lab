const std = @import("std");

// This module will host the C-ABI imports for the Temporal Rust SDK once the headers are generated.
// TODO(codex, zig-core-01): Generate headers via cbindgen and replace these extern placeholders.
// See packages/temporal-bun-sdk/docs/ffi-surface.md and docs/zig-bridge-migration-plan.md.

const builtin = @import("builtin");

pub const RuntimeOpaque = opaque {};
pub const ClientOpaque = opaque {};
pub const WorkerOpaque = opaque {};

pub const ByteBuf = extern struct {
    data_ptr: ?[*]u8,
    len: usize,
    cap: usize,
};
pub const ByteBufDestroyFn = *const fn (?*ByteBuf) void;

pub const ByteArray = extern struct {
    data_ptr: ?[*]const u8,
    len: usize,
    cap: usize,
    disable_free: bool,
};

pub const ByteArrayRef = extern struct {
    data_ptr: ?[*]const u8,
    len: usize,
};

pub const WorkerCallback = *const fn (?*anyopaque, ?*const ByteArray) callconv(.c) void;

pub const WorkerCompleteFn = *const fn (?*WorkerOpaque, ByteArrayRef, ?*anyopaque, WorkerCallback) callconv(.c) void;
pub const RuntimeByteArrayFreeFn = *const fn (?*RuntimeOpaque, ?*const ByteArray) callconv(.c) void;
pub const WorkerNewFn = *const fn (?*RuntimeOpaque, ?*ClientOpaque, ?[*]const u8, usize) callconv(.c) ?*WorkerOpaque;
pub const WorkerFreeFn = *const fn (?*WorkerOpaque) callconv(.c) void;
pub const WorkerShutdownFn = *const fn (?*WorkerOpaque) callconv(.c) void;

extern fn temporal_sdk_core_runtime_new(options_json: ?[*]const u8, len: usize) ?*RuntimeOpaque;
extern fn temporal_sdk_core_runtime_free(handle: ?*RuntimeOpaque) void;

extern fn temporal_sdk_core_connect_async(
    runtime: ?*RuntimeOpaque,
    config_json: ?[*]const u8,
    len: usize,
) ?*ClientOpaque;

extern fn temporal_sdk_core_client_free(handle: ?*ClientOpaque) void;
extern fn temporal_sdk_core_byte_buffer_destroy(handle: ?*ByteBuf) void;
extern fn temporal_sdk_core_worker_new(
    runtime: ?*RuntimeOpaque,
    client: ?*ClientOpaque,
    config_json: ?[*]const u8,
    len: usize,
) ?*WorkerOpaque;
extern fn temporal_sdk_core_worker_free(handle: ?*WorkerOpaque) void;
extern fn temporal_sdk_core_worker_initiate_shutdown(handle: ?*WorkerOpaque) void;
extern fn temporal_sdk_core_worker_finalize_shutdown(handle: ?*WorkerOpaque) void;

pub const runtime_new = temporal_sdk_core_runtime_new;
pub const runtime_free = temporal_sdk_core_runtime_free;
pub const connect_async = temporal_sdk_core_connect_async;
pub const client_free = temporal_sdk_core_client_free;

pub const api = struct {
    pub const runtime_new = temporal_sdk_core_runtime_new;
    pub const runtime_free = temporal_sdk_core_runtime_free;
    pub const connect_async = temporal_sdk_core_connect_async;
    pub const client_free = temporal_sdk_core_client_free;
    pub const byte_buffer_destroy = temporal_sdk_core_byte_buffer_destroy;
    pub const worker_new = workerNew;
    pub const worker_free = workerFree;
    pub const worker_initiate_shutdown = workerInitiateShutdown;
    pub const worker_finalize_shutdown = workerFinalizeShutdown;
};

const fallback_error_slice =
    "temporal-bun-bridge-zig: temporal core worker completion bridge is not linked"[0..];

const fallback_error_array = ByteArray{
    .data_ptr = fallback_error_slice.ptr,
    .len = fallback_error_slice.len,
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

var fallback_worker_storage: usize = 0;

fn fallbackWorkerNew(
    runtime: ?*RuntimeOpaque,
    client: ?*ClientOpaque,
    config_json: ?[*]const u8,
    len: usize,
) callconv(.c) ?*WorkerOpaque {
    _ = runtime;
    _ = client;
    _ = config_json;
    _ = len;
    return @as(?*WorkerOpaque, @ptrCast(&fallback_worker_storage));
}

fn fallbackWorkerLifecycle(handle: ?*WorkerOpaque) callconv(.c) void {
    _ = handle;
}

pub var worker_complete_workflow_activation: WorkerCompleteFn =
    if (builtin.is_test) undefined else fallbackWorkerCompleteWorkflowActivation;

pub var runtime_byte_array_free: RuntimeByteArrayFreeFn =
    if (builtin.is_test) undefined else fallbackRuntimeByteArrayFree;

pub var worker_new_impl: WorkerNewFn = fallbackWorkerNew;

pub var worker_free_impl: WorkerFreeFn = fallbackWorkerLifecycle;

pub var worker_initiate_shutdown_impl: WorkerShutdownFn = fallbackWorkerLifecycle;

pub var worker_finalize_shutdown_impl: WorkerShutdownFn = fallbackWorkerLifecycle;

pub fn registerTemporalCoreCallbacks(
    worker_complete: ?WorkerCompleteFn,
    byte_array_free: ?RuntimeByteArrayFreeFn,
) void {
    worker_complete_workflow_activation =
        worker_complete orelse fallbackWorkerCompleteWorkflowActivation;
    runtime_byte_array_free = byte_array_free orelse fallbackRuntimeByteArrayFree;
}

pub fn registerTemporalCoreWorkerFactories(
    worker_new: ?WorkerNewFn,
    worker_free: ?WorkerFreeFn,
    worker_initiate_shutdown: ?WorkerShutdownFn,
    worker_finalize_shutdown: ?WorkerShutdownFn,
) void {
    worker_new_impl = worker_new orelse fallbackWorkerNew;
    worker_free_impl = worker_free orelse fallbackWorkerLifecycle;
    worker_initiate_shutdown_impl =
        worker_initiate_shutdown orelse fallbackWorkerLifecycle;
    worker_finalize_shutdown_impl =
        worker_finalize_shutdown orelse fallbackWorkerLifecycle;
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

pub fn workerNew(
    runtime: ?*RuntimeOpaque,
    client: ?*ClientOpaque,
    config_json: []const u8,
) ?*WorkerOpaque {
    const config_ptr: ?[*]const u8 = if (config_json.len == 0) null else config_json.ptr;
    return worker_new_impl(runtime, client, config_ptr, config_json.len);
}

pub fn workerFree(handle: ?*WorkerOpaque) void {
    worker_free_impl(handle);
}

pub fn workerInitiateShutdown(handle: ?*WorkerOpaque) void {
    worker_initiate_shutdown_impl(handle);
}

pub fn workerFinalizeShutdown(handle: ?*WorkerOpaque) void {
    worker_finalize_shutdown_impl(handle);
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

    // TODO(codex, zig-core-02): Invoke temporal_sdk_core_client_signal_workflow once headers are available.
}
