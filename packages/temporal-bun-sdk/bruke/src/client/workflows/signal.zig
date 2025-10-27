const std = @import("std");
const common = @import("../common.zig");
const errors = @import("../../errors.zig");
const pending = @import("../../pending.zig");
const core = @import("../../core.zig");
const byte_array = @import("../../byte_array.zig");

const grpc = common.grpc;
const ClientHandle = common.ClientHandle;

const SignalPayloadError = error{
    InvalidJson,
    MissingNamespace,
    MissingWorkflowId,
    MissingSignalName,
};

const SignalPayloadValidator = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    signal_name: []const u8,
};

fn validateSignalPayload(payload: []const u8) SignalPayloadError!void {
    const allocator = std.heap.c_allocator;
    var parsed = std.json.parseFromSlice(SignalPayloadValidator, allocator, payload, .{ .ignore_unknown_fields = true }) catch {
        return SignalPayloadError.InvalidJson;
    };
    defer parsed.deinit();

    if (parsed.value.namespace.len == 0) return SignalPayloadError.MissingNamespace;
    if (parsed.value.workflow_id.len == 0) return SignalPayloadError.MissingWorkflowId;
    if (parsed.value.signal_name.len == 0) return SignalPayloadError.MissingSignalName;
}

const SignalWorkerContext = struct {
    handle: *pending.PendingByteArray,
    client: *ClientHandle,
    payload: []u8,
};

fn runSignalWorkflow(context: SignalWorkerContext) void {
    defer std.heap.c_allocator.free(context.payload);
    defer pending.release(context.handle);

    core.signalWorkflow(context.client.core_client, context.payload) catch |err| {
        const Rejection = struct { code: i32, message: []const u8 };
        const failure: Rejection = switch (err) {
            core.SignalWorkflowError.NotFound => .{ .code = grpc.not_found, .message = "temporal-bun-bridge-zig: workflow not found" },
            core.SignalWorkflowError.ClientUnavailable => .{ .code = grpc.unavailable, .message = "temporal-bun-bridge-zig: Temporal core client unavailable" },
            core.SignalWorkflowError.Internal => .{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to signal workflow" },
        };
        _ = pending.rejectByteArray(context.handle, failure.code, failure.message);
        return;
    };

    const ack = byte_array.allocate(.{ .slice = "" }) orelse {
        const message = "temporal-bun-bridge-zig: failed to allocate signal acknowledgment";
        _ = pending.rejectByteArray(context.handle, grpc.internal, message);
        return;
    };

    if (!pending.resolveByteArray(context.handle, ack)) {
        byte_array.free(ack);
        const message = "temporal-bun-bridge-zig: failed to resolve signal pending handle";
        _ = pending.rejectByteArray(context.handle, grpc.internal, message);
    }
}

pub fn signalWorkflow(client_ptr: ?*ClientHandle, payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return common.createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: signalWorkflow received null client");
    }

    validateSignalPayload(payload) catch |err| {
        const message = switch (err) {
            SignalPayloadError.InvalidJson => "temporal-bun-bridge-zig: signalWorkflow payload must be valid JSON",
            SignalPayloadError.MissingNamespace => "temporal-bun-bridge-zig: signalWorkflow namespace must be a non-empty string",
            SignalPayloadError.MissingWorkflowId => "temporal-bun-bridge-zig: signalWorkflow workflow_id must be a non-empty string",
            SignalPayloadError.MissingSignalName => "temporal-bun-bridge-zig: signalWorkflow signal_name must be a non-empty string",
        };
        return common.createByteArrayError(grpc.invalid_argument, message);
    };

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, payload.len) catch {
        return common.createByteArrayError(grpc.resource_exhausted, "temporal-bun-bridge-zig: failed to allocate signal payload copy");
    };
    @memcpy(copy, payload);

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        allocator.free(copy);
        return common.createByteArrayError(grpc.internal, "temporal-bun-bridge-zig: failed to allocate pending signal handle");
    };

    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_handle_ptr));
    const client_handle = client_ptr.?;

    const context = SignalWorkerContext{
        .handle = pending_handle,
        .client = client_handle,
        .payload = copy,
    };

    if (!pending.retain(pending_handle_ptr)) {
        allocator.free(copy);
        pending.free(pending_handle_ptr);
        return common.createByteArrayError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to retain pending signal handle",
        );
    }

    const thread = std.Thread.spawn(.{}, runSignalWorkflow, .{context}) catch |err| {
        allocator.free(copy);
        pending.release(pending_handle_ptr);
        pending.free(pending_handle_ptr);
        var scratch: [128]u8 = undefined;
        const formatted = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn signal worker thread: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to spawn signal worker thread";
        return common.createByteArrayError(grpc.internal, formatted);
    };
    thread.detach();

    return pending_handle;
}
