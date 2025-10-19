const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");
const builtin = @import("builtin");
const json = std.json;

const grpc = pending.GrpcStatus;
const whitespace = " \t\r\n";
const default_identity_prefix = "temporal-bun-worker";

const WorkerConfigAnalysis = struct {
    identity: []u8,
};

fn trimString(value: []const u8) []const u8 {
    return std.mem.trim(u8, value, whitespace);
}

fn duplicateSlice(slice: []const u8) ?[]u8 {
    if (slice.len == 0) {
        return ""[0..0];
    }
    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, slice.len) catch {
        return null;
    };
    @memcpy(copy, slice);
    return copy;
}

fn analyzeWorkerConfig(config_json: []const u8, worker_id: u64) ?WorkerConfigAnalysis {
    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const parsed = json.parseFromSlice(json.Value, allocator, config_json, .{}) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config must be valid JSON",
            .details = null,
        });
        return null;
    };

    if (parsed.value != .object) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config must be a JSON object",
            .details = null,
        });
        return null;
    }

    var object = parsed.value.object;

    const namespace_ptr = object.getPtr("namespace") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config requires a namespace",
            .details = null,
        });
        return null;
    };

    if (namespace_ptr.* != .string) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: namespace must be a string",
            .details = null,
        });
        return null;
    }

    const namespace = trimString(namespace_ptr.string);
    if (namespace.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: namespace cannot be empty",
            .details = null,
        });
        return null;
    }

    const task_queue_ptr = object.getPtr("taskQueue") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config requires a task queue",
            .details = null,
        });
        return null;
    };

    if (task_queue_ptr.* != .string) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: task queue must be a string",
            .details = null,
        });
        return null;
    }

    const task_queue = trimString(task_queue_ptr.string);
    if (task_queue.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: task queue cannot be empty",
            .details = null,
        });
        return null;
    }

    var identity_prefix_slice: []const u8 = default_identity_prefix;
    if (object.getPtr("identityPrefix")) |prefix_ptr| {
        if (prefix_ptr.* != .string) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: identityPrefix must be a string",
                .details = null,
            });
            return null;
        }
        const trimmed_prefix = trimString(prefix_ptr.string);
        if (trimmed_prefix.len == 0) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: identityPrefix cannot be empty",
                .details = null,
            });
            return null;
        }
        identity_prefix_slice = trimmed_prefix;
    }

    var identity_slice: []const u8 = ""[0..0];
    if (object.getPtr("identity")) |identity_ptr| {
        if (identity_ptr.* != .string) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: identity must be a string",
                .details = null,
            });
            return null;
        }
        const trimmed_identity = trimString(identity_ptr.string);
        if (trimmed_identity.len == 0) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: identity cannot be empty",
                .details = null,
            });
            return null;
        }
        identity_slice = trimmed_identity;
    }

    if (identity_slice.len == 0) {
        identity_slice = std.fmt.allocPrint(allocator, "{s}-{d}", .{ identity_prefix_slice, worker_id }) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.resource_exhausted,
                .message = "temporal-bun-bridge-zig: failed to allocate worker identity",
                .details = null,
            });
            return null;
        };
    }

    const identity_copy = duplicateSlice(identity_slice) orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to copy worker identity",
            .details = null,
        });
        return null;
    };

    return WorkerConfigAnalysis{ .identity = identity_copy };
}

pub const WorkerHandle = struct {
    id: u64,
    runtime: ?*runtime.RuntimeHandle,
    client: ?*client.ClientHandle,
    config: []u8,
    identity: []u8,
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
    if (handle.identity.len > 0) {
        allocator.free(handle.identity);
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
    if (runtime_ptr == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker creation received null runtime handle",
            .details = null,
        });
        return null;
    }

    if (client_ptr == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker creation received null client handle",
            .details = null,
        });
        return null;
    }

    const runtime_handle = runtime_ptr.?;
    const client_handle = client_ptr.?;
    if (client_handle.runtime) |client_runtime| {
        if (client_runtime != runtime_ptr) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: worker client runtime handle mismatch",
                .details = null,
            });
            return null;
        }
    }

    const worker_id = next_worker_id;

    const analysis = analyzeWorkerConfig(config_json, worker_id) orelse {
        return null;
    };

    const config_copy = duplicateConfig(config_json) orelse {
        std.heap.c_allocator.free(analysis.identity);
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker config",
        });
        return null;
    };

    const allocator = std.heap.c_allocator;
    const handle = allocator.create(WorkerHandle) catch |err| {
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        if (analysis.identity.len > 0) {
            allocator.free(analysis.identity);
        }
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(&scratch, "temporal-bun-bridge-zig: failed to allocate worker handle: {}", .{err}) catch
            "temporal-bun-bridge-zig: failed to allocate worker handle";
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = message, .details = null });
        return null;
    };

    handle.* = .{
        .id = worker_id,
        .runtime = runtime_ptr,
        .client = client_ptr,
        .config = config_copy,
        .identity = analysis.identity,
        .core_worker = null,
    };

    const core_worker = core.workerNew(runtime_handle.core_runtime, client_handle.core_client, config_copy);
    if (core_worker == null) {
        releaseHandle(handle);
        errors.setStructuredErrorJson(.{
            .code = grpc.internal,
            .message = "temporal-bun-bridge-zig: Temporal core worker creation failed",
            .details = null,
        });
        return null;
    }

    handle.core_worker = core_worker;
    next_worker_id = worker_id + 1;
    errors.setLastError(""[0..0]);
    return handle;
}

pub fn destroy(handle: ?*WorkerHandle) void {
    if (handle == null) {
        return;
    }

    const worker_handle = handle.?;
    if (worker_handle.core_worker) |core_handle| {
        core.workerFree(core_handle);
    }
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
    if (bytes.data_ptr == null or bytes.len == 0) {
        return ""[0..0];
    }

    return bytes.data_ptr.?[0..bytes.len];
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
        .data_ptr = payload.ptr,
        .len = payload.len,
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
    var fake_client_storage: usize = 0;

    var stub_completion_call_count: usize = 0;
    var stub_byte_array_free_count: usize = 0;
    var last_completion_payload: []const u8 = ""[0..0];
    var last_runtime_byte_array_free_ptr: ?*const core.ByteArray = null;
    var last_runtime_byte_array_free_runtime: ?*core.RuntimeOpaque = null;

    var stub_fail_message: []const u8 = ""[0..0];
    var stub_fail_buffer: core.ByteArray = .{
        .data_ptr = null,
        .len = 0,
        .cap = 0,
        .disable_free = false,
    };

    var stub_worker_new_call_count: usize = 0;
    var stub_worker_free_call_count: usize = 0;
    var stub_worker_should_fail: bool = false;

    fn resetStubs() void {
        stub_completion_call_count = 0;
        stub_byte_array_free_count = 0;
        last_completion_payload = ""[0..0];
        last_runtime_byte_array_free_ptr = null;
        last_runtime_byte_array_free_runtime = null;
        resetWorkerFactory();
    }

    fn resetWorkerFactory() void {
        stub_worker_new_call_count = 0;
        stub_worker_free_call_count = 0;
        stub_worker_should_fail = false;
    }

    fn stubCompletionSlice(ref: core.ByteArrayRef) []const u8 {
        if (ref.data_ptr == null or ref.len == 0) {
            return ""[0..0];
        }
        return ref.data_ptr.?[0..ref.len];
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
        if (@intFromPtr(callback) != 0) {
            callback(user_data, null);
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
            .data_ptr = stub_fail_message.ptr,
            .len = stub_fail_message.len,
            .cap = stub_fail_message.len,
            .disable_free = false,
        };
        if (@intFromPtr(callback) != 0) {
            callback(user_data, &stub_fail_buffer);
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
            .identity = ""[0..0],
            .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&fake_worker_storage)),
        };
    }

    fn fakeClientHandle(rt: *runtime.RuntimeHandle) client.ClientHandle {
        return .{
            .id = 11,
            .runtime = rt,
            .config = @constCast(""[0..0]),
            .core_client = @as(?*core.ClientOpaque, @ptrCast(&fake_client_storage)),
        };
    }

    fn stubWorkerNew(
        runtime_ptr: ?*core.RuntimeOpaque,
        client_ptr: ?*core.ClientOpaque,
        config_ptr: ?[*]const u8,
        len: usize,
    ) callconv(.c) ?*core.WorkerOpaque {
        _ = runtime_ptr;
        _ = client_ptr;
        _ = config_ptr;
        _ = len;
        stub_worker_new_call_count += 1;
        if (stub_worker_should_fail) {
            return null;
        }
        return @as(?*core.WorkerOpaque, @ptrCast(&fake_worker_storage));
    }

    fn stubWorkerFree(handle: ?*core.WorkerOpaque) callconv(.c) void {
        _ = handle;
        stub_worker_free_call_count += 1;
    }
};

test "create returns worker handle for valid config" {
    const original_worker_new = core.worker_new_impl;
    const original_worker_free = core.worker_free_impl;
    defer {
        core.worker_new_impl = original_worker_new;
        core.worker_free_impl = original_worker_free;
    }

    WorkerTests.resetWorkerFactory();
    core.worker_new_impl = WorkerTests.stubWorkerNew;
    core.worker_free_impl = WorkerTests.stubWorkerFree;

    errors.setLastError(""[0..0]);
    next_worker_id = 1;

    var runtime_handle = WorkerTests.fakeRuntimeHandle();
    var client_handle = WorkerTests.fakeClientHandle(&runtime_handle);

    const config = "{\"namespace\":\"default\",\"taskQueue\":\"zig-tests\"}";
    const worker_ptr = create(&runtime_handle, &client_handle, config) orelse {
        try testing.expect(false);
        return;
    };

    const worker_handle = worker_ptr;
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_new_call_count);
    try testing.expectEqual(@as(u64, 1), worker_handle.id);
    try testing.expectEqualSlices(u8, config, worker_handle.config);
    const expected_identity = "temporal-bun-worker-1";
    try testing.expectEqualSlices(u8, expected_identity, worker_handle.identity);
    try testing.expectEqualStrings("", errors.snapshot());

    WorkerTests.stub_worker_free_call_count = 0;
    destroy(worker_ptr);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_free_call_count);
}

test "create fails when namespace missing" {
    const original_worker_new = core.worker_new_impl;
    defer core.worker_new_impl = original_worker_new;

    WorkerTests.resetWorkerFactory();
    core.worker_new_impl = WorkerTests.stubWorkerNew;

    errors.setLastError(""[0..0]);
    next_worker_id = 1;

    var runtime_handle = WorkerTests.fakeRuntimeHandle();
    var client_handle = WorkerTests.fakeClientHandle(&runtime_handle);

    const config = "{\"taskQueue\":\"zig-tests\"}";
    const worker_ptr = create(&runtime_handle, &client_handle, config);
    try testing.expect(worker_ptr == null);
    const expected_error =
        "{\"code\":3,\"message\":\"temporal-bun-bridge-zig: worker config requires a namespace\"}";
    try testing.expectEqualStrings(expected_error, errors.snapshot());
    try testing.expectEqual(@as(usize, 0), WorkerTests.stub_worker_new_call_count);
}

test "destroy frees core worker handle" {
    const original_worker_new = core.worker_new_impl;
    const original_worker_free = core.worker_free_impl;
    defer {
        core.worker_new_impl = original_worker_new;
        core.worker_free_impl = original_worker_free;
    }

    WorkerTests.resetWorkerFactory();
    core.worker_new_impl = WorkerTests.stubWorkerNew;
    core.worker_free_impl = WorkerTests.stubWorkerFree;

    errors.setLastError(""[0..0]);
    next_worker_id = 1;

    var runtime_handle = WorkerTests.fakeRuntimeHandle();
    var client_handle = WorkerTests.fakeClientHandle(&runtime_handle);

    const config = "{\"namespace\":\"default\",\"taskQueue\":\"zig-tests\"}";
    const worker_ptr = create(&runtime_handle, &client_handle, config) orelse {
        try testing.expect(false);
        return;
    };

    WorkerTests.stub_worker_free_call_count = 0;
    destroy(worker_ptr);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_free_call_count);
}

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
        try testing.expectEqual(@as(usize, WorkerTests.stub_fail_message.len), ptr.len);
    }
}
