const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const byte_array = @import("byte_array.zig");
const pending = @import("pending.zig");

fn sliceFrom(ptr: ?[*]const u8, len: u64) []const u8 {
    if (ptr == null or len == 0) {
        return ""[0..0];
    }

    const size: usize = @intCast(len);
    return ptr.?[0..size];
}

fn toPendingHandle(ptr: ?*anyopaque) ?*pending.PendingHandle {
    return if (ptr) |nonNull| @as(?*pending.PendingHandle, @alignCast(@ptrCast(nonNull))) else null;
}

pub export fn temporal_bun_runtime_new(payload_ptr: ?[*]const u8, len: u64) ?*runtime.RuntimeHandle {
    const payload = sliceFrom(payload_ptr, len);
    return runtime.create(payload);
}

pub export fn temporal_bun_runtime_free(handle: ?*runtime.RuntimeHandle) void {
    runtime.destroy(handle);
}

pub export fn temporal_bun_error_message(len_ptr: ?*u64) ?[*]u8 {
    return errors.takeForFfi(len_ptr);
}

pub export fn temporal_bun_error_free(ptr: ?[*]u8, len: u64) void {
    errors.freeFfiBuffer(ptr, len);
}

pub export fn temporal_bun_client_connect_async(
    runtime_ptr: ?*runtime.RuntimeHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.connectAsync(runtime_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_free(handle: ?*client.ClientHandle) void {
    client.destroy(handle);
}

pub export fn temporal_bun_client_describe_namespace_async(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.describeNamespaceAsync(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_update_headers(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return client.updateHeaders(client_ptr, payload);
}

pub export fn temporal_bun_pending_client_poll(_handle: ?*anyopaque) i32 {
    const handle = toPendingHandle(_handle);
    return pending.poll(handle);
}

pub export fn temporal_bun_pending_client_consume(_handle: ?*anyopaque) ?*client.ClientHandle {
    const handle = toPendingHandle(_handle);
    if (pending.consume(handle)) |payload| {
        return @as(?*client.ClientHandle, @alignCast(@ptrCast(payload)));
    }
    return null;
}

pub export fn temporal_bun_pending_client_free(_handle: ?*anyopaque) void {
    const handle = toPendingHandle(_handle);
    pending.free(handle);
}

pub export fn temporal_bun_pending_byte_array_poll(_handle: ?*anyopaque) i32 {
    const handle = toPendingHandle(_handle);
    return pending.poll(handle);
}

pub export fn temporal_bun_pending_byte_array_consume(_handle: ?*anyopaque) ?*byte_array.ByteArray {
    const handle = toPendingHandle(_handle);
    if (pending.consume(handle)) |payload| {
        return @as(?*byte_array.ByteArray, @alignCast(@ptrCast(payload)));
    }
    return null;
}

pub export fn temporal_bun_pending_byte_array_free(_handle: ?*anyopaque) void {
    const handle = toPendingHandle(_handle);
    pending.free(handle);
}

pub export fn temporal_bun_byte_array_free(handle: ?*byte_array.ByteArray) void {
    byte_array.free(handle);
}

pub export fn temporal_bun_client_start_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*byte_array.ByteArray {
    const payload = sliceFrom(payload_ptr, len);
    return client.startWorkflow(client_ptr, payload);
}

pub export fn temporal_bun_client_terminate_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return client.terminateWorkflow(client_ptr, payload);
}

pub export fn temporal_bun_client_signal_with_start(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*byte_array.ByteArray {
    const payload = sliceFrom(payload_ptr, len);
    return client.signalWithStart(client_ptr, payload);
}

pub export fn temporal_bun_client_query_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.queryWorkflow(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}
