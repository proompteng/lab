const std = @import("std");
const errors = @import("errors.zig");
const byte_array = @import("byte_array.zig");
const math = std.math;

/// Maps directly onto the poll contract expected by Bun. See native.ts for semantics.
pub const Status = enum(i32) {
    pending = 0,
    ready = 1,
    failed = -1,
};

const CleanupFn = ?*const fn (?*anyopaque) void;

pub const PendingTaskFn = *const fn (?*anyopaque) void;

pub const PendingTask = struct {
    run: PendingTaskFn,
    context: ?*anyopaque,
};

pub const PendingExecutorOptions = struct {
    worker_count: usize,
    queue_capacity: usize,
};

pub const PendingExecutorSubmitError = error{
    ShuttingDown,
};

pub const PendingExecutor = struct {
    allocator: std.mem.Allocator = std.heap.c_allocator,
    mutex: std.Thread.Mutex = .{},
    not_empty: std.Thread.Condition = .{},
    not_full: std.Thread.Condition = .{},
    queue: []PendingTask = &[_]PendingTask{},
    head: usize = 0,
    tail: usize = 0,
    count: usize = 0,
    worker_count: usize = 0,
    shutting_down: bool = false,
    initialized: bool = false,
    workers: []std.Thread = &[_]std.Thread{},

    pub fn init(self: *PendingExecutor, allocator: std.mem.Allocator, options: PendingExecutorOptions) !void {
        if (options.worker_count == 0 or options.queue_capacity == 0) {
            return error.InvalidExecutorConfiguration;
        }

        self.allocator = allocator;
        self.queue = try allocator.alloc(PendingTask, options.queue_capacity);
        errdefer allocator.free(self.queue);

        self.workers = try allocator.alloc(std.Thread, options.worker_count);
        errdefer allocator.free(self.workers);

        self.worker_count = options.worker_count;
        self.head = 0;
        self.tail = 0;
        self.count = 0;
        self.shutting_down = false;
        self.initialized = true;

        var spawned: usize = 0;
        errdefer {
            self.mutex.lock();
            self.shutting_down = true;
            self.not_empty.broadcast();
            self.not_full.broadcast();
            self.mutex.unlock();

            var idx: usize = 0;
            while (idx < spawned) : (idx += 1) {
                self.workers[idx].join();
            }
            allocator.free(self.workers);
            allocator.free(self.queue);
            self.workers = &[_]std.Thread{};
            self.queue = &[_]PendingTask{};
            self.worker_count = 0;
            self.initialized = false;
        }

        while (spawned < options.worker_count) : (spawned += 1) {
            const thread = try std.Thread.spawn(.{}, pendingExecutorWorker, .{self});
            self.workers[spawned] = thread;
        }
    }

    pub fn submit(self: *PendingExecutor, task: PendingTask) PendingExecutorSubmitError!void {
        self.mutex.lock();
        defer self.mutex.unlock();

        if (!self.initialized or self.shutting_down) {
            return PendingExecutorSubmitError.ShuttingDown;
        }

        while (self.count == self.queue.len) {
            self.not_full.wait(&self.mutex);
            if (self.shutting_down) {
                return PendingExecutorSubmitError.ShuttingDown;
            }
        }

        self.queue[self.tail] = task;
        self.tail = (self.tail + 1) % self.queue.len;
        self.count += 1;
        self.not_empty.signal();
    }

    pub fn shutdown(self: *PendingExecutor) void {
        self.mutex.lock();
        if (!self.initialized or self.shutting_down) {
            self.shutting_down = true;
            self.mutex.unlock();
        } else {
            self.shutting_down = true;
            self.not_empty.broadcast();
            self.not_full.broadcast();
            self.mutex.unlock();
        }

        // Join workers outside the mutex to avoid deadlocks.
        var idx: usize = 0;
        while (idx < self.worker_count) : (idx += 1) {
            self.workers[idx].join();
        }

        self.mutex.lock();
        self.count = 0;
        self.head = 0;
        self.tail = 0;
        self.initialized = false;
        self.mutex.unlock();

        if (self.workers.len != 0) {
            self.allocator.free(self.workers);
        }
        if (self.queue.len != 0) {
            self.allocator.free(self.queue);
        }
        self.workers = &[_]std.Thread{};
        self.queue = &[_]PendingTask{};
        self.worker_count = 0;
    }

    pub fn workerCount(self: *const PendingExecutor) usize {
        return self.worker_count;
    }

    pub fn queueCapacity(self: *const PendingExecutor) usize {
        return self.queue.len;
    }

    fn workerLoop(self: *PendingExecutor) void {
        while (true) {
            self.mutex.lock();
            while (self.count == 0) {
                if (self.shutting_down) {
                    self.mutex.unlock();
                    return;
                }
                self.not_empty.wait(&self.mutex);
            }

            const task = self.queue[self.head];
            self.head = (self.head + 1) % self.queue.len;
            self.count -= 1;
            self.not_full.signal();
            self.mutex.unlock();

            task.run(task.context);
        }
    }
};

pub fn recommendedExecutorWorkerCount() usize {
    const cpu_count_result = std.Thread.getCpuCount() catch 4;
    const cpu_count: usize = @intCast(cpu_count_result);
    return math.clamp(cpu_count, 2, 8);
}

pub fn recommendedExecutorQueueCapacity(worker_count: usize) usize {
    if (worker_count == 0) {
        return 0;
    }
    const per_worker: usize = 16;
    return worker_count * per_worker;
}

fn pendingExecutorWorker(executor: *PendingExecutor) void {
    executor.workerLoop();
}

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

const ExecutorTestContext = struct {
    counter: *std.atomic.Value(u32),
};

fn executorIncrementTask(context: ?*anyopaque) void {
    const raw = context orelse return;
    const ctx = @as(*ExecutorTestContext, @ptrCast(@alignCast(raw)));
    _ = ctx.counter.fetchAdd(1, .seq_cst);
}

const ExecutorBlockingContext = struct {
    gate: *std.atomic.Value(bool),
    counter: *std.atomic.Value(u32),
};

fn executorBlockingTask(context: ?*anyopaque) void {
    const raw = context orelse return;
    const ctx = @as(*ExecutorBlockingContext, @ptrCast(@alignCast(raw)));
    while (!ctx.gate.load(.seq_cst)) {
        std.Thread.sleep(100_000);
    }
    _ = ctx.counter.fetchAdd(1, .seq_cst);
}

const ExecutorSimpleContext = struct {
    counter: *std.atomic.Value(u32),
    completed: *std.atomic.Value(bool),
};

fn executorSimpleTask(context: ?*anyopaque) void {
    const raw = context orelse return;
    const ctx = @as(*ExecutorSimpleContext, @ptrCast(@alignCast(raw)));
    _ = ctx.counter.fetchAdd(1, .seq_cst);
    ctx.completed.store(true, .seq_cst);
}

const SubmitThreadArgs = struct {
    executor: *PendingExecutor,
    context: *ExecutorSimpleContext,
};

fn submitSimpleTaskWorker(args: SubmitThreadArgs) void {
    args.executor.submit(.{
        .run = executorSimpleTask,
        .context = @as(?*anyopaque, @ptrCast(@alignCast(args.context))),
    }) catch unreachable;
}

const ExecutorSleepContext = struct {
    counter: *std.atomic.Value(u32),
};

fn executorSleepTask(context: ?*anyopaque) void {
    const raw = context orelse return;
    const ctx = @as(*ExecutorSleepContext, @ptrCast(@alignCast(raw)));
    std.Thread.sleep(2 * std.time.ns_per_ms);
    _ = ctx.counter.fetchAdd(1, .seq_cst);
}

fn waitForCounter(counter: *std.atomic.Value(u32), expected: u32) void {
    var attempts: usize = 0;
    while (counter.load(.seq_cst) != expected and attempts < 20000) {
        std.Thread.sleep(100_000);
        attempts += 1;
    }
}

test "pending executor processes submitted tasks" {
    var executor = PendingExecutor{};
    defer executor.shutdown();
    try executor.init(std.heap.c_allocator, .{ .worker_count = 2, .queue_capacity = 4 });

    var counter = std.atomic.Value(u32).init(0);
    const contexts = [_]ExecutorTestContext{
        .{ .counter = &counter },
        .{ .counter = &counter },
        .{ .counter = &counter },
        .{ .counter = &counter },
    };

    for (contexts[0..]) |*ctx| {
        try executor.submit(.{
            .run = executorIncrementTask,
            .context = @as(?*anyopaque, @ptrCast(@alignCast(@constCast(ctx)))),
        });
    }

    waitForCounter(&counter, @intCast(contexts.len));
    try testing.expectEqual(@as(u32, contexts.len), counter.load(.seq_cst));
}

test "pending executor waits for queue availability" {
    var executor = PendingExecutor{};
    defer executor.shutdown();
    try executor.init(std.heap.c_allocator, .{ .worker_count = 1, .queue_capacity = 1 });

    var gate = std.atomic.Value(bool).init(false);
    var counter = std.atomic.Value(u32).init(0);
    var submit_completed = std.atomic.Value(bool).init(false);

    var blocking_ctx = ExecutorBlockingContext{ .gate = &gate, .counter = &counter };
    try executor.submit(.{
        .run = executorBlockingTask,
        .context = @as(?*anyopaque, @ptrCast(@alignCast(&blocking_ctx))),
    });

    var simple_ctx = ExecutorSimpleContext{ .counter = &counter, .completed = &submit_completed };
    const args = SubmitThreadArgs{ .executor = &executor, .context = &simple_ctx };
    var submit_thread = try std.Thread.spawn(.{}, submitSimpleTaskWorker, .{args});
    var joined = false;
    defer if (!joined) submit_thread.join();

    std.Thread.sleep(2 * std.time.ns_per_ms);
    try testing.expect(!submit_completed.load(.seq_cst));

    gate.store(true, .seq_cst);
    submit_thread.join();
    joined = true;

    waitForCounter(&counter, 2);
    try testing.expectEqual(@as(u32, 2), counter.load(.seq_cst));
    try testing.expect(submit_completed.load(.seq_cst));
}

test "pending executor shutdown waits for tasks to finish" {
    var executor = PendingExecutor{};
    try executor.init(std.heap.c_allocator, .{ .worker_count = 2, .queue_capacity = 4 });

    var counter = std.atomic.Value(u32).init(0);
    const contexts = [_]ExecutorSleepContext{
        .{ .counter = &counter },
        .{ .counter = &counter },
        .{ .counter = &counter },
    };

    for (contexts[0..]) |*ctx| {
        try executor.submit(.{
            .run = executorSleepTask,
            .context = @as(?*anyopaque, @ptrCast(@alignCast(@constCast(ctx)))),
        });
    }

    executor.shutdown();
    try testing.expectEqual(@as(u32, contexts.len), counter.load(.seq_cst));
}
