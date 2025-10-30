const std = @import("std");
const common = @import("../common.zig");
const errors = @import("../../errors.zig");
const runtime = @import("../../runtime.zig");
const pending = @import("../../pending.zig");
const core = @import("../../core.zig");
const byte_array = @import("../../byte_array.zig");
const shared = @import("shared.zig");

const grpc = common.grpc;
const StartWorkflowRequestParts = shared.StartWorkflowRequestParts;

const start_workflow_rpc = "StartWorkflowExecution";

pub const StartWorkflowRpcContext = struct {
    allocator: std.mem.Allocator,
    wait_group: std.Thread.WaitGroup = .{},
    runtime_handle: *runtime.RuntimeHandle,
    core_runtime: ?*core.RuntimeOpaque = null,
    response: []u8 = ""[0..0],
    error_message_owned: bool = false,
    error_message: []const u8 = ""[0..0],
    success: bool = false,
    error_code: i32 = grpc.internal,
};

fn freeContextSlice(ctx: *StartWorkflowRpcContext, slice: []const u8) void {
    if (slice.len > 0) {
        ctx.allocator.free(@constCast(slice));
    }
}

pub fn clientStartWorkflowCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
    failure_details: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*StartWorkflowRpcContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    const core_runtime_ptr = context.core_runtime orelse context.runtime_handle.core_runtime;

    defer {
        if (failure_message) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);
        if (failure_details) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);
    }

    if (success != null and status_code == 0) {
        const slice = common.byteArraySlice(success.?);

        if (slice.len == 0) {
            if (success) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);
            context.error_code = grpc.internal;
            if (context.error_message_owned) {
                freeContextSlice(context, context.error_message);
                context.error_message_owned = false;
            }
            context.error_message = "temporal-bun-bridge-zig: startWorkflow returned empty response";
            context.success = false;
            return;
        }

        const copy = context.allocator.alloc(u8, slice.len) catch {
            if (success) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);
            context.error_code = grpc.resource_exhausted;
            if (context.error_message_owned) {
                freeContextSlice(context, context.error_message);
                context.error_message_owned = false;
            }
            context.error_message = "temporal-bun-bridge-zig: failed to allocate startWorkflow response";
            context.success = false;
            return;
        };

        @memcpy(copy, slice);
        if (success) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);
        freeContextSlice(context, context.response);
        context.response = copy;
        context.success = true;
        context.error_code = grpc.ok;
        if (context.error_message_owned) {
            freeContextSlice(context, context.error_message);
            context.error_message_owned = false;
        }
        context.error_message = ""[0..0];
        return;
    }

    if (success) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);
    const code: i32 = if (status_code == 0) grpc.internal else @as(i32, @intCast(status_code));
    context.error_code = code;

    if (context.error_message_owned) {
        freeContextSlice(context, context.error_message);
        context.error_message_owned = false;
    }

    const message_slice = if (failure_message) |ptr| common.byteArraySlice(ptr) else "temporal-bun-bridge-zig: startWorkflow failed"[0..];
    if (message_slice.len == 0) {
        context.error_message = ""[0..0];
    } else {
        const copy = context.allocator.alloc(u8, message_slice.len) catch {
            context.error_message = "temporal-bun-bridge-zig: failed to duplicate startWorkflow error";
            context.error_message_owned = false;
            context.success = false;
            context.error_code = code;
            return;
        };
        @memcpy(copy, message_slice);
        context.error_message = copy;
        context.error_message_owned = true;
    }
    context.success = false;
}

pub fn startWorkflow(_client: ?*common.ClientHandle, _payload: []const u8) ?*byte_array.ByteArray {
    if (_client == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow received null client",
            .details = null,
        });
        return null;
    }

    if (_payload.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow payload must be non-empty",
            .details = null,
        });
        return null;
    }

    const client_ptr = _client.?;
    const runtime_handle = client_ptr.runtime orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: startWorkflow missing runtime handle",
            .details = null,
        });
        return null;
    };

    if (runtime_handle.core_runtime == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime core handle is not initialized",
            .details = null,
        });
        return null;
    }

    const core_client = client_ptr.core_client orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: client core handle is not initialized",
            .details = null,
        });
        return null;
    };

    const retained_core_runtime = runtime.retainCoreRuntime(runtime_handle) orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
            .details = null,
        });
        return null;
    };
    defer runtime.releaseCoreRuntime(runtime_handle);

    const allocator = std.heap.c_allocator;

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, _payload, .{}) catch |err| {
        var scratch: [192]u8 = undefined;
        const msg = std.fmt.bufPrint(&scratch, "temporal-bun-bridge-zig: startWorkflow payload must be valid JSON: {}", .{err}) catch "temporal-bun-bridge-zig: startWorkflow payload must be valid JSON";
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = msg, .details = null });
        return null;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow payload must be a JSON object",
            .details = null,
        });
        return null;
    }

    var object = parsed.value.object;

    const namespace_ptr = object.getPtr("namespace") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow namespace is required",
            .details = null,
        });
        return null;
    };
    const namespace_slice = switch (namespace_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow namespace must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (namespace_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow namespace must be non-empty",
            .details = null,
        });
        return null;
    }

    const workflow_id_ptr = object.getPtr("workflow_id") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow workflow_id is required",
            .details = null,
        });
        return null;
    };
    const workflow_id_slice = switch (workflow_id_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_id must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (workflow_id_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow workflow_id must be non-empty",
            .details = null,
        });
        return null;
    }

    const workflow_type_ptr = object.getPtr("workflow_type") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow workflow_type is required",
            .details = null,
        });
        return null;
    };
    const workflow_type_slice = switch (workflow_type_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_type must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (workflow_type_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow workflow_type must be non-empty",
            .details = null,
        });
        return null;
    }

    const task_queue_ptr = object.getPtr("task_queue") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow task_queue is required",
            .details = null,
        });
        return null;
    };
    const task_queue_slice = switch (task_queue_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow task_queue must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (task_queue_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow task_queue must be non-empty",
            .details = null,
        });
        return null;
    }

    const identity_ptr = object.getPtr("identity") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow identity is required",
            .details = null,
        });
        return null;
    };
    const identity_slice = switch (identity_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow identity must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (identity_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow identity must be non-empty",
            .details = null,
        });
        return null;
    }

    var args_array: ?*std.json.Array = null;
    if (object.getPtr("args")) |args_ptr| {
        switch (args_ptr.*) {
            .array => |*arr| args_array = arr,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow args must be an array",
                    .details = null,
                });
                return null;
            },
        }
    }

    var memo_map: ?*std.json.ObjectMap = null;
    if (object.getPtr("memo")) |memo_ptr| {
        switch (memo_ptr.*) {
            .object => |*map| memo_map = map,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow memo must be an object",
                    .details = null,
                });
                return null;
            },
        }
    }

    var search_map: ?*std.json.ObjectMap = null;
    if (object.getPtr("search_attributes")) |search_ptr| {
        switch (search_ptr.*) {
            .object => |*map| search_map = map,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow search_attributes must be an object",
                    .details = null,
                });
                return null;
            },
        }
    }

    var header_map: ?*std.json.ObjectMap = null;
    if (object.getPtr("headers")) |headers_ptr| {
        switch (headers_ptr.*) {
            .object => |*map| header_map = map,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow headers must be an object",
                    .details = null,
                });
                return null;
            },
        }
    }

    var retry_policy_map: ?*std.json.ObjectMap = null;
    if (object.getPtr("retry_policy")) |retry_ptr| {
        switch (retry_ptr.*) {
            .object => |*map| retry_policy_map = map,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow retry_policy must be an object",
                    .details = null,
                });
                return null;
            },
        }
    }

    var cron_schedule: ?[]const u8 = null;
    if (object.getPtr("cron_schedule")) |cron_ptr| {
        const cron_slice = switch (cron_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow cron_schedule must be a string",
                    .details = null,
                });
                return null;
            },
        };
        cron_schedule = cron_slice;
    }

    var exec_timeout_ms: ?u64 = null;
    if (object.getPtr("workflow_execution_timeout_ms")) |value_ptr| {
        exec_timeout_ms = shared.jsonValueToU64(value_ptr.*) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_execution_timeout_ms must be a non-negative integer",
                .details = null,
            });
            return null;
        };
    }

    var run_timeout_ms: ?u64 = null;
    if (object.getPtr("workflow_run_timeout_ms")) |value_ptr| {
        run_timeout_ms = shared.jsonValueToU64(value_ptr.*) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_run_timeout_ms must be a non-negative integer",
                .details = null,
            });
            return null;
        };
    }

    var task_timeout_ms: ?u64 = null;
    if (object.getPtr("workflow_task_timeout_ms")) |value_ptr| {
        task_timeout_ms = shared.jsonValueToU64(value_ptr.*) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_task_timeout_ms must be a non-negative integer",
                .details = null,
            });
            return null;
        };
    }

    var request_id_owned: ?[]u8 = null;
    defer if (request_id_owned) |owned| allocator.free(owned);

    var request_id_slice: []const u8 = ""[0..0];
    if (object.getPtr("request_id")) |request_ptr| {
        const req_slice = switch (request_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow request_id must be a string",
                    .details = null,
                });
                return null;
            },
        };
        if (req_slice.len == 0) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow request_id must be non-empty",
                .details = null,
            });
            return null;
        }
        request_id_slice = req_slice;
    } else {
        request_id_owned = shared.generateRequestId(allocator) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.resource_exhausted,
                .message = "temporal-bun-bridge-zig: failed to allocate workflow request_id",
                .details = null,
            });
            return null;
        };
        request_id_slice = request_id_owned.?;
    }

    const namespace_copy = common.duplicateSlice(allocator, namespace_slice) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate namespace copy",
            .details = null,
        });
        return null;
    };
    defer if (namespace_copy.len > 0) allocator.free(namespace_copy);

    const workflow_id_copy = common.duplicateSlice(allocator, workflow_id_slice) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate workflow_id copy",
            .details = null,
        });
        return null;
    };
    defer if (workflow_id_copy.len > 0) allocator.free(workflow_id_copy);

    const params = StartWorkflowRequestParts{
        .namespace = namespace_slice,
        .workflow_id = workflow_id_slice,
        .workflow_type = workflow_type_slice,
        .task_queue = task_queue_slice,
        .identity = identity_slice,
        .request_id = request_id_slice,
        .cron_schedule = cron_schedule,
        .workflow_execution_timeout_ms = exec_timeout_ms,
        .workflow_run_timeout_ms = run_timeout_ms,
        .workflow_task_timeout_ms = task_timeout_ms,
        .args = args_array,
        .memo = memo_map,
        .search_attributes = search_map,
        .headers = header_map,
        .retry_policy = retry_policy_map,
    };

    const request_bytes = shared.encodeStartWorkflowRequest(allocator, params) catch |err| {
        const message = switch (err) {
            error.InvalidNumber => "temporal-bun-bridge-zig: startWorkflow payload contains invalid numeric values",
            error.InvalidRetryPolicy => "temporal-bun-bridge-zig: startWorkflow retry_policy contains invalid values",
            else => "temporal-bun-bridge-zig: failed to encode startWorkflow request",
        };
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = message, .details = null });
        return null;
    };
    defer allocator.free(request_bytes);

    var context = StartWorkflowRpcContext{
        .allocator = allocator,
        .runtime_handle = runtime_handle,
        .core_runtime = retained_core_runtime,
    };
    context.wait_group.start();

    var call_options = std.mem.zeroes(core.RpcCallOptions);
    call_options.service = 1;
    call_options.rpc = common.makeByteArrayRef(start_workflow_rpc);
    call_options.req = common.makeByteArrayRef(request_bytes);
    call_options.retry = true;
    call_options.metadata = common.emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &call_options, &context, clientStartWorkflowCallback);
    context.wait_group.wait();

    const response_bytes = context.response;
    defer if (response_bytes.len > 0) allocator.free(response_bytes);

    const error_message_bytes = context.error_message;
    defer if (context.error_message_owned and error_message_bytes.len > 0) allocator.free(error_message_bytes);

    if (!context.success or response_bytes.len == 0) {
        const message = if (error_message_bytes.len > 0)
            error_message_bytes
        else
            "temporal-bun-bridge-zig: startWorkflow failed"[0..];
        errors.setStructuredErrorJson(.{
            .code = context.error_code,
            .message = message,
            .details = null,
        });
        return null;
    }

    const run_id_slice = shared.parseStartWorkflowRunId(response_bytes) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.internal,
            .message = "temporal-bun-bridge-zig: failed to decode startWorkflow response",
            .details = null,
        });
        return null;
    };

    const run_id_copy = common.duplicateSlice(allocator, run_id_slice) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate workflow run_id",
            .details = null,
        });
        return null;
    };
    defer if (run_id_copy.len > 0) allocator.free(run_id_copy);

    const ResponsePayload = struct {
        runId: []const u8,
        workflowId: []const u8,
        namespace: []const u8,
    };

    const response_json = std.json.Stringify.valueAlloc(allocator, ResponsePayload{
        .runId = run_id_copy,
        .workflowId = workflow_id_copy,
        .namespace = namespace_copy,
    }, .{}) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to encode startWorkflow metadata",
            .details = null,
        });
        return null;
    };
    defer allocator.free(response_json);

    const result_array = byte_array.allocate(.{ .slice = response_json }) orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate startWorkflow response",
            .details = null,
        });
        return null;
    };

    errors.setLastError(""[0..0]);
    return result_array;
}
