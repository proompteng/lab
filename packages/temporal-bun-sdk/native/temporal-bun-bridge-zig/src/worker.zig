const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const pending = @import("pending.zig");
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

const StringFieldLookup = struct {
    value: ?[]const u8 = null,
    found: bool = false,
    invalid_type: bool = false,
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

fn parseWorkerFailPayload(bytes: []const u8) struct { code: i32, message: []const u8, details: ?[]const u8 } {
    if (bytes.len == 0) {
        return .{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: worker creation failed", .details = null };
    }

    const allocator = std.heap.c_allocator;
    const parse_opts = json.ParseOptions{
        .duplicate_field_behavior = .use_first,
        .ignore_unknown_fields = true,
    };

    var parsed = json.parseFromSlice(json.Value, allocator, bytes, parse_opts) catch {
        return .{ .code = grpc.internal, .message = bytes, .details = null };
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        return .{ .code = grpc.internal, .message = bytes, .details = null };
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

    var message = bytes;
    if (obj.getPtr("message")) |message_value| {
        if (message_value.* == .string and message_value.string.len > 0) {
            message = message_value.string;
        }
    }

    var details: ?[]const u8 = null;
    if (obj.getPtr("details")) |details_value| {
        if (details_value.* == .string and details_value.string.len > 0) {
            details = details_value.string;
        }
    }

    return .{ .code = code, .message = message, .details = details };
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
    var identity_slice: []const u8 = default_identity[0..];
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

    core.ensureExternalApiInstalled();

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
        errors.setStructuredErrorJson(.{
            .code = parsed_fail.code,
            .message = if (parsed_fail.message.len > 0) parsed_fail.message else "temporal-bun-bridge-zig: Temporal core worker creation failed",
            .details = parsed_fail.details,
        });
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
    if (worker_handle.core_worker) |core_worker_ptr| {
        core.ensureExternalApiInstalled();
        core.api.worker_free(core_worker_ptr);
        worker_handle.core_worker = null;
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
