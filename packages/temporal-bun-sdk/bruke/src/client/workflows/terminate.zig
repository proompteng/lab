const std = @import("std");
const common = @import("../common.zig");
const errors = @import("../../errors.zig");
const runtime = @import("../../runtime.zig");
const pending = @import("../../pending.zig");
const core = @import("../../core.zig");
const shared = @import("shared.zig");

const grpc = common.grpc;
const makeByteArrayRef = common.makeByteArrayRef;
const emptyByteArrayRef = common.emptyByteArrayRef;
const TerminateWorkflowRequestParts = shared.TerminateWorkflowRequestParts;
const encodeTerminateWorkflowRequest = shared.encodeTerminateWorkflowRequest;

const terminate_workflow_rpc = "TerminateWorkflowExecution";
const terminate_workflow_failure_default = "temporal-bun-bridge-zig: terminateWorkflow failed";

const TerminateWorkflowRpcContext = struct {
    allocator: std.mem.Allocator,
    wait_group: std.Thread.WaitGroup = .{},
    runtime_handle: *runtime.RuntimeHandle,
    error_message_owned: bool = false,
    error_message: []const u8 = ""[0..0],
    success: bool = false,
    error_code: i32 = grpc.internal,
};

fn releaseTerminateMessage(context: *TerminateWorkflowRpcContext) void {
    if (context.error_message_owned and context.error_message.len > 0) {
        context.allocator.free(@constCast(context.error_message));
        context.error_message_owned = false;
    }
    if (!context.error_message_owned) {
        context.error_message = ""[0..0];
    }
}

fn clientTerminateWorkflowCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
    failure_details: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*TerminateWorkflowRpcContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    defer {
        if (failure_details) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    }

    if (success) |ptr| {
        core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    }

    if (status_code == 0) {
        releaseTerminateMessage(context);
        context.success = true;
        context.error_code = 0;
        context.error_message = ""[0..0];
        if (failure_message) |ptr| {
            core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
        }
        return;
    }

    const code: i32 = @intCast(status_code);
    context.error_code = code;
    releaseTerminateMessage(context);

    if (failure_message) |ptr| {
        const slice = common.byteArraySlice(ptr);
        if (slice.len > 0) {
            const copy = context.allocator.alloc(u8, slice.len) catch {
                context.error_message = terminate_workflow_failure_default;
                context.error_message_owned = false;
                context.success = false;
                return;
            };
            @memcpy(copy, slice);
            context.error_message = copy;
            context.error_message_owned = true;
        } else {
            context.error_message = terminate_workflow_failure_default;
            context.error_message_owned = false;
        }
        core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    } else {
        context.error_message = terminate_workflow_failure_default;
        context.error_message_owned = false;
    }

    context.success = false;
}

pub fn terminateWorkflow(_client: ?*common.ClientHandle, _payload: []const u8) i32 {
    if (_client == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow received null client",
            .details = null,
        });
        return -1;
    }

    if (_payload.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow payload must be non-empty",
            .details = null,
        });
        return -1;
    }

    const client_ptr = _client.?;
    const runtime_handle = client_ptr.runtime orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: terminateWorkflow missing runtime handle",
            .details = null,
        });
        return -1;
    };

    if (runtime_handle.core_runtime == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime core handle is not initialized",
            .details = null,
        });
        return -1;
    }

    const core_client = client_ptr.core_client orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: client core handle is not initialized",
            .details = null,
        });
        return -1;
    };

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, _payload, .{ .ignore_unknown_fields = true }) catch |err| {
        var scratch: [192]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: terminateWorkflow payload must be valid JSON: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: terminateWorkflow payload must be valid JSON";
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = message, .details = null });
        return -1;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow payload must be a JSON object",
            .details = null,
        });
        return -1;
    }

    var object = parsed.value.object;

    const namespace_ptr = object.getPtr("namespace") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow namespace is required",
            .details = null,
        });
        return -1;
    };
    const namespace_slice = switch (namespace_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: terminateWorkflow namespace must be a string",
                .details = null,
            });
            return -1;
        },
    };
    if (namespace_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow namespace must be non-empty",
            .details = null,
        });
        return -1;
    }

    const workflow_id_ptr = object.getPtr("workflow_id") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow workflow_id is required",
            .details = null,
        });
        return -1;
    };
    const workflow_id_slice = switch (workflow_id_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: terminateWorkflow workflow_id must be a string",
                .details = null,
            });
            return -1;
        },
    };
    if (workflow_id_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow workflow_id must be non-empty",
            .details = null,
        });
        return -1;
    }

    var run_id: ?[]const u8 = null;
    if (object.getPtr("run_id")) |run_ptr| {
        const slice = switch (run_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow run_id must be a string",
                    .details = null,
                });
                return -1;
            },
        };
        if (slice.len == 0) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: terminateWorkflow run_id must be non-empty",
                .details = null,
            });
            return -1;
        }
        run_id = slice;
    }

    var first_execution_run_id: ?[]const u8 = null;
    if (object.getPtr("first_execution_run_id")) |first_ptr| {
        const slice = switch (first_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow first_execution_run_id must be a string",
                    .details = null,
                });
                return -1;
            },
        };
        if (slice.len == 0) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: terminateWorkflow first_execution_run_id must be non-empty",
                .details = null,
            });
            return -1;
        }
        first_execution_run_id = slice;
    }

    var reason_slice: ?[]const u8 = null;
    if (object.getPtr("reason")) |reason_ptr| {
        const slice = switch (reason_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow reason must be a string",
                    .details = null,
                });
                return -1;
            },
        };
        reason_slice = slice;
    }

    var details_array: ?*std.json.Array = null;
    if (object.getPtr("details")) |details_ptr| {
        switch (details_ptr.*) {
            .array => |*arr| details_array = arr,
            .null => {},
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow details must be an array",
                    .details = null,
                });
                return -1;
            },
        }
    }

    var identity_slice: ?[]const u8 = null;
    if (object.getPtr("identity")) |identity_ptr| {
        const slice = switch (identity_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow identity must be a string",
                    .details = null,
                });
                return -1;
            },
        };
        if (slice.len != 0) {
            identity_slice = slice;
        }
    }

    if (identity_slice == null) {
        identity_slice = common.extractOptionalStringField(client_ptr.config, &.{"identity"});
    }

    const params = TerminateWorkflowRequestParts{
        .namespace = namespace_slice,
        .workflow_id = workflow_id_slice,
        .run_id = run_id,
        .first_execution_run_id = first_execution_run_id,
        .reason = reason_slice,
        .details = details_array,
        .identity = identity_slice,
    };

    const request_bytes = encodeTerminateWorkflowRequest(allocator, params) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate terminateWorkflow request",
            .details = null,
        });
        return -1;
    };
    defer allocator.free(request_bytes);

    if (!runtime.beginPendingClientConnect(runtime_handle)) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
            .details = null,
        });
        return -1;
    }
    defer runtime.endPendingClientConnect(runtime_handle);

    var context = TerminateWorkflowRpcContext{
        .allocator = allocator,
        .runtime_handle = runtime_handle,
    };
    context.wait_group.start();

    var call_options = std.mem.zeroes(core.RpcCallOptions);
    call_options.service = 1;
    call_options.rpc = makeByteArrayRef(terminate_workflow_rpc);
    call_options.req = makeByteArrayRef(request_bytes);
    call_options.retry = true;
    call_options.metadata = emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &call_options, &context, clientTerminateWorkflowCallback);
    context.wait_group.wait();

    const error_message = context.error_message;
    defer releaseTerminateMessage(&context);

    if (!context.success) {
        const message = if (error_message.len > 0) error_message else terminate_workflow_failure_default;
        errors.setStructuredErrorJson(.{ .code = context.error_code, .message = message, .details = null });
        return -1;
    }

    errors.setLastError(""[0..0]);
    return 0;
}
