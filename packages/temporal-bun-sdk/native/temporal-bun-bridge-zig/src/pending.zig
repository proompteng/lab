const std = @import("std");
const errors = @import("errors.zig");

/// Maps directly onto the poll contract expected by Bun. See native.ts for semantics.
pub const Status = enum(i32) {
    pending = 0,
    ready = 1,
    failed = -1,
};

const CleanupFn = ?*const fn (?*anyopaque) void;

pub const PendingHandle = struct {
    status: Status,
    consumed: bool,
    payload: ?*anyopaque,
    cleanup: CleanupFn,
    error_message: []const u8,
    owns_message: bool,
};

fn allocateHandle(status: Status) ?*PendingHandle {
    const allocator = std.heap.c_allocator;
    const handle = allocator.create(PendingHandle) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate pending handle: {}", .{err});
        return null;
    };
    handle.* = .{
        .status = status,
        .consumed = false,
        .payload = null,
        .cleanup = null,
        .error_message = "",
        .owns_message = false,
    };
    return handle;
}

fn duplicateMessage(message: []const u8) []const u8 {
    if (message.len == 0) {
        return "";
    }

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, message.len) catch {
        return "";
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
    destroyMessage(handle.error_message, handle.owns_message);
    const allocator = std.heap.c_allocator;
    allocator.destroy(handle);
}

pub const PendingClient = PendingHandle;
pub const PendingByteArray = PendingHandle;

pub fn createPendingError(message: []const u8) ?*PendingHandle {
    const handle = allocateHandle(.failed) orelse return null;
    const duplicated = duplicateMessage(message);
    handle.error_message = duplicated;
    handle.owns_message = duplicated.len != 0;
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
        errors.setLastError("temporal-bun-bridge-zig: pending poll received null handle");
        return @intFromEnum(Status.failed);
    }

    const pending = handle.?;
    return switch (pending.status) {
        .pending => @intFromEnum(Status.pending),
        .ready => blk: {
            if (pending.consumed) {
                errors.setLastError("temporal-bun-bridge-zig: pending handle already consumed");
                break :blk @intFromEnum(Status.failed);
            }
            break :blk @intFromEnum(Status.ready);
        },
        .failed => blk: {
            errors.setLastError(pending.error_message);
            break :blk @intFromEnum(Status.failed);
        },
    };
}

pub fn consume(handle: ?*PendingHandle) ?*anyopaque {
    if (handle == null) {
        errors.setLastError("temporal-bun-bridge-zig: pending consume received null handle");
        return null;
    }

    const pending = handle.?;
    switch (pending.status) {
        .pending => {
            errors.setLastError("temporal-bun-bridge-zig: pending handle not ready");
            return null;
        },
        .failed => {
            errors.setLastError(pending.error_message);
            return null;
        },
        .ready => {},
    }

    if (pending.consumed) {
        errors.setLastError("temporal-bun-bridge-zig: pending handle already consumed");
        return null;
    }

    pending.consumed = true;
    const payload = pending.payload orelse {
        errors.setLastError("temporal-bun-bridge-zig: pending handle missing payload");
        return null;
    };

    // Transfer ownership to the caller; prevent free() from double-dropping.
    pending.payload = null;
    pending.status = .failed;
    pending.error_message = "temporal-bun-bridge-zig: pending handle already consumed";
    pending.owns_message = false;
    return payload;
}

pub fn free(handle: ?*PendingHandle) void {
    if (handle == null) {
        return;
    }

    const pending = handle.?;
    destroyHandle(pending);
}
