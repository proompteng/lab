const std = @import("std");
const builtin = @import("builtin");
const atomic = std.atomic;
const testing = std.testing;

const errors = @import("errors.zig");
const byte_array = @import("byte_array.zig");

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
    pub const deadline_exceeded: i32 = 4;
    pub const not_found: i32 = 5;
    pub const already_exists: i32 = 6;
    pub const permission_denied: i32 = 7;
    pub const resource_exhausted: i32 = 8;
    pub const failed_precondition: i32 = 9;
    pub const aborted: i32 = 10;
    pub const out_of_range: i32 = 11;
    pub const unimplemented: i32 = 12;
    pub const internal: i32 = 13;
    pub const unavailable: i32 = 14;
    pub const data_loss: i32 = 15;
    pub const unauthenticated: i32 = 16;
};

const PendingErrorState = struct {
    code: i32,
    message: []const u8,
    owns_message: bool,
    details: ?[]const u8,
    owns_details: bool,
    active: bool,
};

const ERR_POLL_NULL = "temporal-bun-bridge-zig: pending poll received null handle";
const ERR_CONSUME_NULL = "temporal-bun-bridge-zig: pending consume received null handle";
const ERR_NOT_READY = "temporal-bun-bridge-zig: pending handle not ready";
const ERR_ALREADY_CONSUMED = "temporal-bun-bridge-zig: pending handle already consumed";
const ERR_MISSING_PAYLOAD = "temporal-bun-bridge-zig: pending handle missing payload";
const ERR_DUPLICATE_MESSAGE = "temporal-bun-bridge-zig: failed to duplicate error message";
const ERR_DUPLICATE_DETAILS = "temporal-bun-bridge-zig: failed to duplicate error details";
const ERR_HANDLE_FAILED_WITHOUT_STRUCTURED = "temporal-bun-bridge-zig: pending handle failed without structured error";
const ERR_RESOLVE_HANDLE_NULL = "temporal-bun-bridge-zig: resolveByteArray received null handle";
const ERR_RESOLVE_ARRAY_NULL = "temporal-bun-bridge-zig: resolveByteArray received null byte array";
const ERR_RESOLVE_STATUS = "temporal-bun-bridge-zig: resolveByteArray expected pending status";
const ERR_RESOLVE_CONSUMED = "temporal-bun-bridge-zig: resolveByteArray received consumed handle";
const ERR_REJECT_HANDLE_NULL = "temporal-bun-bridge-zig: rejectByteArray received null handle";
const ERR_REJECT_STATUS = "temporal-bun-bridge-zig: rejectByteArray expected pending status";
const ERR_TRANSITION_READY_FAILED = "temporal-bun-bridge-zig: failed to transition pending handle to ready";
const ERR_TRANSITION_ERROR_FAILED = "temporal-bun-bridge-zig: failed to transition pending handle to error";

/// Configuration for transitioning a pending handle into the failed state.
/// Callers can opt out of duplicating message/details slices when they remain valid
/// for the lifetime of the handle, or attach optional details to surface richer context.
pub const TransitionToErrorOptions = struct {
    duplicate_message: bool = true,
    details: ?[]const u8 = null,
    duplicate_details: bool = true,
};

pub const PendingHandle = struct {
    status: atomic.Value(Status),
    consumed: atomic.Value(bool),
    payload: ?*anyopaque,
    cleanup: CleanupFn,
    fault: PendingErrorState,
    state_lock: std.Thread.Mutex,
    ref_count: atomic.Value(usize),
    cancelled: atomic.Value(bool),
};

const TestHooks = if (builtin.is_test) struct {
    pub var before_consume_lock: ?*const fn (*PendingHandle) void = null;
} else struct {};

inline fn runBeforeConsumeLockHook(handle: *PendingHandle) void {
    if (comptime builtin.is_test) {
        if (TestHooks.before_consume_lock) |hook| {
            hook(handle);
        }
    }
}

/// Entry points coordinating PendingHandle state:
/// - pending.createPendingInFlight: creates `.pending` handles without payload or message.
/// - pending.createPendingReady: allocates a pending handle then delegates to transitionToReady for initialization.
/// - pending.createPendingError: allocates a pending handle then delegates to transitionToError for initialization.
/// - pending.transitionToReady / transitionToError: producers use these helpers to finalize `.pending` handles while
///   guarding payload/message ownership under a mutex and publishing status with release semantics.
/// - pending.poll: invoked by `temporal_bun_pending_{client,byte_array}_poll` exports to surface `.pending`, `.ready`,
///   or `.failed` to Bun; emits structured errors for null handles, consumed ready handles, and failure cases.
/// - pending.consume: called by `temporal_bun_pending_{client,byte_array}_consume` to transfer payload ownership; marks
///   handles consumed and rewrites status/error to guard against double consume or missing payload.
/// - pending.free: releases handle resources via `temporal_bun_pending_{client,byte_array}_free` and other call sites.
/// - client.connectAsync and future async client APIs wrap payload pointers in `.ready` handles; worker.zig uses
///   createPendingError for unimplemented paths today. All callers depend on errors.zig to expose thread-local messages.
fn setStructuredError(code: i32, message: []const u8) void {
    errors.setStructuredErrorJson(.{ .code = code, .message = message, .details = null });
}

fn allocateHandle(status: Status) ?*PendingHandle {
    const allocator = std.heap.c_allocator;
    const handle = allocator.create(PendingHandle) catch |err| {
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate pending handle: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate pending handle";
        setStructuredError(GrpcStatus.resource_exhausted, message);
        return null;
    };
    handle.* = .{
        .status = atomic.Value(Status).init(status),
        .consumed = atomic.Value(bool).init(false),
        .payload = null,
        .cleanup = null,
        .fault = .{
            .code = GrpcStatus.unknown,
            .message = "",
            .owns_message = false,
            .details = null,
            .owns_details = false,
            .active = false,
        },
        .state_lock = .{},
        .ref_count = atomic.Value(usize).init(1),
        .cancelled = atomic.Value(bool).init(false),
    };
    return handle;
}

fn duplicateSlice(buffer: []const u8) ?[]const u8 {
    if (buffer.len == 0) {
        return "";
    }

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, buffer.len) catch {
        return null;
    };

    @memcpy(copy, buffer);
    return copy;
}

fn destroySlice(buffer: []const u8, owns_buffer: bool) void {
    if (!owns_buffer or buffer.len == 0) {
        return;
    }
    const allocator = std.heap.c_allocator;
    allocator.free(@constCast(buffer));
}

fn clearErrorLocked(handle: *PendingHandle) void {
    destroySlice(handle.fault.message, handle.fault.owns_message);
    if (handle.fault.details) |details| {
        destroySlice(details, handle.fault.owns_details);
    }
    handle.fault.code = GrpcStatus.unknown;
    handle.fault.message = "";
    handle.fault.owns_message = false;
    handle.fault.details = null;
    handle.fault.owns_details = false;
    handle.fault.active = false;
}

fn assignErrorLocked(handle: *PendingHandle, code: i32, message: []const u8, options: TransitionToErrorOptions) void {
    destroySlice(handle.fault.message, handle.fault.owns_message);
    if (handle.fault.details) |details| {
        destroySlice(details, handle.fault.owns_details);
    }
    handle.fault.code = code;
    handle.fault.message = "";
    handle.fault.owns_message = false;
    handle.fault.details = null;
    handle.fault.owns_details = false;
    handle.fault.active = true;

    if (message.len != 0) {
        if (options.duplicate_message) {
            if (duplicateSlice(message)) |copy| {
                handle.fault.message = copy;
                handle.fault.owns_message = true;
            } else {
                handle.fault.code = GrpcStatus.internal;
                handle.fault.message = ERR_DUPLICATE_MESSAGE;
                handle.fault.owns_message = false;
                return;
            }
        } else {
            handle.fault.message = message;
            handle.fault.owns_message = false;
        }
    }

    if (options.details) |details| {
        if (details.len == 0) {
            handle.fault.details = details;
            handle.fault.owns_details = false;
            return;
        }

        if (options.duplicate_details) {
            if (duplicateSlice(details)) |copy| {
                handle.fault.details = copy;
                handle.fault.owns_details = true;
                return;
            }
            destroySlice(handle.fault.message, handle.fault.owns_message);
            handle.fault.code = GrpcStatus.internal;
            handle.fault.message = ERR_DUPLICATE_DETAILS;
            handle.fault.owns_message = false;
            handle.fault.details = null;
            handle.fault.owns_details = false;
            return;
        }

        handle.fault.details = details;
        handle.fault.owns_details = false;
    }
}

/// Caller must ensure exclusive access to the handle before releasing payload state.
fn releasePayload(handle: *PendingHandle) void {
    if (handle.payload) |ptr| {
        if (handle.cleanup) |cleanup_fn| {
            cleanup_fn(ptr);
        }
        handle.payload = null;
    }
    handle.cleanup = null;
}

fn destroyHandle(handle: *PendingHandle) void {
    handle.state_lock.lock();
    releasePayload(handle);
    clearErrorLocked(handle);
    handle.state_lock.unlock();

    const allocator = std.heap.c_allocator;
    allocator.destroy(handle);
}

fn retainHandle(handle: *PendingHandle) bool {
    var current = handle.ref_count.load(.acquire);
    while (true) {
        if (current == 0) {
            return false;
        }
        const next = current + 1;
        const exchanged = handle.ref_count.cmpxchgStrong(current, next, .acq_rel, .acquire);
        if (exchanged == null) {
            return true;
        }
        current = exchanged.?;
    }
}

fn releaseHandle(handle: *PendingHandle) void {
    const previous = handle.ref_count.fetchSub(1, .acq_rel);
    std.debug.assert(previous > 0);
    if (previous == 1) {
        destroyHandle(handle);
    }
}

pub fn retain(handle: ?*PendingHandle) bool {
    if (handle == null) {
        return false;
    }

    return retainHandle(handle.?);
}

pub fn release(handle: ?*PendingHandle) void {
    if (handle == null) {
        return;
    }

    releaseHandle(handle.?);
}

pub fn isCancelled(handle: ?*PendingHandle) bool {
    if (handle == null) {
        return true;
    }

    return handle.?.cancelled.load(.acquire);
}

fn publishFault(handle: *PendingHandle) void {
    if (handle.fault.active) {
        errors.setStructuredErrorJson(.{
            .code = handle.fault.code,
            .message = handle.fault.message,
            .details = handle.fault.details,
        });
    } else {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.internal,
            .message = ERR_HANDLE_FAILED_WITHOUT_STRUCTURED,
            .details = null,
        });
    }
}

pub fn transitionToReady(handle: *PendingHandle, payload: ?*anyopaque, cleanup: CleanupFn) bool {
    handle.state_lock.lock();
    defer handle.state_lock.unlock();

    const current_status = handle.status.load(.acquire);
    if (current_status != .pending) {
        return false;
    }

    releasePayload(handle);
    clearErrorLocked(handle);

    handle.payload = payload;
    handle.cleanup = cleanup;
    handle.consumed.store(false, .release);
    handle.status.store(.ready, .release);
    return true;
}

/// Transitions a handle to the failed state while honoring advanced error options.
/// Safe for concurrent producers: releases payload when moving from `.ready` and
/// ensures error slices are duplicated or borrowed per the provided options.
pub fn transitionToErrorWithOptions(
    handle: *PendingHandle,
    code: i32,
    message: []const u8,
    options: TransitionToErrorOptions,
) bool {
    handle.state_lock.lock();
    defer handle.state_lock.unlock();

    const current_status = handle.status.load(.acquire);
    if (current_status == .failed) {
        return false;
    }
    if (current_status == .ready) {
        releasePayload(handle);
    }

    assignErrorLocked(handle, code, message, options);
    handle.consumed.store(false, .release);
    handle.status.store(.failed, .release);
    return true;
}

pub fn transitionToError(handle: *PendingHandle, code: i32, message: []const u8) bool {
    return transitionToErrorWithOptions(handle, code, message, .{});
}

pub const PendingClient = PendingHandle;
pub const PendingByteArray = PendingHandle;

pub fn createPendingError(code: i32, message: []const u8) ?*PendingHandle {
    return createPendingErrorWithOptions(code, message, .{});
}

/// Allocates a pending handle in the failed state using the provided error options.
pub fn createPendingErrorWithOptions(
    code: i32,
    message: []const u8,
    options: TransitionToErrorOptions,
) ?*PendingHandle {
    const handle = allocateHandle(.pending) orelse return null;
    if (!transitionToErrorWithOptions(handle, code, message, options)) {
        destroyHandle(handle);
        setStructuredError(GrpcStatus.internal, ERR_TRANSITION_ERROR_FAILED);
        return null;
    }
    return handle;
}

pub fn createPendingReady(payload: ?*anyopaque, cleanup: CleanupFn) ?*PendingHandle {
    const handle = allocateHandle(.pending) orelse return null;
    if (!transitionToReady(handle, payload, cleanup)) {
        destroyHandle(handle);
        setStructuredError(GrpcStatus.internal, ERR_TRANSITION_READY_FAILED);
        return null;
    }
    return handle;
}

pub fn createPendingInFlight() ?*PendingHandle {
    return allocateHandle(.pending);
}

pub fn poll(handle: ?*PendingHandle) i32 {
    if (handle == null) {
        setStructuredError(GrpcStatus.invalid_argument, ERR_POLL_NULL);
        return @intFromEnum(Status.failed);
    }

    const pending = handle.?;
    const status = pending.status.load(.acquire);
    return switch (status) {
        .pending => @intFromEnum(Status.pending),
        .ready => blk: {
            if (pending.consumed.load(.acquire)) {
                setStructuredError(GrpcStatus.failed_precondition, ERR_ALREADY_CONSUMED);
                break :blk @intFromEnum(Status.failed);
            }
            break :blk @intFromEnum(Status.ready);
        },
        .failed => blk: {
            publishFault(pending);
            break :blk @intFromEnum(Status.failed);
        },
    };
}

pub fn consume(handle: ?*PendingHandle) ?*anyopaque {
    if (handle == null) {
        setStructuredError(GrpcStatus.invalid_argument, ERR_CONSUME_NULL);
        return null;
    }

    const pending = handle.?;
    const status = pending.status.load(.acquire);
    switch (status) {
        .pending => {
            setStructuredError(GrpcStatus.failed_precondition, ERR_NOT_READY);
            return null;
        },
        .failed => {
            publishFault(pending);
            return null;
        },
        .ready => {},
    }

    const already_consumed = pending.consumed.swap(true, .acq_rel);
    if (already_consumed) {
        setStructuredError(GrpcStatus.failed_precondition, ERR_ALREADY_CONSUMED);
        return null;
    }

    runBeforeConsumeLockHook(pending);

    pending.state_lock.lock();
    defer pending.state_lock.unlock();

    const locked_status = pending.status.load(.acquire);
    if (locked_status != .ready) {
        pending.consumed.store(false, .release);
        switch (locked_status) {
            .pending => setStructuredError(GrpcStatus.failed_precondition, ERR_NOT_READY),
            .ready => unreachable,
            .failed => publishFault(pending),
        }
        return null;
    }

    const payload = pending.payload orelse {
        assignErrorLocked(pending, GrpcStatus.internal, ERR_MISSING_PAYLOAD, .{
            .duplicate_message = false,
        });
        pending.status.store(.failed, .release);
        setStructuredError(GrpcStatus.internal, ERR_MISSING_PAYLOAD);
        return null;
    };

    pending.payload = null;
    pending.cleanup = null;
    assignErrorLocked(pending, GrpcStatus.failed_precondition, ERR_ALREADY_CONSUMED, .{
        .duplicate_message = false,
    });
    pending.status.store(.failed, .release);
    return payload;
}

pub fn free(handle: ?*PendingHandle) void {
    if (handle == null) {
        return;
    }

    const pending = handle.?;
    const status = pending.status.load(.acquire);
    if (status == .pending and !pending.consumed.load(.acquire)) {
        pending.cancelled.store(true, .release);
    }

    releaseHandle(pending);
}

fn freeByteArrayFromPending(ptr: ?*anyopaque) void {
    const array: ?*byte_array.ByteArray = if (ptr) |non_null|
        @as(?*byte_array.ByteArray, @ptrCast(@alignCast(non_null)))
    else
        null;
    byte_array.free(array);
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
    const status = pending_handle.status.load(.acquire);
    if (status != .pending) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: resolveClient expected pending status",
            .details = null,
        });
        return false;
    }

    if (pending_handle.consumed.load(.acquire)) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: resolveClient received consumed handle",
            .details = null,
        });
        return false;
    }

    if (!transitionToReady(pending_handle, payload, cleanup)) {
        // Another producer modified the handle concurrently.
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: resolveClient failed to publish ready payload",
            .details = null,
        });
        return false;
    }

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
    const status = pending_handle.status.load(.acquire);
    if (status != .pending) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: rejectClient expected pending status",
            .details = null,
        });
        return false;
    }

    if (!transitionToError(pending_handle, code, message)) {
        errors.setStructuredErrorJson(.{
            .code = GrpcStatus.failed_precondition,
            .message = "temporal-bun-bridge-zig: rejectClient failed to publish error state",
            .details = null,
        });
        return false;
    }

    errors.setStructuredErrorJson(.{ .code = code, .message = if (message.len != 0) message else "", .details = null });
    return true;
}

pub fn resolveByteArray(handle: ?*PendingByteArray, array: ?*byte_array.ByteArray) bool {
    if (handle == null) {
        setStructuredError(GrpcStatus.invalid_argument, ERR_RESOLVE_HANDLE_NULL);
        if (array) |non_null| {
            byte_array.free(non_null);
        }
        return false;
    }

    if (array == null) {
        setStructuredError(GrpcStatus.invalid_argument, ERR_RESOLVE_ARRAY_NULL);
        return false;
    }

    const pending_handle = handle.?;
    pending_handle.state_lock.lock();
    defer pending_handle.state_lock.unlock();

    const status = pending_handle.status.load(.acquire);
    if (status != .pending) {
        setStructuredError(GrpcStatus.failed_precondition, ERR_RESOLVE_STATUS);
        byte_array.free(array.?);
        return false;
    }

    if (pending_handle.consumed.load(.acquire)) {
        setStructuredError(GrpcStatus.failed_precondition, ERR_RESOLVE_CONSUMED);
        byte_array.free(array.?);
        return false;
    }

    releasePayload(pending_handle);
    clearErrorLocked(pending_handle);

    const non_null = array.?;
    pending_handle.payload = @as(?*anyopaque, @ptrCast(@alignCast(non_null)));
    pending_handle.cleanup = freeByteArrayFromPending;
    pending_handle.consumed.store(false, .release);
    pending_handle.status.store(.ready, .release);
    return true;
}

pub fn rejectByteArray(handle: ?*PendingByteArray, code: i32, message: []const u8) bool {
    if (handle == null) {
        setStructuredError(GrpcStatus.invalid_argument, ERR_REJECT_HANDLE_NULL);
        return false;
    }

    const pending_handle = handle.?;
    pending_handle.state_lock.lock();
    defer pending_handle.state_lock.unlock();

    const status = pending_handle.status.load(.acquire);
    if (status != .pending) {
        setStructuredError(GrpcStatus.failed_precondition, ERR_REJECT_STATUS);
        return false;
    }

    releasePayload(pending_handle);
    clearErrorLocked(pending_handle);

    assignErrorLocked(pending_handle, code, message, .{});
    pending_handle.consumed.store(false, .release);
    pending_handle.status.store(.failed, .release);

    setStructuredError(code, if (message.len != 0) message else "");
    return true;
}

fn payloadCleanup(ptr: ?*anyopaque) void {
    if (ptr) |non_null| {
        const typed = @as(*u8, @ptrCast(non_null));
        std.heap.c_allocator.destroy(typed);
    }
}

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

test "pending handle consumes payload exactly once" {
    errors.setLastError("");
    const allocator = std.heap.c_allocator;
    const payload_ptr = allocator.create(u8) catch unreachable;
    payload_ptr.* = 42;

    const handle = createPendingReady(@as(?*anyopaque, @ptrCast(payload_ptr)), null) orelse unreachable;
    defer free(handle);

    const first_opt = consume(handle);
    try testing.expect(first_opt != null);
    const first = first_opt.?;
    const typed = @as(*u8, @ptrCast(first));
    try testing.expectEqual(@as(u8, 42), typed.*);
    allocator.destroy(typed);

    const second = consume(handle);
    try testing.expect(second == null);
    const expected_json = std.fmt.comptimePrint(
        "{{\"code\":{d},\"message\":\"{s}\"}}",
        .{ GrpcStatus.failed_precondition, ERR_ALREADY_CONSUMED },
    );
    try testing.expectEqualStrings(expected_json, errors.snapshot());
}

test "pending handle missing payload surfaces error" {
    errors.setLastError("");
    const handle = createPendingReady(null, null) orelse unreachable;
    defer free(handle);

    const result = consume(handle);
    try testing.expect(result == null);
    const missing_json = std.fmt.comptimePrint(
        "{{\"code\":{d},\"message\":\"{s}\"}}",
        .{ GrpcStatus.internal, ERR_MISSING_PAYLOAD },
    );
    try testing.expectEqualStrings(missing_json, errors.snapshot());

    const status_code = poll(handle);
    try testing.expectEqual(@intFromEnum(Status.failed), status_code);
    try testing.expectEqualStrings(missing_json, errors.snapshot());
}

test "pending handle transition to error surfaces message" {
    errors.setLastError("");
    const handle = createPendingInFlight() orelse unreachable;
    defer free(handle);

    const message = "synthetic failure";
    const transitioned = transitionToError(handle, GrpcStatus.internal, message);
    try testing.expect(transitioned);

    const status_code = poll(handle);
    try testing.expectEqual(@intFromEnum(Status.failed), status_code);
    const expected_json = std.fmt.comptimePrint(
        "{{\"code\":{d},\"message\":\"{s}\"}}",
        .{ GrpcStatus.internal, message },
    );
    try testing.expectEqualStrings(expected_json, errors.snapshot());

    const payload = consume(handle);
    try testing.expect(payload == null);
    try testing.expectEqualStrings(expected_json, errors.snapshot());
}

test "transitionToErrorWithOptions duplicates details when requested" {
    errors.setLastError("");
    const handle = createPendingInFlight() orelse unreachable;
    defer free(handle);

    const allocator = std.heap.c_allocator;
    const detail_source = allocator.dupe(u8, "detail context") catch unreachable;
    defer allocator.free(detail_source);
    const detail_slice = detail_source[0..];

    try testing.expect(transitionToErrorWithOptions(
        handle,
        GrpcStatus.internal,
        "error with detail",
        .{ .details = detail_slice },
    ));

    const stored_details_opt = handle.fault.details;
    try testing.expect(stored_details_opt != null);
    const stored_details = stored_details_opt.?;

    detail_source[0] = 'X';
    try testing.expectEqual(@as(u8, 'd'), stored_details[0]);
    try testing.expect(handle.fault.owns_details);

    const status_code = poll(handle);
    try testing.expectEqual(@intFromEnum(Status.failed), status_code);
}

test "transitionToErrorWithOptions retains borrowed details" {
    errors.setLastError("");
    const handle = createPendingInFlight() orelse unreachable;
    defer free(handle);

    const message = "borrowed message";
    const details = "borrowed details";

    try testing.expect(transitionToErrorWithOptions(
        handle,
        GrpcStatus.internal,
        message,
        .{
            .duplicate_message = false,
            .details = details,
            .duplicate_details = false,
        },
    ));

    try testing.expect(!handle.fault.owns_message);
    try testing.expect(!handle.fault.owns_details);

    const stored_details_opt = handle.fault.details;
    try testing.expect(stored_details_opt != null);
    const stored_details = stored_details_opt.?;
    try testing.expectEqual(@as(usize, details.len), stored_details.len);
    try testing.expectEqual(@intFromPtr(details.ptr), @intFromPtr(stored_details.ptr));

    const status_code = poll(handle);
    try testing.expectEqual(@intFromEnum(Status.failed), status_code);
}

test "transitionToReady clears previous fault details" {
    errors.setLastError("");
    const handle = createPendingInFlight() orelse unreachable;
    defer free(handle);

    handle.state_lock.lock();
    assignErrorLocked(handle, GrpcStatus.internal, "prefail", .{
        .duplicate_message = false,
        .details = "contextual info",
        .duplicate_details = false,
    });
    handle.state_lock.unlock();
    try testing.expect(handle.fault.details != null);
    try testing.expect(handle.fault.active);

    const allocator = std.heap.c_allocator;
    const payload_ptr = allocator.create(u8) catch unreachable;
    payload_ptr.* = 13;

    const became_ready = transitionToReady(
        handle,
        @as(?*anyopaque, @ptrCast(payload_ptr)),
        payloadCleanup,
    );
    try testing.expect(became_ready);

    try testing.expect(handle.fault.details == null);
    try testing.expect(handle.fault.active == false);
}

test "pending handle concurrent poll and consume" {
    errors.setLastError("");
    const handle = createPendingInFlight() orelse unreachable;
    defer free(handle);

    const allocator = std.heap.c_allocator;
    const payload_ptr = allocator.create(u8) catch unreachable;
    payload_ptr.* = 7;

    var success_count = atomic.Value(usize).init(0);
    var worker_payload = atomic.Value(?*anyopaque).init(null);
    var start_flag = atomic.Value(bool).init(false);

    const Poller = struct {
        pub fn run(handle_ptr: *PendingHandle) void {
            var ready_seen = false;
            while (!ready_seen) {
                const status_code = poll(handle_ptr);
                if (status_code == @intFromEnum(Status.ready)) {
                    ready_seen = true;
                } else if (status_code == @intFromEnum(Status.failed)) {
                    return;
                } else {
                    std.Thread.sleep(1_000);
                }
            }
        }
    };

    var poll_threads: [4]std.Thread = undefined;
    var idx: usize = 0;
    while (idx < poll_threads.len) : (idx += 1) {
        poll_threads[idx] = std.Thread.spawn(.{}, Poller.run, .{handle}) catch unreachable;
    }

    const Consumer = struct {
        pub fn run(
            handle_ptr: *PendingHandle,
            start_flag_ptr: *atomic.Value(bool),
            success_ptr: *atomic.Value(usize),
            payload_slot: *atomic.Value(?*anyopaque),
        ) void {
            while (!start_flag_ptr.load(.acquire)) {
                std.Thread.sleep(1_000);
            }

            while (true) {
                const status_code = poll(handle_ptr);
                if (status_code == @intFromEnum(Status.ready)) {
                    break;
                }
                if (status_code == @intFromEnum(Status.failed)) {
                    return;
                }
                std.Thread.sleep(1_000);
            }

            if (consume(handle_ptr)) |ptr| {
                _ = success_ptr.fetchAdd(1, .acq_rel);
                payload_slot.store(ptr, .release);
                return;
            }
        }
    };

    var worker_thread = std.Thread.spawn(
        .{},
        Consumer.run,
        .{ handle, &start_flag, &success_count, &worker_payload },
    ) catch unreachable;

    const transitioned = transitionToReady(
        handle,
        @as(?*anyopaque, @ptrCast(payload_ptr)),
        payloadCleanup,
    );
    try testing.expect(transitioned);

    start_flag.store(true, .release);

    var spins: usize = 0;
    // Wait for readiness before attempting to consume on the main thread.
    while (true) {
        const status_code = poll(handle);
        if (status_code == @intFromEnum(Status.ready)) {
            break;
        }
        if (status_code == @intFromEnum(Status.failed)) {
            break;
        }
        std.Thread.sleep(1_000);
        spins += 1;
        if (spins > 5000) {
            worker_thread.join();
            var join_idx: usize = 0;
            while (join_idx < poll_threads.len) : (join_idx += 1) {
                poll_threads[join_idx].join();
            }
            try testing.expect(false);
            return;
        }
    }

    var main_payload: ?*anyopaque = null;
    // If the worker thread beat us to consumption, bail early instead of spinning forever.
    if (success_count.load(.acquire) != 0) {
        worker_thread.join();
        idx = 0;
        while (idx < poll_threads.len) : (idx += 1) {
            poll_threads[idx].join();
        }
        try testing.expectEqual(@as(usize, 1), success_count.load(.acquire));
        return;
    }

    const main_result = consume(handle);
    if (main_result) |ptr| {
        _ = success_count.fetchAdd(1, .acq_rel);
        main_payload = ptr;
    }

    worker_thread.join();

    idx = 0;
    while (idx < poll_threads.len) : (idx += 1) {
        poll_threads[idx].join();
    }

    const successes = success_count.load(.acquire);
    try testing.expectEqual(@as(usize, 1), successes);

    var freed = false;
    if (main_payload) |ptr| {
        payloadCleanup(ptr);
        freed = true;
    }
    const worker_ptr = worker_payload.swap(null, .acq_rel);
    if (worker_ptr) |ptr| {
        try testing.expect(!freed);
        payloadCleanup(ptr);
        freed = true;
    }
    try testing.expect(freed);

    const expected_json = std.fmt.comptimePrint(
        "{{\"code\":{d},\"message\":\"{s}\"}}",
        .{ GrpcStatus.failed_precondition, ERR_ALREADY_CONSUMED },
    );
    try testing.expectEqualStrings(expected_json, errors.snapshot());
}

test "consume preserves producer error published before lock" {
    errors.setLastError("");

    const allocator = std.heap.c_allocator;
    const payload_ptr = allocator.create(u8) catch unreachable;
    payload_ptr.* = 9;

    const Cleanup = struct {
        pub fn run(ptr: ?*anyopaque) void {
            if (ptr) |non_null| {
                const typed = @as(*u8, @ptrCast(non_null));
                std.heap.c_allocator.destroy(typed);
            }
        }
    };

    const handle = createPendingReady(@as(?*anyopaque, @ptrCast(payload_ptr)), Cleanup.run) orelse unreachable;
    defer free(handle);

    const failure_message = "producer failure message";
    const Hook = struct {
        pub fn run(target: *PendingHandle) void {
            if (!transitionToError(target, GrpcStatus.internal, failure_message)) {
                @panic("failed to transition handle to error in test hook");
            }
        }
    };

    TestHooks.before_consume_lock = Hook.run;
    defer TestHooks.before_consume_lock = null;

    const result = consume(handle);
    try testing.expect(result == null);

    const expected_json = std.fmt.comptimePrint(
        "{{\"code\":{d},\"message\":\"{s}\"}}",
        .{ GrpcStatus.internal, failure_message },
    );
    try testing.expectEqualStrings(expected_json, errors.snapshot());
    try testing.expectEqual(false, handle.consumed.load(.acquire));
}

test "resolveClient transitions pending handle to ready" {
    const handle_opt = createPendingInFlight();
    try testing.expect(handle_opt != null);
    const handle_ptr = handle_opt.?;
    defer free(handle_ptr);

    const pending_client = @as(*PendingClient, @ptrCast(@alignCast(handle_ptr)));
    var payload_value: usize = 42;
    const payload_ptr = @as(?*anyopaque, @ptrCast(&payload_value));

    try testing.expect(resolveClient(pending_client, payload_ptr, null));
    try testing.expectEqual(@as(i32, @intFromEnum(Status.ready)), poll(handle_ptr));

    const consumed = consume(handle_ptr);
    try testing.expect(consumed != null);
    try testing.expectEqual(@intFromPtr(payload_ptr.?), @intFromPtr(consumed.?));
}

test "free marks pending handle cancelled while retained" {
    errors.setLastError("");

    const handle_opt = createPendingInFlight();
    try testing.expect(handle_opt != null);
    const handle_ptr = handle_opt.?;

    try testing.expect(retain(handle_ptr));
    try testing.expect(!isCancelled(handle_ptr));

    free(handle_ptr);
    try testing.expect(isCancelled(handle_ptr));

    release(handle_ptr);
}

test "rejectClient transitions pending handle to failed state" {
    const handle_opt = createPendingInFlight();
    try testing.expect(handle_opt != null);
    const handle_ptr = handle_opt.?;
    defer free(handle_ptr);

    const pending_client = @as(*PendingClient, @ptrCast(@alignCast(handle_ptr)));
    try testing.expect(rejectClient(pending_client, GrpcStatus.internal, "boom"));
    try testing.expectEqual(@as(i32, @intFromEnum(Status.failed)), poll(handle_ptr));
    try testing.expect(consume(handle_ptr) == null);
}
