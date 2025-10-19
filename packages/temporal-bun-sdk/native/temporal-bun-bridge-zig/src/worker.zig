const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");

const ascii = std.ascii;
const base64 = std.base64;
const json = std.json;

const empty_bytes = [_]u8{};
const empty_slice = empty_bytes[0..0];

const ActivityCompletionPayload = struct {
    taskToken: []const u8,
    status: []const u8,
    result: ?[]const u8 = null,
    failure: ?[]const u8 = null,
};

const Buffer = struct {
    bytes: []const u8,
    alloc: ?[]u8,
};

fn freeBuffer(buffer: Buffer) void {
    if (buffer.alloc) |slice| {
        if (slice.len > 0) {
            std.heap.c_allocator.free(slice);
        }
    }
}

fn decodeBase64Internal(field_name: []const u8, encoded: []const u8) ?Buffer {
    const decoder = base64.standard.Decoder;
    const size = decoder.calcSizeForSlice(encoded) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: invalid base64 in {s}: {}", .{ field_name, err });
        return null;
    };

    if (size == 0) {
        return Buffer{
            .bytes = empty_slice,
            .alloc = null,
        };
    }

    var allocator = std.heap.c_allocator;
    const out = allocator.alloc(u8, size) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate buffer for {s}: {}", .{ field_name, err });
        return null;
    };

    decoder.decode(out[0..size], encoded) catch |err| {
        allocator.free(out);
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to decode {s}: {}", .{ field_name, err });
        return null;
    };

    return Buffer{
        .bytes = out[0..size],
        .alloc = out,
    };
}

fn decodeRequiredBase64(field_name: []const u8, encoded: []const u8) ?Buffer {
    if (encoded.len == 0) {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: missing {s} in activity completion payload", .{ field_name });
        return null;
    }
    return decodeBase64Internal(field_name, encoded);
}

fn decodeOptionalBase64(field_name: []const u8, encoded_opt: ?[]const u8) ?Buffer {
    if (encoded_opt) |encoded| {
        if (encoded.len == 0) {
            return Buffer{
                .bytes = empty_slice,
                .alloc = null,
            };
        }
        return decodeBase64Internal(field_name, encoded);
    }
    return Buffer{
        .bytes = empty_slice,
        .alloc = null,
    };
}

pub const WorkerHandle = struct {
    id: u64,
    runtime: ?*runtime.RuntimeHandle,
    client: ?*client.ClientHandle,
    config: []u8,
    core_worker: ?*core.WorkerOpaque,
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

pub fn completeActivityTask(handle: ?*WorkerHandle, payload: []const u8) i32 {
    if (handle == null) {
        errors.setLastError("temporal-bun-bridge-zig: completeActivityTask received null worker handle");
        return -1;
    }

    const worker_handle = handle.?;

    const core_worker_ptr = worker_handle.core_worker orelse {
        errors.setLastError("temporal-bun-bridge-zig: worker missing Temporal core worker handle");
        return -1;
    };

    if (payload.len == 0) {
        errors.setLastError("temporal-bun-bridge-zig: completeActivityTask received empty payload");
        return -1;
    }

    var parsed = json.parseFromSlice(ActivityCompletionPayload, std.heap.c_allocator, payload, .{}) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: invalid activity completion payload: {}", .{ err });
        return -1;
    };
    defer parsed.deinit();

    const data = parsed.value;

    const task_token = decodeRequiredBase64("taskToken", data.taskToken) orelse return -1;
    defer freeBuffer(task_token);

    if (data.status.len == 0) {
        errors.setLastError("temporal-bun-bridge-zig: activity completion payload missing status");
        return -1;
    }

    if (ascii.eqlIgnoreCase(data.status, "completed")) {
        const result_payload = decodeOptionalBase64("result", data.result) orelse return -1;
        defer freeBuffer(result_payload);

        const token_buf = core.byteBufFromSlice(task_token.bytes);
        const result_buf = if (result_payload.bytes.len == 0)
            core.emptyByteBuf()
        else
            core.byteBufFromSlice(result_payload.bytes);

        return core.api.worker_respond_activity_task_completed(
            core_worker_ptr,
            token_buf,
            result_buf,
        );
    } else if (ascii.eqlIgnoreCase(data.status, "failed")) {
        const failure_payload = decodeOptionalBase64("failure", data.failure) orelse return -1;
        defer freeBuffer(failure_payload);

        if (failure_payload.bytes.len == 0) {
            errors.setLastError("temporal-bun-bridge-zig: failure payload missing for failed activity completion");
            return -1;
        }

        const token_buf = core.byteBufFromSlice(task_token.bytes);
        const failure_buf = core.byteBufFromSlice(failure_payload.bytes);

        return core.api.worker_respond_activity_task_failed(
            core_worker_ptr,
            token_buf,
            failure_buf,
        );
    }

    errors.setLastError("temporal-bun-bridge-zig: unsupported activity completion status");
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
