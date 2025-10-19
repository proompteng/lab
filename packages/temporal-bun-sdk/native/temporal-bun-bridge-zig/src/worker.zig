const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const pending = @import("pending.zig");

pub const WorkerHandle = struct {
    id: u64,
    runtime: ?*runtime.RuntimeHandle,
    client: ?*client.ClientHandle,
    config: []u8,
};

var next_worker_id: u64 = 1;

fn duplicateConfig(config_json: []const u8) ?[]u8 {
    if (config_json.len == 0) {
        return ""[0..0];
    }

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, config_json.len) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate worker config: {}", .{err});
        return null;
    };
    @memcpy(copy, config_json);
    return copy;
}

fn releaseHandle(handle: *WorkerHandle) void {
    var allocator = std.heap.c_allocator;
    if (handle.config.len > 0) {
        allocator.free(handle.config);
    }
    allocator.destroy(handle);
}

fn pendingByteArrayError(message: []const u8) ?*pending.PendingByteArray {
    errors.setLastError(message);
    const handle = pending.createPendingError(message) orelse {
        errors.setLastError("temporal-bun-bridge-zig: failed to allocate pending worker handle");
        return null;
    };
    return @as(?*pending.PendingByteArray, handle);
}

pub fn create(
    runtime_ptr: ?*runtime.RuntimeHandle,
    client_ptr: ?*client.ClientHandle,
    config_json: []const u8,
) ?*WorkerHandle {
    // TODO(codex, zig-worker-01): Instantiate Temporal core worker via C-ABI and persist opaque handle.
    _ = runtime_ptr;
    _ = client_ptr;
    const config_copy = duplicateConfig(config_json) orelse return null;
    defer {
        if (config_copy.len > 0) {
            std.heap.c_allocator.free(config_copy);
        }
    }
    errors.setLastError("temporal-bun-bridge-zig: worker creation is not implemented yet");
    return null;
}

pub fn destroy(handle: ?*WorkerHandle) void {
    if (handle == null) {
        return;
    }

    // TODO(codex, zig-worker-02): Shut down core worker and free associated resources.
    const worker_handle = handle.?;
    releaseHandle(worker_handle);
}

pub fn pollWorkflowTask(_handle: ?*WorkerHandle) ?*pending.PendingByteArray {
    // TODO(codex, zig-worker-03): Poll workflow tasks and forward activations through pending handles.
    _ = _handle;
    return pendingByteArrayError("temporal-bun-bridge-zig: pollWorkflowTask is not implemented yet");
}

pub fn completeWorkflowTask(_handle: ?*WorkerHandle, _payload: []const u8) i32 {
    // TODO(codex, zig-worker-04): Complete workflow tasks through Temporal core worker client.
    _ = _handle;
    _ = _payload;
    errors.setLastError("temporal-bun-bridge-zig: completeWorkflowTask is not implemented yet");
    return -1;
}

pub fn pollActivityTask(_handle: ?*WorkerHandle) ?*pending.PendingByteArray {
    // TODO(codex, zig-worker-05): Poll activity tasks via Temporal core worker APIs.
    _ = _handle;
    return pendingByteArrayError("temporal-bun-bridge-zig: pollActivityTask is not implemented yet");
}

pub fn completeActivityTask(_handle: ?*WorkerHandle, _payload: []const u8) i32 {
    // TODO(codex, zig-worker-06): Complete activity tasks and propagate results to Temporal core.
    _ = _handle;
    _ = _payload;
    errors.setLastError("temporal-bun-bridge-zig: completeActivityTask is not implemented yet");
    return -1;
}

pub fn recordActivityHeartbeat(_handle: ?*WorkerHandle, _payload: []const u8) i32 {
    // TODO(codex, zig-worker-07): Stream activity heartbeats to Temporal core.
    _ = _handle;
    _ = _payload;
    errors.setLastError("temporal-bun-bridge-zig: recordActivityHeartbeat is not implemented yet");
    return -1;
}

pub fn initiateShutdown(_handle: ?*WorkerHandle) i32 {
    // TODO(codex, zig-worker-08): Initiate graceful worker shutdown (no new polls).
    _ = _handle;
    errors.setLastError("temporal-bun-bridge-zig: initiateShutdown is not implemented yet");
    return -1;
}

pub fn finalizeShutdown(_handle: ?*WorkerHandle) i32 {
    // TODO(codex, zig-worker-09): Await inflight tasks and finalize worker shutdown.
    _ = _handle;
    errors.setLastError("temporal-bun-bridge-zig: finalizeShutdown is not implemented yet");
    return -1;
}
