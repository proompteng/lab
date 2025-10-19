const std = @import("std");
const core = @import("core.zig");
const worker = @import("worker.zig");
const byte_array = @import("byte_array.zig");
const errors = @import("errors.zig");

const empty_bytes = [_]u8{};
const empty_slice = empty_bytes[0..0];

const Buffer = struct {
    bytes: []const u8,
    alloc: ?[]u8,
};

const ActivityCall = struct {
    worker: ?*core.WorkerOpaque,
    task_token: Buffer,
    payload: Buffer,
};

pub const ActivityKind = enum(u8) {
    completed = 0,
    failed = 1,
};

pub const ActivityCallSnapshot = struct {
    worker: ?*core.WorkerOpaque,
    task_token: []const u8,
    payload: []const u8,
};

var completed_call: ?ActivityCall = null;
var failed_call: ?ActivityCall = null;
var completed_status: i32 = 0;
var failed_status: i32 = 0;

fn releaseBuffer(buffer: Buffer) void {
    if (buffer.alloc) |slice| {
        if (slice.len > 0) {
            std.heap.c_allocator.free(slice);
        }
    }
}

fn releaseCall(call: *?ActivityCall) void {
    if (call.*) |value| {
        releaseBuffer(value.task_token);
        releaseBuffer(value.payload);
        call.* = null;
    }
}

fn copyByteBuf(buf: core.ByteBuf) ?Buffer {
    if (buf.data_ptr == null or buf.len == 0) {
        return Buffer{
            .bytes = empty_slice,
            .alloc = null,
        };
    }

    const allocator = std.heap.c_allocator;
    const out = allocator.alloc(u8, buf.len) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate activity buffer copy: {}", .{ err });
        return null;
    };

    @memcpy(out, buf.data_ptr.?[0..buf.len]);
    return Buffer{
        .bytes = out[0..buf.len],
        .alloc = out,
    };
}

fn storeCall(target: *?ActivityCall, worker_ptr: ?*core.WorkerOpaque, token: core.ByteBuf, payload: core.ByteBuf) void {
    releaseCall(target);

    const token_copy = copyByteBuf(token) orelse {
        target.* = null;
        return;
    };

    const payload_copy = copyByteBuf(payload) orelse {
        releaseBuffer(token_copy);
        target.* = null;
        return;
    };

    target.* = ActivityCall{
        .worker = worker_ptr,
        .task_token = token_copy,
        .payload = payload_copy,
    };
}

pub fn reset() void {
    releaseCall(&completed_call);
    releaseCall(&failed_call);
    completed_status = 0;
    failed_status = 0;
}

pub fn setStatus(kind: ActivityKind, status: i32) void {
    switch (kind) {
        .completed => completed_status = status,
        .failed => failed_status = status,
    }
}

fn snapshot(call: ?ActivityCall) ?ActivityCallSnapshot {
    if (call) |value| {
        return ActivityCallSnapshot{
            .worker = value.worker,
            .task_token = value.task_token.bytes,
            .payload = value.payload.bytes,
        };
    }
    return null;
}

pub fn lastSnapshot(kind: ActivityKind) ?ActivityCallSnapshot {
    return switch (kind) {
        .completed => snapshot(completed_call),
        .failed => snapshot(failed_call),
    };
}

fn toByteArray(buffer: Buffer) ?*byte_array.ByteArray {
    return byte_array.allocate(buffer.bytes);
}

fn getCall(kind: ActivityKind) ?ActivityCall {
    return switch (kind) {
        .completed => completed_call,
        .failed => failed_call,
    };
}

fn toKind(kind_id: u8) ?ActivityKind {
    return switch (kind_id) {
        0 => ActivityKind.completed,
        1 => ActivityKind.failed,
        else => null,
    };
}

pub export fn temporal_sdk_core_worker_respond_activity_task_completed(
    worker_ptr: ?*core.WorkerOpaque,
    task_token: core.ByteBuf,
    result: core.ByteBuf,
) i32 {
    storeCall(&completed_call, worker_ptr, task_token, result);
    return completed_status;
}

pub export fn temporal_sdk_core_worker_respond_activity_task_failed(
    worker_ptr: ?*core.WorkerOpaque,
    task_token: core.ByteBuf,
    failure: core.ByteBuf,
) i32 {
    storeCall(&failed_call, worker_ptr, task_token, failure);
    return failed_status;
}

pub export fn temporal_bun_testing_reset_activity_completions() void {
    reset();
}

pub export fn temporal_bun_testing_set_activity_completion_status(kind_id: u8, status: i32) void {
    const kind = toKind(kind_id) orelse {
        errors.setLastError("temporal-bun-bridge-zig: invalid activity completion kind");
        return;
    };
    setStatus(kind, status);
}

pub export fn temporal_bun_testing_last_activity_worker(kind_id: u8) ?*core.WorkerOpaque {
    const kind = toKind(kind_id) orelse {
        errors.setLastError("temporal-bun-bridge-zig: invalid activity completion kind");
        return null;
    };
    const call = getCall(kind) orelse {
        errors.setLastError("temporal-bun-bridge-zig: no activity completion recorded");
        return null;
    };
    return call.worker;
}

pub export fn temporal_bun_testing_take_activity_task_token(kind_id: u8) ?*byte_array.ByteArray {
    const kind = toKind(kind_id) orelse {
        errors.setLastError("temporal-bun-bridge-zig: invalid activity completion kind");
        return null;
    };
    const call = getCall(kind) orelse {
        errors.setLastError("temporal-bun-bridge-zig: no activity completion recorded");
        return null;
    };
    return toByteArray(call.task_token);
}

pub export fn temporal_bun_testing_take_activity_payload(kind_id: u8) ?*byte_array.ByteArray {
    const kind = toKind(kind_id) orelse {
        errors.setLastError("temporal-bun-bridge-zig: invalid activity completion kind");
        return null;
    };
    const call = getCall(kind) orelse {
        errors.setLastError("temporal-bun-bridge-zig: no activity completion recorded");
        return null;
    };
    return toByteArray(call.payload);
}

pub export fn temporal_bun_testing_last_activity_token_len(kind_id: u8) usize {
    const kind = toKind(kind_id) orelse return 0;
    return if (getCall(kind)) |call| call.task_token.bytes.len else 0;
}

pub export fn temporal_bun_testing_last_activity_payload_len(kind_id: u8) usize {
    const kind = toKind(kind_id) orelse return 0;
    return if (getCall(kind)) |call| call.payload.bytes.len else 0;
}

fn copyBytes(bytes: []const u8, dest_ptr: ?[*]u8, dest_len: usize) usize {
    if (dest_ptr == null or dest_len == 0) {
        return 0;
    }

    const limit = @min(bytes.len, dest_len);
    const dest = dest_ptr.?[0..limit];
    @memcpy(dest, bytes[0..limit]);
    return limit;
}

pub export fn temporal_bun_testing_copy_activity_task_token(kind_id: u8, dest_ptr: ?[*]u8, dest_len: usize) usize {
    const kind = toKind(kind_id) orelse return 0;
    const call = getCall(kind) orelse return 0;
    return copyBytes(call.task_token.bytes, dest_ptr, dest_len);
}

pub export fn temporal_bun_testing_copy_activity_payload(kind_id: u8, dest_ptr: ?[*]u8, dest_len: usize) usize {
    const kind = toKind(kind_id) orelse return 0;
    const call = getCall(kind) orelse return 0;
    return copyBytes(call.payload.bytes, dest_ptr, dest_len);
}

pub export fn temporal_bun_testing_create_worker_handle(core_ptr: usize) ?*worker.WorkerHandle {
    const allocator = std.heap.c_allocator;
    const handle = allocator.create(worker.WorkerHandle) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate worker handle: {}", .{ err });
        return null;
    };

    const empty_config: []u8 = @constCast(empty_slice);
    const ptr_value: ?*core.WorkerOpaque = if (core_ptr == 0)
        null
    else
        @as(?*core.WorkerOpaque, @ptrFromInt(core_ptr));

    handle.* = .{
        .id = 0,
        .runtime = null,
        .client = null,
        .config = empty_config,
        .core_worker = ptr_value,
    };

    return handle;
}
