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

const DestroyState = enum(u8) {
    idle,
    shutdown_requested,
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
    build_id: []u8,
    core_worker: ?*core.WorkerOpaque,
    poll_lock: std.Thread.Mutex = .{},
    poll_condition: std.Thread.Condition = .{},
    pending_polls: usize = 0,
    destroy_state: DestroyState = .idle,
    shutdown_initiating: bool = false,
    buffers_released: bool = false,
    owns_allocation: bool = false,
    destroy_reclaims_allocation: bool = false,
};

pub const WorkerReplayHandle = struct {
    worker: ?*WorkerHandle,
    replay_pusher: ?*core.WorkerReplayPusher,
};

var next_worker_id: u64 = 1;
const default_identity = "temporal-bun-worker";
const default_workflow_poller_simple = core.WorkerPollerBehaviorSimpleMaximum{
    .simple_maximum = 20,
};
const default_activity_poller_simple = core.WorkerPollerBehaviorSimpleMaximum{
    .simple_maximum = 20,
};
const default_nexus_poller_simple = core.WorkerPollerBehaviorSimpleMaximum{
    .simple_maximum = 4,
};
const default_workflow_poller_behavior = core.WorkerPollerBehavior{
    .simple_maximum = &default_workflow_poller_simple,
    .autoscaling = null,
};
const default_activity_poller_behavior = core.WorkerPollerBehavior{
    .simple_maximum = &default_activity_poller_simple,
    .autoscaling = null,
};
const default_nexus_poller_behavior = core.WorkerPollerBehavior{
    .simple_maximum = &default_nexus_poller_simple,
    .autoscaling = null,
};

const debug_ptr_env_name = "BUN_SDK_DEBUG_PTR";
const debug_ptr_state_uninitialized: u8 = 0;
const debug_ptr_state_disabled: u8 = 1;
const debug_ptr_state_enabled: u8 = 2;
var debug_ptr_state = std.atomic.Value(u8).init(debug_ptr_state_uninitialized);
const worker_pointer_mismatch_message =
    "temporal-bun-bridge-zig: worker pointer mismatch";

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

fn duplicateBytesNullTerminated(slice: []const u8) ?[]u8 {
    if (slice.len == 0) {
        return ""[0..0];
    }

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, slice.len + 1) catch {
        return null;
    };
    @memcpy(copy[0..slice.len], slice);
    copy[slice.len] = 0;
    return copy;
}

fn computeDebugPtrEnabled() bool {
    const allocator = std.heap.c_allocator;
    const value = std.process.getEnvVarOwned(allocator, debug_ptr_env_name) catch {
        return false;
    };
    defer allocator.free(value);

    const trimmed = std.mem.trim(u8, value, " \n\r\t");
    if (trimmed.len == 0) {
        return false;
    }

    if (std.ascii.eqlIgnoreCase(trimmed, "0") or std.ascii.eqlIgnoreCase(trimmed, "false") or std.ascii.eqlIgnoreCase(trimmed, "off")) {
        return false;
    }

    return true;
}

fn debugPtrEnabled() bool {
    const state = debug_ptr_state.load(.acquire);
    if (state == debug_ptr_state_uninitialized) {
        const enabled = computeDebugPtrEnabled();
        debug_ptr_state.store(
            if (enabled) debug_ptr_state_enabled else debug_ptr_state_disabled,
            .release,
        );
        return enabled;
    }

    return state == debug_ptr_state_enabled;
}

fn debugPrintWorkerPtr(label: []const u8, worker_ptr: ?*core.WorkerOpaque) void {
    if (!debugPtrEnabled()) {
        return;
    }

    const ptr = worker_ptr orelse return;
    std.debug.print("{s}=0x{x}\n", .{ label, @intFromPtr(ptr) });
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
    if (handle.build_id.len > 0) {
        allocator.free(handle.build_id);
        handle.build_id = ""[0..0];
    }

    if (handle.runtime) |runtime_handle| {
        runtime.unregisterWorker(runtime_handle);
    }

    handle.runtime = null;
    handle.client = null;
    handle.buffers_released = true;
    handle.owns_allocation = false;
    handle.destroy_reclaims_allocation = false;
}

const FinalizeCleanupMode = enum {
    release_allocation,
    preserve_allocation,
};

const FinalizeOutcome = enum {
    success,
    already_finalized,
    failure,
};

fn finalizeWorkerShutdown(
    worker_handle: *WorkerHandle,
    should_initiate_core_shutdown: bool,
    cleanup_mode: FinalizeCleanupMode,
) FinalizeOutcome {
    const original_owns_allocation = worker_handle.owns_allocation;
    const original_destroy_reclaims_allocation = worker_handle.destroy_reclaims_allocation;

    if (worker_handle.core_worker == null) {
        releaseHandle(worker_handle);
        if (cleanup_mode == .preserve_allocation) {
            worker_handle.owns_allocation = original_owns_allocation;
            worker_handle.destroy_reclaims_allocation = original_destroy_reclaims_allocation;
        }
        errors.setLastError(""[0..0]);
        return .already_finalized;
    }

    const core_worker_ptr = worker_handle.core_worker.?;
    core.ensureExternalApiInstalled();

    if (should_initiate_core_shutdown) {
        core.api.worker_initiate_shutdown(core_worker_ptr);
    }

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
        const base_description = "temporal-bun-bridge-zig: worker shutdown failed";
        var description_slice: []const u8 = base_description;
        var allocated_description: ?[]u8 = null;

        if (message.len > 0) {
            allocated_description = std.fmt.allocPrint(std.heap.c_allocator, "{s}: {s}", .{ base_description, message }) catch null;
            if (allocated_description) |buffer| {
                description_slice = buffer;
            }
        }

        errors.setStructuredErrorJson(.{
            .code = grpc.internal,
            .message = description_slice,
            .details = null,
        });

        if (allocated_description) |buffer| {
            std.heap.c_allocator.free(buffer);
        }

        if (runtime_handle) |runtime_ptr| {
            if (runtime_ptr.core_runtime) |core_runtime_ptr| {
                core.runtimeByteArrayFree(core_runtime_ptr, fail);
            } else {
                core.runtimeByteArrayFree(null, fail);
            }
        } else {
            core.runtimeByteArrayFree(null, fail);
        }

        return .failure;
    }

    core.api.worker_free(core_worker_ptr);
    worker_handle.core_worker = null;

    releaseHandle(worker_handle);
    if (cleanup_mode == .preserve_allocation) {
        worker_handle.owns_allocation = original_owns_allocation;
        worker_handle.destroy_reclaims_allocation = original_destroy_reclaims_allocation;
    }

    errors.setLastError(""[0..0]);
    return .success;
}

/// Pollers must secure a permit before invoking core APIs so shutdown fences new work.
fn acquirePollPermit(handle: *WorkerHandle) bool {
    handle.poll_lock.lock();
    defer handle.poll_lock.unlock();

    if (handle.destroy_state != .idle) {
        return false;
    }

    handle.pending_polls += 1;
    return true;
}

fn releasePollPermit(handle: *WorkerHandle) void {
    handle.poll_lock.lock();
    defer handle.poll_lock.unlock();

    if (handle.pending_polls > 0) {
        handle.pending_polls -= 1;
    }

    if (handle.pending_polls == 0) {
        handle.poll_condition.broadcast();
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

const PollWorkflowTaskContext = struct {
    allocator: std.mem.Allocator,
    pending_handle: *pending.PendingByteArray,
    worker_handle: *WorkerHandle,
    runtime_handle: *runtime.RuntimeHandle,
    core_worker: *core.WorkerOpaque,
    core_runtime: *core.RuntimeOpaque,
    wait_group: std.Thread.WaitGroup = .{},
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
    const poll_ptr = context.core_worker;
    if (context.worker_handle.core_worker) |register_ptr| {
        if (register_ptr != poll_ptr) {
            if (debugPtrEnabled()) {
                std.debug.print("worker@register=0x{x}\n", .{@intFromPtr(register_ptr)});
                std.debug.print("worker@poll=0x{x}\n", .{@intFromPtr(poll_ptr)});
            }
            errors.setStructuredError(.{
                .code = grpc.internal,
                .message = worker_pointer_mismatch_message,
            });
            _ = pending.rejectByteArray(
                context.pending_handle,
                grpc.internal,
                worker_pointer_mismatch_message,
            );
            pending.release(context.pending_handle);
            releasePollPermit(context.worker_handle);
            context.allocator.destroy(context);
            return;
        }
    }

    if (debugPtrEnabled()) {
        std.debug.print("worker@poll=0x{x}\n", .{@intFromPtr(poll_ptr)});
    }

    context.wait_group.start();
    core.api.worker_poll_workflow_activation(
        context.core_worker,
        @as(?*anyopaque, @ptrCast(context)),
        pollWorkflowTaskCallback,
    );
    context.wait_group.wait();
    pending.release(context.pending_handle);
    releasePollPermit(context.worker_handle);
    context.allocator.destroy(context);
}

fn runPollWorkflowTask(context: ?*anyopaque) void {
    const raw = context orelse return;
    const ctx = @as(*PollWorkflowTaskContext, @ptrCast(@alignCast(raw)));
    pollWorkflowTaskWorker(ctx);
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

    const build_id_lookup = lookupStringField(&obj, &.{ "buildId", "build_id" });
    if (!build_id_lookup.found) {
        if (identity_copy.len > 0) {
            allocator.free(identity_copy);
        }
        allocator.free(task_queue_copy);
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker config missing buildId",
        });
        return null;
    }
    if (build_id_lookup.invalid_type or build_id_lookup.value == null) {
        if (identity_copy.len > 0) {
            allocator.free(identity_copy);
        }
        allocator.free(task_queue_copy);
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker buildId must be a string",
        });
        return null;
    }
    const build_id_slice = build_id_lookup.value.?;
    if (build_id_slice.len == 0) {
        if (identity_copy.len > 0) {
            allocator.free(identity_copy);
        }
        allocator.free(task_queue_copy);
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker buildId must be non-empty",
        });
        return null;
    }

    const build_id_copy = duplicateBytesNullTerminated(build_id_slice) orelse {
        if (identity_copy.len > 0) {
            allocator.free(identity_copy);
        }
        allocator.free(task_queue_copy);
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker buildId",
        });
        return null;
    };
    const build_id_ref_slice = build_id_copy[0..build_id_slice.len];

    core.ensureExternalApiInstalled();

    var options: core.WorkerOptions = undefined;
    @memset(std.mem.asBytes(&options), 0);
    options.namespace_ = makeByteArrayRef(namespace_copy);
    options.task_queue = makeByteArrayRef(task_queue_copy);
    options.identity_override = makeByteArrayRef(identity_slice);
    options.versioning_strategy.tag = @as(@TypeOf(options.versioning_strategy.tag), 1); // DeploymentBased
    const deployment_versioning = &options.versioning_strategy.unnamed_0.unnamed_1.deployment_based;
    deployment_versioning.version.deployment_name = makeByteArrayRef(build_id_ref_slice);
    deployment_versioning.version.build_id = makeByteArrayRef(build_id_ref_slice);
    deployment_versioning.use_worker_versioning = true;
    deployment_versioning.default_versioning_behavior = 0; // Unspecified; server defaults apply
    options.nondeterminism_as_workflow_fail_for_types = .{
        .data = null,
        .size = 0,
    };
    options.workflow_task_poller_behavior = default_workflow_poller_behavior;
    options.activity_task_poller_behavior = default_activity_poller_behavior;
    options.nexus_task_poller_behavior = default_nexus_poller_behavior;

    const result = core.api.worker_new(client_handle.core_client, &options);
    debugPrintWorkerPtr("worker@register", result.worker);

    if (result.worker == null) {
        if (identity_copy.len > 0) {
            allocator.free(identity_copy);
        }
        allocator.free(build_id_copy);
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
        allocator.free(build_id_copy);
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
        .build_id = build_id_copy,
        .core_worker = result.worker,
        .owns_allocation = true,
        .destroy_reclaims_allocation = true,
    };

    if (!runtime.registerWorker(runtime_handle)) {
        handle.runtime = null;
        releaseHandle(handle);
        core.api.worker_free(result.worker);
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
        });
        return null;
    }

    if (result.fail) |fail_ptr| {
        core.api.byte_array_free(runtime_handle.core_runtime, fail_ptr);
    }

    errors.setLastError(""[0..0]);
    return handle;
}

pub fn createReplay(
    runtime_ptr: ?*runtime.RuntimeHandle,
    config_json: []const u8,
) ?*WorkerReplayHandle {
    if (runtime_ptr == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker replay creation received null runtime handle",
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

    const config_copy = duplicateConfig(config_json) orelse {
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker replay config",
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
            .message = "temporal-bun-bridge-zig: worker replay config is not valid JSON",
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
            .message = "temporal-bun-bridge-zig: worker replay config must be a JSON object",
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
            .message = "temporal-bun-bridge-zig: worker replay config missing namespace",
        });
        return null;
    }
    if (namespace_lookup.invalid_type or namespace_lookup.value == null) {
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker replay namespace must be a string",
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
            .message = "temporal-bun-bridge-zig: worker replay namespace must be non-empty",
        });
        return null;
    }

    const namespace_copy = duplicateBytes(namespace_slice) orelse {
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate worker replay namespace",
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
            .message = "temporal-bun-bridge-zig: worker replay config missing taskQueue",
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
            .message = "temporal-bun-bridge-zig: worker replay taskQueue must be a string",
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
            .message = "temporal-bun-bridge-zig: worker replay taskQueue must be non-empty",
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
            .message = "temporal-bun-bridge-zig: failed to allocate worker replay taskQueue",
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
            .message = "temporal-bun-bridge-zig: worker replay identity must be a string when provided",
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
                .message = "temporal-bun-bridge-zig: failed to allocate worker replay identity",
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
    options.max_cached_workflows = 16;

    const result = core.api.worker_replayer_new(runtime_handle.core_runtime, &options);

    if (result.worker == null or result.worker_replay_pusher == null) {
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

        const fallback_message = "temporal-bun-bridge-zig: Temporal core worker replay creation failed";
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
        if (result.worker_replay_pusher) |pusher_ptr| {
            core.api.worker_replay_pusher_free(pusher_ptr);
        }
        if (result.worker) |worker_ptr| {
            core.api.worker_free(worker_ptr);
        }
        return null;
    }

    const handle = allocator.create(WorkerHandle) catch |err| {
        core.api.worker_replay_pusher_free(result.worker_replay_pusher);
        core.api.worker_free(result.worker);
        if (identity_copy.len > 0) {
            allocator.free(identity_copy);
        }
        allocator.free(task_queue_copy);
        allocator.free(namespace_copy);
        if (config_copy.len > 0) {
            allocator.free(config_copy);
        }
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate worker replay handle: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate worker replay handle";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        if (result.fail) |fail_ptr| {
            core.api.byte_array_free(runtime_handle.core_runtime, fail_ptr);
        }
        return null;
    };

    const id = next_worker_id;
    next_worker_id += 1;

    handle.* = .{
        .id = id,
        .runtime = runtime_ptr,
        .client = null,
        .config = config_copy,
        .namespace = namespace_copy,
        .task_queue = task_queue_copy,
        .identity = identity_copy,
        .build_id = ""[0..0],
        .core_worker = result.worker,
        .owns_allocation = true,
        .destroy_reclaims_allocation = true,
    };

    if (!runtime.registerWorker(runtime_handle)) {
        handle.runtime = null;
        releaseHandle(handle);
        core.api.worker_free(result.worker);
        core.api.worker_replay_pusher_free(result.worker_replay_pusher);
        allocator.destroy(handle);
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
        });
        if (result.fail) |fail_ptr| {
            core.api.byte_array_free(runtime_handle.core_runtime, fail_ptr);
        }
        return null;
    }

    if (result.fail) |fail_ptr| {
        core.api.byte_array_free(runtime_handle.core_runtime, fail_ptr);
    }

    const replay_handle = allocator.create(WorkerReplayHandle) catch |err| {
        runtime.unregisterWorker(runtime_handle);
        handle.runtime = null;
        releaseHandle(handle);
        core.api.worker_free(result.worker);
        core.api.worker_replay_pusher_free(result.worker_replay_pusher);
        allocator.destroy(handle);
        var scratch: [176]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate worker replay container: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate worker replay container";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        return null;
    };

    replay_handle.* = .{
        .worker = handle,
        .replay_pusher = result.worker_replay_pusher,
    };

    errors.setLastError(""[0..0]);
    return replay_handle;
}

pub fn destroy(handle: ?*WorkerHandle) i32 {
    if (handle == null) {
        return 0;
    }

    const worker_handle = handle.?;
    var should_initiate_core_shutdown = false;

    worker_handle.poll_lock.lock();

    switch (worker_handle.destroy_state) {
        .destroyed => {
            const should_free = worker_handle.owns_allocation and worker_handle.destroy_reclaims_allocation;
            if (should_free) {
                worker_handle.owns_allocation = false;
                worker_handle.destroy_reclaims_allocation = false;
            }
            worker_handle.poll_lock.unlock();
            if (should_free) {
                std.heap.c_allocator.destroy(worker_handle);
            }
            return 0;
        },
        .destroying => {
            worker_handle.poll_lock.unlock();
            return 0;
        },
        .shutdown_requested => {
            while (worker_handle.shutdown_initiating) {
                worker_handle.poll_condition.wait(&worker_handle.poll_lock);
            }
            worker_handle.destroy_state = .destroying;
        },
        .idle => {
            worker_handle.destroy_state = .destroying;
            should_initiate_core_shutdown = true;
        },
    }

    while (worker_handle.pending_polls != 0) {
        worker_handle.poll_condition.wait(&worker_handle.poll_lock);
    }
    worker_handle.poll_lock.unlock();

    var completed = false;
    const owns_allocation = worker_handle.owns_allocation;
    const destroy_reclaims_allocation = worker_handle.destroy_reclaims_allocation;
    defer {
        worker_handle.poll_lock.lock();
        worker_handle.destroy_state = if (completed) .destroyed else .idle;
        worker_handle.shutdown_initiating = false;
        worker_handle.poll_condition.broadcast();
        worker_handle.poll_lock.unlock();
        if (completed and owns_allocation and destroy_reclaims_allocation) {
            worker_handle.owns_allocation = false;
            worker_handle.destroy_reclaims_allocation = false;
            std.heap.c_allocator.destroy(worker_handle);
        }
    }

    const result = finalizeWorkerShutdown(worker_handle, should_initiate_core_shutdown, .release_allocation);
    switch (result) {
        .success, .already_finalized => {
            completed = true;
            return 0;
        },
        .failure => {
            return -1;
        },
    }
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
        .build_id = ""[0..0],
        .core_worker = null,
        .poll_lock = .{},
        .poll_condition = .{},
        .pending_polls = 0,
        .destroy_state = .idle,
        .shutdown_initiating = false,
        .buffers_released = false,
        .owns_allocation = true,
        .destroy_reclaims_allocation = false,
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
    worker_handle.owns_allocation = false;
    worker_handle.destroy_reclaims_allocation = false;
    allocator.destroy(worker_handle);
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

    // Poll loops must respect shutdown gating; no core poll without a permit.
    if (!acquirePollPermit(worker_handle)) {
        return pendingByteArrayError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker is shutting down",
        );
    }
    var permit_transferred = false;
    defer {
        if (!permit_transferred) {
            releasePollPermit(worker_handle);
        }
    }

    core.ensureExternalApiInstalled();

    const raw_pending_handle = pending.createPendingInFlight() orelse {
        return pendingByteArrayError(
            grpc.internal,
            "temporal-bun-bridge-zig: failed to allocate workflow poll handle",
        );
    };
    const pending_base: *pending.PendingHandle = raw_pending_handle;
    const pending_handle_ptr: *pending.PendingByteArray = @ptrCast(pending_base);

    if (!pending.retain(pending_base)) {
        const message =
            "temporal-bun-bridge-zig: failed to retain workflow poll pending handle";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        _ = pending.rejectByteArray(pending_handle_ptr, grpc.resource_exhausted, message);
        return pending_handle_ptr;
    }

    const allocator = std.heap.c_allocator;
    const context = allocator.create(PollWorkflowTaskContext) catch |err| {
        pending.release(pending_base);
        releasePollPermit(worker_handle);
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

    const context_any: ?*anyopaque = @as(?*anyopaque, @ptrCast(@alignCast(context)));
    runtime.schedulePendingTask(runtime_handle, .{
        .run = runPollWorkflowTask,
        .context = context_any,
    }) catch |err| switch (err) {
        runtime.SchedulePendingTaskError.ShuttingDown => {
            allocator.destroy(context);
            pending.release(pending_base);
            const message = "temporal-bun-bridge-zig: runtime is shutting down";
            errors.setStructuredError(.{ .code = grpc.failed_precondition, .message = message });
            _ = pending.rejectByteArray(pending_handle_ptr, grpc.failed_precondition, message);
            return pending_handle_ptr;
        },
        runtime.SchedulePendingTaskError.ExecutorUnavailable => {
            allocator.destroy(context);
            pending.release(pending_base);
            var scratch: [176]u8 = undefined;
            const message = std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: pending executor unavailable",
                .{},
            ) catch "temporal-bun-bridge-zig: pending executor unavailable";
            errors.setStructuredError(.{ .code = grpc.internal, .message = message });
            _ = pending.rejectByteArray(pending_handle_ptr, grpc.internal, message);
            return pending_handle_ptr;
        },
    };
    permit_transferred = true;
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

pub fn destroyReplay(handle: ?*WorkerReplayHandle) i32 {
    if (handle == null) {
        return 0;
    }

    const replay_handle = handle.?;
    const worker_handle = replay_handle.worker;
    if (worker_handle) |worker_ptr| {
        const result = destroy(worker_ptr);
        if (result != 0) {
            return result;
        }
        replay_handle.worker = null;
    }

    if (replay_handle.replay_pusher) |pusher| {
        core.ensureExternalApiInstalled();
        core.api.worker_replay_pusher_free(pusher);
        replay_handle.replay_pusher = null;
    }

    std.heap.c_allocator.destroy(replay_handle);
    return 0;
}

pub fn pushReplayHistory(
    handle: ?*WorkerReplayHandle,
    workflow_id: []const u8,
    history: []const u8,
) i32 {
    if (handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker replay push received null handle",
            .details = null,
        });
        return -1;
    }

    const replay_handle = handle.?;
    const worker_handle = replay_handle.worker orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: worker replay push requires initialized worker",
            .details = null,
        });
        return -1;
    };

    const core_worker_ptr = worker_handle.core_worker orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: worker replay push missing core worker",
            .details = null,
        });
        return -1;
    };

    const runtime_handle = worker_handle.runtime orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: worker replay runtime handle is not initialized",
            .details = null,
        });
        return -1;
    };

    const core_runtime_ptr = runtime_handle.core_runtime orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: worker replay runtime core handle is not initialized",
            .details = null,
        });
        return -1;
    };

    const replay_pusher = replay_handle.replay_pusher orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: worker replay push missing replay pusher",
            .details = null,
        });
        return -1;
    };

    if (workflow_id.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker replay workflowId must be non-empty",
            .details = null,
        });
        return -1;
    }

    if (history.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: worker replay history payload must be non-empty",
            .details = null,
        });
        return -1;
    }

    core.ensureExternalApiInstalled();

    const result = core.api.worker_replay_push(
        core_worker_ptr,
        replay_pusher,
        makeByteArrayRef(workflow_id),
        makeByteArrayRef(history),
    );

    if (result.fail) |fail_ptr| {
        const failure_slice = byteArraySlice(fail_ptr);
        const parsed_fail = parseWorkerFailPayload(failure_slice);

        const fallback_message = "temporal-bun-bridge-zig: Temporal worker replay push failed";
        const error_message = if (parsed_fail.message.len > 0) parsed_fail.message else fallback_message;
        const error_details = parsed_fail.details;

        errors.setStructuredErrorJson(.{
            .code = parsed_fail.code,
            .message = error_message,
            .details = error_details,
        });

        if (parsed_fail.details_allocated and parsed_fail.details != null) {
            std.heap.c_allocator.free(@constCast(parsed_fail.details.?));
        }
        if (parsed_fail.message_allocated) {
            std.heap.c_allocator.free(@constCast(parsed_fail.message));
        }

        core.api.byte_array_free(core_runtime_ptr, fail_ptr);
        return -1;
    }

    errors.setLastError(""[0..0]);
    return 0;
}

pub fn replayWorkerHandle(handle: ?*WorkerReplayHandle) ?*WorkerHandle {
    if (handle == null) {
        return null;
    }
    return handle.?.worker;
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

const ActivityPollContext = struct {
    pending_handle: *pending.PendingByteArray,
    runtime_handle: *runtime.RuntimeHandle,
    core_runtime: *core.RuntimeOpaque,
    wait_group: std.Thread.WaitGroup = .{},
};

const ActivityPollTask = struct {
    worker_handle: ?*WorkerHandle,
    pending_handle: *pending.PendingByteArray,
};

fn workerPollActivityCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    fail: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) {
        return;
    }

    const context = @as(*ActivityPollContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    const pending_handle = context.pending_handle;
    const runtime_ptr = context.core_runtime;

    if (success == null and fail == null) {
        const array_opt = byte_array.allocateFromSlice(""[0..0]);
        if (array_opt == null) {
            _ = pending.rejectByteArray(
                pending_handle,
                grpc.resource_exhausted,
                "temporal-bun-bridge-zig: failed to allocate shutdown poll payload",
            );
            return;
        }

        const array = array_opt.?;
        if (!pending.resolveByteArray(pending_handle, array)) {
            byte_array.free(array);
            return;
        }

        errors.setLastError(""[0..0]);
        return;
    }

    if (success) |success_ptr| {
        defer core.runtimeByteArrayFree(runtime_ptr, success_ptr);

        const payload = byteArraySlice(success_ptr);
        const array_opt = byte_array.allocateFromSlice(payload);
        if (array_opt == null) {
            _ = pending.rejectByteArray(
                pending_handle,
                grpc.resource_exhausted,
                "temporal-bun-bridge-zig: failed to allocate activity task payload",
            );
            return;
        }

        const array = array_opt.?;
        if (!pending.resolveByteArray(pending_handle, array)) {
            byte_array.free(array);
            return;
        }

        errors.setLastError(""[0..0]);
        return;
    }

    if (fail) |fail_ptr| {
        defer core.runtimeByteArrayFree(runtime_ptr, fail_ptr);

        const failure_slice = byteArraySlice(fail_ptr);
        const parsed = parseWorkerFailPayload(failure_slice);

        const allocator = std.heap.c_allocator;
        defer {
            if (parsed.details_allocated and parsed.details != null) {
                allocator.free(@constCast(parsed.details.?));
            }
            if (parsed.message_allocated) {
                allocator.free(@constCast(parsed.message));
            }
        }

        const message = if (parsed.message.len > 0)
            parsed.message
        else
            "temporal-bun-bridge-zig: activity poll failed";

        _ = pending.rejectByteArray(pending_handle, parsed.code, message);
        return;
    }

    _ = pending.rejectByteArray(
        pending_handle,
        grpc.internal,
        "temporal-bun-bridge-zig: activity poll returned unexpected payload state",
    );
}

fn pollActivityTaskWorker(task: *ActivityPollTask) void {
    const allocator = std.heap.c_allocator;
    defer allocator.destroy(task);

    const pending_handle = task.pending_handle;
    const pending_base = @as(*pending.PendingHandle, @ptrCast(pending_handle));
    defer pending.release(pending_base);

    const worker_ptr_opt = task.worker_handle;
    defer {
        if (worker_ptr_opt) |wh| {
            releasePollPermit(wh);
        }
    }

    const worker_handle = worker_ptr_opt orelse {
        _ = pending.rejectByteArray(
            pending_handle,
            grpc.internal,
            "temporal-bun-bridge-zig: activity poll worker missing handle",
        );
        return;
    };

    const runtime_handle = worker_handle.runtime orelse {
        _ = pending.rejectByteArray(
            pending_handle,
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker runtime handle is not initialized",
        );
        return;
    };

    const runtime_core = runtime_handle.core_runtime orelse {
        _ = pending.rejectByteArray(
            pending_handle,
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker runtime core handle is not initialized",
        );
        return;
    };

    const core_worker = worker_handle.core_worker orelse {
        _ = pending.rejectByteArray(
            pending_handle,
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker core handle is not initialized",
        );
        return;
    };

    var context = ActivityPollContext{
        .pending_handle = pending_handle,
        .runtime_handle = runtime_handle,
        .core_runtime = runtime_core,
    };
    context.wait_group.start();

    core.api.worker_poll_activity_task(core_worker, &context, workerPollActivityCallback);
    context.wait_group.wait();
}

pub fn pollActivityTask(_handle: ?*WorkerHandle) ?*pending.PendingByteArray {
    if (_handle == null) {
        return pendingByteArrayError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: pollActivityTask received null worker handle",
        );
    }

    const worker_handle = _handle.?;

    if (worker_handle.core_worker == null) {
        return pendingByteArrayError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker core handle is not initialized",
        );
    }

    const runtime_handle = worker_handle.runtime orelse {
        return pendingByteArrayError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker runtime handle is not initialized",
        );
    };

    if (runtime_handle.core_runtime == null) {
        return pendingByteArrayError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker runtime core handle is not initialized",
        );
    }

    // Poll loops must respect shutdown gating; no core poll without a permit.
    if (!acquirePollPermit(worker_handle)) {
        return pendingByteArrayError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: worker is shutting down",
        );
    }
    var permit_transferred = false;
    defer {
        if (!permit_transferred) {
            releasePollPermit(worker_handle);
        }
    }

    core.ensureExternalApiInstalled();

    const pending_base = pending.createPendingInFlight() orelse {
        return pendingByteArrayError(
            grpc.internal,
            "temporal-bun-bridge-zig: failed to allocate activity poll pending handle",
        );
    };
    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_base));

    const allocator = std.heap.c_allocator;
    const task = allocator.create(ActivityPollTask) catch |err| {
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate activity poll task: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate activity poll task";
        _ = pending.rejectByteArray(pending_handle, grpc.resource_exhausted, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    task.* = .{
        .worker_handle = worker_handle,
        .pending_handle = pending_handle,
    };

    if (!pending.retain(pending_base)) {
        allocator.destroy(task);
        _ = pending.rejectByteArray(
            pending_handle,
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to retain activity poll pending handle",
        );
        return @as(?*pending.PendingByteArray, pending_handle);
    }

    const context_any: ?*anyopaque = @as(?*anyopaque, @ptrCast(@alignCast(task)));
    runtime.schedulePendingTask(runtime_handle, .{
        .run = runPollActivityTask,
        .context = context_any,
    }) catch |err| switch (err) {
        runtime.SchedulePendingTaskError.ShuttingDown => {
            allocator.destroy(task);
            pending.release(pending_base);
            const message = "temporal-bun-bridge-zig: runtime is shutting down";
            errors.setStructuredError(.{ .code = grpc.failed_precondition, .message = message });
            _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, message);
            return @as(?*pending.PendingByteArray, pending_handle);
        },
        runtime.SchedulePendingTaskError.ExecutorUnavailable => {
            allocator.destroy(task);
            pending.release(pending_base);
            var scratch: [160]u8 = undefined;
            const message = std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: pending executor unavailable",
                .{},
            ) catch "temporal-bun-bridge-zig: pending executor unavailable";
            errors.setStructuredError(.{ .code = grpc.internal, .message = message });
            _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
            return @as(?*pending.PendingByteArray, pending_handle);
        },
    };
    permit_transferred = true;

    return @as(?*pending.PendingByteArray, pending_handle);
}

pub fn completeActivityTask(_handle: ?*WorkerHandle, _payload: []const u8) i32 {
    if (_handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: completeActivityTask received null worker handle",
            .details = null,
        });
        return -1;
    }

    const worker_handle = _handle.?;

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

    if (_payload.len == 0) {
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
        .data = _payload.ptr,
        .size = _payload.len,
    };

    core.workerCompleteActivityTask(
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

pub fn recordActivityHeartbeat(_handle: ?*WorkerHandle, _payload: []const u8) i32 {
    if (_handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: recordActivityHeartbeat received null worker handle",
            .details = null,
        });
        return -1;
    }

    const worker_handle = _handle.?;

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

    if (_payload.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: recordActivityHeartbeat requires a heartbeat payload",
            .details = null,
        });
        return -1;
    }

    const heartbeat = core.ByteArrayRef{
        .data = _payload.ptr,
        .size = _payload.len,
    };

    if (core.workerRecordActivityHeartbeat(worker_handle.core_worker, heartbeat)) |fail| {
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

pub fn initiateShutdown(_handle: ?*WorkerHandle) i32 {
    if (_handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: initiateShutdown received null worker handle",
            .details = null,
        });
        return -1;
    }

    const worker_handle = _handle.?;
    var should_call_core = false;
    var core_worker_ptr: ?*core.WorkerOpaque = null;

    worker_handle.poll_lock.lock();
    switch (worker_handle.destroy_state) {
        .idle => {
            worker_handle.destroy_state = .shutdown_requested;
            core_worker_ptr = worker_handle.core_worker;
            should_call_core = core_worker_ptr != null;
            if (should_call_core) {
                worker_handle.shutdown_initiating = true;
            }
            worker_handle.poll_condition.broadcast();
        },
        .shutdown_requested, .destroying, .destroyed => {
            worker_handle.poll_lock.unlock();
            errors.setLastError(""[0..0]);
            return 0;
        },
    }

    if (should_call_core) {
        const core_worker = core_worker_ptr.?;
        worker_handle.poll_lock.unlock();
        core.ensureExternalApiInstalled();
        core.api.worker_initiate_shutdown(core_worker);
        worker_handle.poll_lock.lock();
        worker_handle.shutdown_initiating = false;
        worker_handle.poll_condition.broadcast();
        worker_handle.poll_lock.unlock();
    } else {
        worker_handle.poll_lock.unlock();
    }

    errors.setLastError(""[0..0]);
    return 0;
}

pub fn finalizeShutdown(_handle: ?*WorkerHandle) i32 {
    if (_handle == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: finalizeShutdown received null worker handle",
            .details = null,
        });
        return -1;
    }

    const worker_handle = _handle.?;
    var should_initiate_core_shutdown = false;

    worker_handle.poll_lock.lock();

    while (worker_handle.destroy_state == .destroying) {
        worker_handle.poll_condition.wait(&worker_handle.poll_lock);
    }

    switch (worker_handle.destroy_state) {
        .destroyed => {
            worker_handle.poll_lock.unlock();
            errors.setLastError(""[0..0]);
            return 0;
        },
        .shutdown_requested => {
            while (worker_handle.shutdown_initiating) {
                worker_handle.poll_condition.wait(&worker_handle.poll_lock);
            }
            worker_handle.destroy_state = .destroying;
        },
        .idle => {
            worker_handle.destroy_state = .destroying;
            should_initiate_core_shutdown = true;
        },
        .destroying => unreachable,
    }

    while (worker_handle.pending_polls != 0) {
        worker_handle.poll_condition.wait(&worker_handle.poll_lock);
    }
    worker_handle.poll_lock.unlock();

    var completed = false;
    defer {
        worker_handle.poll_lock.lock();
        worker_handle.destroy_state = if (completed) .destroyed else .idle;
        worker_handle.shutdown_initiating = false;
        worker_handle.poll_condition.broadcast();
        worker_handle.poll_lock.unlock();
    }

    const result = finalizeWorkerShutdown(worker_handle, should_initiate_core_shutdown, .preserve_allocation);
    switch (result) {
        .success, .already_finalized => {
            completed = true;
            return 0;
        },
        .failure => {
            return -1;
        },
    }
}

fn runPollActivityTask(context: ?*anyopaque) void {
    const raw = context orelse return;
    const task_ptr = @as(*ActivityPollTask, @ptrCast(@alignCast(raw)));
    pollActivityTaskWorker(task_ptr);
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
    var stub_worker_initiate_calls: usize = 0;
    var stub_worker_finalize_calls: usize = 0;
    var stub_poll_workflow_call_count: usize = 0;
    var stub_poll_workflow_success_payload: []const u8 = ""[0..0];
    var stub_poll_workflow_success_buffer: core.ByteArray = .{
        .data = null,
        .size = 0,
        .cap = 0,
        .disable_free = false,
    };
    var stub_poll_workflow_fail_message: []const u8 = ""[0..0];
    var stub_poll_workflow_fail_buffer: core.ByteArray = .{
        .data = null,
        .size = 0,
        .cap = 0,
        .disable_free = false,
    };
    var stub_poll_activity_call_count: usize = 0;
    var stub_activity_success_payload: []const u8 = ""[0..0];
    var stub_activity_success_buffer: core.ByteArray = .{
        .data = null,
        .size = 0,
        .cap = 0,
        .disable_free = false,
    };
    var stub_activity_fail_payload: []const u8 = ""[0..0];
    var stub_activity_fail_buffer: core.ByteArray = .{
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
        stub_worker_initiate_calls = 0;
        stub_worker_finalize_calls = 0;
        stub_poll_workflow_call_count = 0;
        stub_poll_workflow_success_payload = ""[0..0];
        stub_poll_workflow_success_buffer = .{
            .data = null,
            .size = 0,
            .cap = 0,
            .disable_free = false,
        };
        stub_poll_workflow_fail_message = ""[0..0];
        stub_poll_workflow_fail_buffer = .{
            .data = null,
            .size = 0,
            .cap = 0,
            .disable_free = false,
        };
        stub_poll_activity_call_count = 0;
        stub_activity_success_payload = ""[0..0];
        stub_activity_success_buffer = .{
            .data = null,
            .size = 0,
            .cap = 0,
            .disable_free = false,
        };
        stub_activity_fail_payload = ""[0..0];
        stub_activity_fail_buffer = .{
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
        stub_poll_workflow_call_count += 1;
        stub_poll_workflow_success_buffer = .{
            .data = if (stub_poll_workflow_success_payload.len > 0)
                stub_poll_workflow_success_payload.ptr
            else
                null,
            .size = stub_poll_workflow_success_payload.len,
            .cap = stub_poll_workflow_success_payload.len,
            .disable_free = false,
        };
        if (callback) |cb| {
            cb(user_data, &stub_poll_workflow_success_buffer, null);
        }
    }

    fn stubPollWorkflowFailure(
        worker_ptr: ?*core.WorkerOpaque,
        user_data: ?*anyopaque,
        callback: core.WorkerPollCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_poll_workflow_call_count += 1;
        stub_poll_workflow_fail_buffer = .{
            .data = if (stub_poll_workflow_fail_message.len > 0)
                stub_poll_workflow_fail_message.ptr
            else
                null,
            .size = stub_poll_workflow_fail_message.len,
            .cap = stub_poll_workflow_fail_message.len,
            .disable_free = false,
        };
        if (callback) |cb| {
            cb(user_data, null, &stub_poll_workflow_fail_buffer);
        }
    }

    fn stubPollWorkflowShutdown(
        worker_ptr: ?*core.WorkerOpaque,
        user_data: ?*anyopaque,
        callback: core.WorkerPollCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_poll_workflow_call_count += 1;
        if (callback) |cb| {
            cb(user_data, null, null);
        }
    }

    fn stubPollActivitySuccess(
        worker_ptr: ?*core.WorkerOpaque,
        user_data: ?*anyopaque,
        callback: core.WorkerPollCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_poll_activity_call_count += 1;
        stub_activity_success_buffer = .{
            .data = stub_activity_success_payload.ptr,
            .size = stub_activity_success_payload.len,
            .cap = stub_activity_success_payload.len,
            .disable_free = false,
        };
        if (callback) |cb| {
            cb(user_data, &stub_activity_success_buffer, null);
        }
    }

    fn stubPollActivityFailure(
        worker_ptr: ?*core.WorkerOpaque,
        user_data: ?*anyopaque,
        callback: core.WorkerPollCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_poll_activity_call_count += 1;
        stub_activity_fail_buffer = .{
            .data = stub_activity_fail_payload.ptr,
            .size = stub_activity_fail_payload.len,
            .cap = stub_activity_fail_payload.len,
            .disable_free = false,
        };
        if (callback) |cb| {
            cb(user_data, null, &stub_activity_fail_buffer);
        }
    }

    fn stubPollActivityShutdown(
        worker_ptr: ?*core.WorkerOpaque,
        user_data: ?*anyopaque,
        callback: core.WorkerPollCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_poll_activity_call_count += 1;
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
            .build_id = ""[0..0],
            .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&fake_worker_storage)),
            .poll_lock = .{},
            .poll_condition = .{},
            .pending_polls = 0,
            .destroy_state = .idle,
            .shutdown_initiating = false,
            .buffers_released = false,
            .owns_allocation = false,
            .destroy_reclaims_allocation = false,
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

    fn stubWorkerInitiateShutdown(worker_ptr: ?*core.WorkerOpaque) callconv(.c) void {
        _ = worker_ptr;
        stub_worker_initiate_calls += 1;
    }

    fn stubWorkerFinalizeShutdown(
        worker_ptr: ?*core.WorkerOpaque,
        user_data: ?*anyopaque,
        callback: core.WorkerCallback,
    ) callconv(.c) void {
        _ = worker_ptr;
        stub_worker_finalize_calls += 1;
        if (callback) |cb| {
            cb(user_data, null);
        }
    }
};

test "create returns worker handle and frees resources on destroy" {
    core.ensureExternalApiInstalled();
    const original_worker_new = core.api.worker_new;
    const original_worker_free = core.api.worker_free;
    const original_worker_initiate = core.api.worker_initiate_shutdown;
    const original_worker_finalize = core.api.worker_finalize_shutdown;
    defer {
        core.api.worker_new = original_worker_new;
        core.api.worker_free = original_worker_free;
        core.api.worker_initiate_shutdown = original_worker_initiate;
        core.api.worker_finalize_shutdown = original_worker_finalize;
    }

    core.api.worker_new = WorkerTests.stubWorkerNewSuccess;
    core.api.worker_free = WorkerTests.stubWorkerFree;
    core.api.worker_initiate_shutdown = WorkerTests.stubWorkerInitiateShutdown;
    core.api.worker_finalize_shutdown = WorkerTests.stubWorkerFinalizeShutdown;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    var rt = WorkerTests.fakeRuntimeHandle();
    var client_handle = WorkerTests.fakeClientHandle(&rt);
    const config = "{\"namespace\":\"unit\",\"taskQueue\":\"queue\",\"identity\":\"worker\",\"buildId\":\"test-build\"}";

    const maybe_handle = create(&rt, &client_handle, config);
    try testing.expect(maybe_handle != null);
    const worker_handle = maybe_handle.?;

    try testing.expect(worker_handle.core_worker != null);
    try testing.expect(worker_handle.runtime != null);
    try testing.expect(worker_handle.client != null);
    try testing.expect(std.mem.eql(u8, config, worker_handle.config));
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_new_calls);
    try testing.expectEqualStrings("", errors.snapshot());

    try testing.expectEqual(@as(i32, 0), destroy(worker_handle));

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
    const config = "{\"namespace\":\"unit\",\"taskQueue\":\"queue\",\"buildId\":\"test-build\"}";

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

test "initiateShutdown rejects null handle" {
    errors.setLastError(""[0..0]);
    const rc = initiateShutdown(null);
    try testing.expectEqual(@as(i32, -1), rc);
    const snapshot = errors.snapshot();
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, "\"code\":3"));
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, "initiateShutdown received null worker handle"));
}

test "initiateShutdown transitions once and fences poll permits" {
    core.ensureExternalApiInstalled();
    const original_worker_initiate = core.api.worker_initiate_shutdown;
    defer core.api.worker_initiate_shutdown = original_worker_initiate;

    core.api.worker_initiate_shutdown = WorkerTests.stubWorkerInitiateShutdown;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    try testing.expect(acquirePollPermit(&worker_handle));
    releasePollPermit(&worker_handle);
    try testing.expectEqual(@as(usize, 0), worker_handle.pending_polls);

    const rc = initiateShutdown(&worker_handle);
    try testing.expectEqual(@as(i32, 0), rc);
    try testing.expect(worker_handle.destroy_state == .shutdown_requested);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_initiate_calls);
    try testing.expectEqualStrings("", errors.snapshot());

    try testing.expect(!acquirePollPermit(&worker_handle));
    try testing.expectEqual(@as(usize, 0), worker_handle.pending_polls);
}

test "initiateShutdown is idempotent" {
    core.ensureExternalApiInstalled();
    const original_worker_initiate = core.api.worker_initiate_shutdown;
    defer core.api.worker_initiate_shutdown = original_worker_initiate;

    core.api.worker_initiate_shutdown = WorkerTests.stubWorkerInitiateShutdown;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    try testing.expectEqual(@as(i32, 0), initiateShutdown(&worker_handle));
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_initiate_calls);
    try testing.expect(worker_handle.destroy_state == .shutdown_requested);
    try testing.expectEqualStrings("", errors.snapshot());

    try testing.expectEqual(@as(i32, 0), initiateShutdown(&worker_handle));
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_initiate_calls);
    try testing.expect(worker_handle.destroy_state == .shutdown_requested);
    try testing.expectEqualStrings("", errors.snapshot());
}

test "finalizeShutdown rejects null handle" {
    errors.setLastError(""[0..0]);
    const rc = finalizeShutdown(null);
    try testing.expectEqual(@as(i32, -1), rc);
    const snapshot = errors.snapshot();
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, "\"code\":3"));
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, "finalizeShutdown received null worker handle"));
}

test "finalizeShutdown finalizes worker once and releases buffers" {
    core.ensureExternalApiInstalled();
    const original_worker_initiate = core.api.worker_initiate_shutdown;
    const original_worker_finalize = core.api.worker_finalize_shutdown;
    const original_worker_free = core.api.worker_free;
    defer {
        core.api.worker_initiate_shutdown = original_worker_initiate;
        core.api.worker_finalize_shutdown = original_worker_finalize;
        core.api.worker_free = original_worker_free;
    }

    core.api.worker_initiate_shutdown = WorkerTests.stubWorkerInitiateShutdown;
    core.api.worker_finalize_shutdown = WorkerTests.stubWorkerFinalizeShutdown;
    core.api.worker_free = WorkerTests.stubWorkerFree;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    try testing.expectEqual(@as(i32, 0), finalizeShutdown(&worker_handle));
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_initiate_calls);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_finalize_calls);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_free_calls);
    try testing.expect(worker_handle.destroy_state == .destroyed);
    try testing.expect(worker_handle.core_worker == null);
    try testing.expect(worker_handle.buffers_released);
    try testing.expectEqualStrings("", errors.snapshot());
}

test "finalizeShutdown is idempotent" {
    core.ensureExternalApiInstalled();
    const original_worker_initiate = core.api.worker_initiate_shutdown;
    const original_worker_finalize = core.api.worker_finalize_shutdown;
    const original_worker_free = core.api.worker_free;
    defer {
        core.api.worker_initiate_shutdown = original_worker_initiate;
        core.api.worker_finalize_shutdown = original_worker_finalize;
        core.api.worker_free = original_worker_free;
    }

    core.api.worker_initiate_shutdown = WorkerTests.stubWorkerInitiateShutdown;
    core.api.worker_finalize_shutdown = WorkerTests.stubWorkerFinalizeShutdown;
    core.api.worker_free = WorkerTests.stubWorkerFree;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    try testing.expectEqual(@as(i32, 0), initiateShutdown(&worker_handle));
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_initiate_calls);
    try testing.expect(worker_handle.destroy_state == .shutdown_requested);

    try testing.expectEqual(@as(i32, 0), finalizeShutdown(&worker_handle));
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_finalize_calls);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_free_calls);
    try testing.expect(worker_handle.destroy_state == .destroyed);

    try testing.expectEqual(@as(i32, 0), finalizeShutdown(&worker_handle));
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_finalize_calls);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_worker_free_calls);
    try testing.expect(worker_handle.destroy_state == .destroyed);
    try testing.expectEqualStrings("", errors.snapshot());
}

test "destroy frees allocation after finalizeShutdown" {
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
    const allocator = std.heap.c_allocator;
    const handle = allocator.create(WorkerHandle) catch unreachable;
    handle.* = .{
        .id = 6,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .namespace = ""[0..0],
        .task_queue = ""[0..0],
        .identity = ""[0..0],
        .build_id = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&worker_storage)),
        .poll_lock = .{},
        .poll_condition = .{},
        .pending_polls = 0,
        .destroy_state = .idle,
        .shutdown_initiating = false,
        .buffers_released = false,
        .owns_allocation = true,
        .destroy_reclaims_allocation = true,
    };

    errors.setLastError(""[0..0]);
    try testing.expectEqual(@as(i32, 0), initiateShutdown(handle));
    try testing.expect(handle.destroy_state == .shutdown_requested);

    try testing.expectEqual(@as(i32, 0), finalizeShutdown(handle));
    try testing.expectEqual(@as(usize, 1), test_hooks.finalize_calls);
    try testing.expectEqual(@as(usize, 1), test_hooks.free_calls);
    try testing.expect(handle.destroy_state == .destroyed);

    try testing.expectEqual(@as(i32, 0), destroy(handle));
    try testing.expectEqual(@as(usize, 1), test_hooks.finalize_calls);
    try testing.expectEqual(@as(usize, 1), test_hooks.free_calls);
}

test "finalizeShutdown surfaces core finalization errors" {
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

    const error_message = "synthetic finalize failure";
    var error_array = core.ByteArray{
        .data = error_message.ptr,
        .size = error_message.len,
        .cap = error_message.len,
        .disable_free = true,
    };
    test_hooks.finalize_fail_ptr = &error_array;

    var worker_storage: [1]u8 align(@alignOf(core.WorkerOpaque)) = undefined;
    var runtime_storage: [1]u8 align(@alignOf(core.RuntimeOpaque)) = undefined;
    var runtime_handle_instance = runtime.RuntimeHandle{
        .id = 5,
        .config = ""[0..0],
        .core_runtime = @as(?*core.RuntimeOpaque, @ptrCast(&runtime_storage)),
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    var handle = WorkerHandle{
        .id = 5,
        .runtime = &runtime_handle_instance,
        .client = null,
        .config = ""[0..0],
        .namespace = ""[0..0],
        .task_queue = ""[0..0],
        .identity = ""[0..0],
        .build_id = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&worker_storage)),
        .poll_lock = .{},
        .poll_condition = .{},
        .pending_polls = 0,
        .destroy_state = .idle,
        .shutdown_initiating = false,
        .buffers_released = false,
        .owns_allocation = false,
        .destroy_reclaims_allocation = false,
    };

    errors.setLastError(""[0..0]);
    const rc = finalizeShutdown(&handle);
    try testing.expectEqual(@as(i32, -1), rc);
    try testing.expectEqual(@as(usize, 1), test_hooks.initiate_calls);
    try testing.expectEqual(@as(usize, 1), test_hooks.finalize_calls);
    try testing.expectEqual(@as(usize, 0), test_hooks.free_calls);
    try testing.expectEqual(@as(usize, 1), runtime_free_calls);
    try testing.expectEqual(runtime_handle_instance.core_runtime, runtime_free_last_runtime);
    try testing.expect(runtime_free_last_fail != null);
    try testing.expect(handle.destroy_state == .idle);
    try testing.expect(handle.core_worker != null);
    const snapshot = errors.snapshot();
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, "worker shutdown failed"));
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, error_message));
}

test "destroy handles null and missing worker pointers" {
    const original_worker_free = core.api.worker_free;
    defer {
        core.api.worker_free = original_worker_free;
    }

    core.api.worker_free = WorkerTests.stubWorkerFree;
    WorkerTests.resetStubs();

    try testing.expectEqual(@as(i32, 0), destroy(null));
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
        .build_id = ""[0..0],
        .core_worker = null,
        .poll_lock = .{},
        .poll_condition = .{},
        .pending_polls = 0,
        .destroy_state = .idle,
        .shutdown_initiating = false,
        .buffers_released = false,
        .owns_allocation = false,
        .destroy_reclaims_allocation = false,
    };

    try testing.expectEqual(@as(i32, 0), destroy(handle));

    try testing.expectEqual(@as(usize, 0), WorkerTests.stub_worker_free_calls);
    try testing.expect(handle.destroy_state == .destroyed);
    try testing.expect(handle.buffers_released);
    try testing.expectEqual(@as(usize, 0), handle.config.len);
    allocator.destroy(handle);
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
        .build_id = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&worker_storage)),
        .poll_lock = .{},
        .poll_condition = .{},
        .pending_polls = 0,
        .destroy_state = .idle,
        .buffers_released = false,
        .owns_allocation = false,
        .destroy_reclaims_allocation = false,
    };

    try testing.expectEqual(@as(i32, 0), destroy(&handle));

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
        .build_id = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&worker_storage)),
        .poll_lock = .{},
        .poll_condition = .{},
        .pending_polls = 0,
        .destroy_state = .idle,
        .buffers_released = false,
        .owns_allocation = false,
        .destroy_reclaims_allocation = false,
    };

    try testing.expectEqual(@as(i32, 0), destroy(&handle));
    try testing.expectEqual(@as(i32, 0), destroy(&handle));
    try testing.expectEqual(@as(i32, 0), destroy(null));

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
        .build_id = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&worker_storage)),
        .poll_lock = .{},
        .poll_condition = .{},
        .pending_polls = 0,
        .destroy_state = .idle,
        .buffers_released = false,
        .owns_allocation = false,
        .destroy_reclaims_allocation = false,
    };

    try testing.expectEqual(@as(i32, -1), destroy(&handle));

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

test "pollWorkflowTask resolves workflow activation payload" {
    core.ensureExternalApiInstalled();
    const original_api = core.api;
    defer core.api = original_api;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    core.api.worker_poll_workflow_activation = WorkerTests.stubPollWorkflowSuccess;
    core.api.byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    WorkerTests.stub_poll_workflow_success_payload = "workflow-activation";

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

    try testing.expectEqual(@as(usize, WorkerTests.stub_poll_workflow_success_payload.len), payload_ptr.size);
    if (payload_ptr.data) |ptr| {
        try testing.expectEqualSlices(u8, WorkerTests.stub_poll_workflow_success_payload, ptr[0..payload_ptr.size]);
    } else {
        try testing.expectEqual(@as(usize, 0), WorkerTests.stub_poll_workflow_success_payload.len);
    }

    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_poll_workflow_call_count);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_byte_array_free_count);
    try testing.expectEqual(
        @as(?*core.RuntimeOpaque, @ptrCast(&WorkerTests.fake_runtime_storage)),
        WorkerTests.last_runtime_byte_array_free_runtime,
    );
    try testing.expectEqual(
        @as(?*const core.ByteArray, @ptrCast(&WorkerTests.stub_poll_workflow_success_buffer)),
        WorkerTests.last_runtime_byte_array_free_ptr,
    );
    try testing.expectEqual(@as(usize, 0), worker_handle.pending_polls);
    try testing.expectEqualStrings("", errors.snapshot());
}

test "pollWorkflowTask surfaces workflow failure payload" {
    core.ensureExternalApiInstalled();
    const original_api = core.api;
    defer core.api = original_api;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    core.api.worker_poll_workflow_activation = WorkerTests.stubPollWorkflowFailure;
    core.api.byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    WorkerTests.stub_poll_workflow_fail_message = "workflow poll failed";

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
    try testing.expect(std.mem.indexOf(u8, snapshot, WorkerTests.stub_poll_workflow_fail_message) != null);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_poll_workflow_call_count);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_byte_array_free_count);
    try testing.expectEqual(@as(usize, 0), worker_handle.pending_polls);
}

test "pollWorkflowTask surfaces workflow poll cancellation" {
    core.ensureExternalApiInstalled();
    const original_api = core.api;
    defer core.api = original_api;

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    core.api.worker_poll_workflow_activation = WorkerTests.stubPollWorkflowShutdown;
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
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_poll_workflow_call_count);
    try testing.expectEqual(@as(usize, 0), WorkerTests.stub_byte_array_free_count);
    try testing.expectEqual(@as(usize, 0), worker_handle.pending_polls);
}

test "pollActivityTask resolves pending handle with activity payload" {
    core.ensureExternalApiInstalled();
    const original_poll = core.api.worker_poll_activity_task;
    const original_free = core.runtime_byte_array_free;
    defer {
        core.api.worker_poll_activity_task = original_poll;
        core.runtime_byte_array_free = original_free;
    }

    core.api.worker_poll_activity_task = WorkerTests.stubPollActivitySuccess;
    core.runtime_byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);
    WorkerTests.stub_activity_success_payload = "poll-activity-success";

    const pending_handle_opt = pollActivityTask(&worker_handle);
    try testing.expect(pending_handle_opt != null);
    const pending_handle = pending_handle_opt.?;

    const base_handle = @as(*pending.PendingHandle, @ptrCast(pending_handle));
    var attempts: usize = 0;
    while (true) {
        const status = pending.poll(base_handle);
        if (status == @intFromEnum(pending.Status.ready)) {
            break;
        }
        try testing.expect(status != @intFromEnum(pending.Status.failed));
        std.Thread.sleep(1_000_000); // 1ms
        attempts += 1;
        try testing.expect(attempts < 100);
    }

    const payload_any = pending.consume(base_handle);
    try testing.expect(payload_any != null);
    const payload_ptr = @as(*byte_array.ByteArray, @ptrCast(@alignCast(payload_any.?)));
    defer byte_array.free(payload_ptr);

    try testing.expect(payload_ptr.data != null);
    const actual = payload_ptr.data.?[0..payload_ptr.size];
    try testing.expect(std.mem.eql(u8, WorkerTests.stub_activity_success_payload, actual));
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_poll_activity_call_count);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_byte_array_free_count);
    try testing.expectEqualStrings("", errors.snapshot());

    pending.free(base_handle);
}

test "pollActivityTask propagates core error payload" {
    core.ensureExternalApiInstalled();
    const original_poll = core.api.worker_poll_activity_task;
    const original_free = core.runtime_byte_array_free;
    defer {
        core.api.worker_poll_activity_task = original_poll;
        core.runtime_byte_array_free = original_free;
    }

    core.api.worker_poll_activity_task = WorkerTests.stubPollActivityFailure;
    core.runtime_byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);
    WorkerTests.stub_activity_fail_payload = "{\"code\":14,\"message\":\"activity poll failed\"}";

    const pending_handle_opt = pollActivityTask(&worker_handle);
    try testing.expect(pending_handle_opt != null);
    const pending_handle = pending_handle_opt.?;

    const base_handle = @as(*pending.PendingHandle, @ptrCast(pending_handle));
    var attempts: usize = 0;
    var status: i32 = 0;
    while (true) {
        status = pending.poll(base_handle);
        if (status == @intFromEnum(pending.Status.failed) or status == @intFromEnum(pending.Status.ready)) {
            break;
        }
        std.Thread.sleep(1_000_000);
        attempts += 1;
        try testing.expect(attempts < 100);
    }
    try testing.expectEqual(@intFromEnum(pending.Status.failed), status);

    const snapshot = errors.snapshot();
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, "activity poll failed"));
    try testing.expect(std.mem.containsAtLeast(u8, snapshot, 1, "\"code\":14"));

    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_poll_activity_call_count);
    try testing.expectEqual(@as(usize, 1), WorkerTests.stub_byte_array_free_count);

    try testing.expect(pending.consume(base_handle) == null);

    pending.free(base_handle);
}

test "pollActivityTask resolves empty payload when core signals shutdown" {
    core.ensureExternalApiInstalled();
    const original_poll = core.api.worker_poll_activity_task;
    const original_free = core.runtime_byte_array_free;
    defer {
        core.api.worker_poll_activity_task = original_poll;
        core.runtime_byte_array_free = original_free;
    }

    core.api.worker_poll_activity_task = WorkerTests.stubPollActivityShutdown;
    core.runtime_byte_array_free = WorkerTests.stubRuntimeByteArrayFree;

    var rt = WorkerTests.fakeRuntimeHandle();
    var worker_handle = WorkerTests.fakeWorkerHandle(&rt);

    WorkerTests.resetStubs();
    errors.setLastError(""[0..0]);

    const pending_handle_opt = pollActivityTask(&worker_handle);
    try testing.expect(pending_handle_opt != null);
    const pending_handle = pending_handle_opt.?;

    const base_handle = @as(*pending.PendingHandle, @ptrCast(pending_handle));
    var attempts: usize = 0;
    while (true) {
        const status = pending.poll(base_handle);
        if (status == @intFromEnum(pending.Status.ready)) {
            break;
        }
        try testing.expect(status != @intFromEnum(pending.Status.failed));
        std.Thread.sleep(1_000_000);
        attempts += 1;
        try testing.expect(attempts < 100);
    }

    const payload_any = pending.consume(base_handle);
    try testing.expect(payload_any != null);
    const payload_ptr = @as(*byte_array.ByteArray, @ptrCast(@alignCast(payload_any.?)));
    defer byte_array.free(payload_ptr);

    try testing.expectEqual(@as(usize, 0), payload_ptr.size);
    try testing.expectEqual(@as(usize, 0), WorkerTests.stub_byte_array_free_count);
    try testing.expectEqualStrings("", errors.snapshot());

    pending.free(base_handle);
}
