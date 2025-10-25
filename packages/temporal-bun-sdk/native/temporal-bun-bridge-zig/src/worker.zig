const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const pending = @import("pending.zig");
const byte_array = @import("byte_array.zig");
const core = @import("core.zig");
const builtin = @import("builtin");
const json = std.json;

const grpc = pending.GrpcStatus;

pub const WorkerHandle = struct {
    id: u64,
    runtime: ?*runtime.RuntimeHandle,
    client: ?*client.ClientHandle,
    config: []u8,
    namespace: []u8,
    task_queue: []u8,
    identity: []u8,
    core_worker: ?*core.WorkerOpaque,
    pending_lock: std.Thread.Mutex = .{},
    pending_condition: std.Thread.Condition = .{},
    pending_polls: usize = 0,
    destroying: bool = false,
};

var next_worker_id: u64 = 1;
const default_identity = "temporal-bun-worker";

fn emptyByteArrayRef() core.ByteArrayRef {
    return .{ .data = null, .size = 0 };
}

fn makeByteArrayRef(slice: []const u8) core.ByteArrayRef {
    if (slice.len == 0) {
        return emptyByteArrayRef();
    }
    return .{ .data = slice.ptr, .size = slice.len };
}

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

fn duplicateBytes(slice: []const u8) ?[]u8 {
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

fn releaseHandle(handle: *WorkerHandle) void {
    var allocator = std.heap.c_allocator;
    if (handle.config.len > 0) {
        allocator.free(handle.config);
    }
    if (handle.namespace.len > 0) {
        allocator.free(handle.namespace);
    }
    if (handle.task_queue.len > 0) {
        allocator.free(handle.task_queue);
    }
    if (handle.identity.len > 0) {
        allocator.free(handle.identity);
    }
    allocator.destroy(handle);
}

fn beginPendingPoll(handle: *WorkerHandle) bool {
    handle.pending_lock.lock();
    defer handle.pending_lock.unlock();

    if (handle.destroying) {
        return false;
    }

    handle.pending_polls += 1;
    return true;
}

fn endPendingPoll(handle: *WorkerHandle) void {
    handle.pending_lock.lock();
    defer handle.pending_lock.unlock();

    if (handle.pending_polls > 0) {
        handle.pending_polls -= 1;
    }

    if (handle.destroying and handle.pending_polls == 0) {
        handle.pending_condition.broadcast();
    }
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

const PollWorkflowTaskContext = struct {
    allocator: std.mem.Allocator,
    pending_handle: *pending.PendingByteArray,
    worker_handle: *WorkerHandle,
    runtime_handle: *runtime.RuntimeHandle,
    core_worker: *core.WorkerOpaque,
    core_runtime: *core.RuntimeOpaque,
    wait_group: std.Thread.WaitGroup = .{},
};

fn pollWorkflowTaskCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    fail: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) {
        return;
    }

    const context = @as(*PollWorkflowTaskContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    const pending_handle = context.pending_handle;

    if (success) |success_ptr| {
        const activation_slice = byteArraySlice(success_ptr);
        defer core.api.byte_array_free(context.core_runtime, success_ptr);
        if (fail) |fail_ptr| {
            core.api.byte_array_free(context.core_runtime, fail_ptr);
        }

        if (activation_slice.len == 0) {
            const message = "temporal-bun-bridge-zig: workflow poll returned empty activation";
            errors.setStructuredError(.{ .code = grpc.internal, .message = message });
            _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
            return;
        }

        if (byte_array.allocateFromSlice(activation_slice)) |array_ptr| {
            if (!pending.resolveByteArray(pending_handle, array_ptr)) {
                byte_array.free(array_ptr);
            } else {
                errors.setLastError(""[0..0]);
            }
        } else {
            const message = "temporal-bun-bridge-zig: failed to allocate workflow activation payload";
            errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
            _ = pending.rejectByteArray(pending_handle, grpc.resource_exhausted, message);
        }
        return;
    }

    if (fail) |fail_ptr| {
        const failure_slice = byteArraySlice(fail_ptr);
        defer core.api.byte_array_free(context.core_runtime, fail_ptr);
        const message = if (failure_slice.len != 0)
            failure_slice
        else
            "temporal-bun-bridge-zig: workflow task poll failed";
        errors.setStructuredError(.{ .code = grpc.internal, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
        return;
    }

    const message = "temporal-bun-bridge-zig: workflow task poll cancelled";
    errors.setStructuredError(.{ .code = grpc.cancelled, .message = message });
    _ = pending.rejectByteArray(pending_handle, grpc.cancelled, message);
}

fn pollWorkflowTaskWorker(context: *PollWorkflowTaskContext) void {
    context.wait_group.start();
    core.workerPollWorkflowActivation(
        context.core_worker,
        @as(?*anyopaque, @ptrCast(context)),
        pollWorkflowTaskCallback,
    );
    context.wait_group.wait();
    pending.release(context.pending_handle);
    endPendingPoll(context.worker_handle);
    context.allocator.destroy(context);
}

const StringFieldLookup = struct {
    value: ?[]const u8 = null,
    found: bool = false,
    invalid_type: bool = false,
};

const WorkerFailPayload = struct {
    code: i32,
    message: []const u8,
    message_allocated: bool,
    details: ?[]const u8,
    details_allocated: bool,
};

fn lookupStringField(map: *json.ObjectMap, aliases: []const []const u8) StringFieldLookup {
    var result = StringFieldLookup{};
    for (aliases) |alias| {
        if (map.getPtr(alias)) |field| {
            result.found = true;
            switch (field.*) {
                .string => {
                    result.value = field.string;
                    return result;
                },
                .null => {
                    result.invalid_type = true;
                    return result;
                },
                else => {
                    result.invalid_type = true;
                    return result;
                },
            }
        }
    }
    return result;
}

fn parseWorkerFailPayload(bytes: []const u8) WorkerFailPayload {
    const default_message = "temporal-bun-bridge-zig: worker creation failed";
    var result: WorkerFailPayload = .{
        .code = grpc.internal,
        .message = default_message,
        .message_allocated = false,
        .details = null,
        .details_allocated = false,
    };

    if (bytes.len == 0) {
        return result;
    }

    const allocator = std.heap.c_allocator;
    const parse_opts = json.ParseOptions{
        .duplicate_field_behavior = .use_first,
        .ignore_unknown_fields = true,
    };

    var parsed = json.parseFromSlice(json.Value, allocator, bytes, parse_opts) catch {
        return result;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        return result;
    }

    var obj = parsed.value.object;
    var code = grpc.internal;
    if (obj.getPtr("code")) |code_value| {
        switch (code_value.*) {
            .integer => {
                if (std.math.cast(i32, code_value.integer)) |casted| {
                    code = casted;
                }
            },
            .float => {
                const converted = @as(i64, @intFromFloat(code_value.float));
                if (std.math.cast(i32, converted)) |casted| {
                    code = casted;
                }
            },
            else => {},
        }
    }
    result.code = code;

    if (obj.getPtr("message")) |message_value| {
        if (message_value.* == .string and message_value.string.len > 0) {
            if (duplicateBytes(message_value.string)) |copy| {
                result.message = copy;
                result.message_allocated = true;
            } else {
                result.message = default_message;
            }
        }
    }

    if (obj.getPtr("details")) |details_value| {
        if (details_value.* == .string and details_value.string.len > 0) {
            if (duplicateBytes(details_value.string)) |copy| {
                result.details = copy;
                result.details_allocated = true;
            }
        }
    }

    return result;
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

    const runtime_handle = runtime_ptr.?;
    if (runtime_handle.core_runtime == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime core handle is not initialized",
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

    const client_handle = client_ptr.?;
    if (client_handle.core_client == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: worker client core handle is not initialized",
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

    const allocator = std.heap.c_allocator;
    const parse_opts = json.ParseOptions{
        .duplicate_field_behavior = .use_first,
        .ignore_unknown_fields = true,
    };

    var parsed = json.parseFromSlice(json.Value, allocator, config_json, parse_opts) catch {
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config is not valid JSON",
        });
        return null;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config must be a JSON object",
        });
        return null;
    }

    var obj = parsed.value.object;

    const namespace_lookup = lookupStringField(&obj, &.{ "namespace", "namespace_", "Namespace" });
    if (!namespace_lookup.found) {
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config missing namespace",
        });
        return null;
    }
    if (namespace_lookup.invalid_type or namespace_lookup.value == null) {
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker namespace must be a string",
        });
        return null;
    }
    const namespace_slice = namespace_lookup.value.?;
    if (namespace_slice.len == 0) {
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker namespace must be non-empty",
        });
        return null;
    }

    const namespace_copy = duplicateBytes(namespace_slice) orelse {
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker namespace",
        });
        return null;
    };

    const task_queue_lookup = lookupStringField(&obj, &.{ "taskQueue", "task_queue" });
    if (!task_queue_lookup.found) {
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config missing taskQueue",
        });
        return null;
    }
    if (task_queue_lookup.invalid_type or task_queue_lookup.value == null) {
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker taskQueue must be a string",
        });
        return null;
    }
    const task_queue_slice = task_queue_lookup.value.?;
    if (task_queue_slice.len == 0) {
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker taskQueue must be non-empty",
        });
        return null;
    }

    const task_queue_copy = duplicateBytes(task_queue_slice) orelse {
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker taskQueue",
        });
        return null;
    };

    const identity_lookup = lookupStringField(&obj, &.{ "identity", "identityOverride", "identity_override" });
    if (identity_lookup.invalid_type) {
        allocator.free(task_queue_copy);
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker identity must be a string when provided",
        });
        return null;
    }

    var identity_copy: []u8 = ""[0..0];
    var identity_slice: []const u8 = default_identity;
    if (identity_lookup.value) |identity_value| {
        identity_copy = duplicateBytes(identity_value) orelse {
            allocator.free(task_queue_copy);
            allocator.free(namespace_copy);
            if (config_copy.len > 0) {
                allocator.free(config_copy);
            }
            errors.setStructuredError(.{
                .code = grpc.resource_exhausted,
                .message = "temporal-bun-bridge-zig: failed to allocate worker identity",
            });
            return null;
        };
        identity_slice = identity_copy;
    }

    var options: core.WorkerOptions = undefined;
    @memset(std.mem.asBytes(&options), 0);
    options.namespace_ = makeByteArrayRef(namespace_copy);
    options.task_queue = makeByteArrayRef(task_queue_copy);
    options.identity_override = makeByteArrayRef(identity_slice);
    options.versioning_strategy.tag = 0;
    options.nondeterminism_as_workflow_fail_for_types = .{
        .data = null,
        .size = 0,
    };

    const result = core.api.worker_new(client_handle.core_client, &options);

    if (result.worker == null) {
        if (identity_copy.len > 0) {
            allocator.free(identity_copy);
        }
        allocator.free(task_queue_copy);
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        const failure_slice = byteArraySlice(result.fail);
        const parsed_fail = parseWorkerFailPayload(failure_slice);

        const fallback_message = "temporal-bun-bridge-zig: Temporal core worker creation failed";
        const error_message = if (parsed_fail.message.len > 0) parsed_fail.message else fallback_message;
        const error_details = parsed_fail.details;

        errors.setStructuredErrorJson(.{
            .code = parsed_fail.code,
            .message = error_message,
            .details = error_details,
        });

        if (parsed_fail.details_allocated and parsed_fail.details != null) {
            allocator.free(@constCast(parsed_fail.details.?));
        }
        if (parsed_fail.message_allocated) {
            allocator.free(@constCast(parsed_fail.message));
        }
        if (result.fail) |fail_ptr| {
            core.api.byte_array_free(runtime_handle.core_runtime, fail_ptr);
        }
        return null;
    }

    const handle = allocator.create(WorkerHandle) catch |err| {
        core.api.worker_free(result.worker);
        if (identity_copy.len > 0) {
            allocator.free(identity_copy);
        }
        allocator.free(task_queue_copy);
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate worker handle: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate worker handle";
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
        .namespace = namespace_copy,
        .task_queue = task_queue_copy,
        .identity = identity_copy,
        .core_worker = result.worker,
    };

    if (result.fail) |fail_ptr| {
        core.api.byte_array_free(runtime_handle.core_runtime, fail_ptr);
    }

    errors.setLastError(""[0..0]);
    return handle;
}

pub fn destroy(handle: ?*WorkerHandle) void {
    if (handle == null) {
        return;
    }

    const worker_handle = handle.?;
    worker_handle.pending_lock.lock();
    worker_handle.destroying = true;
    while (worker_handle.pending_polls != 0) {
        worker_handle.pending_condition.wait(&worker_handle.pending_lock);
    }
    worker_handle.pending_lock.unlock();

    if (worker_handle.core_worker) |core_worker_ptr| {
        core.ensureExternalApiInstalled();
        core.api.worker_free(core_worker_ptr);
        worker_handle.core_worker = null;
    }
    releaseHandle(worker_handle);
}

pub fn pollWorkflowTask(_handle: ?*WorkerHandle) ?*pending.PendingByteArray {

    if (_handle == null) {
        return pendingByteArrayError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: pollWorkflowTask received null worker handle",
        );
    }

    const worker_handle = _handle.?;

    const core_worker_ptr = worker_handle.core_worker orelse {
        return pendingByteArrayError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker core handle is not initialized",
        );
    };

    const runtime_handle = worker_handle.runtime orelse {
        return pendingByteArrayError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker runtime handle is not initialized",
        );
    };

    const core_runtime_ptr = runtime_handle.core_runtime orelse {
        return pendingByteArrayError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker runtime core handle is not initialized",
        );
    };

    if (!beginPendingPoll(worker_handle)) {
        return pendingByteArrayError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker is shutting down",
        );
    }

    const raw_pending_handle = pending.createPendingInFlight() orelse {
        endPendingPoll(worker_handle);
        return pendingByteArrayError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to allocate workflow poll handle",
        );
    };

    const pending_handle_ptr: *pending.PendingByteArray = @ptrCast(raw_pending_handle);

    if (!pending.retain(pending_handle_ptr)) {
        endPendingPoll(worker_handle);
        const message =
            "temporal-bun-bridge-zig: failed to retain workflow poll pending handle";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        _ = pending.rejectByteArray(pending_handle_ptr, grpc.resource_exhausted, message);
        return pending_handle_ptr;
    }

    var allocator = std.heap.c_allocator;
    const context = allocator.create(PollWorkflowTaskContext) catch |err| {
        pending.release(pending_handle_ptr);
        endPendingPoll(worker_handle);
        var scratch: [176]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate workflow poll context: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate workflow poll context";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        _ = pending.rejectByteArray(pending_handle_ptr, grpc.resource_exhausted, message);
        return pending_handle_ptr;
    };

    context.* = .{
        .allocator = allocator,
        .pending_handle = pending_handle_ptr,
        .worker_handle = worker_handle,
        .runtime_handle = runtime_handle,
        .core_worker = core_worker_ptr,
        .core_runtime = core_runtime_ptr,
        .wait_group = .{},
    };

    const thread = std.Thread.spawn(.{}, pollWorkflowTaskWorker, .{context}) catch |err| {
        allocator.destroy(context);
        pending.release(pending_handle_ptr);
        endPendingPoll(worker_handle);
        var scratch: [176]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn workflow poll thread: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to spawn workflow poll thread";
        errors.setStructuredError(.{ .code = grpc.internal, .message = message });
        _ = pending.rejectByteArray(pending_handle_ptr, grpc.internal, message);
        return pending_handle_ptr;
    };

    thread.detach();
    errors.setLastError(""[0..0]);
    return pending_handle_ptr;
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
    var fake_client_storage: usize = 0;

    var stub_completion_call_count: usize = 0;
    var stub_byte_array_free_count: usize = 0;
    var last_completion_payload: []const u8 = ""[0..0];
    var last_runtime_byte_array_free_ptr: ?*const core.ByteArray = null;
    var last_runtime_byte_array_free_runtime: ?*core.RuntimeOpaque = null;
    var stub_poll_call_count: usize = 0;
    var stub_poll_success_payload: []const u8 = ""[0..0];
    var stub_poll_success_buffer: core.ByteArray = .{
        .data = null,
        .size = 0,
        .cap = 0,
        .disable_free = false,
    };
    var stub_poll_fail_message: []const u8 = ""[0..0];
    var stub_poll_fail_buffer: core.ByteArray = .{
        .data = null,
        .size = 0,
        .cap = 0,
        .disable_free = false,
    };

    var stub_fail_message: []const u8 = ""[0..0];
    var stub_fail_buffer: core.ByteArray = .{
        .data = null,
        .size = 0,
        .cap = 0,
        .disable_free = false,
    };

    var stub_worker_new_calls: usize = 0;
    var stub_worker_free_calls: usize = 0;
    var stub_worker_fail_message: []const u8 = ""[0..0];
    var stub_worker_fail_buffer: core.ByteArray = .{
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
        stub_poll_call_count = 0;
        stub_poll_success_payload = ""[0..0];
        stub_poll_success_buffer = .{
            .data = null,
            .size = 0,
            .cap = 0,
            .disable_free = false,
        };
        stub_poll_fail_message = ""[0..0];
        stub_poll_fail_buffer = .{
            .data = null,
            .size = 0,
            .cap = 0,
            .disable_free = false,
        };
        stub_fail_message = ""[0..0];
        stub_fail_buffer = .{
            .data = null,
            .size = 0,
            .cap = 0,
            .disable_free = false,
        };
        stub_worker_new_calls = 0;
        stub_worker_free_calls = 0;
        stub_worker_fail_message = ""[0..0];
        stub_worker_fail_buffer = .{
            .data = null,
            .size = 0,
            .cap = 0,
            .disable_free = false,
        };
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

    fn stubPollWorkflowSuccess(
        worker_ptr: ?*core.WorkerOpaque,
        user_data: ?*anyopaque,
        callback: core.WorkerPollCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_poll_call_count += 1;
        stub_poll_success_buffer = .{
            .data = if (stub_poll_success_payload.len > 0) stub_poll_success_payload.ptr else null,
            .size = stub_poll_success_payload.len,
            .cap = stub_poll_success_payload.len,
            .disable_free = false,
        };
        if (callback) |cb| {
            cb(user_data, &stub_poll_success_buffer, null);
        }
    }

    fn stubPollWorkflowFailure(
        worker_ptr: ?*core.WorkerOpaque,
        user_data: ?*anyopaque,
        callback: core.WorkerPollCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_poll_call_count += 1;
        stub_poll_fail_buffer = .{
            .data = if (stub_poll_fail_message.len > 0) stub_poll_fail_message.ptr else null,
            .size = stub_poll_fail_message.len,
            .cap = stub_poll_fail_message.len,
            .disable_free = false,
        };
        if (callback) |cb| {
            cb(user_data, null, &stub_poll_fail_buffer);
        }
    }

    fn stubPollWorkflowShutdown(
        worker_ptr: ?*core.WorkerOpaque,
        user_data: ?*anyopaque,
        callback: core.WorkerPollCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_poll_call_count += 1;
        if (callback) |cb| {
            cb(user_data, null, null);
        }
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
            .namespace = ""[0..0],
            .task_queue = ""[0..0],
            .identity = ""[0..0],
            .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&fake_worker_storage)),
            .pending_lock = .{},
            .pending_condition = .{},
            .pending_polls = 0,
            .destroying = false,
        };
    }

    fn fakeClientHandle(rt: *runtime.RuntimeHandle) client.ClientHandle {
        return .{
            .id = 11,
            .runtime = rt,
            .config = ""[0..0],
            .core_client = @as(?*core.ClientOpaque, @ptrCast(&fake_client_storage)),
        };
    }

    fn stubWorkerNewSuccess(
        _client: ?*core.Client,
        options: *const core.WorkerOptions,
    ) callconv(.c) core.WorkerOrFail {
        _ = _client;
        _ = options;
        stub_worker_new_calls += 1;
        return .{
            .worker = @as(?*core.WorkerOpaque, @ptrCast(&fake_worker_storage)),
            .fail = null,
        };
    }

    fn stubWorkerNewFailure(
        _client: ?*core.Client,
        _options: *const core.WorkerOptions,
    ) callconv(.c) core.WorkerOrFail {
        _ = _client;
        _ = _options;
        stub_worker_new_calls += 1;
        if (stub_worker_fail_message.len == 0) {
            stub_worker_fail_buffer = .{
                .data = null,
                .size = 0,
                .cap = 0,
                .disable_free = false,
            };
        } else {
            stub_worker_fail_buffer = .{
                .data = stub_worker_fail_message.ptr,
                .size = stub_worker_fail_message.len,
                .cap = stub_worker_fail_message.len,
                .disable_free = false,
            };
        }
        return .{
            .worker = null,
            .fail = &stub_worker_fail_buffer,
        };
    }

    fn stubWorkerFree(worker_ptr: ?*core.WorkerOpaque) callconv(.c) void {
        _ = worker_ptr;
        stub_worker_free_calls += 1;
    }
};

test "create returns worker handle and frees resources on destroy" {
    core.ensureExternalApiInstalled();
    const original_worker_new = core.api.worker_new;
    const original_worker_free = core.api.worker_free;
    defer {
        core.api.worker_new = original_worker_new;
        core.api.worker_free = original_worker_free;
    }

    core.api.worker_new = WorkerTests.stubWorkerNewSuccess;
    core.api.worker_free = WorkerTests.stubWorkerFree;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    var rt = WorkerTests.fakeRuntimeHandle();
    var client_handle = WorkerTests.fakeClientHandle(&rt);
    const config = "{\"namespace\":\"unit\",\"taskQueue\":\"queue\",\"identity\":\"worker\"}";

    const maybe_handle = create(&rt, &client_handle, config);
    try testing.expect(maybe_handle != null);
    const worker_handle = maybe_handle.?;

    try testing.expect(worker_handle.core_worker != null);
    try testing.expect(worker_handle.runtime != null);
    try testing.expect(worker_handle.client != null);
    try testing.expect(std.mem.eql(u8, config, worker_handle.config));
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_new_calls);
    try testing.expectEqualStrings("", errors.snapshot());

    destroy(worker_handle);

    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_free_calls);
}

test "create surfaces core worker failure payload" {
    core.ensureExternalApiInstalled();
    const original_worker_new = core.api.worker_new;
    const original_worker_free = core.api.worker_free;
    const original_byte_array_free = core.api.byte_array_free;
    defer {
        core.api.worker_new = original_worker_new;
        core.api.worker_free = original_worker_free;
        core.api.byte_array_free = original_byte_array_free;
    }

    core.api.worker_new = WorkerTests.stubWorkerNewFailure;
    core.api.worker_free = WorkerTests.stubWorkerFree;
    core.api.byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);
    WorkerTests.stub_worker_fail_message = "{\"code\":9,\"message\":\"bad worker config\"}";

    var rt = WorkerTests.fakeRuntimeHandle();
    var client_handle = WorkerTests.fakeClientHandle(&rt);
    const config = "{\"namespace\":\"unit\",\"taskQueue\":\"queue\"}";

    const handle = create(&rt, &client_handle, config);
    try testing.expect(handle == null);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_new_calls);
    try testing.expectEqual(@as(usize, 0), WorkerTests.stub_worker_free_calls);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_byte_array_free_count);
    try testing.expect(WorkerTests.last_runtime_byte_array_free_runtime == rt.core_runtime);

    const snapshot = errors.snapshot();
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, "\"code\":9"));
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, "bad worker config"));
}

test "destroy handles null and missing worker pointers" {
    const original_worker_free = core.api.worker_free;
    defer {
        core.api.worker_free = original_worker_free;
    }

    core.api.worker_free = WorkerTests.stubWorkerFree;
    WorkerTests.resetStubs();

    destroy(null);
    try testing.expectEqual(@as(usize, 0), WorkerTests.stub_worker_free_calls);

    const allocator = std.heap.c_allocator;
    var config = allocator.alloc(u8, 4) catch unreachable;
    config[0] = 't';
    config[1] = 'e';
    config[2] = 's';
    config[3] = 't';

    const handle = allocator.create(WorkerHandle) catch unreachable;
    handle.* = .{
        .id = 99,
        .runtime = null,
        .client = null,
        .config = config,
        .namespace = ""[0..0],
        .task_queue = ""[0..0],
        .identity = ""[0..0],
        .core_worker = null,
    };

    destroy(handle);

    try testing.expectEqual(@as(usize, 0), WorkerTests.stub_worker_free_calls);
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
        try testing.expectEqual(@as(usize, WorkerTests.stub_fail_message.len), ptr.size);
    }
}

fn awaitPendingByteArray(handle: *pending.PendingByteArray) !pending.Status {
    var attempts: usize = 0;
    while (true) {
        const status_value = pending.poll(@as(?*pending.PendingHandle, @ptrCast(handle)));
        const status = try std.meta.intToEnum(pending.Status, status_value);
        if (status != .pending) {
            return status;
        }
        std.Thread.sleep(1 * std.time.ns_per_ms);
        attempts += 1;
        if (attempts > 1000) {
            return error.Timeout;
        }
    }
}

test "pollWorkflowTask resolves activation payload" {
    const original_api = core.api;
    defer core.api = original_api;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    core.api.worker_poll_workflow_activation = WorkerTests.stubPollWorkflowSuccess;
    core.worker_poll_workflow_activation = WorkerTests.stubPollWorkflowSuccess;
    core.api.byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    WorkerTests.stub_poll_success_payload = "workflow-activation";

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    const pending_handle_opt = pollWorkflowTask(&worker_handle);
    try testing.expect(pending_handle_opt != null);
    const pending_handle = pending_handle_opt.?;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_handle)));

    const status = awaitPendingByteArray(pending_handle) catch unreachable;
    try testing.expectEqual(pending.Status.ready, status);

    const payload_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(pending_handle))) orelse unreachable;
    const payload_ptr = @as(*byte_array.ByteArray, @ptrCast(@alignCast(payload_any)));
    defer byte_array.free(payload_ptr);

    try testing.expectEqual(@as(usize, WorkerTests.stub_poll_success_payload.len), payload_ptr.size);
    if (payload_ptr.data) |ptr| {
        try testing.expectEqualSlices(u8, WorkerTests.stub_poll_success_payload, ptr[0..payload_ptr.size]);
    } else {
        try testing.expectEqual(@as(usize, 0), WorkerTests.stub_poll_success_payload.len);
    }

    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_poll_call_count);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_byte_array_free_count);
    try testing.expectEqual(
        @as(?*core.RuntimeOpaque, @ptrCast(&WorkerTests.fake_runtime_storage)),
        WorkerTests.last_runtime_byte_array_free_runtime,
    );
    try testing.expectEqual(
        @as(?*const core.ByteArray, @ptrCast(&WorkerTests.stub_poll_success_buffer)),
        WorkerTests.last_runtime_byte_array_free_ptr,
    );
    try testing.expectEqual(@as(usize, 0), worker_handle.pending_polls);
    try testing.expectEqualStrings("", errors.snapshot());
}

test "pollWorkflowTask surfaces poll failure payloads" {
    const original_api = core.api;
    defer core.api = original_api;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    core.api.worker_poll_workflow_activation = WorkerTests.stubPollWorkflowFailure;
    core.worker_poll_workflow_activation = WorkerTests.stubPollWorkflowFailure;
    core.api.byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    WorkerTests.stub_poll_fail_message = "workflow poll failed";

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    const pending_handle_opt = pollWorkflowTask(&worker_handle);
    try testing.expect(pending_handle_opt != null);
    const pending_handle = pending_handle_opt.?;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_handle)));

    const status = awaitPendingByteArray(pending_handle) catch unreachable;
    try testing.expectEqual(pending.Status.failed, status);

    const snapshot = errors.snapshot();
    try testing.expect(std.mem.indexOf(u8, snapshot, "\"code\":13") != null);
    try testing.expect(std.mem.indexOf(u8, snapshot, WorkerTests.stub_poll_fail_message) != null);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_poll_call_count);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_byte_array_free_count);
    try testing.expectEqual(@as(usize, 0), worker_handle.pending_polls);
}

test "pollWorkflowTask treats shutdown sentinel as cancelled" {
    const original_api = core.api;
    defer core.api = original_api;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    core.api.worker_poll_workflow_activation = WorkerTests.stubPollWorkflowShutdown;
    core.worker_poll_workflow_activation = WorkerTests.stubPollWorkflowShutdown;
    core.api.byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    const pending_handle_opt = pollWorkflowTask(&worker_handle);
    try testing.expect(pending_handle_opt != null);
    const pending_handle = pending_handle_opt.?;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_handle)));

    const status = awaitPendingByteArray(pending_handle) catch unreachable;
    try testing.expectEqual(pending.Status.failed, status);

    const snapshot = errors.snapshot();
    try testing.expect(std.mem.indexOf(u8, snapshot, "\"code\":1") != null);
    try testing.expect(std.mem.indexOf(u8, snapshot, "workflow task poll cancelled") != null);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_poll_call_count);
    try testing.expectEqual(@as(usize, 0), WorkerTests.stub_byte_array_free_count);
    try testing.expectEqual(@as(usize, 0), worker_handle.pending_polls);
}
