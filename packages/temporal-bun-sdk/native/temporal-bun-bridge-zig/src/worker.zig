const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");
const builtin = @import("builtin");
const json = std.json;

const grpc = pending.GrpcStatus;

const DestroyState = enum(u8) {
    idle,
    destroying,
    destroyed,
};

pub const WorkerHandle = struct {
    id: u64,
    runtime: ?*runtime.RuntimeHandle,
    client: ?*client.ClientHandle,
    config: []u8,
    namespace: []u8,
    task_queue: []u8,
    identity: []u8,
    core_worker: ?*core.WorkerOpaque,
    destroy_state: DestroyState = .idle,
    buffers_released: bool = false,
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
    if (handle.buffers_released) {
        return;
    }

    var allocator = std.heap.c_allocator;
    if (handle.config.len > 0) {
        allocator.free(handle.config);
        handle.config = ""[0..0];
    }
    if (handle.namespace.len > 0) {
        allocator.free(handle.namespace);
        handle.namespace = ""[0..0];
    }
    if (handle.task_queue.len > 0) {
        allocator.free(handle.task_queue);
        handle.task_queue = ""[0..0];
    }
    if (handle.identity.len > 0) {
        allocator.free(handle.identity);
        handle.identity = ""[0..0];
    }

    handle.runtime = null;
    handle.client = null;
    handle.buffers_released = true;
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

    switch (worker_handle.destroy_state) {
        .destroying, .destroyed => {
            return;
        },
        .idle => {},
    }

    worker_handle.destroy_state = .destroying;
    var completed = false;
    defer {
        worker_handle.destroy_state = if (completed) .destroyed else .idle;
    }

    if (worker_handle.core_worker == null) {
        releaseHandle(worker_handle);
        worker_handle.core_worker = null;
        completed = true;
        errors.setLastError(""[0..0]);
        return;
    }

    const core_worker_ptr = worker_handle.core_worker.?;
    core.ensureExternalApiInstalled();

    core.api.worker_initiate_shutdown(core_worker_ptr);

    var state = ShutdownState{};
    defer state.wait_group.reset();
    state.wait_group.start();

    core.api.worker_finalize_shutdown(
        core_worker_ptr,
        @as(?*anyopaque, @ptrCast(&state)),
        workerFinalizeCallback,
    );

    state.wait_group.wait();

    if (state.fail_ptr) |fail| {
        const runtime_handle = worker_handle.runtime;
        const message = byteArraySlice(fail);
        const description = if (message.len > 0)
            message
        else
            "temporal-bun-bridge-zig: worker shutdown failed";

        errors.setStructuredErrorJson(.{
            .code = grpc.internal,
            .message = description,
            .details = null,
        });

        if (runtime_handle) |runtime_ptr| {
            if (runtime_ptr.core_runtime) |core_runtime_ptr| {
                core.runtimeByteArrayFree(core_runtime_ptr, fail);
            } else {
                core.runtimeByteArrayFree(null, fail);
            }
        } else {
            core.runtimeByteArrayFree(null, fail);
        }

        return;
    }

    core.api.worker_free(core_worker_ptr);
    worker_handle.core_worker = null;
    releaseHandle(worker_handle);
    completed = true;
    errors.setLastError(""[0..0]);
}

pub fn createTestHandle() ?*WorkerHandle {
    const allocator = std.heap.c_allocator;
    const handle = allocator.create(WorkerHandle) catch {
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker test handle",
        });
        return null;
    };

    const id = next_worker_id;
    next_worker_id += 1;

    handle.* = .{
        .id = id,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .namespace = ""[0..0],
        .task_queue = ""[0..0],
        .identity = ""[0..0],
        .core_worker = null,
        .destroy_state = .idle,
        .buffers_released = false,
    };

    errors.setLastError(""[0..0]);
    return handle;
}

pub fn releaseTestHandle(handle: ?*WorkerHandle) void {
    if (handle == null) {
        return;
    }

    const allocator = std.heap.c_allocator;
    const worker_handle = handle.?;
    releaseHandle(worker_handle);
    allocator.destroy(worker_handle);
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

const ShutdownState = struct {
    wait_group: std.Thread.WaitGroup = .{},
    fail_ptr: ?*const core.ByteArray = null,
};

fn workerFinalizeCallback(user_data: ?*anyopaque, fail_ptr: ?*const core.ByteArray) callconv(.c) void {
    if (user_data == null) {
        return;
    }

    const state_ptr = @as(*ShutdownState, @ptrCast(@alignCast(user_data.?)));
    state_ptr.fail_ptr = fail_ptr;
    state_ptr.wait_group.finish();
}

const FinalizeMode = enum {
    success,
    fail,
};

const TestHookState = struct {
    initiate_calls: usize = 0,
    finalize_calls: usize = 0,
    free_calls: usize = 0,
    finalize_mode: FinalizeMode = .success,
    finalize_fail_ptr: ?*const core.ByteArray = null,
};

var test_hooks = TestHookState{};
var runtime_free_calls: usize = 0;
var runtime_free_last_runtime: ?*core.RuntimeOpaque = null;
var runtime_free_last_fail: ?*const core.ByteArray = null;

fn resetTestHooks() void {
    test_hooks = .{};
    runtime_free_calls = 0;
    runtime_free_last_runtime = null;
    runtime_free_last_fail = null;
}

fn testWorkerInitiateShutdownStub(_worker: ?*core.WorkerOpaque) callconv(.c) void {
    _ = _worker;
    test_hooks.initiate_calls += 1;
}

fn testWorkerFinalizeShutdownStub(
    _worker: ?*core.WorkerOpaque,
    user_data: ?*anyopaque,
    callback: core.WorkerCallback,
) callconv(.c) void {
    _ = _worker;
    test_hooks.finalize_calls += 1;
    if (callback) |cb| {
        switch (test_hooks.finalize_mode) {
            .success => cb(user_data, null),
            .fail => cb(user_data, test_hooks.finalize_fail_ptr),
        }
    }
}

fn testWorkerFreeStub(_worker: ?*core.WorkerOpaque) callconv(.c) void {
    _ = _worker;
    test_hooks.free_calls += 1;
}

fn testRuntimeByteArrayFreeStub(runtime_ptr: ?*core.RuntimeOpaque, fail_ptr: ?*const core.ByteArray) callconv(.c) void {
    runtime_free_calls += 1;
    runtime_free_last_runtime = runtime_ptr;
    runtime_free_last_fail = fail_ptr;
}

test "worker destroy performs single shutdown finalize and free" {
    resetTestHooks();
    test_hooks.finalize_mode = .success;
    test_hooks.finalize_fail_ptr = null;

    const original_api = core.api;
    const original_runtime_byte_array_free = core.runtime_byte_array_free;
    defer {
        core.api = original_api;
        core.runtime_byte_array_free = original_runtime_byte_array_free;
    }

    core.ensureExternalApiInstalled();
    var api = core.stub_api;
    api.worker_initiate_shutdown = testWorkerInitiateShutdownStub;
    api.worker_finalize_shutdown = testWorkerFinalizeShutdownStub;
    api.worker_free = testWorkerFreeStub;
    core.api = api;
    core.runtime_byte_array_free = testRuntimeByteArrayFreeStub;

    var worker_storage: [1]u8 align(@alignOf(core.WorkerOpaque)) = undefined;

    var handle = WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .namespace = ""[0..0],
        .task_queue = ""[0..0],
        .identity = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&worker_storage)),
        .destroy_state = .idle,
        .buffers_released = false,
    };

    destroy(&handle);

    try testing.expectEqual(@as(usize, 1), test_hooks.initiate_calls);
    try testing.expectEqual(@as(usize, 1), test_hooks.finalize_calls);
    try testing.expectEqual(@as(usize, 1), test_hooks.free_calls);
    try testing.expectEqual(@as(usize, 0), runtime_free_calls);
    try testing.expect(handle.core_worker == null);
    try testing.expect(handle.buffers_released);
    try testing.expectEqual(@as(usize, 0), handle.config.len);
    try testing.expectEqual(@as(usize, 0), handle.namespace.len);
    try testing.expectEqual(@as(usize, 0), handle.task_queue.len);
    try testing.expectEqual(@as(usize, 0), handle.identity.len);
    try testing.expect(handle.destroy_state == .destroyed);
}

test "worker destroy is idempotent for double invocation and null handle" {
    resetTestHooks();
    test_hooks.finalize_mode = .success;
    test_hooks.finalize_fail_ptr = null;

    const original_api = core.api;
    const original_runtime_byte_array_free = core.runtime_byte_array_free;
    defer {
        core.api = original_api;
        core.runtime_byte_array_free = original_runtime_byte_array_free;
    }

    core.ensureExternalApiInstalled();
    var api = core.stub_api;
    api.worker_initiate_shutdown = testWorkerInitiateShutdownStub;
    api.worker_finalize_shutdown = testWorkerFinalizeShutdownStub;
    api.worker_free = testWorkerFreeStub;
    core.api = api;
    core.runtime_byte_array_free = testRuntimeByteArrayFreeStub;

    var worker_storage: [1]u8 align(@alignOf(core.WorkerOpaque)) = undefined;

    var handle = WorkerHandle{
        .id = 2,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .namespace = ""[0..0],
        .task_queue = ""[0..0],
        .identity = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&worker_storage)),
        .destroy_state = .idle,
        .buffers_released = false,
    };

    destroy(&handle);
    destroy(&handle);
    destroy(null);

    try testing.expectEqual(@as(usize, 1), test_hooks.initiate_calls);
    try testing.expectEqual(@as(usize, 1), test_hooks.finalize_calls);
    try testing.expectEqual(@as(usize, 1), test_hooks.free_calls);
    try testing.expectEqual(@as(usize, 0), runtime_free_calls);
    try testing.expect(handle.destroy_state == .destroyed);
    try testing.expect(handle.core_worker == null);
    try testing.expect(handle.buffers_released);
}

test "worker destroy frees finalize error buffers" {
    resetTestHooks();
    test_hooks.finalize_mode = .fail;

    const original_api = core.api;
    const original_runtime_byte_array_free = core.runtime_byte_array_free;
    defer {
        core.api = original_api;
        core.runtime_byte_array_free = original_runtime_byte_array_free;
    }

    core.ensureExternalApiInstalled();
    var api = core.stub_api;
    api.worker_initiate_shutdown = testWorkerInitiateShutdownStub;
    api.worker_finalize_shutdown = testWorkerFinalizeShutdownStub;
    api.worker_free = testWorkerFreeStub;
    core.api = api;
    core.runtime_byte_array_free = testRuntimeByteArrayFreeStub;

    var worker_storage: [1]u8 align(@alignOf(core.WorkerOpaque)) = undefined;
    const error_message = "synthetic finalize failure";
    var error_array = core.ByteArray{
        .data = error_message.ptr,
        .size = error_message.len,
        .cap = error_message.len,
        .disable_free = true,
    };
    test_hooks.finalize_fail_ptr = &error_array;

    var runtime_core_storage: [1]u8 align(@alignOf(core.RuntimeOpaque)) = undefined;
    var runtime_handle_instance = runtime.RuntimeHandle{
        .id = 3,
        .config = ""[0..0],
        .core_runtime = @as(?*core.RuntimeOpaque, @ptrCast(&runtime_core_storage)),
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    var handle = WorkerHandle{
        .id = 3,
        .runtime = &runtime_handle_instance,
        .client = null,
        .config = ""[0..0],
        .namespace = ""[0..0],
        .task_queue = ""[0..0],
        .identity = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&worker_storage)),
        .destroy_state = .idle,
        .buffers_released = false,
    };

    destroy(&handle);

    try testing.expectEqual(@as(usize, 1), test_hooks.initiate_calls);
    try testing.expectEqual(@as(usize, 1), test_hooks.finalize_calls);
    try testing.expectEqual(@as(usize, 0), test_hooks.free_calls);
    try testing.expectEqual(@as(usize, 1), runtime_free_calls);
    try testing.expectEqual(runtime_handle_instance.core_runtime, runtime_free_last_runtime);
    try testing.expect(runtime_free_last_fail != null);
    try testing.expect(handle.destroy_state == .idle);
    try testing.expect(handle.core_worker != null);
    try testing.expect(!handle.buffers_released);
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
            .namespace = ""[0..0],
            .task_queue = ""[0..0],
            .identity = ""[0..0],
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
