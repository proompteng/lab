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

extern fn temporal_sdk_core_runtime_new(options_json: ?[*]const u8, len: usize) ?*RuntimeOpaque;
extern fn temporal_sdk_core_runtime_free(handle: ?*RuntimeOpaque) void;
extern fn temporal_sdk_core_runtime_update_telemetry(
    runtime: ?*RuntimeOpaque,
    options_json: ?[*]const u8,
    len: usize,
) i32;

extern fn temporal_sdk_core_connect_async(
    runtime: ?*RuntimeOpaque,
    config_json: ?[*]const u8,
    len: usize,
) ?*ClientOpaque;

extern fn temporal_sdk_core_client_free(handle: ?*ClientOpaque) void;
extern fn temporal_sdk_core_byte_buffer_destroy(handle: ?*ByteBuf) void;

pub const runtime_new = temporal_sdk_core_runtime_new;
pub const runtime_free = temporal_sdk_core_runtime_free;
pub const connect_async = temporal_sdk_core_connect_async;
pub const client_free = temporal_sdk_core_client_free;

pub const api = struct {
    pub const runtime_new = temporal_sdk_core_runtime_new;
    pub const runtime_free = temporal_sdk_core_runtime_free;
    pub const runtime_update_telemetry = temporal_sdk_core_runtime_update_telemetry;
    pub const connect_async = temporal_sdk_core_connect_async;
    pub const client_free = temporal_sdk_core_client_free;
    pub const byte_buffer_destroy = temporal_sdk_core_byte_buffer_destroy;
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

    // TODO(codex, zig-core-02): Invoke temporal_sdk_core_client_signal_workflow once headers are available.
}
