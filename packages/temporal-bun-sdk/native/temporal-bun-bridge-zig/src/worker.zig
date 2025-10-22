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

pub var next_worker_id: u64 = 1;

pub fn duplicateConfig(config_json: []const u8) ?[]u8 {
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

pub fn releaseHandle(handle: *WorkerHandle) void {
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
    if (runtime_ptr == null) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: runtime handle is required for worker creation",
        });
        return null;
    }

    if (client_ptr == null) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: client handle is required for worker creation",
        });
        return null;
    }

    const runtime_handle = runtime_ptr.?;
    const client_handle = client_ptr.?;

    if (runtime_handle.core_runtime == null) {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime core handle is not initialized",
        });
        return null;
    }

    if (client_handle.core_client == null) {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: client core handle is not initialized",
        });
        return null;
    }

    // Parse worker configuration from JSON
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

    // Parse JSON configuration to extract worker options
    const parsed_config = std.json.parseFromSlice(std.json.Value, std.heap.c_allocator, config_copy, .{}) catch |err| {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = std.fmt.allocPrint(std.heap.c_allocator, "temporal-bun-bridge-zig: failed to parse worker config JSON: {s}", .{@errorName(err)}) catch "temporal-bun-bridge-zig: failed to parse worker config JSON",
        });
        return null;
    };
    defer parsed_config.deinit();

    // Extract required fields from config
    const namespace_str = parsed_config.value.object.get("namespace") orelse parsed_config.value.object.get("namespace_") orelse {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config must include 'namespace' field",
        });
        return null;
    };

    const task_queue_str = parsed_config.value.object.get("taskQueue") orelse parsed_config.value.object.get("task_queue") orelse {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config must include 'taskQueue' field",
        });
        return null;
    };

    if (namespace_str != .string or task_queue_str != .string) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: namespace and taskQueue must be strings",
        });
        return null;
    }

    // Create worker options structure
    const namespace_bytes = namespace_str.string;
    const task_queue_bytes = task_queue_str.string;

    // Create worker options with minimal configuration
    var worker_options = std.mem.zeroes(core.WorkerOptions);

    // Set required fields
    worker_options.namespace_ = core.ByteArrayRef{
        .data = namespace_bytes.ptr,
        .size = namespace_bytes.len,
    };
    worker_options.task_queue = core.ByteArrayRef{
        .data = task_queue_bytes.ptr,
        .size = task_queue_bytes.len,
    };

    // Set versioning strategy to None (tag = 0)
    worker_options.versioning_strategy.tag = 0;

    // Set reasonable defaults
    worker_options.max_cached_workflows = 1000;
    worker_options.no_remote_activities = false;
    worker_options.sticky_queue_schedule_to_start_timeout_millis = 10000;
    worker_options.max_heartbeat_throttle_interval_millis = 60000;
    worker_options.default_heartbeat_throttle_interval_millis = 30000;
    worker_options.max_activities_per_second = 100000.0;
    worker_options.max_task_queue_activities_per_second = 100000.0;
    worker_options.graceful_shutdown_period_millis = 30000;
    worker_options.nonsticky_to_sticky_poll_ratio = 0.2;
    worker_options.nondeterminism_as_workflow_fail = false;

    // Ensure external API is installed
    core.ensureExternalApiInstalled();

    // Create the Temporal core worker
    const worker_result = core.api.worker_new(client_handle.core_client, &worker_options);

    if (worker_result.fail) |fail| {
        const error_message = if (fail.*.data != null and fail.*.size > 0)
            fail.*.data[0..fail.*.size]
        else
            "temporal-bun-bridge-zig: failed to create worker";

        errors.setStructuredError(.{
            .code = grpc.internal,
            .message = error_message,
        });

        // Free the error payload
        core.api.byte_array_free(runtime_handle.core_runtime, fail);
        return null;
    }

    if (worker_result.worker == null) {
        errors.setStructuredError(.{
            .code = grpc.internal,
            .message = "temporal-bun-bridge-zig: worker creation returned null without error",
        });
        return null;
    }

    // Create worker handle
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(WorkerHandle) catch {
        // Clean up the core worker
        core.api.worker_free(worker_result.worker);
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker handle",
        });
        return null;
    };

    worker_handle.* = WorkerHandle{
        .id = next_worker_id,
        .runtime = runtime_handle,
        .client = client_handle,
        .config = duplicateConfig(config_json) orelse ""[0..0],
        .core_worker = worker_result.worker,
    };

    next_worker_id += 1;
    errors.setLastError(""[0..0]);
    return worker_handle;
}

pub fn destroy(handle: ?*WorkerHandle) void {
    if (handle == null) {
        return;
    }

    const worker_handle = handle.?;

    // Shut down core worker if it exists
    if (worker_handle.core_worker) |core_worker| {
        core.ensureExternalApiInstalled();
        core.api.worker_free(core_worker);
    }

    // Release the handle and associated resources
    releaseHandle(worker_handle);
}

pub fn pollWorkflowTask(handle: ?*WorkerHandle) ?*pending.PendingByteArray {
    if (handle == null) {
        return pendingByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: worker handle is null");
    }

    const worker_handle = handle.?;

    if (worker_handle.core_worker == null) {
        return pendingByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: core worker is null");
    }

    // Create a pending handle for the async operation
    const pending_handle = pending.createPendingByteArray() orelse {
        return pendingByteArrayError(grpc.internal, "temporal-bun-bridge-zig: failed to allocate pending handle");
    };

    // Set up completion callback
    var completion_state = CompletionState{};
    completion_state.wait_group.start();

    // Store the completion state in the pending handle
    pending_handle.user_data = @as(?*anyopaque, @ptrCast(&completion_state));
    pending_handle.completion_callback = workflowCompletionCallback;

    // Poll workflow activation from core worker
    core.ensureExternalApiInstalled();
    core.api.worker_poll_workflow_activation(
        worker_handle.core_worker,
        @as(?*anyopaque, @ptrCast(pending_handle)),
        workflowPollCallback,
    );

    return pending_handle;
}

pub const CompletionState = struct {
    wait_group: std.Thread.WaitGroup = .{},
    fail_ptr: ?*const core.ByteArray = null,
};

pub fn workflowCompletionCallback(user_data: ?*anyopaque, fail_ptr: ?*const core.ByteArray) callconv(.c) void {
    if (user_data == null) {
        return;
    }

    const state_ptr = @as(*CompletionState, @ptrCast(@alignCast(user_data.?)));
    state_ptr.fail_ptr = fail_ptr;
    state_ptr.wait_group.finish();
}

pub fn workflowPollCallback(user_data: ?*anyopaque, _success: ?*const core.ByteArray, fail: ?*const core.ByteArray) callconv(.c) void {
    _ = _success;
    if (user_data == null) {
        return;
    }

    const state_ptr = @as(*CompletionState, @ptrCast(@alignCast(user_data.?)));
    state_ptr.fail_ptr = fail;
    state_ptr.wait_group.finish();
}

pub fn byteArraySlice(bytes_ptr: ?*const core.ByteArray) []const u8 {
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

pub fn pollActivityTask(handle: ?*WorkerHandle) ?*pending.PendingByteArray {
    if (handle == null) {
        return pendingByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: worker handle is null");
    }

    const worker_handle = handle.?;

    if (worker_handle.core_worker == null) {
        return pendingByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: core worker is null");
    }

    // Create a pending handle for the async operation
    const pending_handle = pending.createPendingByteArray() orelse {
        return pendingByteArrayError(grpc.internal, "temporal-bun-bridge-zig: failed to allocate pending handle");
    };

    // Set up completion callback
    var completion_state = CompletionState{};
    completion_state.wait_group.start();

    // Store the completion state in the pending handle
    pending_handle.user_data = @as(?*anyopaque, @ptrCast(&completion_state));
    pending_handle.completion_callback = workflowCompletionCallback;

    // Poll activity task from core worker
    core.ensureExternalApiInstalled();
    core.api.worker_poll_activity_task(
        worker_handle.core_worker,
        @as(?*anyopaque, @ptrCast(pending_handle)),
        workflowPollCallback,
    );

    return pending_handle;
}

pub fn completeActivityTask(handle: ?*WorkerHandle, payload: []const u8) i32 {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: completeActivityTask received null worker handle",
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
            .message = "temporal-bun-bridge-zig: completeActivityTask requires an activity completion payload",
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

    core.ensureExternalApiInstalled();
    core.api.worker_complete_activity_task(
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
            "temporal-bun-bridge-zig: activity completion failed with an unknown error";
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

pub fn recordActivityHeartbeat(handle: ?*WorkerHandle, payload: []const u8) i32 {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: recordActivityHeartbeat received null worker handle",
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

    const details = core.ByteArrayRef{
        .data = payload.ptr,
        .size = payload.len,
    };

    core.ensureExternalApiInstalled();
    const result = core.api.worker_record_activity_heartbeat(worker_handle.core_worker, details);

    if (result) |fail| {
        const message = byteArraySlice(fail);
        const description = if (message.len > 0)
            message
        else
            "temporal-bun-bridge-zig: activity heartbeat failed with an unknown error";
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

pub fn initiateShutdown(handle: ?*WorkerHandle) i32 {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: initiateShutdown received null worker handle",
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

    core.ensureExternalApiInstalled();
    core.api.worker_initiate_shutdown(worker_handle.core_worker);

    errors.setLastError(""[0..0]);
    return 0;
}

pub fn finalizeShutdown(handle: ?*WorkerHandle) i32 {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: finalizeShutdown received null worker handle",
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

    var state = CompletionState{};
    defer state.wait_group.reset();
    state.wait_group.start();

    core.ensureExternalApiInstalled();
    core.api.worker_finalize_shutdown(
        worker_handle.core_worker,
        @as(?*anyopaque, @ptrCast(&state)),
        workflowCompletionCallback,
    );

    state.wait_group.wait();

    if (state.fail_ptr) |fail| {
        const message = byteArraySlice(fail);
        const description = if (message.len > 0)
            message
        else
            "temporal-bun-bridge-zig: worker finalize shutdown failed with an unknown error";
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
            .pending_lock = .{},
            .pending_condition = .{},
            .pending_connects = 0,
            .destroying = false,
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

test "create worker returns handle on success" {
    const original_new = core.api.worker_new;
    const original_free = core.api.worker_free;
    defer {
        core.api.worker_new = original_new;
        core.api.worker_free = original_free;
    }

    // Mock successful worker creation
    core.api.worker_new = struct {
        fn mockWorkerNew(client_ptr: ?*core.Client, options_ptr: *const core.WorkerOptions) callconv(.c) core.WorkerOrFail {
            _ = client_ptr;
            _ = options_ptr;
            return core.WorkerOrFail{
                .worker = @as(?*core.Worker, @ptrFromInt(0x12345678)),
                .fail = null,
            };
        }
    }.mockWorkerNew;

    core.api.worker_free = struct {
        fn mockWorkerFree(worker_ptr: ?*core.Worker) callconv(.c) void {
            _ = worker_ptr;
            // Mock cleanup
        }
    }.mockWorkerFree;

    var rt = WorkerTests.fakeRuntimeHandle();
    var client_handle = client.ClientHandle{
        .id = 5,
        .runtime = &rt,
        .config = ""[0..0],
        .core_client = @as(?*core.ClientOpaque, @ptrFromInt(0x87654321)),
    };

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    const config_json = "{\"namespace\":\"test-namespace\",\"taskQueue\":\"test-queue\"}";
    const worker_handle = create(&rt, &client_handle, config_json);

    try testing.expect(worker_handle != null);
    try testing.expectEqual(@as(u64, 1), worker_handle.?.id);
    try testing.expectEqual(@as(?*core.WorkerOpaque, @ptrFromInt(0x12345678)), worker_handle.?.core_worker);
    try testing.expectEqualStrings("", errors.snapshot());

    // Clean up
    destroy(worker_handle);
}

test "create worker returns null on failure" {
    const original_new = core.api.worker_new;
    defer {
        core.api.worker_new = original_new;
    }

    // Mock failed worker creation
    core.api.worker_new = struct {
        fn mockWorkerNew(client_ptr: ?*core.Client, options_ptr: *const core.WorkerOptions) callconv(.c) core.WorkerOrFail {
            _ = client_ptr;
            _ = options_ptr;
            return core.WorkerOrFail{
                .worker = null,
                .fail = &WorkerTests.stub_fail_buffer,
            };
        }
    }.mockWorkerNew;

    var rt = WorkerTests.fakeRuntimeHandle();
    var client_handle = client.ClientHandle{
        .id = 5,
        .runtime = &rt,
        .config = ""[0..0],
        .core_client = @as(?*core.ClientOpaque, @ptrFromInt(0x87654321)),
    };

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);
    WorkerTests.stub_fail_message = "Worker creation failed: Invalid configuration";

    const config_json = "{\"namespace\":\"test-namespace\",\"taskQueue\":\"test-queue\"}";
    const worker_handle = create(&rt, &client_handle, config_json);

    try testing.expect(worker_handle == null);
    try testing.expectEqualStrings("{\"code\":13,\"message\":\"Worker creation failed: Invalid configuration\"}", errors.snapshot());
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
