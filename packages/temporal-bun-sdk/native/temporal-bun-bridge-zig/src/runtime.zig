const std = @import("std");
const errors = @import("errors.zig");
const core = @import("core.zig");
const pending = @import("pending.zig");

const grpc = pending.GrpcStatus;

const allocator = std.heap.c_allocator;

const runtime_error_message = "temporal-bun-bridge-zig: runtime initialization failed";

const fallback_error_array = core.ByteArray{
    .data = runtime_error_message.ptr,
    .size = runtime_error_message.len,
    .cap = runtime_error_message.len,
    .disable_free = true,
};

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

/// Placeholder handle that mirrors the pointer-based interface exposed by the Rust bridge.
pub const RuntimeHandle = struct {
    id: u64,
    /// Raw JSON payload passed from TypeScript; retained until the Rust runtime wiring is complete.
    config: []u8,
    core_runtime: ?*core.RuntimeOpaque,
    pending_lock: std.Thread.Mutex = .{},
    pending_condition: std.Thread.Condition = .{},
    pending_connects: usize = 0,
    destroying: bool = false,
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

    core.ensureExternalApiInstalled();

    var runtime_options = std.mem.zeroes(core.RuntimeOptions);
    const created = core.api.runtime_new(&runtime_options);
    if (created.runtime == null) {
        const message_slice = byteArraySlice(created.fail orelse &fallback_error_array);
        const message = if (message_slice.len > 0)
            message_slice
        else
            "temporal-bun-bridge-zig: failed to create Temporal runtime";

        errors.setStructuredError(.{ .code = grpc.internal, .message = message });
        if (created.fail) |fail_ptr| {
            core.api.byte_array_free(null, fail_ptr);
        }
        allocator.free(copy);
        allocator.destroy(handle);
        return null;
    }

    handle.* = .{
        .id = id,
        .config = copy,
        .core_runtime = created.runtime,
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    if (created.fail) |fail_ptr| {
        core.api.byte_array_free(handle.core_runtime, fail_ptr);
    }

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
        core.api.runtime_free(core_runtime_ptr);
    }

    if (runtime.config.len > 0) {
        allocator.free(runtime.config);
    }

    allocator.destroy(runtime);
}

pub fn updateTelemetry(handle: ?*RuntimeHandle, _options_json: []const u8) i32 {
    _ = handle;
    _ = _options_json;
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: runtime telemetry updates are not implemented yet",
    });
    return -1;
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

    if (handle.pending_connects > 0) {
        handle.pending_connects -= 1;
    }

    if (handle.destroying and handle.pending_connects == 0) {
        handle.pending_condition.broadcast();
    }
}

pub fn setLogger(handle: ?*RuntimeHandle, _callback_ptr: ?*anyopaque) i32 {
    _ = handle;
    _ = _callback_ptr;
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: runtime logger installation is not implemented yet",
    });
    return -1;
}
