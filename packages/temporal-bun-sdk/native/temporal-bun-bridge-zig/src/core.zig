// This module will host the C-ABI imports for the Temporal Rust SDK once the headers are generated.
// TODO(codex, zig-core-01): Generate headers via cbindgen and replace these extern placeholders.
// See packages/temporal-bun-sdk/docs/ffi-surface.md and docs/zig-bridge-migration-plan.md.

pub const RuntimeOpaque = opaque {};
pub const ClientOpaque = opaque {};
pub const WorkerOpaque = opaque {};

const empty_bytes = [_]u8{};

pub const ByteBuf = extern struct {
    data_ptr: ?[*]u8,
    len: usize,
    cap: usize,
};

pub fn byteBufFromSlice(bytes: []const u8) ByteBuf {
    if (bytes.len == 0) {
        return .{
            .data_ptr = null,
            .len = 0,
            .cap = 0,
        };
    }

    return .{
        .data_ptr = @as(?[*]u8, @ptrCast(@constCast(bytes.ptr))),
        .len = bytes.len,
        .cap = bytes.len,
    };
}

pub fn emptyByteBuf() ByteBuf {
    return .{
        .data_ptr = null,
        .len = 0,
        .cap = 0,
    };
}

pub fn sliceFromByteBuf(buf: ByteBuf) []const u8 {
    if (buf.data_ptr) |ptr| {
        return ptr[0..buf.len];
    }
    return empty_bytes[0..0];
}

extern fn temporal_sdk_core_runtime_new(options_json: ?[*]const u8, len: usize) ?*RuntimeOpaque;
extern fn temporal_sdk_core_runtime_free(handle: ?*RuntimeOpaque) void;

extern fn temporal_sdk_core_connect_async(
    runtime: ?*RuntimeOpaque,
    config_json: ?[*]const u8,
    len: usize,
) ?*ClientOpaque;

extern fn temporal_sdk_core_client_free(handle: ?*ClientOpaque) void;

extern fn temporal_sdk_core_worker_respond_activity_task_completed(
    worker: ?*WorkerOpaque,
    task_token: ByteBuf,
    result: ByteBuf,
) i32;

extern fn temporal_sdk_core_worker_respond_activity_task_failed(
    worker: ?*WorkerOpaque,
    task_token: ByteBuf,
    failure: ByteBuf,
) i32;

// TODO(codex, temporal-zig-phase-0): wire all exported Temporal client RPCs once the header generation lands.

pub const api = struct {
    pub const runtime_new = temporal_sdk_core_runtime_new;
    pub const runtime_free = temporal_sdk_core_runtime_free;
    pub const connect_async = temporal_sdk_core_connect_async;
    pub const client_free = temporal_sdk_core_client_free;
    pub const worker_respond_activity_task_completed = temporal_sdk_core_worker_respond_activity_task_completed;
    pub const worker_respond_activity_task_failed = temporal_sdk_core_worker_respond_activity_task_failed;
};
