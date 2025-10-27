const std = @import("std");
const common = @import("common.zig");
const errors = @import("../errors.zig");
const runtime = @import("../runtime.zig");
const pending = @import("../pending.zig");
const core = @import("../core.zig");
const byte_array = @import("../byte_array.zig");

const grpc = common.grpc;
const ClientHandle = common.ClientHandle;

const DescribeNamespacePayload = struct {
    namespace: []const u8,
};

const DescribeNamespaceTask = struct {
    client: ?*ClientHandle,
    pending_handle: *pending.PendingByteArray,
    namespace: []u8,
};

const RpcCallContext = struct {
    allocator: std.mem.Allocator,
    pending_handle: *pending.PendingByteArray,
    wait_group: std.Thread.WaitGroup = .{},
    runtime_handle: *runtime.RuntimeHandle,
};

const describe_namespace_rpc = "DescribeNamespace";

fn encodeDescribeNamespaceRequest(allocator: std.mem.Allocator, namespace: []const u8) ![]u8 {
    var length_buffer: [10]u8 = undefined;
    var length_index: usize = 0;
    var remaining = namespace.len;
    while (true) {
        const byte: u8 = @as(u8, @intCast(remaining & 0x7F));
        remaining >>= 7;
        if (remaining == 0) {
            length_buffer[length_index] = byte;
            length_index += 1;
            break;
        }
        length_buffer[length_index] = byte | 0x80;
        length_index += 1;
    }

    const total_len = 1 + length_index + namespace.len;
    const out = try allocator.alloc(u8, total_len);
    out[0] = 0x0A;
    @memcpy(out[1 .. 1 + length_index], length_buffer[0..length_index]);
    @memcpy(out[1 + length_index ..], namespace);
    return out;
}

fn clientDescribeCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
    failure_details: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*RpcCallContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    if (success != null and status_code == 0) {
        const slice = common.byteArraySlice(success.?);
        if (slice.len == 0) {
            errors.setStructuredError(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: describeNamespace returned empty payload" });
            _ = pending.rejectByteArray(context.pending_handle, grpc.internal, "temporal-bun-bridge-zig: describeNamespace returned empty payload");
        } else if (byte_array.allocateFromSlice(slice)) |array_ptr| {
            if (!pending.resolveByteArray(context.pending_handle, array_ptr)) {
                byte_array.free(array_ptr);
            } else {
                errors.setLastError(""[0..0]);
            }
        } else {
            errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to allocate describeNamespace response" });
            _ = pending.rejectByteArray(context.pending_handle, grpc.resource_exhausted, "temporal-bun-bridge-zig: failed to allocate describeNamespace response");
        }
        core.api.byte_array_free(context.runtime_handle.core_runtime, success.?);
        if (failure_message) |msg| core.api.byte_array_free(context.runtime_handle.core_runtime, msg);
        if (failure_details) |details| core.api.byte_array_free(context.runtime_handle.core_runtime, details);
        return;
    }

    const code: i32 = if (status_code == 0) grpc.internal else @as(i32, @intCast(status_code));
    const message_slice = if (failure_message) |msg| common.byteArraySlice(msg) else "temporal-bun-bridge-zig: describeNamespace failed"[0..];
    _ = pending.rejectByteArray(context.pending_handle, code, message_slice);
    errors.setStructuredError(.{ .code = code, .message = message_slice });
    if (success) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    if (failure_message) |msg| core.api.byte_array_free(context.runtime_handle.core_runtime, msg);
    if (failure_details) |details| core.api.byte_array_free(context.runtime_handle.core_runtime, details);
}

fn describeNamespaceWorker(task: *DescribeNamespaceTask) void {
    const allocator = std.heap.c_allocator;
    defer {
        allocator.free(task.namespace);
        allocator.destroy(task);
    }

    const pending_handle = task.pending_handle;
    defer pending.release(pending_handle);
    const client_ptr = task.client orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.internal, "temporal-bun-bridge-zig: describeNamespace worker missing client");
        return;
    };
    const runtime_handle = client_ptr.runtime orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: describeNamespace missing runtime handle");
        return;
    };
    if (runtime_handle.core_runtime == null) {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: runtime core handle is not initialized");
        return;
    }

    if (!runtime.beginPendingClientConnect(runtime_handle)) {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: runtime is shutting down");
        return;
    }
    defer runtime.endPendingClientConnect(runtime_handle);

    const core_client = client_ptr.core_client orelse {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: client core handle is not initialized",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: client core handle is not initialized");
        return;
    };

    const request_bytes = encodeDescribeNamespaceRequest(allocator, task.namespace) catch |err| {
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(&scratch, "temporal-bun-bridge-zig: failed to encode describeNamespace payload: {}", .{err}) catch "temporal-bun-bridge-zig: failed to encode describeNamespace payload";
        _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
        return;
    };
    defer allocator.free(request_bytes);

    var rpc_context = RpcCallContext{ .allocator = allocator, .pending_handle = pending_handle, .runtime_handle = runtime_handle };
    rpc_context.wait_group.start();

    var call_options = std.mem.zeroes(core.RpcCallOptions);
    call_options.service = @as(core.RpcService, 1);
    call_options.rpc = common.makeByteArrayRef(describe_namespace_rpc);
    call_options.req = common.makeByteArrayRef(request_bytes);
    call_options.retry = true;
    call_options.metadata = common.emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &call_options, &rpc_context, clientDescribeCallback);
    rpc_context.wait_group.wait();
}

fn parseNamespaceFromPayload(payload: []const u8) ?[]u8 {
    if (payload.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: describeNamespace received empty payload",
            .details = null,
        });
        return null;
    }

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer {
        const status = gpa.deinit();
        switch (status) {
            .ok => {},
            .leak => {},
        }
    }
    const allocator = gpa.allocator();

    const parsed = std.json.parseFromSlice(DescribeNamespacePayload, allocator, payload, .{}) catch |err| {
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to parse describeNamespace payload: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to parse describeNamespace payload";
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = message, .details = null });
        return null;
    };
    defer parsed.deinit();

    if (parsed.value.namespace.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: describeNamespace payload missing namespace",
            .details = null,
        });
        return null;
    }

    const c_allocator = std.heap.c_allocator;
    const copy = c_allocator.alloc(u8, parsed.value.namespace.len) catch |err| {
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to copy namespace: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to copy namespace";
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = message, .details = null });
        return null;
    };
    @memcpy(copy, parsed.value.namespace);
    return copy;
}

pub fn describeNamespaceAsync(client_ptr: ?*ClientHandle, payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return common.createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: describeNamespace received null client");
    }

    const client = client_ptr.?;
    if (client.runtime == null) {
        return common.createByteArrayError(grpc.failed_precondition, "temporal-bun-bridge-zig: describeNamespace missing runtime handle");
    }

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        return common.createByteArrayError(grpc.internal, "temporal-bun-bridge-zig: failed to allocate describeNamespace pending handle");
    };
    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_handle_ptr));

    const namespace_copy = parseNamespaceFromPayload(payload) orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, errors.snapshot());
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    const allocator = std.heap.c_allocator;
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
        .client = client_ptr,
        .pending_handle = pending_handle,
        .namespace = namespace_copy,
    };

    if (!pending.retain(pending_handle_ptr)) {
        allocator.destroy(task);
        allocator.free(namespace_copy);
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to retain describeNamespace pending handle",
        });
        _ = pending.rejectByteArray(
            pending_handle,
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to retain describeNamespace pending handle",
        );
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
