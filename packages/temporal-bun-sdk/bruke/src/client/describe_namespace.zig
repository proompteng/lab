const std = @import("std");
const common = @import("common.zig");
const errors = @import("../errors.zig");
const runtime = @import("../runtime.zig");
const pending = @import("../pending.zig");
const core = @import("../core.zig");
const byte_array = @import("../byte_array.zig");

const grpc = common.grpc;
const ClientHandle = common.ClientHandle;

const RpcContext = struct {
    allocator: std.mem.Allocator,
    pending_handle: *pending.PendingByteArray,
    runtime_handle: *runtime.RuntimeHandle,
    core_runtime: ?*core.RuntimeOpaque,
    wait_group: std.Thread.WaitGroup = .{},
};

const DescribeNamespaceTask = struct {
    allocator: std.mem.Allocator,
    client: ?*ClientHandle,
    pending_handle: *pending.PendingByteArray,
    namespace: []u8,
};

fn encodeDescribeNamespaceRequest(allocator: std.mem.Allocator, namespace: []const u8) ![]u8 {
    var buffer = std.ArrayListUnmanaged(u8){};
    defer buffer.deinit(allocator);

    try buffer.append(allocator, 0x0A); // field 1, length-delimited

    var remaining = namespace.len;
    while (true) {
        var byte: u8 = @intCast(remaining & 0x7F);
        remaining >>= 7;
        if (remaining != 0) {
            byte |= 0x80;
        }
        try buffer.append(allocator, byte);
        if (remaining == 0) break;
    }

    try buffer.appendSlice(allocator, namespace);
    return buffer.toOwnedSlice(allocator);
}

fn parseNamespace(allocator: std.mem.Allocator, payload: []const u8) ![]u8 {
    if (payload.len == 0) {
        return error.EmptyPayload;
    }

    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, payload, .{});
    defer parsed.deinit();

    if (parsed.value != .object) {
        return error.InvalidShape;
    }

    const obj = parsed.value.object;
    const namespace_ptr = obj.getPtr("namespace") orelse return error.MissingNamespace;
    const namespace_value = namespace_ptr.*;
    if (namespace_value != .string) {
        return error.InvalidNamespace;
    }

    const namespace = namespace_value.string;
    if (namespace.len == 0) {
        return error.InvalidNamespace;
    }

    const copy = try allocator.alloc(u8, namespace.len);
    @memcpy(copy, namespace);
    return copy;
}

fn describeNamespaceCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
    failure_details: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*RpcContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    const core_runtime_ptr = context.core_runtime orelse context.runtime_handle.core_runtime;

    defer if (failure_message) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);
    defer if (failure_details) |ptr| core.api.byte_array_free(core_runtime_ptr, ptr);

    if (success != null and status_code == 0) {
        const slice = common.byteArraySlice(success.?);
        const array_ptr = byte_array.allocate(.{ .slice = slice }) orelse {
            core.api.byte_array_free(core_runtime_ptr, success.?);
            const message = "temporal-bun-bridge-zig: failed to allocate describeNamespace response";
            _ = pending.rejectByteArray(context.pending_handle, grpc.resource_exhausted, message);
            errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
            return;
        };

        core.api.byte_array_free(core_runtime_ptr, success.?);
        if (!pending.resolveByteArray(context.pending_handle, array_ptr)) {
            byte_array.free(array_ptr);
        } else {
            errors.setLastError(""[0..0]);
        }
        return;
    }

    if (success) |ptr| {
        core.api.byte_array_free(core_runtime_ptr, ptr);
    }

    const code: i32 = if (status_code == 0) grpc.internal else @as(i32, @intCast(status_code));
    const message_slice = if (failure_message) |ptr| common.byteArraySlice(ptr) else "temporal-bun-bridge-zig: describeNamespace failed"[0..];
    _ = pending.rejectByteArray(context.pending_handle, code, message_slice);
    errors.setStructuredError(.{ .code = code, .message = message_slice });
}

fn describeNamespaceWorker(task: *DescribeNamespaceTask) void {
    const allocator = task.allocator;
    defer allocator.free(task.namespace);

    const pending_handle = task.pending_handle;
    defer pending.release(pending_handle);

    const client_ptr = task.client orelse {
        const message = "temporal-bun-bridge-zig: describeNamespace received null client";
        errors.setStructuredError(.{ .code = grpc.invalid_argument, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, message);
        allocator.destroy(task);
        return;
    };

    const runtime_handle = client_ptr.runtime orelse {
        const message = "temporal-bun-bridge-zig: describeNamespace missing runtime handle";
        errors.setStructuredError(.{ .code = grpc.failed_precondition, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, message);
        allocator.destroy(task);
        return;
    };

    if (runtime_handle.core_runtime == null) {
        const message = "temporal-bun-bridge-zig: runtime core handle is not initialized";
        errors.setStructuredError(.{ .code = grpc.failed_precondition, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, message);
        allocator.destroy(task);
        return;
    }

    const core_client = client_ptr.core_client orelse {
        const message = "temporal-bun-bridge-zig: client core handle is not initialized";
        errors.setStructuredError(.{ .code = grpc.failed_precondition, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, message);
        allocator.destroy(task);
        return;
    };

    const retained_core_runtime = runtime.retainCoreRuntime(runtime_handle) orelse {
        const message = "temporal-bun-bridge-zig: runtime is shutting down";
        errors.setStructuredError(.{ .code = grpc.failed_precondition, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, message);
        allocator.destroy(task);
        return;
    };
    defer runtime.releaseCoreRuntime(runtime_handle);

    const request_bytes = encodeDescribeNamespaceRequest(allocator, task.namespace) catch |err| {
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to encode describeNamespace payload: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to encode describeNamespace payload";
        _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
        allocator.destroy(task);
        return;
    };
    defer allocator.free(request_bytes);

    var context = RpcContext{
        .allocator = allocator,
        .pending_handle = pending_handle,
        .runtime_handle = runtime_handle,
        .core_runtime = retained_core_runtime,
    };
    context.wait_group.start();

    var options = std.mem.zeroes(core.RpcCallOptions);
    options.service = @as(core.RpcService, 1);
    options.rpc = common.makeByteArrayRef("DescribeNamespace");
    options.req = common.makeByteArrayRef(request_bytes);
    options.retry = true;
    options.metadata = common.emptyByteArrayRef();
    options.timeout_millis = 0;
    options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &options, &context, describeNamespaceCallback);
    context.wait_group.wait();

    allocator.destroy(task);
}

pub fn describeNamespaceAsync(client_ptr: ?*ClientHandle, payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return common.createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: describeNamespace received null client");
    }

    const allocator = std.heap.c_allocator;
    const namespace_copy = parseNamespace(allocator, payload) catch |err| {
        const message = switch (err) {
            error.EmptyPayload => "temporal-bun-bridge-zig: describeNamespace payload must be non-empty JSON",
            error.InvalidShape => "temporal-bun-bridge-zig: describeNamespace payload must be a JSON object",
            error.MissingNamespace => "temporal-bun-bridge-zig: describeNamespace payload missing namespace",
            error.InvalidNamespace => "temporal-bun-bridge-zig: describeNamespace namespace must be a non-empty string",
            else => blk: {
                var scratch: [160]u8 = undefined;
                break :blk std.fmt.bufPrint(
                    &scratch,
                    "temporal-bun-bridge-zig: failed to parse describeNamespace payload: {}",
                    .{err},
                ) catch "temporal-bun-bridge-zig: failed to parse describeNamespace payload";
            },
        };
        return common.createByteArrayError(grpc.invalid_argument, message);
    };

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        allocator.free(namespace_copy);
        return common.createByteArrayError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to allocate describeNamespace pending handle",
        );
    };
    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_handle_ptr));

    const task = allocator.create(DescribeNamespaceTask) catch |err| {
        allocator.free(namespace_copy);
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate describeNamespace task: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate describeNamespace task";
        _ = pending.rejectByteArray(pending_handle, grpc.resource_exhausted, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    task.* = .{
        .allocator = allocator,
        .client = client_ptr,
        .pending_handle = pending_handle,
        .namespace = namespace_copy,
    };

    if (!pending.retain(pending_handle_ptr)) {
        allocator.destroy(task);
        allocator.free(namespace_copy);
        const message = "temporal-bun-bridge-zig: failed to retain describeNamespace pending handle";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.resource_exhausted, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    }

    const thread = std.Thread.spawn(.{}, describeNamespaceWorker, .{task}) catch |err| {
        allocator.destroy(task);
        allocator.free(namespace_copy);
        pending.release(pending_handle_ptr);
        pending.free(pending_handle_ptr);
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn describeNamespace worker: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to spawn describeNamespace worker";
        _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    thread.detach();
    return @as(?*pending.PendingByteArray, pending_handle);
}
