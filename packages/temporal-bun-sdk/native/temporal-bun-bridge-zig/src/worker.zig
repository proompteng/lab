const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");
const builtin = @import("builtin");

const grpc = pending.GrpcStatus;

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
    const copy = allocator.alloc(u8, config_json.len) catch {
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

fn pendingByteArrayError(code: i32, message: []const u8) ?*pending.PendingByteArray {
    errors.setStructuredError(.{ .code = code, .message = message });
    const handle = pending.createPendingError(code, message) orelse {
        errors.setStructuredError(.{
            .code = grpc.internal,
            .message = "temporal-bun-bridge-zig: failed to allocate pending worker handle",
        });
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
    const config_copy = duplicateConfig(config_json) orelse {
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker config",
        });
        return null;
    };
    defer {
        if (config_copy.len > 0) {
            std.heap.c_allocator.free(config_copy);
        }
    }
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: worker creation is not implemented yet",
    });
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
    return pendingByteArrayError(grpc.unimplemented, "temporal-bun-bridge-zig: pollWorkflowTask is not implemented yet");
}

const CompletionState = struct {
    wait_group: std.Thread.WaitGroup = .{},
    fail_ptr: ?*const core.ByteArray = null,
};

fn workflowCompletionCallback(user_data: ?*anyopaque, fail_ptr: ?*const core.ByteArray) callconv(.c) void {
    if (user_data == null) {
        return;
    }

    const state_ptr = @as(*CompletionState, @ptrCast(@alignCast(user_data.?)));
    state_ptr.fail_ptr = fail_ptr;
    state_ptr.wait_group.finish();
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

pub fn completeWorkflowTask(handle: ?*WorkerHandle, payload: []const u8) i32 {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: completeWorkflowTask received null worker handle",
            .details = null,
        });
        return -1;
    }

    const worker_handle = handle.?;

    if (worker_handle.core_worker == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: worker core handle is not initialized",
            .details = null,
        });
        return -1;
    }

    if (worker_handle.runtime == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: worker runtime handle is not initialized",
            .details = null,
        });
        return -1;
    }

    const runtime_handle = worker_handle.runtime.?;

    if (runtime_handle.core_runtime == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: worker runtime core handle is not initialized",
            .details = null,
        });
        return -1;
    }

    if (payload.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: completeWorkflowTask requires a workflow completion payload",
            .details = null,
        });
        return -1;
    }

    var state = CompletionState{};
    defer state.wait_group.reset();
    state.wait_group.start();

    const completion = core.ByteArrayRef{
        .data = payload.ptr,
        .size = payload.len,
    };

    core.workerCompleteWorkflowActivation(
        worker_handle.core_worker,
        completion,
        @as(?*anyopaque, @ptrCast(&state)),
        workflowCompletionCallback,
    );

    state.wait_group.wait();

    if (state.fail_ptr) |fail| {
        const message = byteArraySlice(fail);
        const description = if (message.len > 0)
            message
        else
            "temporal-bun-bridge-zig: workflow completion failed with an unknown error";
        errors.setStructuredErrorJson(.{
            .code = grpc.internal,
            .message = description,
            .details = null,
        });

        core.runtimeByteArrayFree(runtime_handle.core_runtime, fail);
        return -1;
    }

    errors.setLastError(""[0..0]);
    return 0;
}

pub fn pollActivityTask(_handle: ?*WorkerHandle) ?*pending.PendingByteArray {
    // TODO(codex, zig-worker-05): Poll activity tasks via Temporal core worker APIs.
    _ = _handle;
    return pendingByteArrayError(grpc.unimplemented, "temporal-bun-bridge-zig: pollActivityTask is not implemented yet");
}

pub fn completeActivityTask(_handle: ?*WorkerHandle, _payload: []const u8) i32 {
    // TODO(codex, zig-worker-06): Complete activity tasks and propagate results to Temporal core.
    _ = _handle;
    _ = _payload;
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: completeActivityTask is not implemented yet",
    });
    return -1;
}

pub fn recordActivityHeartbeat(_handle: ?*WorkerHandle, _payload: []const u8) i32 {
    // TODO(codex, zig-worker-07): Stream activity heartbeats to Temporal core.
    _ = _handle;
    _ = _payload;
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: recordActivityHeartbeat is not implemented yet",
    });
    return -1;
}

pub fn initiateShutdown(_handle: ?*WorkerHandle) i32 {
    // TODO(codex, zig-worker-08): Initiate graceful worker shutdown (no new polls).
    _ = _handle;
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: initiateShutdown is not implemented yet",
    });
    return -1;
}

pub fn finalizeShutdown(_handle: ?*WorkerHandle) i32 {
    // TODO(codex, zig-worker-09): Await inflight tasks and finalize worker shutdown.
    _ = _handle;
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: finalizeShutdown is not implemented yet",
    });
    return -1;
}

const testing = std.testing;

const WorkerTests = struct {
    var fake_runtime_storage: usize = 0;
    var fake_worker_storage: usize = 0;

    var stub_completion_call_count: usize = 0;
    var stub_byte_array_free_count: usize = 0;
    var last_completion_payload: []const u8 = ""[0..0];
    var last_runtime_byte_array_free_ptr: ?*const core.ByteArray = null;
    var last_runtime_byte_array_free_runtime: ?*core.RuntimeOpaque = null;

    var stub_fail_message: []const u8 = ""[0..0];
    var stub_fail_buffer: core.ByteArray = .{
        .data = null,
        .size = 0,
        .cap = 0,
        .disable_free = false,
    };

    fn resetStubs() void {
        stub_completion_call_count = 0;
        stub_byte_array_free_count = 0;
        last_completion_payload = ""[0..0];
        last_runtime_byte_array_free_ptr = null;
        last_runtime_byte_array_free_runtime = null;
    }

    fn stubCompletionSlice(ref: core.ByteArrayRef) []const u8 {
        if (ref.data == null or ref.size == 0) {
            return ""[0..0];
        }
        return ref.data[0..ref.size];
    }

    fn stubCompleteSuccess(
        worker_ptr: ?*core.WorkerOpaque,
        completion: core.ByteArrayRef,
        user_data: ?*anyopaque,
        callback: core.WorkerCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_completion_call_count += 1;
        last_completion_payload = stubCompletionSlice(completion);
        if (callback) |cb| {
            cb(user_data, null);
        }
    }

    fn stubCompleteFailure(
        worker_ptr: ?*core.WorkerOpaque,
        completion: core.ByteArrayRef,
        user_data: ?*anyopaque,
        callback: core.WorkerCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_completion_call_count += 1;
        last_completion_payload = stubCompletionSlice(completion);
        stub_fail_buffer = .{
            .data = stub_fail_message.ptr,
            .size = stub_fail_message.len,
            .cap = stub_fail_message.len,
            .disable_free = false,
        };
        if (callback) |cb| {
            cb(user_data, &stub_fail_buffer);
        }
    }

    fn stubRuntimeByteArrayFree(
        runtime_ptr: ?*core.RuntimeOpaque,
        bytes: ?*const core.ByteArray,
    ) callconv(.c) void {
        stub_byte_array_free_count += 1;
        last_runtime_byte_array_free_runtime = runtime_ptr;
        last_runtime_byte_array_free_ptr = bytes;
    }

    fn fakeRuntimeHandle() runtime.RuntimeHandle {
        return .{
            .id = 7,
            .config = ""[0..0],
            .core_runtime = @as(?*core.RuntimeOpaque, @ptrCast(&fake_runtime_storage)),
        };
    }

    fn fakeWorkerHandle(rt: *runtime.RuntimeHandle) WorkerHandle {
        return .{
            .id = 9,
            .runtime = rt,
            .client = null,
            .config = ""[0..0],
            .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&fake_worker_storage)),
        };
    }
};

test "completeWorkflowTask returns 0 on successful completion" {
    const original_complete = core.worker_complete_workflow_activation;
    const original_free = core.runtime_byte_array_free;
    defer {
        core.worker_complete_workflow_activation = original_complete;
        core.runtime_byte_array_free = original_free;
    }

    core.worker_complete_workflow_activation = WorkerTests.stubCompleteSuccess;
    core.runtime_byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    const payload = "respond-workflow-task";
    const rc = completeWorkflowTask(&worker_handle, payload);

    try testing.expectEqual(@as(i32, 0), rc);
    try testing.expectEqualStrings(payload, WorkerTests.last_completion_payload);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_completion_call_count);
    try testing.expectEqual(@as(usize, 0), WorkerTests.stub_byte_array_free_count);
    try testing.expectEqualStrings("", errors.snapshot());
}

test "completeWorkflowTask surfaces core error payload" {
    const original_complete = core.worker_complete_workflow_activation;
    const original_free = core.runtime_byte_array_free;
    defer {
        core.worker_complete_workflow_activation = original_complete;
        core.runtime_byte_array_free = original_free;
    }

    core.worker_complete_workflow_activation = WorkerTests.stubCompleteFailure;
    core.runtime_byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    WorkerTests.stub_fail_message = "Workflow completion failure: MalformedWorkflowCompletion";

    const payload = "fail-workflow-task";
    const rc = completeWorkflowTask(&worker_handle, payload);

    try testing.expectEqual(@as(i32, -1), rc);
    try testing.expectEqualStrings(payload, WorkerTests.last_completion_payload);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_completion_call_count);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_byte_array_free_count);
    const expected_json = "{\"code\":13,\"message\":\"Workflow completion failure: MalformedWorkflowCompletion\"}";
    try testing.expectEqualStrings(expected_json, errors.snapshot());
    try testing.expectEqual(@as(?*core.RuntimeOpaque, @ptrCast(&WorkerTests.fake_runtime_storage)), WorkerTests.last_runtime_byte_array_free_runtime);
    try testing.expect(WorkerTests.last_runtime_byte_array_free_ptr != null);
    if (WorkerTests.last_runtime_byte_array_free_ptr) |ptr| {
        try testing.expectEqual(@as(usize, WorkerTests.stub_fail_message.len), ptr.size);
    }
}
