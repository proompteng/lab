const std = @import("std");
const common = @import("../common.zig");
const errors = @import("../../errors.zig");
const runtime = @import("../../runtime.zig");
const pending = @import("../../pending.zig");
const core = @import("../../core.zig");
const byte_array = @import("../../byte_array.zig");
const shared = @import("shared.zig");

const grpc = common.grpc;
const makeByteArrayRef = common.makeByteArrayRef;
const emptyByteArrayRef = common.emptyByteArrayRef;
const byteArraySlice = common.byteArraySlice;

const query_workflow_rpc = "QueryWorkflow";

const QueryWorkflowTask = struct {
    client: ?*common.ClientHandle,
    pending_handle: *pending.PendingByteArray,
    payload: []u8,
};

const QueryWorkflowRpcContext = struct {
    allocator: std.mem.Allocator,
    pending_handle: *pending.PendingByteArray,
    runtime_handle: *runtime.RuntimeHandle,
    wait_group: std.Thread.WaitGroup = .{},
    core_runtime: ?*core.RuntimeOpaque = null,
};

fn clientQueryWorkflowCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
    failure_details: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*QueryWorkflowRpcContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    const core_runtime_ptr = context.core_runtime orelse context.runtime_handle.core_runtime;

    defer {
        if (failure_message) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);
        if (failure_details) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);
    }

    if (success != null and status_code == 0) {
        const slice = byteArraySlice(success.?);

        if (slice.len == 0) {
            core.api.byte_array_free(core_runtime_ptr, success.?);
            _ = pending.rejectByteArray(
                context.pending_handle,
                grpc.internal,
                "temporal-bun-bridge-zig: queryWorkflow returned empty payload",
            );
            errors.setStructuredError(.{
                .code = grpc.internal,
                .message = "temporal-bun-bridge-zig: queryWorkflow returned empty payload",
            });
            return;
        }

        const array_ptr = byte_array.allocate(.{ .slice = slice }) orelse {
            core.api.byte_array_free(core_runtime_ptr, success.?);
            _ = pending.rejectByteArray(
                context.pending_handle,
                grpc.resource_exhausted,
                "temporal-bun-bridge-zig: failed to allocate queryWorkflow response",
            );
            errors.setStructuredError(.{
                .code = grpc.resource_exhausted,
                .message = "temporal-bun-bridge-zig: failed to allocate queryWorkflow response",
            });
            return;
        };

        core.api.byte_array_free(core_runtime_ptr, success.?);

        if (!pending.resolveByteArray(context.pending_handle, array_ptr)) {
            byte_array.free(array_ptr);
            errors.setStructuredError(.{
                .code = grpc.internal,
                .message = "temporal-bun-bridge-zig: failed to resolve queryWorkflow handle",
            });
            _ = pending.rejectByteArray(
                context.pending_handle,
                grpc.internal,
                "temporal-bun-bridge-zig: failed to resolve queryWorkflow handle",
            );
            return;
        }

        errors.setLastError(""[0..0]);
        return;
    }

    if (success) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);

    const code: i32 = if (status_code == 0) grpc.internal else @as(i32, @intCast(status_code));
    const message_slice = if (failure_message) |ptr| byteArraySlice(ptr) else "temporal-bun-bridge-zig: queryWorkflow failed"[0..];

    _ = pending.rejectByteArray(context.pending_handle, code, message_slice);
    errors.setStructuredError(.{ .code = code, .message = message_slice });
}

fn queryWorkflowWorker(task: *QueryWorkflowTask) void {
    const allocator = std.heap.c_allocator;
    defer {
        allocator.free(task.payload);
        allocator.destroy(task);
    }

    const pending_handle = task.pending_handle;
    defer pending.release(pending_handle);

    const client_ptr = task.client orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.internal, "temporal-bun-bridge-zig: queryWorkflow worker missing client");
        return;
    };

    const runtime_handle = client_ptr.runtime orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: queryWorkflow missing runtime handle");
        return;
    };

    if (runtime_handle.core_runtime == null) {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: runtime core handle is not initialized");
        return;
    }

    const core_client = client_ptr.core_client orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: client core handle is not initialized");
        return;
    };

    if (!runtime.beginPendingClientConnect(runtime_handle)) {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: runtime is shutting down");
        return;
    }
    defer runtime.endPendingClientConnect(runtime_handle);

    const retained_core_runtime = runtime.retainCoreRuntime(runtime_handle) orelse {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: runtime is shutting down");
        return;
    };
    defer runtime.releaseCoreRuntime(runtime_handle);

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer {
        const status = gpa.deinit();
        switch (status) {
            .ok => {},
            .leak => {},
        }
    }
    const arena = gpa.allocator();

    var parsed = std.json.parseFromSlice(std.json.Value, arena, task.payload, .{ .ignore_unknown_fields = true }) catch |err| {
        var scratch: [192]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: queryWorkflow payload must be valid JSON: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: queryWorkflow payload must be valid JSON";
        errors.setStructuredError(.{ .code = grpc.invalid_argument, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, message);
        return;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow payload must be a JSON object",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow payload must be a JSON object");
        return;
    }

    var object = parsed.value.object;

    const namespace_ptr = object.getPtr("namespace") orelse {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow namespace is required",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow namespace is required");
        return;
    };
    const namespace_slice = switch (namespace_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredError(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: queryWorkflow namespace must be a string",
            });
            _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow namespace must be a string");
            return;
        },
    };
    if (namespace_slice.len == 0) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow namespace must be non-empty",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow namespace must be non-empty");
        return;
    }

    const workflow_id_ptr = object.getPtr("workflow_id") orelse {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow workflow_id is required",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow workflow_id is required");
        return;
    };
    const workflow_id_slice = switch (workflow_id_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredError(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: queryWorkflow workflow_id must be a string",
            });
            _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow workflow_id must be a string");
            return;
        },
    };
    if (workflow_id_slice.len == 0) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow workflow_id must be non-empty",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow workflow_id must be non-empty");
        return;
    }

    var run_id_slice: ?[]const u8 = null;
    if (object.getPtr("run_id")) |run_ptr| {
        const slice = switch (run_ptr.*) {
            .string => |s| s,
            .null => ""[0..0],
            else => {
                errors.setStructuredError(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: queryWorkflow run_id must be a string",
                });
                _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow run_id must be a string");
                return;
            },
        };
        if (slice.len == 0) {
            run_id_slice = null;
        } else {
            run_id_slice = slice;
        }
    }

    var first_execution_run_id: ?[]const u8 = null;
    if (object.getPtr("first_execution_run_id")) |first_ptr| {
        const slice = switch (first_ptr.*) {
            .string => |s| s,
            .null => ""[0..0],
            else => {
                errors.setStructuredError(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: queryWorkflow first_execution_run_id must be a string",
                });
                _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow first_execution_run_id must be a string");
                return;
            },
        };
        if (slice.len == 0) {
            first_execution_run_id = null;
        } else {
            first_execution_run_id = slice;
        }
    }

    const query_name_ptr = object.getPtr("query_name") orelse {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow query_name is required",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow query_name is required");
        return;
    };
    const query_name_slice = switch (query_name_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredError(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: queryWorkflow query_name must be a string",
            });
            _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow query_name must be a string");
            return;
        },
    };
    if (query_name_slice.len == 0) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow query_name must be non-empty",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow query_name must be non-empty");
        return;
    }

    var args_array: ?*std.json.Array = null;
    if (object.getPtr("args")) |args_ptr| {
        switch (args_ptr.*) {
            .array => |*arr| args_array = arr,
            .null => {},
            else => {
                errors.setStructuredError(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: queryWorkflow args must be an array",
                });
                _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow args must be an array");
                return;
            },
        }
    }

    const request_params = shared.QueryWorkflowRequestParts{
        .namespace = namespace_slice,
        .workflow_id = workflow_id_slice,
        .run_id = run_id_slice,
        .first_execution_run_id = first_execution_run_id,
        .query_name = query_name_slice,
        .args = args_array,
    };

    const request_bytes = shared.encodeQueryWorkflowRequest(arena, request_params) catch {
        const message = "temporal-bun-bridge-zig: failed to encode queryWorkflow request";
        errors.setStructuredError(.{ .code = grpc.invalid_argument, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, message);
        return;
    };
    defer arena.free(request_bytes);

    var context = QueryWorkflowRpcContext{
        .allocator = allocator,
        .pending_handle = pending_handle,
        .runtime_handle = runtime_handle,
        .core_runtime = retained_core_runtime,
    };
    context.wait_group.start();

    var call_options = std.mem.zeroes(core.RpcCallOptions);
    call_options.service = 1;
    call_options.rpc = makeByteArrayRef(query_workflow_rpc);
    call_options.req = makeByteArrayRef(request_bytes);
    call_options.retry = true;
    call_options.metadata = emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &call_options, &context, clientQueryWorkflowCallback);
    context.wait_group.wait();
}

fn runQueryWorkflowTask(context: ?*anyopaque) void {
    const raw = context orelse return;
    const task_ptr = @as(*QueryWorkflowTask, @ptrCast(@alignCast(raw)));
    queryWorkflowWorker(task_ptr);
}

pub fn queryWorkflow(client_ptr: ?*common.ClientHandle, payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return common.createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow received null client");
    }

    if (payload.len == 0) {
        return common.createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow payload must be non-empty");
    }

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        return common.createByteArrayError(grpc.internal, "temporal-bun-bridge-zig: failed to allocate query payload handle");
    };
    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_handle_ptr));

    const copy = std.heap.c_allocator.alloc(u8, payload.len) catch {
        pending.free(pending_handle_ptr);
        return common.createByteArrayError(grpc.resource_exhausted, "temporal-bun-bridge-zig: failed to allocate query payload copy");
    };
    @memcpy(copy, payload);

    const allocator = std.heap.c_allocator;
    const task = allocator.create(QueryWorkflowTask) catch |err| {
        allocator.free(copy);
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate queryWorkflow task: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate queryWorkflow task";
        _ = pending.rejectByteArray(pending_handle, grpc.resource_exhausted, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    task.* = .{
        .client = client_ptr,
        .pending_handle = pending_handle,
        .payload = copy,
    };

    if (!pending.retain(pending_handle_ptr)) {
        allocator.destroy(task);
        allocator.free(copy);
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to retain pending query handle",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.resource_exhausted, "temporal-bun-bridge-zig: failed to retain pending query handle");
        return @as(?*pending.PendingByteArray, pending_handle);
    }

    const runtime_handle = client_ptr.?.runtime orelse {
        allocator.destroy(task);
        allocator.free(copy);
        pending.release(pending_handle_ptr);
        const message = "temporal-bun-bridge-zig: queryWorkflow missing runtime handle";
        errors.setStructuredError(.{ .code = grpc.failed_precondition, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    const context_any: ?*anyopaque = @as(?*anyopaque, @ptrCast(@alignCast(task)));
    runtime.schedulePendingTask(runtime_handle, .{
        .run = runQueryWorkflowTask,
        .context = context_any,
    }) catch |err| switch (err) {
        runtime.SchedulePendingTaskError.ShuttingDown => blk: {
            allocator.destroy(task);
            allocator.free(copy);
            pending.release(pending_handle_ptr);
            const message = "temporal-bun-bridge-zig: runtime is shutting down";
            errors.setStructuredError(.{ .code = grpc.failed_precondition, .message = message });
            _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, message);
            break :blk;
        },
        runtime.SchedulePendingTaskError.ExecutorUnavailable => blk: {
            allocator.destroy(task);
            allocator.free(copy);
            pending.release(pending_handle_ptr);
            const message = "temporal-bun-bridge-zig: pending executor unavailable";
            errors.setStructuredError(.{ .code = grpc.internal, .message = message });
            _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
            break :blk;
        },
    };
    return @as(?*pending.PendingByteArray, pending_handle);
}
