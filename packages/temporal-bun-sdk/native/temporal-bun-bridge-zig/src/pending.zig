const std = @import("std");
const errors = @import("errors.zig");

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
    status: Status,
    consumed: bool,
    payload: ?*anyopaque,
    cleanup: CleanupFn,
    error: PendingErrorState,
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
        errors.setStructuredError(.{ .code = GrpcStatus.resource_exhausted, .message = message });
        return null;
    };
    handle.* = .{
        .status = status,
        .consumed = false,
        .payload = null,
        .cleanup = null,
        .error = .{
            .code = GrpcStatus.unknown,
            .message = "",
            .owns_message = false,
            .active = false,
        },
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
}

fn destroyHandle(handle: *PendingHandle) void {
    releasePayload(handle);
    destroyMessage(handle.error.message, handle.error.owns_message);
    const allocator = std.heap.c_allocator;
    allocator.destroy(handle);
}

pub const PendingClient = PendingHandle;
pub const PendingByteArray = PendingHandle;

fn assignError(handle: *PendingHandle, code: i32, message: []const u8, duplicate: bool) void {
    destroyMessage(handle.error.message, handle.error.owns_message);
    handle.error.code = code;
    handle.error.message = "";
    handle.error.owns_message = false;
    handle.error.active = true;

    if (message.len == 0) {
        return;
    }

    if (duplicate) {
        if (duplicateMessage(message)) |copy| {
            handle.error.message = copy;
            handle.error.owns_message = true;
            return;
        }
        // Fall back to an internal error with a static message if duplication fails.
        handle.error.code = GrpcStatus.internal;
        handle.error.message = "temporal-bun-bridge-zig: failed to duplicate error message";
        handle.error.owns_message = false;
        return;
    }

    handle.error.message = message;
    handle.error.owns_message = false;
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

pub fn poll(handle: ?*PendingHandle) i32 {
    if (handle == null) {
        errors.setStructuredError(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: pending poll received null handle",
        });
        return @intFromEnum(Status.failed);
    }

    const pending = handle.?;
    return switch (pending.status) {
        .pending => @intFromEnum(Status.pending),
        .ready => blk: {
            if (pending.consumed) {
                assignError(pending, GrpcStatus.failed_precondition, "temporal-bun-bridge-zig: pending handle already consumed", false);
                errors.setStructuredError(.{ .code = pending.error.code, .message = pending.error.message });
                break :blk @intFromEnum(Status.failed);
            }
            break :blk @intFromEnum(Status.ready);
        },
        .failed => blk: {
            if (pending.error.active) {
                errors.setStructuredError(.{ .code = pending.error.code, .message = pending.error.message });
            } else {
                errors.setStructuredError(.{
                    .code = GrpcStatus.internal,
                    .message = "temporal-bun-bridge-zig: pending handle failed without structured error",
                });
            }
            break :blk @intFromEnum(Status.failed);
        },
    };
}

pub fn consume(handle: ?*PendingHandle) ?*anyopaque {
    if (handle == null) {
        errors.setStructuredError(.{
            .code = GrpcStatus.invalid_argument,
            .message = "temporal-bun-bridge-zig: pending consume received null handle",
        });
        return null;
    }

    const pending = handle.?;
    switch (pending.status) {
        .pending => {
            errors.setStructuredError(.{
                .code = GrpcStatus.failed_precondition,
                .message = "temporal-bun-bridge-zig: pending handle not ready",
            });
            return null;
        },
        .failed => {
            if (pending.error.active) {
                errors.setStructuredError(.{ .code = pending.error.code, .message = pending.error.message });
            } else {
                errors.setStructuredError(.{
                    .code = GrpcStatus.internal,
                    .message = "temporal-bun-bridge-zig: pending handle failed without structured error",
                });
            }
            return null;
        },
        .ready => {},
    }

    if (pending.consumed) {
        errors.setStructuredError(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: pending handle already consumed",
        });
        return null;
    }

    pending.consumed = true;
    const payload = pending.payload orelse {
        assignError(pending, GrpcStatus.internal, "temporal-bun-bridge-zig: pending handle missing payload", false);
        errors.setStructuredError(.{ .code = pending.error.code, .message = pending.error.message });
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
    destroyHandle(pending);
}
