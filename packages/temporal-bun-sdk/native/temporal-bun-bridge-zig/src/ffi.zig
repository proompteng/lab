const std = @import("std");

const Status = enum(i32) {
    ok = 0,
    invalid_argument = 1,
    not_found = 2,
    already_closed = 3,
    busy = 4,
    internal = 5,
    oom = 6,
};

const ErrorSlot = struct {
    payload: ?[]u8 = null,
    code: Status = .ok,
};

threadlocal var tls_error: ErrorSlot = .{};

var global_allocator: std.mem.Allocator = std.heap.c_allocator;

const ClientEntry = struct {
    closed: bool = false,
};

const WorkerEntry = struct {
    closed: bool = false,
    client_id: u64,
};

var client_registry = std.AutoArrayHashMapUnmanaged(u64, ClientEntry){};
var worker_registry = std.AutoArrayHashMapUnmanaged(u64, WorkerEntry){};
var buffer_registry = std.AutoArrayHashMapUnmanaged(u64, usize){};

var client_mutex = std.Thread.Mutex{};
var worker_mutex = std.Thread.Mutex{};
var buffer_mutex = std.Thread.Mutex{};

var client_counter = std.atomic.Value(u64).init(1);
var worker_counter = std.atomic.Value(u64).init(1);

fn allocator() std.mem.Allocator {
    return global_allocator;
}

fn swapAllocator(new_allocator: std.mem.Allocator) std.mem.Allocator {
    const previous = global_allocator;
    global_allocator = new_allocator;
    return previous;
}

fn resetErrorSlot() void {
    if (tls_error.payload) |payload| {
        allocator().free(payload);
    }
    tls_error = .{};
}

fn fail(code: Status, where: []const u8, message: []const u8) i32 {
    resetErrorSlot();
    const result = std.fmt.allocPrint(
        allocator(),
        "{\"code\":{d},\"msg\":\"{s}\",\"where\":\"{s}\"}",
        .{ @intFromEnum(code), message, where },
    ) catch {
        tls_error.code = .oom;
        return @intFromEnum(Status.oom);
    };

    tls_error.payload = result;
    tls_error.code = code;
    return @intFromEnum(code);
}

fn ok() i32 {
    resetErrorSlot();
    return @intFromEnum(Status.ok);
}

const BufferError = error{
    NegativeLength,
    NullPointer,
    LengthOverflow,
};

fn validateBuffer(ptr: ?[*]const u8, len: i64) BufferError!void {
    if (len < 0) return BufferError.NegativeLength;
    if (len == 0) return;
    if (ptr == null) return BufferError.NullPointer;
    _ = std.math.cast(usize, len) orelse return BufferError.LengthOverflow;
}

fn nextId(counter: *std.atomic.Value(u64)) u64 {
    return counter.fetchAdd(1, .seq_cst);
}

fn getClientEntry(id: u64) ?*ClientEntry {
    return client_registry.getPtr(id);
}

fn getWorkerEntry(id: u64) ?*WorkerEntry {
    return worker_registry.getPtr(id);
}

fn registerBuffer(buffer: []u8) !u64 {
    const key = @as(u64, @intCast(@intFromPtr(buffer.ptr)));
    try buffer_registry.put(allocator(), key, buffer.len);
    return key;
}

fn takeErrorBuffer() ?[]u8 {
    if (tls_error.payload) |payload| {
        tls_error.payload = null;
        return payload;
    }
    return null;
}

fn clearRegistries() void {
    {
        client_mutex.lock();
        defer client_mutex.unlock();
        client_registry.deinit(allocator());
        client_registry = .{};
        client_counter.store(1, .seq_cst);
    }

    {
        worker_mutex.lock();
        defer worker_mutex.unlock();
        worker_registry.deinit(allocator());
        worker_registry = .{};
        worker_counter.store(1, .seq_cst);
    }

    {
        buffer_mutex.lock();
        defer buffer_mutex.unlock();
        var it = buffer_registry.iterator();
        while (it.next()) |entry| {
            const ptr_value = entry.key_ptr.*;
            const len_value = entry.value_ptr.*;
            const slice_ptr: [*]u8 = @ptrFromInt(ptr_value);
            if (len_value > 0) {
                const slice_len = len_value;
                const slice = slice_ptr[0..slice_len];
                allocator().free(slice);
            }
        }
        buffer_registry.deinit(allocator());
        buffer_registry = .{};
    }

    resetErrorSlot();
}

pub export fn te_client_connect(config_ptr: ?[*]const u8, len: i64, out_handle: ?*u64) i32 {
    resetErrorSlot();
    if (out_handle == null) {
        return fail(.invalid_argument, "te_client_connect", "out_handle is null");
    }

    if (validateBuffer(config_ptr, len)) |_| {
        // ignore validated slice contents for now
    } else |err| switch (err) {
        BufferError.NegativeLength => {
            return fail(.invalid_argument, "te_client_connect", "config length is negative");
        },
        BufferError.NullPointer => {
            return fail(.invalid_argument, "te_client_connect", "config pointer is null");
        },
        BufferError.LengthOverflow => {
            return fail(.invalid_argument, "te_client_connect", "config length overflow");
        },
    }

    const id = nextId(&client_counter);

    client_mutex.lock();
    defer client_mutex.unlock();

    client_registry.put(allocator(), id, .{}) catch |err| {
        return switch (err) {
            error.OutOfMemory => fail(.oom, "te_client_connect", "allocation failed"),
            else => fail(.internal, "te_client_connect", "registry insert failed"),
        };
    };

    out_handle.?.* = id;
    return ok();
}

pub export fn te_client_close(handle: u64) i32 {
    resetErrorSlot();
    if (handle == 0) {
        return fail(.invalid_argument, "te_client_close", "handle is zero");
    }

    client_mutex.lock();
    defer client_mutex.unlock();

    if (getClientEntry(handle)) |entry| {
        if (entry.closed) {
            return fail(.already_closed, "te_client_close", "client already closed");
        }
        entry.closed = true;
        return ok();
    }

    return fail(.not_found, "te_client_close", "unknown client handle");
}

pub export fn te_worker_start(client_handle: u64, options_ptr: ?[*]const u8, len: i64, out_handle: ?*u64) i32 {
    resetErrorSlot();
    if (out_handle == null) {
        return fail(.invalid_argument, "te_worker_start", "out_handle is null");
    }

    if (client_handle == 0) {
        return fail(.invalid_argument, "te_worker_start", "client handle is zero");
    }

    if (validateBuffer(options_ptr, len)) |_| {
        // nothing to do with contents yet
    } else |err| switch (err) {
        BufferError.NegativeLength => {
            return fail(.invalid_argument, "te_worker_start", "options length is negative");
        },
        BufferError.NullPointer => {
            return fail(.invalid_argument, "te_worker_start", "options pointer is null");
        },
        BufferError.LengthOverflow => {
            return fail(.invalid_argument, "te_worker_start", "options length overflow");
        },
    }

    client_mutex.lock();
    defer client_mutex.unlock();

    const client_entry = getClientEntry(client_handle) orelse {
        return fail(.not_found, "te_worker_start", "client handle not found");
    };

    if (client_entry.closed) {
        return fail(.invalid_argument, "te_worker_start", "client is closed");
    }

    const id = nextId(&worker_counter);

    worker_mutex.lock();
    defer worker_mutex.unlock();

    worker_registry.put(allocator(), id, .{ .client_id = client_handle }) catch |err| {
        return switch (err) {
            error.OutOfMemory => fail(.oom, "te_worker_start", "allocation failed"),
            else => fail(.internal, "te_worker_start", "registry insert failed"),
        };
    };

    out_handle.?.* = id;
    return ok();
}

pub export fn te_worker_shutdown(handle: u64) i32 {
    resetErrorSlot();
    if (handle == 0) {
        return fail(.invalid_argument, "te_worker_shutdown", "handle is zero");
    }

    worker_mutex.lock();
    defer worker_mutex.unlock();

    if (getWorkerEntry(handle)) |entry| {
        if (entry.closed) {
            return fail(.already_closed, "te_worker_shutdown", "worker already shutdown");
        }
        entry.closed = true;
        return ok();
    }

    return fail(.not_found, "te_worker_shutdown", "unknown worker handle");
}

pub export fn te_get_last_error(out_ptr: ?*u64, out_len: ?*u64) i32 {
    if (out_ptr == null or out_len == null) {
        return fail(.invalid_argument, "te_get_last_error", "output pointers are null");
    }

    if (takeErrorBuffer()) |buffer| {
        const len_usize = buffer.len;
        out_len.?.* = @as(u64, @intCast(len_usize));

        buffer_mutex.lock();
        defer buffer_mutex.unlock();
        const key = registerBuffer(buffer) catch |err| {
            allocator().free(buffer);
            return switch (err) {
                error.OutOfMemory => fail(.oom, "te_get_last_error", "buffer registry allocation failed"),
                else => fail(.internal, "te_get_last_error", "buffer registry failure"),
            };
        };

        out_ptr.?.* = key;
        return ok();
    }

    out_ptr.?.* = 0;
    out_len.?.* = 0;
    return @intFromEnum(Status.not_found);
}

pub export fn te_free_buf(ptr_value: u64, len: i64) i32 {
    resetErrorSlot();

    if (len < 0) {
        return fail(.invalid_argument, "te_free_buf", "length is negative");
    }

    if (len == 0) {
        if (ptr_value != 0) {
            return fail(.invalid_argument, "te_free_buf", "length is zero but pointer is not null");
        }
        return ok();
    }

    if (ptr_value == 0) {
        return fail(.invalid_argument, "te_free_buf", "pointer is null");
    }

    const len_usize = std.math.cast(usize, len) orelse {
        return fail(.invalid_argument, "te_free_buf", "length overflow");
    };

    const key = ptr_value;
    const pointer: [*]u8 = @ptrFromInt(ptr_value);

    buffer_mutex.lock();
    defer buffer_mutex.unlock();

    if (buffer_registry.fetchRemove(key)) |kv| {
        if (kv.value != len_usize) {
            buffer_registry.put(allocator(), key, kv.value) catch {
                // if reinsertion fails we still surface mismatch error
            };
            return fail(.invalid_argument, "te_free_buf", "length mismatch");
        }
        const slice = pointer[0..len_usize];
        allocator().free(slice);
        return ok();
    }

    return fail(.not_found, "te_free_buf", "buffer handle not found");
}

fn statusFromInt(value: i32) Status {
    return @enumFromInt(value);
}

fn expectStatus(status: i32, expected: Status) !void {
    try std.testing.expectEqual(expected, statusFromInt(status));
}

fn expectError(where: []const u8, expected_code: Status) !void {
    var ptr_value: u64 = 0;
    var len: u64 = 0;
    const status = te_get_last_error(&ptr_value, &len);
    try expectStatus(status, .ok);
    try std.testing.expect(ptr_value != 0);
    try std.testing.expect(len > 0);
    const slice_len: usize = @intCast(len);
    const pointer: [*]u8 = @ptrFromInt(ptr_value);
    const slice = pointer[0..slice_len];
    defer {
        const free_status = te_free_buf(ptr_value, len);
        std.debug.assert(free_status == @intFromEnum(Status.ok));
    }
    var code_buf: [32]u8 = undefined;
    const code_fragment = std.fmt.bufPrint(&code_buf, "\"code\":{d}", .{@intFromEnum(expected_code)}) catch unreachable;
    try std.testing.expect(std.mem.indexOf(u8, slice, code_fragment) != null);
    try std.testing.expect(std.mem.indexOf(u8, slice, where) != null);
}

fn expectNoError() !void {
    var buf_ptr: u64 = 123;
    var len: u64 = 123;
    const status = te_get_last_error(&buf_ptr, &len);
    try std.testing.expectEqual(Status.not_found, statusFromInt(status));
    try std.testing.expectEqual(@as(u64, 0), buf_ptr);
    try std.testing.expectEqual(@as(u64, 0), len);
}

test "client connect and close lifecycle" {
    clearRegistries();
    defer clearRegistries();

    var handle: u64 = 0;
    try expectStatus(te_client_connect(null, 0, &handle), .ok);
    try std.testing.expect(handle != 0);
    try expectStatus(te_client_close(handle), .ok);

    const second_close = te_client_close(handle);
    try std.testing.expectEqual(Status.already_closed, statusFromInt(second_close));
    try expectError("te_client_close", .already_closed);
}

test "worker lifecycle depends on client" {
    clearRegistries();
    defer clearRegistries();

    var client_handle: u64 = 0;
    try expectStatus(te_client_connect(null, 0, &client_handle), .ok);

    var worker_handle: u64 = 0;
    try expectStatus(te_worker_start(client_handle, null, 0, &worker_handle), .ok);
    try std.testing.expect(worker_handle != 0);

    try expectStatus(te_worker_shutdown(worker_handle), .ok);

    const again = te_worker_shutdown(worker_handle);
    try std.testing.expectEqual(Status.already_closed, statusFromInt(again));
    try expectError("te_worker_shutdown", .already_closed);

    try expectStatus(te_client_close(client_handle), .ok);
}

test "invalid arguments surface descriptive errors" {
    clearRegistries();
    defer clearRegistries();

    try std.testing.expectEqual(Status.invalid_argument, statusFromInt(te_client_connect(null, 0, null)));
    try expectError("te_client_connect", .invalid_argument);

    var client_handle: u64 = 0;
    try expectStatus(te_client_connect(null, 0, &client_handle), .ok);
    try expectStatus(te_client_close(client_handle), .ok);

    var worker_handle: u64 = 0;
    try std.testing.expectEqual(Status.invalid_argument, statusFromInt(te_worker_start(client_handle, null, 0, &worker_handle)));
    try expectError("te_worker_start", .invalid_argument);
}

test "double free and buffer mismatch errors" {
    clearRegistries();
    defer clearRegistries();

    const status = te_client_close(42);
    try std.testing.expectEqual(Status.not_found, statusFromInt(status));
    try expectError("te_client_close", .not_found);

    var ptr_value: u64 = 0;
    var len: u64 = 0;
    try expectStatus(te_get_last_error(&ptr_value, &len), .ok);
    try std.testing.expect(ptr_value != 0);
    try expectStatus(te_free_buf(ptr_value, len), .ok);

    const double_free = te_free_buf(ptr_value, len);
    try std.testing.expectEqual(Status.not_found, statusFromInt(double_free));
    try expectError("te_free_buf", .not_found);
}

test "allocator counting" {
    clearRegistries();
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    const test_allocator = gpa.allocator();
    const previous = swapAllocator(test_allocator);
    defer {
        _ = swapAllocator(previous);
        clearRegistries();
        const status = gpa.deinit();
        std.testing.expect(status == .ok) catch unreachable;
    };

    var handle: u64 = 0;
    try expectStatus(te_client_connect(null, 0, &handle), .ok);
    try expectStatus(te_client_close(handle), .ok);
    try expectNoError();
}

test "stress 8 threads connect close" {
    clearRegistries();
    defer clearRegistries();

    const iterations: usize = 100;
    var threads: [8]std.Thread = undefined;

    for (threads, 0..) |*thread, _| {
        thread.* = try std.Thread.spawn(.{}, stressThread, .{iterations});
    }

    for (threads) |thread| {
        thread.join();
    }

    try expectNoError();
}

fn stressThread(iterations: usize) void {
    var index: usize = 0;
    while (index < iterations) : (index += 1) {
        var handle: u64 = 0;
        const connect_status = te_client_connect(null, 0, &handle);
        std.debug.assert(connect_status == @intFromEnum(Status.ok));
        const close_status = te_client_close(handle);
        std.debug.assert(close_status == @intFromEnum(Status.ok));
    }
}

