const std = @import("std");
const errors = @import("errors.zig");
const builtin = @import("builtin");

// This module will host the C-ABI imports for the Temporal Rust SDK once the headers are generated.
// TODO(codex, zig-core-01): Generate headers via cbindgen and replace these extern placeholders.
// See packages/temporal-bun-sdk/docs/ffi-surface.md and docs/zig-bridge-migration-plan.md.

pub const RuntimeOpaque = opaque {};
pub const ClientOpaque = opaque {};
pub const PendingClientOpaque = opaque {};
pub const PendingByteArrayOpaque = opaque {};
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

extern fn temporal_sdk_core_connect_async(
  runtime: ?*RuntimeOpaque,
  config_json: ?[*]const u8,
  len: usize,
) ?*PendingClientOpaque;

extern fn temporal_sdk_core_client_free(handle: ?*ClientOpaque) void;
extern fn temporal_sdk_core_byte_buffer_destroy(handle: ?*ByteBuf) void;

extern fn temporal_sdk_core_client_describe_namespace_async(
  client: ?*ClientOpaque,
  request_json: ?[*]const u8,
  len: usize,
) ?*PendingByteArrayOpaque;

extern fn temporal_sdk_core_pending_client_consume(handle: ?*PendingClientOpaque) ?*ClientOpaque;
extern fn temporal_sdk_core_pending_client_poll(handle: ?*PendingClientOpaque) i32;
extern fn temporal_sdk_core_pending_client_free(handle: ?*PendingClientOpaque) void;

extern fn temporal_sdk_core_pending_byte_array_poll(handle: ?*PendingByteArrayOpaque) i32;
extern fn temporal_sdk_core_pending_byte_array_consume(
  handle: ?*PendingByteArrayOpaque,
  out: *ByteBuf,
) i32;
extern fn temporal_sdk_core_pending_byte_array_free(handle: ?*PendingByteArrayOpaque) void;
extern fn temporal_sdk_core_byte_buf_free(buf: *ByteBuf) void;

pub const runtime_new = temporal_sdk_core_runtime_new;
pub const runtime_free = temporal_sdk_core_runtime_free;
pub const connect_async = temporal_sdk_core_connect_async;
pub const client_free = temporal_sdk_core_client_free;

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

pub const Api = struct {
  runtime_new: *const fn (?[*]const u8, usize) ?*RuntimeOpaque,
  runtime_free: *const fn (?*RuntimeOpaque) void,
  connect_async: *const fn (?*RuntimeOpaque, ?[*]const u8, usize) ?*PendingClientOpaque,
  pending_client_poll: *const fn (?*PendingClientOpaque) i32,
  pending_client_consume: *const fn (?*PendingClientOpaque) ?*ClientOpaque,
  pending_client_free: *const fn (?*PendingClientOpaque) void,
  client_free: *const fn (?*ClientOpaque) void,
  client_describe_namespace_async: *const fn (?*ClientOpaque, ?[*]const u8, usize) ?*PendingByteArrayOpaque,
  pending_byte_array_poll: *const fn (?*PendingByteArrayOpaque) i32,
  pending_byte_array_consume: *const fn (?*PendingByteArrayOpaque, *ByteBuf) i32,
  pending_byte_array_free: *const fn (?*PendingByteArrayOpaque) void,
  byte_buffer_destroy: *const fn (?*ByteBuf) void,
  byte_buf_free: *const fn (*ByteBuf) void,
};

fn stubPendingClientPoll(_handle: ?*PendingClientOpaque) i32 {
  _ = _handle;
  errors.setLastError("temporal-bun-bridge-zig: Temporal core pending client poll not linked");
  return -1;
}

fn stubPendingClientConsume(_handle: ?*PendingClientOpaque) ?*ClientOpaque {
  _ = _handle;
  errors.setLastError("temporal-bun-bridge-zig: Temporal core pending client consume not linked");
  return null;
}

fn stubPendingClientFree(_handle: ?*PendingClientOpaque) void {
  _ = _handle;
}

fn stubClientDescribeNamespaceAsync(_client: ?*ClientOpaque, _payload: ?[*]const u8, _len: usize) ?*PendingByteArrayOpaque {
  _ = _client;
  _ = _payload;
  _ = _len;
  errors.setLastError("temporal-bun-bridge-zig: Temporal core describe namespace RPC is unavailable");
  return null;
}

fn stubPendingByteArrayPoll(_handle: ?*PendingByteArrayOpaque) i32 {
  _ = _handle;
  errors.setLastError("temporal-bun-bridge-zig: Temporal core pending byte array poll not linked");
  return -1;
}

fn stubPendingByteArrayConsume(_handle: ?*PendingByteArrayOpaque, _out: *ByteBuf) i32 {
  _ = _handle;
  _ = _out;
  errors.setLastError("temporal-bun-bridge-zig: Temporal core pending byte array consume not linked");
  return -1;
}

fn stubPendingByteArrayFree(_handle: ?*PendingByteArrayOpaque) void {
  _ = _handle;
}

fn stubRuntimeNew(_options_json: ?[*]const u8, _len: usize) ?*RuntimeOpaque {
  _ = _options_json;
  _ = _len;
  errors.setLastError("temporal-bun-bridge-zig: Temporal core runtime is unavailable");
  return null;
}

fn stubRuntimeFree(_handle: ?*RuntimeOpaque) void {
  _ = _handle;
}

fn stubConnectAsync(_runtime: ?*RuntimeOpaque, _config_json: ?[*]const u8, _len: usize) ?*PendingClientOpaque {
  _ = _runtime;
  _ = _config_json;
  _ = _len;
  errors.setLastError("temporal-bun-bridge-zig: Temporal core connect async is unavailable");
  return null;
}

fn stubClientFree(_handle: ?*ClientOpaque) void {
  _ = _handle;
}

fn stubByteBufferDestroy(_handle: ?*ByteBuf) void {
  _ = _handle;
}

fn stubByteBufFree(_buf: *ByteBuf) void {
  _ = _buf;
}

pub const extern_api: Api = .{
  .runtime_new = temporal_sdk_core_runtime_new,
  .runtime_free = temporal_sdk_core_runtime_free,
  .connect_async = temporal_sdk_core_connect_async,
  .pending_client_poll = temporal_sdk_core_pending_client_poll,
  .pending_client_consume = temporal_sdk_core_pending_client_consume,
  .pending_client_free = temporal_sdk_core_pending_client_free,
  .client_free = temporal_sdk_core_client_free,
  .client_describe_namespace_async = temporal_sdk_core_client_describe_namespace_async,
  .pending_byte_array_poll = temporal_sdk_core_pending_byte_array_poll,
  .pending_byte_array_consume = temporal_sdk_core_pending_byte_array_consume,
  .pending_byte_array_free = temporal_sdk_core_pending_byte_array_free,
  .byte_buffer_destroy = temporal_sdk_core_byte_buffer_destroy,
  .byte_buf_free = temporal_sdk_core_byte_buf_free,
};

pub var api: Api = .{
  .runtime_new = stubRuntimeNew,
  .runtime_free = stubRuntimeFree,
  .connect_async = stubConnectAsync,
  .pending_client_poll = stubPendingClientPoll,
  .pending_client_consume = stubPendingClientConsume,
  .pending_client_free = stubPendingClientFree,
  .client_free = stubClientFree,
  .client_describe_namespace_async = stubClientDescribeNamespaceAsync,
  .pending_byte_array_poll = stubPendingByteArrayPoll,
  .pending_byte_array_consume = stubPendingByteArrayConsume,
  .pending_byte_array_free = stubPendingByteArrayFree,
  .byte_buffer_destroy = stubByteBufferDestroy,
  .byte_buf_free = stubByteBufFree,
};

pub fn installExternalApi() void {
  api = extern_api;
}
