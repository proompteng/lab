const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");
const byte_array = @import("byte_array.zig");

const grpc = pending.GrpcStatus;

const TaskKind = enum { workflow, activity };

const WorkerPollContext = struct {
    pending_handle: *pending.PendingByteArray,
    runtime_handle: *runtime.RuntimeHandle,
    worker_handle: *WorkerHandle,
    kind: TaskKind,
};

fn makeByteArrayRef(slice: []const u8) core.ByteArrayRef {
    return if (slice.len == 0)
        .{ .data = null, .size = 0 }
    else
        .{ .data = slice.ptr, .size = slice.len };
}

fn initPollContext(
    worker_handle: *WorkerHandle,
    runtime_handle: *runtime.RuntimeHandle,
    pending_handle: *pending.PendingByteArray,
    kind: TaskKind,
) ?*WorkerPollContext {
    const allocator = std.heap.c_allocator;
    const context = allocator.create(WorkerPollContext) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to allocate worker poll context", .details = null });
        return null;
    };

    context.* = .{
        .pending_handle = pending_handle,
        .runtime_handle = runtime_handle,
        .worker_handle = worker_handle,
        .kind = kind,
    };

    if (!pending.retain(pending_handle)) {
        allocator.destroy(context);
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to retain pending handle", .details = null });
        return null;
    }

    return context;
}

// Transfers ownership of a core-managed byte array into the bridge-managed representation.
fn adoptCoreByteArray(runtime_handle: *runtime.RuntimeHandle, bytes_ptr: *const core.ByteArray) ?*byte_array.ByteArray {
    if (runtime_handle == null or runtime_handle.?.core_runtime == null) {
        errors.setStructuredErrorJson(.{ .code = grpc.failed_precondition, .message = "temporal-bun-bridge-zig: runtime handle is not initialized", .details = null });
        return null;
    }

    return byte_array.adoptCoreByteBuf(@constCast(bytes_ptr), core.api.byte_array_free) orelse {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to adopt core byte array", .details = null });
        return null;
    };
}

fn validateWorkerHandle(handle: ?*WorkerHandle) ?*WorkerHandle {
    if (handle == null) {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: worker handle was null", .details = null });
        return null;
    }

    const worker_handle = handle.?;
    if (worker_handle.core_worker == null) {
        errors.setStructuredErrorJson(.{ .code = grpc.failed_precondition, .message = "temporal-bun-bridge-zig: worker core handle is not initialized", .details = null });
        return null;
    }

    if (worker_handle.runtime == null or worker_handle.runtime.?.core_runtime == null) {
        errors.setStructuredErrorJson(.{ .code = grpc.failed_precondition, .message = "temporal-bun-bridge-zig: worker runtime is not initialized", .details = null });
        return null;
    }

    return worker_handle;
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

fn parseWorkerOptions(config_json: []const u8, options: *core.WorkerOptions) bool {
    options.* = std.mem.zeroes(core.WorkerOptions);

    const namespace = extractStringField(config_json, "namespace") orelse "";
    const task_queue = extractStringField(config_json, "taskQueue") orelse extractStringField(config_json, "task_queue") orelse "";
    const identity = extractStringField(config_json, "identity") orelse extractStringField(config_json, "workerIdentity") orelse "";

    if (task_queue.len == 0) {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: worker config missing taskQueue", .details = null });
        return false;
    }

    options.namespace_ = makeByteArrayRef(namespace);
    options.task_queue = makeByteArrayRef(task_queue);
    options.identity_override = makeByteArrayRef(identity);

    return true;
}

fn pollTask(worker_handle: *WorkerHandle, kind: TaskKind) ?*pending.PendingByteArray {
    const runtime_handle = worker_handle.runtime.?;

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to allocate pending worker poll handle", .details = null });
        return null;
    };
    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_handle_ptr));

    const context = initPollContext(worker_handle, runtime_handle, pending_handle, kind) orelse {
        pending.free(pending_handle_ptr);
        return null;
    };

    switch (kind) {
        .workflow => core.api.worker_poll_workflow_activation(
            worker_handle.core_worker,
            context,
            workerPollCallback,
        ),
        .activity => core.api.worker_poll_activity_task(
            worker_handle.core_worker,
            context,
            workerPollCallback,
        ),
    }

    return @as(?*pending.PendingByteArray, pending_handle_ptr);
}

fn completeCoreTask(handle: ?*WorkerHandle, payload: []const u8, kind: TaskKind) i32 {
    const worker_handle = validateWorkerHandle(handle) orelse return -1;
    const runtime_handle = worker_handle.runtime.?;

    if (payload.len == 0) {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: completion payload is required", .details = null });
        return -1;
    }

    var state = CompletionState{};
    defer state.wait_group.reset();
    state.wait_group.start();

    const completion = core.ByteArrayRef{ .data = payload.ptr, .size = payload.len };

    switch (kind) {
        .workflow => core.workerCompleteWorkflowActivation(
            worker_handle.core_worker,
            completion,
            @as(?*anyopaque, @ptrCast(&state)),
            workflowCompletionCallback,
        ),
        .activity => core.workerCompleteActivityTask(
            worker_handle.core_worker,
            completion,
            @as(?*anyopaque, @ptrCast(&state)),
            workflowCompletionCallback,
        ),
    }

    state.wait_group.wait();

    if (state.fail_ptr) |fail| {
        const description = byteArraySlice(fail);
        const message = if (description.len > 0)
            description
        else
            "temporal-bun-bridge-zig: worker completion failed";
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = message, .details = null });
        core.runtimeByteArrayFree(runtime_handle.core_runtime, fail);
        return -1;
    }

    errors.setLastError(""[0..0]);
    return 0;
}

pub fn create(
    runtime_ptr: ?*runtime.RuntimeHandle,
    client_ptr: ?*client.ClientHandle,
    config_json: []const u8,
) ?*WorkerHandle {
    if (runtime_ptr == null or client_ptr == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker.create requires runtime and client handles",
            .details = null,
        });
        return null;
    }

    const config_copy = duplicateConfig(config_json) orelse {
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker config",
        });
        return null;
    };

    var worker_options = std.mem.zeroes(core.WorkerOptions);
    if (!parseWorkerOptions(config_copy, &worker_options)) {
        std.heap.c_allocator.free(config_copy);
        return null;
    }

    const created = core.api.worker_new(
        runtime_ptr.?.core_runtime,
        client_ptr.?.core_client,
        &worker_options,
    );

    if (created.worker == null) {
        std.heap.c_allocator.free(config_copy);
        const fail_ptr = created.fail;
        const message = byteArraySlice(fail_ptr);
        const description = if (message.len > 0)
            message
        else
            "temporal-bun-bridge-zig: Temporal core failed to create worker";
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = description, .details = null });
        if (fail_ptr) |fail| {
            core.api.byte_array_free(runtime_ptr.?.core_runtime, fail);
        }
        return null;
    }

    if (created.fail) |fail| {
        core.api.byte_array_free(runtime_ptr.?.core_runtime, fail);
    }

    const allocator = std.heap.c_allocator;
    const handle = allocator.create(WorkerHandle) catch |err| {
        core.api.worker_free(created.worker);
        std.heap.c_allocator.free(config_copy);
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(&scratch, "temporal-bun-bridge-zig: failed to allocate worker handle: {}", .{err}) catch
            "temporal-bun-bridge-zig: failed to allocate worker handle";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        return null;
    };

    const id = next_worker_id;
    next_worker_id += 1;

    handle.* = .{
        .id = id,
        .runtime = runtime_ptr,
        .client = client_ptr,
        .config = config_copy,
        .core_worker = created.worker,
    };

    errors.setLastError(""[0..0]);
    return handle;
}

pub fn destroy(handle: ?*WorkerHandle) void {
    if (handle == null) {
        return;
    }

    const worker_handle = handle.?;

    if (worker_handle.core_worker) |core_worker_ptr| {
        core.api.worker_free(core_worker_ptr);
    }

    releaseHandle(worker_handle);
}

pub fn pollWorkflowTask(handle: ?*WorkerHandle) ?*pending.PendingByteArray {
    const worker_handle = validateWorkerHandle(handle) orelse return null;
    return pollTask(worker_handle, .workflow);
}

pub fn completeWorkflowTask(handle: ?*WorkerHandle, payload: []const u8) i32 {
    return completeCoreTask(handle, payload, .workflow);
}

pub fn pollActivityTask(handle: ?*WorkerHandle) ?*pending.PendingByteArray {
    const worker_handle = validateWorkerHandle(handle) orelse return null;
    return pollTask(worker_handle, .activity);
}

pub fn completeActivityTask(handle: ?*WorkerHandle, payload: []const u8) i32 {
    return completeCoreTask(handle, payload, .activity);
}

pub fn recordActivityHeartbeat(handle: ?*WorkerHandle, payload: []const u8) i32 {
    const worker_handle = validateWorkerHandle(handle) orelse return -1;
    const heartbeat_ref = core.ByteArrayRef{ .data = if (payload.len > 0) payload.ptr else null, .size = payload.len };

    const error_ptr = core.api.worker_record_activity_heartbeat(worker_handle.core_worker, heartbeat_ref);
    if (error_ptr == null) {
        errors.setLastError(""[0..0]);
        return 0;
    }

    const message = byteArraySlice(error_ptr);
    const description = if (message.len > 0)
        message
    else
        "temporal-bun-bridge-zig: activity heartbeat rejected by Temporal core";
    errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = description, .details = null });
    core.api.byte_array_free(worker_handle.runtime.?.core_runtime, error_ptr);
    return -1;
}

pub fn initiateShutdown(handle: ?*WorkerHandle) i32 {
    const worker_handle = validateWorkerHandle(handle) orelse return -1;
    core.api.worker_initiate_shutdown(worker_handle.core_worker);
    errors.setLastError(""[0..0]);
    return 0;
}

pub fn finalizeShutdown(handle: ?*WorkerHandle) i32 {
    const worker_handle = validateWorkerHandle(handle) orelse return -1;
    var completion_state = CompletionState{};
    completion_state.wait_group.start();

    core.api.worker_finalize_shutdown(
        worker_handle.core_worker,
        @as(?*anyopaque, @ptrCast(&completion_state)),
        workflowCompletionCallback,
    );

    completion_state.wait_group.wait();

    if (completion_state.fail_ptr) |fail| {
        const message = byteArraySlice(fail);
        const description = if (message.len > 0)
            message
        else
            "temporal-bun-bridge-zig: worker finalize shutdown failed";
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = description, .details = null });
        core.runtimeByteArrayFree(worker_handle.runtime.?.core_runtime, fail);
        return -1;
    }

    errors.setLastError(""[0..0]);
    return 0;
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

fn workerPollCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    fail: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) {
        return;
    }

    const context = @as(*WorkerPollContext, @ptrCast(@alignCast(user_data.?)));
    const runtime_handle = context.runtime_handle;
    const pending_handle = context.pending_handle;
    const allocator = std.heap.c_allocator;
    defer allocator.destroy(context);
    defer pending.release(pending_handle);

    if (success) |activation| {
        const managed = adoptCoreByteArray(runtime_handle, activation) orelse {
            const snapshot = errors.snapshot();
            const message = if (snapshot.len > 0)
                snapshot
            else
                "temporal-bun-bridge-zig: failed to transfer activation";
            _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
            return;
        };

        if (!pending.resolveByteArray(pending_handle, managed)) {
            byte_array.free(managed);
        }
        return;
    }

    if (fail) |error_ptr| {
        const description = byteArraySlice(error_ptr);
        const message = if (description.len > 0)
            description
        else
            "temporal-bun-bridge-zig: worker poll returned error";
        _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
        core.api.byte_array_free(runtime_handle.core_runtime, error_ptr);
        return;
    }

    _ = pending.rejectByteArray(
        pending_handle,
        grpc.cancelled,
        "temporal-bun-bridge-zig: worker poll cancelled",
    );
}

fn extractStringField(json: []const u8, key: []const u8) ?[]const u8 {
    var pattern_buffer: [96]u8 = undefined;
    if (key.len + 2 > pattern_buffer.len) return null;
    const pattern = std.fmt.bufPrint(&pattern_buffer, "\"{s}\"", .{key}) catch return null;
    const key_index = std.mem.indexOf(u8, json, pattern) orelse return null;

    var index = key_index + pattern.len;
    while (index < json.len and std.ascii.isWhitespace(json[index])) : (index += 1) {}
    if (index >= json.len or json[index] != ':') return null;
    index += 1;

    while (index < json.len and std.ascii.isWhitespace(json[index])) : (index += 1) {}
    if (index >= json.len or json[index] != '"') return null;
    index += 1;

    const start = index;
    var escape = false;
    while (index < json.len) : (index += 1) {
        const char = json[index];
        if (escape) {
            escape = false;
            continue;
        }
        if (char == '\\') {
            escape = true;
            continue;
        }
        if (char == '"') {
            return json[start..index];
        }
    }

    return null;
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

fn parseWorkerOptionsForTests(config_json: []const u8, options: *core.WorkerOptions) bool {
    return parseWorkerOptions(config_json, options);
}

fn initPollContextForTests(
    worker_handle: *WorkerHandle,
    runtime_handle: *runtime.RuntimeHandle,
    pending_handle: *pending.PendingByteArray,
    kind: TaskKind,
) ?*WorkerPollContext {
    return initPollContext(worker_handle, runtime_handle, pending_handle, kind);
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
    try testing.expectEqual(
        @as(?*core.RuntimeOpaque, @ptrCast(&WorkerTests.fake_runtime_storage)),
        WorkerTests.last_runtime_byte_array_free_runtime,
    );
    try testing.expect(WorkerTests.last_runtime_byte_array_free_ptr != null);
    if (WorkerTests.last_runtime_byte_array_free_ptr) |ptr| {
        try testing.expectEqual(@as(usize, WorkerTests.stub_fail_message.len), ptr.size);
    }
}
