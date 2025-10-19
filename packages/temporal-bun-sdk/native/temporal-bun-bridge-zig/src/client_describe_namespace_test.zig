const std = @import("std");
const client = @import("client.zig");
const runtime = @import("runtime.zig");
const pending = @import("pending.zig");
const byte_array = @import("byte_array.zig");
const errors = @import("errors.zig");

const PendingPollError = error{
    PendingFailed,
    PendingTimedOut,
};

fn pollUntilReady(handle: ?*pending.PendingHandle) PendingPollError!void {
    var attempts: usize = 0;
    while (attempts < 100) {
        const status = pending.poll(handle);
        if (status == @intFromEnum(pending.Status.ready)) {
            return;
        }
        if (status == @intFromEnum(pending.Status.failed)) {
            return error.PendingFailed;
        }
        std.Thread.sleep(1_000_000); // 1ms
        attempts += 1;
    }
    return error.PendingTimedOut;
}

test "describeNamespaceAsync resolves with byte payload for valid namespace" {
    const runtime_handle = runtime.create("{}") orelse unreachable;
    defer runtime.destroy(runtime_handle);

    const pending_client = client.connectAsync(runtime_handle, "{}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    try std.testing.expectEqual(
        @intFromEnum(pending.Status.ready),
        pending.poll(@as(?*pending.PendingHandle, @ptrCast(pending_client))),
    );

    const client_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(pending_client))) orelse unreachable;
    const client_ptr = @as(*client.ClientHandle, @ptrCast(@alignCast(client_any)));
    defer client.destroy(client_ptr);

    const payload = "{\"namespace\":\"zig-tests\"}";
    const describe_pending = client.describeNamespaceAsync(client_ptr, payload) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));

    try pollUntilReady(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));

    const array_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(describe_pending))) orelse unreachable;
    const array_ptr = @as(*byte_array.ByteArray, @ptrCast(@alignCast(array_any)));
    defer byte_array.free(array_ptr);

    try std.testing.expect(array_ptr.len > 0);
}

test "describeNamespaceAsync returns failed handle for empty payload" {
    const runtime_handle = runtime.create("{}") orelse unreachable;
    defer runtime.destroy(runtime_handle);

    const pending_client = client.connectAsync(runtime_handle, "{}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    try std.testing.expectEqual(
        @intFromEnum(pending.Status.ready),
        pending.poll(@as(?*pending.PendingHandle, @ptrCast(pending_client))),
    );

    const client_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(pending_client))) orelse unreachable;
    const client_ptr = @as(*client.ClientHandle, @ptrCast(@alignCast(client_any)));
    defer client.destroy(client_ptr);

    const describe_pending = client.describeNamespaceAsync(client_ptr, "{}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));

    const status = pending.poll(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));
    try std.testing.expectEqual(@intFromEnum(pending.Status.failed), status);
    const message = errors.snapshot();
    try std.testing.expect(message.len > 0);
}

test "describeNamespaceAsync rejects null client pointer" {
    const payload = "{\"namespace\":\"example\"}";
    const describe_pending = client.describeNamespaceAsync(null, payload) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));

    const status = pending.poll(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));
    try std.testing.expectEqual(@intFromEnum(pending.Status.failed), status);
    const message = errors.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, message, "null client") != null);
}

test "describeNamespaceAsync rejects when core client pointer is missing" {
    const runtime_handle = runtime.create("{}") orelse unreachable;
    defer runtime.destroy(runtime_handle);

    const pending_client = client.connectAsync(runtime_handle, "{}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    try std.testing.expectEqual(
        @intFromEnum(pending.Status.ready),
        pending.poll(@as(?*pending.PendingHandle, @ptrCast(pending_client))),
    );

    const client_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(pending_client))) orelse unreachable;
    const client_ptr = @as(*client.ClientHandle, @ptrCast(@alignCast(client_any)));
    defer client.destroy(client_ptr);

    client_ptr.core_client = null;

    const payload = "{\"namespace\":\"zig-tests\"}";
    const describe_pending = client.describeNamespaceAsync(client_ptr, payload) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));

    const status = pending.poll(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));
    try std.testing.expectEqual(@intFromEnum(pending.Status.failed), status);
    const message = errors.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, message, "missing Temporal core client handle") != null);
}
