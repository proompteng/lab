const std = @import("std");
const errors = @import("errors.zig");
const core = @import("core.zig");
const pending = @import("pending.zig");

const grpc = pending.GrpcStatus;

const allocator = std.heap.c_allocator;

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

    handle.* = .{
        .id = id,
        .config = copy,
        .core_runtime = null,
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    // TODO(codex, zig-rt-01): Initialize the Temporal core runtime through the Rust C-ABI
    // (`temporal_sdk_core_runtime_new`) and store the opaque pointer on the handle.

    return handle;
}

pub fn destroy(handle: ?*RuntimeHandle) void {
    if (handle == null) {
        return;
    }

    const runtime = handle.?;

    runtime.pending_lock.lock();
    runtime.destroying = true;
    runtime.pending_condition.broadcast();
    runtime.pending_lock.unlock();

    // TODO(codex, zig-rt-02): Call into the Temporal core to drop the runtime (`runtime.free`).
    if (runtime.core_runtime) |_| {
        // The Zig bridge does not yet link against Temporal core; release will be wired in zig-rt-02.
    }

    if (runtime.config.len > 0) {
        allocator.free(runtime.config);
    }

    allocator.destroy(runtime);
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
    // TODO(codex, zig-rt-04): Forward Temporal core log events through the provided Bun callback.
    _ = handle;
    _ = _callback_ptr;
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: runtime logger installation is not implemented yet",
    });
    return -1;
}
