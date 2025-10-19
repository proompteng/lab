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

pub const WorkerCallback = *const fn (?*anyopaque, ?*const ByteArray) callconv(.C) void;
pub const WorkerCompleteFn = *const fn (?*WorkerOpaque, ByteArrayRef, ?*anyopaque, WorkerCallback) callconv(.C) void;
pub const RuntimeByteArrayFreeFn = *const fn (?*RuntimeOpaque, ?*const ByteArray) callconv(.C) void;

extern fn temporal_sdk_core_runtime_new(options_json: ?[*]const u8, len: usize) ?*RuntimeOpaque;
extern fn temporal_sdk_core_runtime_free(handle: ?*RuntimeOpaque) void;

extern fn temporal_sdk_core_connect_async(
    runtime: ?*RuntimeOpaque,
    config_json: ?[*]const u8,
    len: usize,
) ?*ClientOpaque;

extern fn temporal_sdk_core_client_free(handle: ?*ClientOpaque) void;
extern fn temporal_sdk_core_byte_buffer_destroy(handle: ?*ByteBuf) void;

extern fn temporal_sdk_core_worker_complete_workflow_activation(
    worker: ?*WorkerOpaque,
    completion: ByteArrayRef,
    user_data: ?*anyopaque,
    callback: WorkerCallback,
) void;

extern fn temporal_sdk_core_byte_array_free(runtime: ?*RuntimeOpaque, bytes: ?*const ByteArray) void;

pub const api = struct {
    pub const runtime_new = temporal_sdk_core_runtime_new;
    pub const runtime_free = temporal_sdk_core_runtime_free;
    pub const connect_async = temporal_sdk_core_connect_async;
    pub const client_free = temporal_sdk_core_client_free;
    pub const byte_buffer_destroy = temporal_sdk_core_byte_buffer_destroy;
};

pub var worker_complete_workflow_activation: WorkerCompleteFn = blk: {
    if (builtin.is_test) break :blk undefined;
    break :blk temporal_sdk_core_worker_complete_workflow_activation;
};

pub var runtime_byte_array_free: RuntimeByteArrayFreeFn = blk: {
    if (builtin.is_test) break :blk undefined;
    break :blk temporal_sdk_core_byte_array_free;
};

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
