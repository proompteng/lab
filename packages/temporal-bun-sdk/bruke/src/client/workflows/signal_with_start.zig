const std = @import("std");
const common = @import("../common.zig");
const errors = @import("../../errors.zig");
const runtime = @import("../../runtime.zig");
const core = @import("../../core.zig");
const byte_array = @import("../../byte_array.zig");
const shared = @import("shared.zig");
const start = @import("start.zig");

const grpc = common.grpc;
const ArrayListManaged = common.ArrayListManaged;
const StartWorkflowRequestParts = shared.StartWorkflowRequestParts;
const StartWorkflowRpcContext = start.StartWorkflowRpcContext;
const clientStartWorkflowCallback = start.clientStartWorkflowCallback;
const generateRequestId = shared.generateRequestId;
const encodePayloadsFromArray = shared.encodePayloadsFromArray;
const encodePayloadMap = shared.encodePayloadMap;
const appendLengthDelimited = shared.appendLengthDelimited;
const appendString = shared.appendString;
const appendBytes = shared.appendBytes;
const appendVarint = shared.appendVarint;
const encodeDurationMillis = shared.encodeDurationMillis;
const encodeRetryPolicyFromObject = shared.encodeRetryPolicyFromObject;
const parseStartWorkflowRunId = shared.parseStartWorkflowRunId;
const duplicateSlice = common.duplicateSlice;
const makeByteArrayRef = common.makeByteArrayRef;
const emptyByteArrayRef = common.emptyByteArrayRef;

pub fn signalWithStart(_client: ?*common.ClientHandle, _payload: []const u8) ?*byte_array.ByteArray {
    if (_client == null) {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart received null client", .details = null });
        return null;
    }
    if (_payload.len == 0) {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart payload must be non-empty", .details = null });
        return null;
    }

    const allocator = std.heap.c_allocator;

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, _payload, .{ .ignore_unknown_fields = true }) catch |err| {
        var scratch: [200]u8 = undefined;
        const msg = std.fmt.bufPrint(&scratch, "temporal-bun-bridge-zig: signalWithStart payload must be valid JSON: {}", .{err}) catch "temporal-bun-bridge-zig: signalWithStart payload must be valid JSON";
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = msg, .details = null });
        return null;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart payload must be a JSON object", .details = null });
        return null;
    }

    var obj = parsed.value.object;

    const namespace_ptr = obj.getPtr("namespace") orelse {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart namespace is required", .details = null });
        return null;
    };
    const namespace = switch (namespace_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart namespace must be a string", .details = null });
            return null;
        },
    };
    if (namespace.len == 0) {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart namespace must be non-empty", .details = null });
        return null;
    }

    const workflow_id_ptr = obj.getPtr("workflow_id") orelse {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart workflow_id is required", .details = null });
        return null;
    };
    const workflow_id = switch (workflow_id_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart workflow_id must be a string", .details = null });
            return null;
        },
    };
    if (workflow_id.len == 0) {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart workflow_id must be non-empty", .details = null });
        return null;
    }

    const signal_name_ptr = obj.getPtr("signal_name") orelse {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart signal_name is required", .details = null });
        return null;
    };
    const signal_name = switch (signal_name_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart signal_name must be a string", .details = null });
            return null;
        },
    };
    if (signal_name.len == 0) {
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart signal_name must be non-empty", .details = null });
        return null;
    }

    var signal_args_array: ?*std.json.Array = null;
    if (obj.getPtr("signal_args")) |args_ptr| {
        switch (args_ptr.*) {
            .array => |*arr| signal_args_array = arr,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart signal_args must be an array", .details = null });
                return null;
            },
        }
    }

    var memo_map: ?*std.json.ObjectMap = null;
    if (obj.getPtr("memo")) |memo_ptr| {
        switch (memo_ptr.*) {
            .object => |*map| memo_map = map,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart memo must be an object", .details = null });
                return null;
            },
        }
    }

    var search_map: ?*std.json.ObjectMap = null;
    if (obj.getPtr("search_attributes")) |search_ptr| {
        switch (search_ptr.*) {
            .object => |*map| search_map = map,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart search_attributes must be an object", .details = null });
                return null;
            },
        }
    }

    var header_map: ?*std.json.ObjectMap = null;
    if (obj.getPtr("headers")) |headers_ptr| {
        switch (headers_ptr.*) {
            .object => |*map| header_map = map,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart headers must be an object", .details = null });
                return null;
            },
        }
    }

    var retry_policy_map: ?*std.json.ObjectMap = null;
    if (obj.getPtr("retry_policy")) |retry_ptr| {
        switch (retry_ptr.*) {
            .object => |*map| retry_policy_map = map,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart retry_policy must be an object", .details = null });
                return null;
            },
        }
    }

    var cron_schedule: ?[]const u8 = null;
    if (obj.getPtr("cron_schedule")) |cron_ptr| {
        const cron_slice = switch (cron_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart cron_schedule must be a string", .details = null });
                return null;
            },
        };
        cron_schedule = cron_slice;
    }

    var exec_timeout_ms: ?u64 = null;
    if (obj.getPtr("workflow_execution_timeout_ms")) |value_ptr| {
        exec_timeout_ms = shared.jsonValueToU64(value_ptr.*) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: signalWithStart workflow_execution_timeout_ms must be a non-negative integer",
                .details = null,
            });
            return null;
        };
    }

    var run_timeout_ms: ?u64 = null;
    if (obj.getPtr("workflow_run_timeout_ms")) |value_ptr| {
        run_timeout_ms = shared.jsonValueToU64(value_ptr.*) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: signalWithStart workflow_run_timeout_ms must be a non-negative integer",
                .details = null,
            });
            return null;
        };
    }

    var task_timeout_ms: ?u64 = null;
    if (obj.getPtr("workflow_task_timeout_ms")) |value_ptr| {
        task_timeout_ms = shared.jsonValueToU64(value_ptr.*) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: signalWithStart workflow_task_timeout_ms must be a non-negative integer",
                .details = null,
            });
            return null;
        };
    }

    const workflow_type = blk: {
        const p = obj.getPtr("workflow_type") orelse {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart workflow_type is required", .details = null });
            return null;
        };
        const s = switch (p.*) {
            .string => |v| v,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart workflow_type must be a string", .details = null });
                return null;
            },
        };
        if (s.len == 0) {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart workflow_type must be non-empty", .details = null });
            return null;
        }
        break :blk s;
    };

    const task_queue = blk: {
        const p = obj.getPtr("task_queue") orelse {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart task_queue is required", .details = null });
            return null;
        };
        const s = switch (p.*) {
            .string => |v| v,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart task_queue must be a string", .details = null });
                return null;
            },
        };
        if (s.len == 0) {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart task_queue must be non-empty", .details = null });
            return null;
        }
        break :blk s;
    };

    const identity = blk: {
        const p = obj.getPtr("identity") orelse {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart identity is required", .details = null });
            return null;
        };
        const s = switch (p.*) {
            .string => |v| v,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart identity must be a string", .details = null });
                return null;
            },
        };
        if (s.len == 0) {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart identity must be non-empty", .details = null });
            return null;
        }
        break :blk s;
    };

    var request_id_owned: ?[]u8 = null;
    var request_id_slice: []const u8 = ""[0..0];
    if (obj.getPtr("request_id")) |p| {
        const s = switch (p.*) {
            .string => |v| v,
            else => {
                errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart request_id must be a string", .details = null });
                return null;
            },
        };
        if (s.len == 0) {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: signalWithStart request_id must be non-empty", .details = null });
            return null;
        }
        request_id_slice = s;
    } else {
        request_id_owned = generateRequestId(allocator) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to allocate signalWithStart request_id", .details = null });
            return null;
        };
        request_id_slice = request_id_owned.?;
    }
    defer if (request_id_owned) |owned| allocator.free(owned);

    const start_params = StartWorkflowRequestParts{
        .namespace = namespace,
        .workflow_id = workflow_id,
        .workflow_type = workflow_type,
        .task_queue = task_queue,
        .identity = identity,
        .request_id = request_id_slice,
        .cron_schedule = cron_schedule,
        .workflow_execution_timeout_ms = exec_timeout_ms,
        .workflow_run_timeout_ms = run_timeout_ms,
        .workflow_task_timeout_ms = task_timeout_ms,
        .args = signal_args_array,
        .memo = memo_map,
        .search_attributes = search_map,
        .headers = header_map,
        .retry_policy = retry_policy_map,
    };

    var request = ArrayListManaged(u8).init(allocator);
    defer request.deinit();

    appendString(&request, 1, namespace) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS namespace", .details = null });
        return null;
    };

    appendString(&request, 2, workflow_id) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS workflow_id", .details = null });
        return null;
    };

    var workflow_type_buf = ArrayListManaged(u8).init(allocator);
    defer workflow_type_buf.deinit();
    appendString(&workflow_type_buf, 1, workflow_type) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS workflow_type name", .details = null });
        return null;
    };
    const workflow_type_bytes = workflow_type_buf.toOwnedSlice() catch {
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to allocate SWS workflow_type buffer", .details = null });
        return null;
    };
    defer allocator.free(workflow_type_bytes);
    appendLengthDelimited(&request, 3, workflow_type_bytes) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS workflow_type", .details = null });
        return null;
    };

    var task_queue_buf = ArrayListManaged(u8).init(allocator);
    defer task_queue_buf.deinit();
    appendString(&task_queue_buf, 1, task_queue) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS task_queue name", .details = null });
        return null;
    };
    appendVarint(&task_queue_buf, 2, 1) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS task_queue kind", .details = null });
        return null;
    };
    const task_queue_bytes = task_queue_buf.toOwnedSlice() catch {
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to allocate SWS task_queue buffer", .details = null });
        return null;
    };
    defer allocator.free(task_queue_bytes);
    appendLengthDelimited(&request, 4, task_queue_bytes) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS task_queue", .details = null });
        return null;
    };

    if (start_params.args) |array_ptr| {
        const payloads_opt = encodePayloadsFromArray(allocator, array_ptr) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: failed to encode SWS args", .details = null });
            return null;
        };
        if (payloads_opt) |payloads| {
            defer allocator.free(payloads);
            appendLengthDelimited(&request, 5, payloads) catch {
                errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS input payloads", .details = null });
                return null;
            };
        }
    }

    if (start_params.workflow_execution_timeout_ms) |millis| {
        const duration = encodeDurationMillis(allocator, millis) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS workflow_execution_timeout", .details = null });
            return null;
        };
        defer allocator.free(duration);
        appendLengthDelimited(&request, 6, duration) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to append SWS workflow_execution_timeout", .details = null });
            return null;
        };
    }

    if (start_params.workflow_run_timeout_ms) |millis| {
        const duration = encodeDurationMillis(allocator, millis) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS workflow_run_timeout", .details = null });
            return null;
        };
        defer allocator.free(duration);
        appendLengthDelimited(&request, 7, duration) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to append SWS workflow_run_timeout", .details = null });
            return null;
        };
    }

    if (start_params.workflow_task_timeout_ms) |millis| {
        const duration = encodeDurationMillis(allocator, millis) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS workflow_task_timeout", .details = null });
            return null;
        };
        defer allocator.free(duration);
        appendLengthDelimited(&request, 8, duration) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to append SWS workflow_task_timeout", .details = null });
            return null;
        };
    }

    appendString(&request, 9, identity) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS identity", .details = null });
        return null;
    };

    appendString(&request, 10, request_id_slice) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS request_id", .details = null });
        return null;
    };

    appendString(&request, 12, signal_name) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS signal_name", .details = null });
        return null;
    };

    if (signal_args_array) |args_array| {
        const payloads = encodePayloadsFromArray(allocator, args_array) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: failed to encode SWS signal_args", .details = null });
            return null;
        };
        if (payloads) |bytes| {
            defer allocator.free(bytes);
            appendLengthDelimited(&request, 13, bytes) catch {
                errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS signal payloads", .details = null });
                return null;
            };
        }
    }

    if (start_params.retry_policy) |policy_map| {
        const encoded_retry = encodeRetryPolicyFromObject(allocator, policy_map) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: failed to encode SWS retry_policy", .details = null });
            return null;
        };
        if (encoded_retry) |retry_bytes| {
            defer allocator.free(retry_bytes);
            appendLengthDelimited(&request, 15, retry_bytes) catch {
                errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to append SWS retry_policy", .details = null });
                return null;
            };
        }
    }

    if (cron_schedule) |schedule| {
        if (schedule.len != 0) {
            appendString(&request, 16, schedule) catch {
                errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to encode SWS cron_schedule", .details = null });
                return null;
            };
        }
    }

    if (memo_map) |map| {
        const memo_bytes = encodePayloadMap(allocator, map) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: failed to encode SWS memo", .details = null });
            return null;
        };
        if (memo_bytes) |bytes| {
            defer allocator.free(bytes);
            appendLengthDelimited(&request, 17, bytes) catch {
                errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to append SWS memo", .details = null });
                return null;
            };
        }
    }

    if (search_map) |map| {
        const search_bytes = encodePayloadMap(allocator, map) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: failed to encode SWS search_attributes", .details = null });
            return null;
        };
        if (search_bytes) |bytes| {
            defer allocator.free(bytes);
            appendLengthDelimited(&request, 18, bytes) catch {
                errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to append SWS search_attributes", .details = null });
                return null;
            };
        }
    }

    if (header_map) |map| {
        const header_bytes = encodePayloadMap(allocator, map) catch {
            errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: failed to encode SWS header", .details = null });
            return null;
        };
        if (header_bytes) |bytes| {
            defer allocator.free(bytes);
            appendLengthDelimited(&request, 19, bytes) catch {
                errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to append SWS header", .details = null });
                return null;
            };
        }
    }

    const client_ptr = _client.?;
    const runtime_handle = client_ptr.runtime orelse {
        errors.setStructuredErrorJson(.{ .code = grpc.failed_precondition, .message = "temporal-bun-bridge-zig: signalWithStart missing runtime handle", .details = null });
        return null;
    };
    if (runtime_handle.core_runtime == null) {
        errors.setStructuredErrorJson(.{ .code = grpc.failed_precondition, .message = "temporal-bun-bridge-zig: runtime core handle is not initialized", .details = null });
        return null;
    }
    const core_client = client_ptr.core_client orelse {
        errors.setStructuredErrorJson(.{ .code = grpc.failed_precondition, .message = "temporal-bun-bridge-zig: client core handle is not initialized", .details = null });
        return null;
    };

    var context = StartWorkflowRpcContext{ .allocator = allocator, .runtime_handle = runtime_handle };
    context.wait_group.start();

    var call_options = std.mem.zeroes(core.RpcCallOptions);
    call_options.service = 1;
    call_options.rpc = makeByteArrayRef("SignalWithStartWorkflowExecution");
    call_options.req = makeByteArrayRef(request.items);
    call_options.retry = true;
    call_options.metadata = emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &call_options, &context, clientStartWorkflowCallback);
    context.wait_group.wait();

    const response_bytes = context.response;
    defer if (response_bytes.len > 0) allocator.free(response_bytes);

    const error_message_bytes = context.error_message;
    defer if (context.error_message_owned and error_message_bytes.len > 0) allocator.free(error_message_bytes);

    if (!context.success or response_bytes.len == 0) {
        const message = if (error_message_bytes.len > 0) error_message_bytes else "temporal-bun-bridge-zig: signalWithStart failed"[0..];
        errors.setStructuredErrorJson(.{ .code = context.error_code, .message = message, .details = null });
        return null;
    }

    const run_id_slice = parseStartWorkflowRunId(response_bytes) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to decode signalWithStart response", .details = null });
        return null;
    };

    const run_id_copy = duplicateSlice(allocator, run_id_slice) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to allocate workflow run_id", .details = null });
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
        .workflowId = workflow_id,
        .namespace = namespace,
    }, .{}) catch {
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to encode signalWithStart metadata", .details = null });
        return null;
    };
    defer allocator.free(response_json);

    const result_array = byte_array.allocate(.{ .slice = response_json }) orelse {
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to allocate signalWithStart response", .details = null });
        return null;
    };

    errors.setLastError(""[0..0]);
    return result_array;
}
