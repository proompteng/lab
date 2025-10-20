const std = @import("std");
const errors = @import("errors.zig");
const core = @import("core.zig");
const pending = @import("pending.zig");

const grpc = pending.GrpcStatus;
const allocator = std.heap.c_allocator;

const RuntimeNewFn = *const fn ([*c]const core.RuntimeOptions) callconv(.c) core.RuntimeOrFail;
const RuntimeFreeFn = *const fn (?*core.Runtime) callconv(.c) void;
const RuntimeByteArrayFreeFn = *const fn (?*core.Runtime, [*c]const core.ByteArray) callconv(.c) void;

var runtime_new_impl: RuntimeNewFn = core.api.runtime_new;
var runtime_free_impl: RuntimeFreeFn = core.api.runtime_free;
var runtime_byte_array_free_impl: RuntimeByteArrayFreeFn = core.api.byte_array_free;

fn runtimeNew(options: ?*const core.RuntimeOptions) core.RuntimeOrFail {
    const pointer: [*c]const core.RuntimeOptions = if (options) |value|
        @as([*c]const core.RuntimeOptions, @ptrCast(value))
    else
        @ptrFromInt(0);
    return runtime_new_impl(pointer);
}

fn runtimeFree(runtime: ?*core.Runtime) void {
    runtime_free_impl(runtime);
}

fn runtimeByteArrayFree(runtime: ?*core.Runtime, bytes: ?*const core.ByteArray) void {
    runtime_byte_array_free_impl(runtime, bytes);
}

fn byteArraySlice(bytes_ptr: ?*const core.ByteArray) []const u8 {
    if (bytes_ptr == null) {
        return ""[0..0];
    }

    const bytes = bytes_ptr.?;
    if (bytes.data == null or bytes.size == 0) {
        return ""[0..0];
    }

    return bytes.data[0..bytes.size];
}

fn resetCoreApiOverrides() void {
    runtime_new_impl = core.api.runtime_new;
    runtime_free_impl = core.api.runtime_free;
    runtime_byte_array_free_impl = core.api.byte_array_free;
}

const DummyRuntime = extern struct {
    pad: u8 = 0,
};

/// Placeholder handle that mirrors the pointer-based interface exposed by the Rust bridge.
pub const RuntimeHandle = struct {
    id: u64,
    /// Raw JSON payload passed from TypeScript; retained until the Rust runtime wiring is complete.
    config: []u8,
    core_runtime: ?*core.Runtime,
    pending_lock: std.Thread.Mutex,
    pending_condition: std.Thread.Condition,
    pending_connects: usize,
    destroying: bool,
};

var next_runtime_id: u64 = 1;

pub fn create(options_json: []const u8) ?*RuntimeHandle {
    const copy = allocator.alloc(u8, options_json.len) catch |err| {
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate runtime config: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate runtime config";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        return null;
    };
    @memcpy(copy, options_json);

    const handle = allocator.create(RuntimeHandle) catch |err| {
        allocator.free(copy);
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate runtime handle: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate runtime handle";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        return null;
    };

    const id = next_runtime_id;
    next_runtime_id += 1;

    handle.* = .{
        .id = id,
        .config = copy,
        .core_runtime = null,
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    // Temporal core expects a valid options struct even when telemetry is absent; initialize with defaults.
    var options = core.RuntimeOptions{
        .telemetry = null,
    };

    const runtime_or_fail = runtimeNew(&options);
    const runtime_ptr = runtime_or_fail.runtime;

    if (runtime_or_fail.fail) |fail_ptr| {
        const fail_message = byteArraySlice(fail_ptr);
        const fallback =
            "temporal-bun-bridge-zig: temporal core runtime initialization failed";
        const description = if (fail_message.len > 0) fail_message else fallback;
        errors.setStructuredError(.{
            .code = grpc.internal,
            .message = description,
            .details = if (fail_message.len > 0) fail_message else null,
        });

        runtimeByteArrayFree(runtime_ptr, fail_ptr);
        runtimeFree(runtime_ptr);

        allocator.free(copy);
        allocator.destroy(handle);
        return null;
    }

    if (runtime_ptr == null) {
        const fallback =
            "temporal-bun-bridge-zig: temporal core runtime initialization failed";
        errors.setStructuredError(.{
            .code = grpc.internal,
            .message = fallback,
            .details = null,
        });

        allocator.free(copy);
        allocator.destroy(handle);
        return null;
    }

    handle.core_runtime = runtime_ptr;

    // Temporal core indicates success by leaving `.fail` null. Clear any sticky errors to match Bun expectations.
    errors.setLastError(""[0..0]);

    return handle;
}

pub fn destroy(handle: ?*RuntimeHandle) void {
    if (handle == null) {
        return;
    }

    const runtime = handle.?;

    runtime.pending_lock.lock();
    runtime.destroying = true;
    while (runtime.pending_connects != 0) {
        runtime.pending_condition.wait(&runtime.pending_lock);
    }
    runtime.pending_lock.unlock();

    if (runtime.core_runtime) |core_runtime_ptr| {
        runtimeFree(core_runtime_ptr);
    }

    if (runtime.config.len > 0) {
        allocator.free(runtime.config);
    }

    allocator.destroy(runtime);
}

pub fn beginPendingClientConnect(handle: *RuntimeHandle) bool {
    handle.pending_lock.lock();
    defer handle.pending_lock.unlock();

    if (handle.destroying) {
        return false;
    }

    handle.pending_connects += 1;
    return true;
}

pub fn endPendingClientConnect(handle: *RuntimeHandle) void {
    handle.pending_lock.lock();
    defer handle.pending_lock.unlock();

    std.debug.assert(handle.pending_connects > 0);
    handle.pending_connects -= 1;

    if (handle.destroying and handle.pending_connects == 0) {
        handle.pending_condition.broadcast();
    }
}

pub fn updateTelemetry(handle: ?*RuntimeHandle, _options_json: []const u8) i32 {
    // TODO(codex, zig-rt-03): Apply telemetry configuration by bridging to Temporal core telemetry APIs.
    _ = handle;
    _ = _options_json;
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: runtime telemetry updates are not implemented yet",
    });
    return -1;
}

pub fn setLogger(handle: ?*RuntimeHandle, _callback_ptr: ?*anyopaque) i32 {
    // TODO(codex, zig-rt-04): Forward Temporal core log events through the provided Bun callback.
    _ = handle;
    _ = _callback_ptr;
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: runtime logger installation is not implemented yet",
    });
    return -1;
}

test "create stores Temporal core runtime pointer when runtime_new succeeds" {
    const testing = std.testing;
    resetCoreApiOverrides();
    defer resetCoreApiOverrides();
    errors.setLastError(""[0..0]);

    const Stubs = struct {
        var runtime_new_calls: usize = 0;
        var runtime_free_calls: usize = 0;
        var byte_array_free_calls: usize = 0;
        var last_options_ptr: usize = 0;
        var runtime_storage: DummyRuntime = .{};

        fn runtimePointer() *core.Runtime {
            return @as(*core.Runtime, @ptrCast(&runtime_storage));
        }

        fn runtimeNew(options: [*c]const core.RuntimeOptions) callconv(.c) core.RuntimeOrFail {
            runtime_new_calls += 1;
            last_options_ptr = @intFromPtr(options);
            return .{
                .runtime = runtimePointer(),
                .fail = null,
            };
        }

        fn runtimeFree(runtime: ?*core.Runtime) callconv(.c) void {
            _ = runtime;
            runtime_free_calls += 1;
        }

        fn runtimeByteArrayFree(runtime: ?*core.Runtime, bytes: ?*const core.ByteArray) callconv(.c) void {
            _ = runtime;
            _ = bytes;
            byte_array_free_calls += 1;
        }
    };

    runtime_new_impl = Stubs.runtimeNew;
    runtime_free_impl = Stubs.runtimeFree;
    runtime_byte_array_free_impl = Stubs.runtimeByteArrayFree;

    const payload = "{\"namespace\":\"default\"}"[0..];
    const handle_opt = create(payload);
    try testing.expect(handle_opt != null);
    const handle = handle_opt.?;
    defer destroy(handle);

    try testing.expectEqual(@as(usize, 1), Stubs.runtime_new_calls);
    try testing.expectEqual(@as(usize, 0), Stubs.runtime_free_calls);
    try testing.expectEqual(@as(usize, 0), Stubs.byte_array_free_calls);
    try testing.expect(Stubs.last_options_ptr != 0);
    try testing.expect(handle.core_runtime != null);
    try testing.expectEqual(@intFromPtr(Stubs.runtimePointer()), @intFromPtr(handle.core_runtime.?));
    try testing.expectEqualStrings("", errors.snapshot());
}

test "create surfaces Temporal core runtime failure and frees resources" {
    const testing = std.testing;
    resetCoreApiOverrides();
    defer resetCoreApiOverrides();
    errors.setLastError(""[0..0]);

    const fail_message = "core runtime exploded"[0..];
    var fail_array = core.ByteArray{
        .data = fail_message.ptr,
        .size = fail_message.len,
        .cap = fail_message.len,
        .disable_free = false,
    };

    const Stubs = struct {
        var runtime_new_calls: usize = 0;
        var runtime_free_calls: usize = 0;
        var byte_array_free_calls: usize = 0;
        var last_runtime_free_ptr: ?*core.Runtime = null;
        var last_byte_array_free_runtime: ?*core.Runtime = null;
        var last_byte_array_free_ptr: ?*const core.ByteArray = null;
        var last_options_ptr: usize = 0;
        var fail_ptr: ?*const core.ByteArray = null;
        var runtime_storage: DummyRuntime = .{};

        fn runtimePointer() *core.Runtime {
            return @as(*core.Runtime, @ptrCast(&runtime_storage));
        }

        fn runtimeNew(options: [*c]const core.RuntimeOptions) callconv(.c) core.RuntimeOrFail {
            runtime_new_calls += 1;
            last_options_ptr = @intFromPtr(options);
            return .{
                .runtime = runtimePointer(),
                .fail = fail_ptr,
            };
        }

        fn runtimeFree(runtime: ?*core.Runtime) callconv(.c) void {
            runtime_free_calls += 1;
            last_runtime_free_ptr = runtime;
        }

        fn runtimeByteArrayFree(runtime: ?*core.Runtime, bytes: ?*const core.ByteArray) callconv(.c) void {
            byte_array_free_calls += 1;
            last_byte_array_free_runtime = runtime;
            last_byte_array_free_ptr = bytes;
        }
    };

    Stubs.fail_ptr = @as(?*const core.ByteArray, @ptrCast(&fail_array));

    runtime_new_impl = Stubs.runtimeNew;
    runtime_free_impl = Stubs.runtimeFree;
    runtime_byte_array_free_impl = Stubs.runtimeByteArrayFree;

    const handle_opt = create("{\"fail\":true}"[0..]);
    try testing.expect(handle_opt == null);

    try testing.expectEqual(@as(usize, 1), Stubs.runtime_new_calls);
    try testing.expectEqual(@as(usize, 1), Stubs.byte_array_free_calls);
    try testing.expectEqual(@as(usize, 1), Stubs.runtime_free_calls);
    try testing.expect(Stubs.last_options_ptr != 0);
    try testing.expect(Stubs.last_byte_array_free_runtime != null);
    try testing.expect(Stubs.last_byte_array_free_ptr != null);
    try testing.expectEqual(@intFromPtr(Stubs.runtimePointer()), @intFromPtr(Stubs.last_byte_array_free_runtime.?));
    try testing.expectEqual(@intFromPtr(Stubs.fail_ptr.?), @intFromPtr(Stubs.last_byte_array_free_ptr.?));
    try testing.expect(Stubs.last_runtime_free_ptr != null);
    try testing.expectEqual(@intFromPtr(Stubs.runtimePointer()), @intFromPtr(Stubs.last_runtime_free_ptr.?));

    const expected_error =
        "{\"code\":13,\"message\":\"core runtime exploded\",\"details\":\"core runtime exploded\"}";
    try testing.expectEqualStrings(expected_error, errors.snapshot());
}

test "beginPendingClientConnect guards against runtime destruction" {
    const testing = std.testing;
    resetCoreApiOverrides();
    defer resetCoreApiOverrides();
    errors.setLastError(""[0..0]);

    const Stubs = struct {
        var runtime_new_calls: usize = 0;
        var runtime_free_calls: usize = 0;
        var runtime_storage: DummyRuntime = .{};

        fn runtimePointer() *core.Runtime {
            return @as(*core.Runtime, @ptrCast(&runtime_storage));
        }

        fn runtimeNew(options: [*c]const core.RuntimeOptions) callconv(.c) core.RuntimeOrFail {
            _ = options;
            runtime_new_calls += 1;
            return .{ .runtime = runtimePointer(), .fail = null };
        }

        fn runtimeFree(runtime: ?*core.Runtime) callconv(.c) void {
            _ = runtime;
            runtime_free_calls += 1;
        }
    };

    runtime_new_impl = Stubs.runtimeNew;
    runtime_free_impl = Stubs.runtimeFree;

    const handle_opt = create("{}"[0..]);
    try testing.expect(handle_opt != null);
    const handle = handle_opt.?;
    defer destroy(handle);

    try testing.expect(beginPendingClientConnect(handle));
    try testing.expectEqual(@as(usize, 1), handle.pending_connects);

    endPendingClientConnect(handle);
    try testing.expectEqual(@as(usize, 0), handle.pending_connects);

    handle.pending_lock.lock();
    handle.destroying = true;
    handle.pending_lock.unlock();

    try testing.expect(!beginPendingClientConnect(handle));
    try testing.expectEqual(@as(usize, 0), handle.pending_connects);

    try testing.expectEqual(@as(usize, 1), Stubs.runtime_new_calls);
    try testing.expectEqual(@as(usize, 0), Stubs.runtime_free_calls);
}

test "destroy waits for pending client connects" {
    const testing = std.testing;
    resetCoreApiOverrides();
    defer resetCoreApiOverrides();
    errors.setLastError(""[0..0]);

    const Stubs = struct {
        var runtime_new_calls: usize = 0;
        var runtime_free_calls: usize = 0;
        var runtime_storage: DummyRuntime = .{};

        fn runtimePointer() *core.Runtime {
            return @as(*core.Runtime, @ptrCast(&runtime_storage));
        }

        fn runtimeNew(options: [*c]const core.RuntimeOptions) callconv(.c) core.RuntimeOrFail {
            _ = options;
            runtime_new_calls += 1;
            return .{ .runtime = runtimePointer(), .fail = null };
        }

        fn runtimeFree(runtime: ?*core.Runtime) callconv(.c) void {
            _ = runtime;
            runtime_free_calls += 1;
        }
    };

    runtime_new_impl = Stubs.runtimeNew;
    runtime_free_impl = Stubs.runtimeFree;

    const handle_opt = create("{}"[0..]);
    try testing.expect(handle_opt != null);
    const handle = handle_opt.?;

    try testing.expect(beginPendingClientConnect(handle));

    const Destroyer = struct {
        fn run(handle_ptr: *RuntimeHandle) void {
            destroy(handle_ptr);
        }
    };

    var thread = try std.Thread.spawn(.{}, Destroyer.run, .{handle});

    std.Thread.sleep(std.time.ns_per_ms * 10);
    try testing.expectEqual(@as(usize, 0), Stubs.runtime_free_calls);

    endPendingClientConnect(handle);

    thread.join();

    try testing.expectEqual(@as(usize, 1), Stubs.runtime_new_calls);
    try testing.expectEqual(@as(usize, 1), Stubs.runtime_free_calls);
}
