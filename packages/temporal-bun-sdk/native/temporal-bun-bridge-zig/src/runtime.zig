const std = @import("std");
const errors = @import("errors.zig");
const core = @import("core.zig");
const pending = @import("pending.zig");

const grpc = pending.GrpcStatus;

/// Placeholder handle that mirrors the pointer-based interface exposed by the Rust bridge.
pub const RuntimeHandle = struct {
    id: u64,
    /// Raw JSON payload passed from TypeScript; retained until the Rust runtime wiring is complete.
    config: []u8,
    core_runtime: ?*core.Runtime,
};

var next_runtime_id: u64 = 1;

pub fn create(options_json: []const u8) ?*RuntimeHandle {
    var allocator = std.heap.c_allocator;

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
    };

    // TODO(codex, zig-rt-01): Initialize the Temporal core runtime through the Rust C-ABI
    // (`temporal_sdk_core_runtime_new`) and store the opaque pointer on the handle.

    return handle;
}

pub fn destroy(handle: ?*RuntimeHandle) void {
    if (handle == null) {
        return;
    }

    var allocator = std.heap.c_allocator;
    const runtime = handle.?;

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
