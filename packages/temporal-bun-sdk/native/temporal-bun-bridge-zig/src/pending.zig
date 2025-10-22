const std = @import("std");
const errors = @import("errors.zig");
const byte_array = @import("byte_array.zig");
const core = @import("core.zig");
const math = std.math;

/// Maps directly onto the poll contract expected by Bun. See native.ts for semantics.
pub const Status = enum(i32) {
    pending = 0,
    ready = 1,
    failed = -1,
};

const CleanupFn = ?*const fn (?*anyopaque) void;

pub const GrpcStatus = struct {
    pub const ok: i32 = 0;
    pub const cancelled: i32 = 1;
    pub const unknown: i32 = 2;
    pub const invalid_argument: i32 = 3;
    pub const not_found: i32 = 5;
    pub const already_exists: i32 = 6;
    pub const resource_exhausted: i32 = 8;
    pub const failed_precondition: i32 = 9;
    pub const unimplemented: i32 = 12;
    pub const internal: i32 = 13;
    pub const unavailable: i32 = 14;
};

const PendingErrorState = struct {
    code: i32,
    message: []const u8,
    owns_message: bool,
    active: bool,
};

pub const PendingHandle = struct {
    mutex: std.Thread.Mutex = .{},
    status: Status,
    consumed: bool,
    payload: ?*anyopaque,
    cleanup: CleanupFn,
    fault: PendingErrorState,
    ref_count: usize,
    user_data: ?*anyopaque = null,
    completion_callback: ?*const fn (?*anyopaque, ?*const core.ByteArray) callconv(.c) void = null,
};

fn allocateHandle(status: Status) ?*PendingHandle {
    const allocator = std.heap.c_allocator;
    const handle = allocator.create(PendingHandle) catch |err| {
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate pending handle: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate pending handle";
        errors.setStructuredErrorJson(.{ .code = GrpcStatus.resource_exhausted, .message = message, .details = null });
        return null;
    };
    handle.* = .{
        .mutex = .{},
        .status = status,
        .consumed = false,
        .payload = null,
        .cleanup = null,
        .fault = .{
            .code = GrpcStatus.unknown,
            .message = "",
            .owns_message = false,
            .active = false,
        },
        .ref_count = 1,
        .user_data = null,
        .completion_callback = null,
    };
    return handle;
}

fn duplicateMessage(message: []const u8) ?[]const u8 {
    if (message.len == 0) {
        return "";
    }

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, message.len) catch {
        return null;
    };

    @memcpy(copy, message);
    return copy;
}

fn destroyMessage(message: []const u8, owns_message: bool) void {
    if (!owns_message or message.len == 0) {
        return;
    }
    const allocator = std.heap.c_allocator;
    allocator.free(@constCast(message));
}

fn releasePayload(handle: *PendingHandle) void {
    if (handle.payload) |ptr| {
        if (handle.cleanup) |cleanup| {
            cleanup(ptr);
        }
        handle.payload = null;
    }
    handle.cleanup = null;
}

fn destroyHandle(handle: *PendingHandle) void {
    handle.mutex.lock();
    releasePayload(handle);
    destroyMessage(handle.fault.message, handle.fault.owns_message);
    handle.mutex.unlock();
    const allocator = std.heap.c_allocator;
    allocator.destroy(handle);
}

pub const PendingClient = PendingHandle;
pub const PendingByteArray = PendingHandle;

fn assignError(handle: *PendingHandle, code: i32, message: []const u8, duplicate: bool) void {
    destroyMessage(handle.fault.message, handle.fault.owns_message);
    handle.fault.code = code;
    handle.fault.message = "";
    handle.fault.owns_message = false;
    handle.fault.active = true;

    if (message.len == 0) {
        return;
    }

    if (duplicate) {
        if (duplicateMessage(message)) |copy| {
            handle.fault.message = copy;
            handle.fault.owns_message = true;
            return;
        }
        // Fall back to an internal error with a static message if duplication fails.
        handle.fault.code = GrpcStatus.internal;
        handle.fault.message = "temporal-bun-bridge-zig: failed to duplicate error message";
        handle.fault.owns_message = false;
        return;
    }

    handle.fault.message = message;
    handle.fault.owns_message = false;
}

fn clearError(handle: *PendingHandle) void {
    destroyMessage(handle.fault.message, handle.fault.owns_message);
    handle.fault.code = GrpcStatus.unknown;
    handle.fault.message = "";
    handle.fault.owns_message = false;
    handle.fault.active = false;
}

pub fn createPendingError(code: i32, message: []const u8) ?*PendingHandle {
    const handle = allocateHandle(.failed) orelse return null;
    assignError(handle, code, message, true);
    return handle;
}

pub fn createPendingReady(payload: ?*anyopaque, cleanup: CleanupFn) ?*PendingHandle {
    const handle = allocateHandle(.ready) orelse return null;
    handle.payload = payload;
    handle.cleanup = cleanup;
    return handle;
}

pub fn createPendingInFlight() ?*PendingHandle {
    return allocateHandle(.pending);
}

pub fn createPendingByteArray() ?*PendingByteArray {
    return @as(?*PendingByteArray, @ptrCast(allocateHandle(.pending)));
}

pub fn poll(handle: ?*PendingHandle) i32 {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: pending poll received null handle",
            .details = null,
        });
        return @intFromEnum(Status.failed);
    }

    const pending = handle.?;
    pending.mutex.lock();
    defer pending.mutex.unlock();
    return switch (pending.status) {
        .pending => @intFromEnum(Status.pending),
        .ready => blk: {
            if (pending.consumed) {
                assignError(pending, GrpcStatus.failed_precondition, "temporal-bun-bridge-zig: pending handle already consumed", false);
                errors.setStructuredErrorJson(.{ .code = pending.fault.code, .message = pending.fault.message, .details = null });
                break :blk @intFromEnum(Status.failed);
            }
            break :blk @intFromEnum(Status.ready);
        },
        .failed => blk: {
            if (pending.fault.active) {
                errors.setStructuredErrorJson(.{ .code = pending.fault.code, .message = pending.fault.message, .details = null });
            } else {
                errors.setStructuredErrorJson(.{
                    .code = GrpcStatus.internal,
                    .message = "temporal-bun-bridge-zig: pending handle failed without structured error",
                    .details = null,
                });
            }
            break :blk @intFromEnum(Status.failed);
        },
    };
}

pub fn consume(handle: ?*PendingHandle) ?*anyopaque {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: pending consume received null handle",
            .details = null,
        });
        return null;
    }

    const pending = handle.?;
    pending.mutex.lock();
    defer pending.mutex.unlock();
    switch (pending.status) {
        .pending => {
            errors.setStructuredErrorJson(.{
                .code = GrpcStatus.failed_precondition,
                .message = "temporal-bun-bridge-zig: pending handle not ready",
                .details = null,
            });
            return null;
        },
        .failed => {
            if (pending.fault.active) {
                errors.setStructuredErrorJson(.{ .code = pending.fault.code, .message = pending.fault.message, .details = null });
            } else {
                errors.setStructuredErrorJson(.{
                    .code = GrpcStatus.internal,
                    .message = "temporal-bun-bridge-zig: pending handle failed without structured error",
                    .details = null,
                });
            }
            return null;
        },
        .ready => {},
    }

    if (pending.consumed) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: pending handle already consumed",
            .details = null,
        });
        return null;
    }

    pending.consumed = true;
    const payload = pending.payload orelse {
        assignError(pending, GrpcStatus.internal, "temporal-bun-bridge-zig: pending handle missing payload", false);
        errors.setStructuredErrorJson(.{ .code = pending.fault.code, .message = pending.fault.message, .details = null });
        return null;
    };

    // Transfer ownership to the caller; prevent free() from double-dropping.
    pending.payload = null;
    pending.status = .failed;
    assignError(pending, GrpcStatus.failed_precondition, "temporal-bun-bridge-zig: pending handle already consumed", false);
    return payload;
}

pub fn free(handle: ?*PendingHandle) void {
    if (handle == null) {
        return;
    }

    const pending = handle.?;
    var should_cancel = false;
    pending.mutex.lock();
    if (pending.status == .pending) {
        should_cancel = true;
        releasePayload(pending);
        assignError(
            pending,
            GrpcStatus.cancelled,
            "temporal-bun-bridge-zig: pending handle cancelled",
            false,
        );
        pending.status = .failed;
        pending.consumed = false;
    }
    pending.mutex.unlock();

    if (should_cancel) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.cancelled,
            .message = "temporal-bun-bridge-zig: pending handle cancelled",
            .details = null,
        });
    }

    release(handle);
}

fn freeByteArrayFromPending(ptr: ?*anyopaque) void {
    const array: ?*byte_array.ByteArray = if (ptr) |non_null| @as(?*byte_array.ByteArray, @ptrCast(@alignCast(non_null))) else null;
    byte_array.free(array);
}

pub fn resolveByteArray(handle: ?*PendingByteArray, array: ?*byte_array.ByteArray) bool {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: resolveByteArray received null handle",
            .details = null,
        });
        if (array) |non_null| {
            byte_array.free(non_null);
        }
        return false;
    }

    if (array == null) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: resolveByteArray received null byte array",
            .details = null,
        });
        return false;
    }

    const pending_handle = handle.?;
    pending_handle.mutex.lock();
    defer pending_handle.mutex.unlock();
    if (pending_handle.status != .pending) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: resolveByteArray expected pending status",
            .details = null,
        });
        byte_array.free(array.?);
        return false;
    }

    if (pending_handle.consumed) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: resolveByteArray received consumed handle",
            .details = null,
        });
        byte_array.free(array.?);
        return false;
    }

    releasePayload(pending_handle);
    clearError(pending_handle);

    const non_null = array.?;
    pending_handle.payload = @as(?*anyopaque, @ptrCast(@alignCast(non_null)));
    pending_handle.cleanup = freeByteArrayFromPending;
    pending_handle.status = .ready;
    pending_handle.consumed = false;
    return true;
}

pub fn resolveClient(handle: ?*PendingClient, payload: ?*anyopaque, cleanup: CleanupFn) bool {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: resolveClient received null handle",
            .details = null,
        });
        return false;
    }

    if (payload == null) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: resolveClient received null payload",
            .details = null,
        });
        return false;
    }

    const pending_handle = handle.?;
    pending_handle.mutex.lock();
    defer pending_handle.mutex.unlock();
    if (pending_handle.status != .pending) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: resolveClient expected pending status",
            .details = null,
        });
        return false;
    }

    if (pending_handle.consumed) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: resolveClient received consumed handle",
            .details = null,
        });
        return false;
    }

    releasePayload(pending_handle);
    clearError(pending_handle);

    pending_handle.payload = payload;
    pending_handle.cleanup = cleanup;
    pending_handle.status = .ready;
    pending_handle.consumed = false;
    return true;
}

pub fn rejectByteArray(handle: ?*PendingByteArray, code: i32, message: []const u8) bool {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: rejectByteArray received null handle",
            .details = null,
        });
        return false;
    }

    const pending_handle = handle.?;
    pending_handle.mutex.lock();
    defer pending_handle.mutex.unlock();
    if (pending_handle.status != .pending) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: rejectByteArray expected pending status",
            .details = null,
        });
        return false;
    }

    releasePayload(pending_handle);
    clearError(pending_handle);

    assignError(pending_handle, code, message, true);
    pending_handle.status = .failed;
    pending_handle.consumed = false;

    errors.setStructuredErrorJson(.{ .code = code, .message = if (message.len != 0) message else "", .details = null });
    return true;
}

pub fn rejectClient(handle: ?*PendingClient, code: i32, message: []const u8) bool {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: rejectClient received null handle",
            .details = null,
        });
        return false;
    }

    const pending_handle = handle.?;
    pending_handle.mutex.lock();
    defer pending_handle.mutex.unlock();
    if (pending_handle.status != .pending) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: rejectClient expected pending status",
            .details = null,
        });
        return false;
    }

    releasePayload(pending_handle);
    clearError(pending_handle);

    assignError(pending_handle, code, message, true);
    pending_handle.status = .failed;
    pending_handle.consumed = false;

    errors.setStructuredErrorJson(.{ .code = code, .message = if (message.len != 0) message else "", .details = null });
    return true;
}

pub fn retain(handle: ?*PendingHandle) bool {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: retain received null handle",
            .details = null,
        });
        return false;
    }

    const pending_handle = handle.?;
    pending_handle.mutex.lock();
    defer pending_handle.mutex.unlock();

    const next = math.add(usize, pending_handle.ref_count, 1) catch {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.resource_exhausted,
            .message = "temporal-bun-bridge-zig: pending handle retain overflow",
            .details = null,
        });
        return false;
    };

    pending_handle.ref_count = next;
    return true;
}

pub fn release(handle: ?*PendingHandle) void {
    if (handle == null) {
        return;
    }

    const pending_handle = handle.?;
    pending_handle.mutex.lock();
    if (pending_handle.ref_count == 0) {
        pending_handle.mutex.unlock();
        return;
    }

    pending_handle.ref_count -= 1;
    const should_destroy = pending_handle.ref_count == 0;
    pending_handle.mutex.unlock();

    if (should_destroy) {
        destroyHandle(pending_handle);
    }
}

const testing = std.testing;

test "resolveByteArray transitions pending handle to ready" {
    const handle_opt = createPendingInFlight();
    try testing.expect(handle_opt != null);
    const handle_ptr = handle_opt.?;
    defer free(handle_ptr);

    const pending_byte = @as(*PendingByteArray, @ptrCast(handle_ptr));

    const ack_opt = byte_array.allocate(.{ .slice = "" });
    try testing.expect(ack_opt != null);
    const ack = ack_opt.?;

    try testing.expect(resolveByteArray(pending_byte, ack));
    try testing.expectEqual(@as(i32, @intFromEnum(Status.ready)), poll(handle_ptr));

    const payload_opt = consume(handle_ptr);
    try testing.expect(payload_opt != null);
    const payload_ptr = payload_opt.?;
    const array = @as(*byte_array.ByteArray, @ptrCast(@alignCast(payload_ptr)));
    defer byte_array.free(array);
    try testing.expectEqual(@as(usize, 0), array.size);
}

test "rejectByteArray transitions pending handle to failed state" {
    const handle_opt = createPendingInFlight();
    try testing.expect(handle_opt != null);
    const handle_ptr = handle_opt.?;
    defer free(handle_ptr);

    const pending_byte = @as(*PendingByteArray, @ptrCast(handle_ptr));
    try testing.expect(rejectByteArray(pending_byte, GrpcStatus.internal, "boom"));
    try testing.expectEqual(@as(i32, @intFromEnum(Status.failed)), poll(handle_ptr));

    try testing.expect(consume(handle_ptr) == null);
}

test "resolveClient transitions pending handle to ready" {
    const handle_opt = createPendingInFlight();
    try testing.expect(handle_opt != null);
    const handle_ptr = handle_opt.?;
    defer free(handle_ptr);

    const pending_client = @as(*PendingClient, @ptrCast(handle_ptr));

    const allocator = std.heap.c_allocator;
    const payload_ptr = allocator.create(u8) catch unreachable;
    payload_ptr.* = 42;

    const payload_any = @as(?*anyopaque, @ptrCast(@alignCast(payload_ptr)));
    try testing.expect(resolveClient(pending_client, payload_any, null));
    try testing.expectEqual(@as(i32, @intFromEnum(Status.ready)), poll(handle_ptr));

    const consumed_opt = consume(handle_ptr);
    try testing.expect(consumed_opt != null);
    const consumed_ptr = consumed_opt.?;
    const recovered = @as(*u8, @ptrCast(@alignCast(consumed_ptr)));
    try testing.expectEqual(@as(u8, 42), recovered.*);
    allocator.destroy(recovered);
}

test "rejectClient transitions pending handle to failed state" {
    const handle_opt = createPendingInFlight();
    try testing.expect(handle_opt != null);
    const handle_ptr = handle_opt.?;
    defer free(handle_ptr);

    const pending_client = @as(*PendingClient, @ptrCast(handle_ptr));

    try testing.expect(rejectClient(pending_client, GrpcStatus.internal, "connect failed"));
    try testing.expectEqual(@as(i32, @intFromEnum(Status.failed)), poll(handle_ptr));
    try testing.expect(consume(handle_ptr) == null);
}

test "retain increments reference count" {
    const handle_opt = createPendingInFlight();
    try testing.expect(handle_opt != null);
    const handle_ptr = handle_opt.?;

    try testing.expect(retain(handle_ptr));

    release(handle_ptr);
    release(handle_ptr);
}
