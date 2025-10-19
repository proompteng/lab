// This module will host the C-ABI imports for the Temporal Rust SDK once the headers are generated.
// TODO(codex, zig-core-01): Generate headers via cbindgen and replace these extern placeholders.
// See packages/temporal-bun-sdk/docs/ffi-surface.md and docs/zig-bridge-migration-plan.md.

pub const RuntimeOpaque = opaque {};
pub const ClientOpaque = opaque {};
pub const ByteBuf = extern struct {
    data_ptr: ?[*]u8,
    len: usize,
    cap: usize,
};
pub const ByteBufDestroyFn = *const fn (?*ByteBuf) void;

extern fn temporal_sdk_core_runtime_new(options_json: ?[*]const u8, len: usize) ?*RuntimeOpaque;
extern fn temporal_sdk_core_runtime_free(handle: ?*RuntimeOpaque) void;

extern fn temporal_sdk_core_connect_async(
    runtime: ?*RuntimeOpaque,
    config_json: ?[*]const u8,
    len: usize,
) ?*ClientOpaque;

extern fn temporal_sdk_core_client_free(handle: ?*ClientOpaque) void;
extern fn temporal_sdk_core_byte_buffer_destroy(handle: ?*ByteBuf) void;

// TODO(codex, temporal-zig-phase-0): wire all exported Temporal client RPCs once the header generation lands.

pub const api = struct {
    pub const runtime_new = temporal_sdk_core_runtime_new;
    pub const runtime_free = temporal_sdk_core_runtime_free;
    pub const connect_async = temporal_sdk_core_connect_async;
    pub const client_free = temporal_sdk_core_client_free;
    pub const byte_buffer_destroy = temporal_sdk_core_byte_buffer_destroy;
};
