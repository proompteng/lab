const std = @import("std");
const common = @import("../common.zig");
const pending = @import("../../pending.zig");
const byte_array = @import("../../byte_array.zig");
const core = @import("../../core.zig");

const grpc = common.grpc;

const CancelPayloadError = error{
    InvalidJson,
    MissingNamespace,
    MissingWorkflowId,
    InvalidRunId,
    InvalidFirstExecutionRunId,
};

const CancelPayloadValidator = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    run_id: ?[]const u8 = null,
    first_execution_run_id: ?[]const u8 = null,
};

const CancelWorkerContext = struct {
    handle: *pending.PendingByteArray,
    client: *common.ClientHandle,
    payload: []u8,
};

fn validateCancelPayload(payload: []const u8) CancelPayloadError!void {
    const allocator = std.heap.c_allocator;
    var parsed = std.json.parseFromSlice(CancelPayloadValidator, allocator, payload, .{
        .ignore_unknown_fields = true,
    }) catch {
        return CancelPayloadError.InvalidJson;
    };
    defer parsed.deinit();

    if (parsed.value.namespace.len == 0) {
        return CancelPayloadError.MissingNamespace;
    }

    if (parsed.value.workflow_id.len == 0) {
        return CancelPayloadError.MissingWorkflowId;
    }

    if (parsed.value.run_id) |run| {
        if (run.len == 0) {
            return CancelPayloadError.InvalidRunId;
        }
    }

    if (parsed.value.first_execution_run_id) |first| {
        if (first.len == 0) {
            return CancelPayloadError.InvalidFirstExecutionRunId;
        }
    }
}

fn runCancelWorkflow(context: CancelWorkerContext) void {
    defer std.heap.c_allocator.free(context.payload);
    defer pending.release(context.handle);

    core.cancelWorkflow(context.client.core_client, context.payload) catch |err| {
        const Rejection = struct { code: i32, message: []const u8 };
        const failure: Rejection = switch (err) {
            core.CancelWorkflowError.NotFound => .{ .code = grpc.not_found, .message = "temporal-bun-bridge-zig: workflow not found" },
            core.CancelWorkflowError.ClientUnavailable => .{ .code = grpc.unavailable, .message = "temporal-bun-bridge-zig: Temporal core client unavailable" },
            core.CancelWorkflowError.Internal => .{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to cancel workflow" },
        };
        _ = pending.rejectByteArray(context.handle, failure.code, failure.message);
        return;
    };

    const ack = byte_array.allocate(.{ .slice = "" }) orelse {
        const message = "temporal-bun-bridge-zig: failed to allocate cancel acknowledgment";
        _ = pending.rejectByteArray(context.handle, grpc.internal, message);
        return;
    };

    if (!pending.resolveByteArray(context.handle, ack)) {
        byte_array.free(ack);
        const message = "temporal-bun-bridge-zig: failed to resolve cancel pending handle";
        _ = pending.rejectByteArray(context.handle, grpc.internal, message);
    }
}

pub fn cancelWorkflow(client_ptr: ?*common.ClientHandle, payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return common.createByteArrayError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: cancelWorkflow received null client",
        );
    }

    if (payload.len == 0) {
        return common.createByteArrayError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: cancelWorkflow payload must be non-empty",
        );
    }

    validateCancelPayload(payload) catch |err| {
        const message = switch (err) {
            CancelPayloadError.InvalidJson => "temporal-bun-bridge-zig: cancelWorkflow payload must be valid JSON",
            CancelPayloadError.MissingNamespace => "temporal-bun-bridge-zig: cancelWorkflow namespace must be a non-empty string",
            CancelPayloadError.MissingWorkflowId => "temporal-bun-bridge-zig: cancelWorkflow workflow_id must be a non-empty string",
            CancelPayloadError.InvalidRunId => "temporal-bun-bridge-zig: cancelWorkflow run_id must be a non-empty string",
            CancelPayloadError.InvalidFirstExecutionRunId => "temporal-bun-bridge-zig: cancelWorkflow first_execution_run_id must be a non-empty string",
        };
        return common.createByteArrayError(grpc.invalid_argument, message);
    };

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, payload.len) catch {
        return common.createByteArrayError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to allocate cancel payload copy",
        );
    };
    @memcpy(copy, payload);

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        allocator.free(copy);
        return common.createByteArrayError(
            grpc.internal,
            "temporal-bun-bridge-zig: failed to allocate pending cancel handle",
        );
    };

    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_handle_ptr));
    const client_handle = client_ptr.?;

    const context = CancelWorkerContext{
        .handle = pending_handle,
        .client = client_handle,
        .payload = copy,
    };

    if (!pending.retain(pending_handle_ptr)) {
        allocator.free(copy);
        pending.free(pending_handle_ptr);
        return common.createByteArrayError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to retain pending cancel handle",
        );
    }

    const thread = std.Thread.spawn(.{}, runCancelWorkflow, .{context}) catch |err| {
        allocator.free(copy);
        pending.release(pending_handle_ptr);
        pending.free(pending_handle_ptr);
        var scratch: [128]u8 = undefined;
        const formatted = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn cancel worker thread: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to spawn cancel worker thread";
        return common.createByteArrayError(grpc.internal, formatted);
    };
    thread.detach();

    return pending_handle;
}
