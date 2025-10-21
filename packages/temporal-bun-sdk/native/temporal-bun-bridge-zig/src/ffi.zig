const std = @import("std");
const builtin = @import("builtin");

const Allocator = std.mem.Allocator;

pub const ErrorCode = enum(i32) {
    ok = 0,
    invalid_argument = 1,
    not_found = 2,
    already_closed = 3,
    no_memory = 4,
    internal = 5,
};

const ErrorPayload = struct {
    code: i32,
    message: []const u8,
    where: []const u8,
};

const ClientState = struct {
    closed: bool,
};

const WorkerState = struct {
    closed: bool,
    client_id: u64,
};

const BufferInfo = struct {
    allocator: Allocator,
    len: usize,
};

fn sliceFromPtr(ptr: *u8, len: usize) []u8 {
    const many = @as([*]u8, @ptrCast(ptr));
    return many[0..len];
}

var active_allocator: Allocator = std.heap.c_allocator;

var clients_mutex = std.Thread.Mutex{};
var clients = std.AutoHashMapUnmanaged(u64, ClientState){};

var workers_mutex = std.Thread.Mutex{};
var workers = std.AutoHashMapUnmanaged(u64, WorkerState){};

var buffer_mutex = std.Thread.Mutex{};
var buffer_registry = std.AutoHashMapUnmanaged(usize, BufferInfo){};

threadlocal var last_error_key: ?usize = null;

var client_id_counter = std.atomic.Value(u64).init(1);
var worker_id_counter = std.atomic.Value(u64).init(1);

fn status(code: ErrorCode) i32 {
    return @intFromEnum(code);
}

fn reset_state_internal() void {
    clients_mutex.lock();
    workers_mutex.lock();
    buffer_mutex.lock();

    if (clients.capacity() != 0) {
        clients.deinit(active_allocator);
        clients = .{};
    } else {
        clients = .{};
    }

    if (workers.capacity() != 0) {
        workers.deinit(active_allocator);
        workers = .{};
    } else {
        workers = .{};
    }

    if (buffer_registry.capacity() != 0) {
        var it = buffer_registry.iterator();
        while (it.next()) |entry| {
            const key = entry.key_ptr.*;
            const info = entry.value_ptr.*;
            const ptr_value = @as(*u8, @ptrFromInt(key));
            info.allocator.free(sliceFromPtr(ptr_value, info.len));
        }
        buffer_registry.deinit(active_allocator);
        buffer_registry = .{};
    } else {
        buffer_registry = .{};
    }

    buffer_mutex.unlock();
    workers_mutex.unlock();
    clients_mutex.unlock();

    client_id_counter.store(1, .seq_cst);
    worker_id_counter.store(1, .seq_cst);
    last_error_key = null;
}

fn set_active_allocator(new_allocator: Allocator) void {
    reset_state_internal();
    active_allocator = new_allocator;
}

fn clear_last_error() void {
    if (last_error_key) |key| {
        buffer_mutex.lock();
        const removed = buffer_registry.fetchRemove(key);
        buffer_mutex.unlock();
        if (removed) |kv| {
            const info = kv.value;
            const base_ptr = @as(*u8, @ptrFromInt(kv.key));
            info.allocator.free(sliceFromPtr(base_ptr, info.len));
        }
        last_error_key = null;
    }
}

fn store_error_buffer(buf: []u8, alloc: Allocator) i32 {
    const key = @intFromPtr(buf.ptr);
    buffer_mutex.lock();
    defer buffer_mutex.unlock();

    const result = buffer_registry.getOrPut(alloc, key) catch {
        alloc.free(buf);
        last_error_key = null;
        return status(.no_memory);
    };

    result.value_ptr.* = .{ .allocator = alloc, .len = buf.len };
    last_error_key = key;
    return 0;
}

fn set_last_error(code: ErrorCode, msg: []const u8, where: []const u8) i32 {
    clear_last_error();

    const payload = ErrorPayload{
        .code = @intFromEnum(code),
        .message = msg,
        .where = where,
    };

    const encoded = std.json.stringifyAlloc(active_allocator, payload, .{}) catch {
        last_error_key = null;
        return status(code);
    };

    _ = store_error_buffer(encoded, active_allocator);
    return status(code);
}

fn allocator() Allocator {
    return active_allocator;
}

fn next_client_id() u64 {
    return client_id_counter.fetchAdd(1, .seq_cst);
}

fn next_worker_id() u64 {
    return worker_id_counter.fetchAdd(1, .seq_cst);
}

pub export fn te_client_connect(out_id: ?*u64) i32 {
    if (out_id == null) {
        return set_last_error(.invalid_argument, "client_id pointer was null", "te_client_connect");
    }

    clients_mutex.lock();
    defer clients_mutex.unlock();

    const id = next_client_id();
    const allocator_ref = allocator();
    const entry = clients.getOrPut(allocator_ref, id) catch {
        return set_last_error(.no_memory, "failed to allocate client handle", "te_client_connect");
    };

    entry.value_ptr.* = .{ .closed = false };
    out_id.?.* = id;
    return status(.ok);
}

pub export fn te_client_close(id: u64) i32 {
    clients_mutex.lock();
    defer clients_mutex.unlock();

    if (clients.getPtr(id)) |state| {
        if (state.closed) {
            return set_last_error(.already_closed, "client already closed", "te_client_close");
        }
        state.closed = true;
        return status(.ok);
    }

    return set_last_error(.not_found, "client handle not found", "te_client_close");
}

pub export fn te_worker_start(client_id: u64, out_worker_id: ?*u64) i32 {
    if (out_worker_id == null) {
        return set_last_error(.invalid_argument, "worker_id pointer was null", "te_worker_start");
    }

    clients_mutex.lock();
    if (clients.getPtr(client_id)) |client_state| {
        if (client_state.closed) {
            clients_mutex.unlock();
            return set_last_error(.already_closed, "client is closed", "te_worker_start");
        }
    } else {
        clients_mutex.unlock();
        return set_last_error(.not_found, "client handle not found", "te_worker_start");
    }

    workers_mutex.lock();
    const worker_id = next_worker_id();
    const allocator_ref = allocator();
    const entry = workers.getOrPut(allocator_ref, worker_id) catch {
        workers_mutex.unlock();
        clients_mutex.unlock();
        return set_last_error(.no_memory, "failed to allocate worker handle", "te_worker_start");
    };

    entry.value_ptr.* = .{ .closed = false, .client_id = client_id };
    workers_mutex.unlock();
    clients_mutex.unlock();

    out_worker_id.?.* = worker_id;
    return status(.ok);
}

pub export fn te_worker_shutdown(worker_id: u64) i32 {
    workers_mutex.lock();
    defer workers_mutex.unlock();

    if (workers.getPtr(worker_id)) |state| {
        if (state.closed) {
            return set_last_error(.already_closed, "worker already shutdown", "te_worker_shutdown");
        }
        state.closed = true;
        return status(.ok);
    }

    return set_last_error(.not_found, "worker handle not found", "te_worker_shutdown");
}

pub export fn te_get_last_error(out_ptr: ?*?*u8, out_len: ?*usize) i32 {
    if (out_ptr == null or out_len == null) {
        return set_last_error(.invalid_argument, "output pointers must be non-null", "te_get_last_error");
    }

    const key = last_error_key;
    if (key == null) {
        out_ptr.?.* = null;
        out_len.?.* = 0;
        return status(.ok);
    }

    buffer_mutex.lock();
    const info = buffer_registry.get(key.?);
    buffer_mutex.unlock();

    if (info) |value| {
        out_ptr.?.* = @as(?*u8, @ptrFromInt(key.?));
        out_len.?.* = value.len;
        last_error_key = null;
        return status(.ok);
    }

    last_error_key = null;
    out_ptr.?.* = null;
    out_len.?.* = 0;
    return set_last_error(.internal, "no error buffer registered", "te_get_last_error");
}

pub export fn te_free_buf(ptr_value: usize, len: isize) i32 {
    if (len < 0) {
        return set_last_error(.invalid_argument, "length was negative", "te_free_buf");
    }

    if (ptr_value == 0) {
        if (len == 0) {
            return status(.ok);
        }
        return set_last_error(.invalid_argument, "null pointer requires zero length", "te_free_buf");
    }

    const actual_len: usize = @intCast(len);
    const key = ptr_value;

    buffer_mutex.lock();
    const entry = buffer_registry.fetchRemove(key);
    buffer_mutex.unlock();

    if (entry == null) {
        return set_last_error(.not_found, "buffer not recognized", "te_free_buf");
    }

    const kv = entry.?;
    const info = kv.value;
    const ptr = @as(*u8, @ptrFromInt(ptr_value));
    const slice = sliceFromPtr(ptr, info.len);
    if (info.len != actual_len) {
        info.allocator.free(slice);
        return set_last_error(.invalid_argument, "buffer length mismatch", "te_free_buf");
    }

    info.allocator.free(slice);
    return status(.ok);
}

fn expect_ok(status_code: i32) !void {
    try std.testing.expectEqual(@as(i32, 0), status_code);
}

fn drain_error_slot() !void {
    var ptr_value: ?*u8 = null;
    var len_value: usize = 0;
    _ = te_get_last_error(&ptr_value, &len_value);
    if (ptr_value) |ptr_non_null| {
        _ = te_free_buf(@intFromPtr(ptr_non_null), @intCast(len_value));
    }
}

const StressError = error{NativeFailure};

fn stress_open_close(iterations: usize) StressError!void {
    var index: usize = 0;
    while (index < iterations) : (index += 1) {
        var client_id: u64 = 0;
        if (te_client_connect(&client_id) != status(.ok)) return StressError.NativeFailure;
        if (te_client_close(client_id) != status(.ok)) return StressError.NativeFailure;
    }
}

fn run_stress_thread(iterations: usize) !void {
    try stress_open_close(iterations);
}

test "allocator counting" {
    reset_state_internal();

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer {
        const leaked = gpa.deinit();
        if (leaked == .leak) {
            @panic("allocator leaked");
        }
    }

    set_active_allocator(gpa.allocator());
    defer set_active_allocator(std.heap.c_allocator);

    var client_id: u64 = 0;
    try expect_ok(te_client_connect(&client_id));
    try expect_ok(te_client_close(client_id));

    try drain_error_slot();
}

test "te_client_close double close" {
    reset_state_internal();
    var client_id: u64 = 0;
    try expect_ok(te_client_connect(&client_id));
    try expect_ok(te_client_close(client_id));
    try std.testing.expectEqual(status(.already_closed), te_client_close(client_id));
    try drain_error_slot();
}

test "te_worker_start validates client" {
    reset_state_internal();

    var worker_id: u64 = 0;
    try std.testing.expectEqual(status(.not_found), te_worker_start(42, &worker_id));
    try drain_error_slot();

    var client_id: u64 = 0;
    try expect_ok(te_client_connect(&client_id));
    try expect_ok(te_client_close(client_id));
    try std.testing.expectEqual(status(.already_closed), te_worker_start(client_id, &worker_id));
    try drain_error_slot();
}

test "te_get_last_error returns payload" {
    reset_state_internal();

    var client_id: u64 = 0;
    try expect_ok(te_client_connect(&client_id));
    try expect_ok(te_client_close(client_id));
    try std.testing.expectEqual(status(.already_closed), te_client_close(client_id));

    var err_ptr: ?*u8 = null;
    var err_len: usize = 0;
    try expect_ok(te_get_last_error(&err_ptr, &err_len));
    try std.testing.expect(err_ptr != null);
    try std.testing.expect(err_len > 0);
    if (err_ptr) |ptr_non_null| {
        try expect_ok(te_free_buf(@intFromPtr(ptr_non_null), @intCast(err_len)));
    }

    try drain_error_slot();
}

test "te_get_last_error empty slot" {
    reset_state_internal();

    var err_ptr: ?*u8 = null;
    var err_len: usize = 1234;
    try expect_ok(te_get_last_error(&err_ptr, &err_len));
    try std.testing.expect(err_ptr == null);
    try std.testing.expectEqual(@as(usize, 0), err_len);
}

test "te_free_buf validates arguments" {
    reset_state_internal();

    try std.testing.expectEqual(status(.invalid_argument), te_free_buf(0, 5));
    try drain_error_slot();

    var ptr_value: ?*u8 = null;
    var len_value: usize = 0;
    try expect_ok(te_get_last_error(&ptr_value, &len_value));
    try std.testing.expect(ptr_value == null);
}

test "te_free_buf double free safe" {
    reset_state_internal();

    try std.testing.expectEqual(status(.not_found), te_client_close(4242));

    var err_ptr: ?*u8 = null;
    var err_len: usize = 0;
    try expect_ok(te_get_last_error(&err_ptr, &err_len));
    try std.testing.expect(err_ptr != null);
    try std.testing.expect(err_len > 0);

    const ptr_value = @intFromPtr(err_ptr.?);
    const len_value: isize = @intCast(err_len);
    try expect_ok(te_free_buf(ptr_value, len_value));

    try std.testing.expectEqual(status(.not_found), te_free_buf(ptr_value, len_value));
    try drain_error_slot();
}

test "te_free_buf length mismatch clears entry" {
    reset_state_internal();

    try std.testing.expectEqual(status(.not_found), te_worker_shutdown(9999));

    var err_ptr: ?*u8 = null;
    var err_len: usize = 0;
    try expect_ok(te_get_last_error(&err_ptr, &err_len));
    try std.testing.expect(err_ptr != null);
    try std.testing.expect(err_len > 0);

    const ptr_value = @intFromPtr(err_ptr.?);
    const wrong_len = @as(isize, @intCast(err_len + 1));
    try std.testing.expectEqual(status(.invalid_argument), te_free_buf(ptr_value, wrong_len));
    try drain_error_slot();

    try std.testing.expectEqual(status(.not_found), te_free_buf(ptr_value, @intCast(err_len)));
    try drain_error_slot();
}

test "multi-thread open close stress" {
    reset_state_internal();

    var threads: [8]std.Thread = undefined;
    for (&threads) |*thread| {
        thread.* = try std.Thread.spawn(.{}, run_stress_thread, .{100});
    }

    for (threads) |thread| {
        thread.join();
    }

    try drain_error_slot();
}

pub const testing = struct {
    pub fn reset() void {
        reset_state_internal();
    }

    pub fn useAllocator(alloc: Allocator) void {
        set_active_allocator(alloc);
    }
};
