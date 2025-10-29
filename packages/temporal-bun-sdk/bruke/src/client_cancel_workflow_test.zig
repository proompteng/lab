const std = @import("std");
const client = @import("client.zig");
const pending = @import("pending.zig");
const errors = @import("errors.zig");

fn makeStubClient() !*client.ClientHandle {
    const allocator = std.heap.c_allocator;
    const handle = try allocator.create(client.ClientHandle);
    handle.* = .{
        .id = 1,
        .runtime = null,
        .config = ""[0..0],
        .core_client = null,
    };
    return handle;
}

fn destroyStubClient(handle: *client.ClientHandle) void {
    const allocator = std.heap.c_allocator;
    allocator.destroy(handle);
}

fn freePendingHandle(handle: ?*pending.PendingByteArray) void {
    if (handle) |ptr| {
        const any_handle: ?*pending.PendingHandle = @as(?*pending.PendingHandle, @ptrCast(ptr));
        pending.free(any_handle);
    }
}

test "cancelWorkflow returns structured error when client is null" {
    errors.setLastError(""[0..0]);
    const payload = "{\"namespace\":\"default\",\"workflow_id\":\"wf\"}"[0..];
    const handle = client.cancelWorkflow(null, payload);
    defer freePendingHandle(handle);

    try std.testing.expect(handle != null);
    const snapshot = errors.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "\"code\":3") != null);
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "cancelWorkflow received null client") != null);
    errors.setLastError(""[0..0]);
}

test "cancelWorkflow rejects payload missing namespace" {
    const stub_client = try makeStubClient();
    defer destroyStubClient(stub_client);

    errors.setLastError(""[0..0]);
    const payload = "{\"workflow_id\":\"wf\"}"[0..];
    const handle = client.cancelWorkflow(stub_client, payload);
    defer freePendingHandle(handle);

    try std.testing.expect(handle != null);
    const snapshot = errors.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "\"code\":3") != null);
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "cancelWorkflow namespace must be a non-empty string") != null);
    errors.setLastError(""[0..0]);
}

test "cancelWorkflow rejects empty run_id value" {
    const stub_client = try makeStubClient();
    defer destroyStubClient(stub_client);

    errors.setLastError(""[0..0]);
    const payload = "{\"namespace\":\"default\",\"workflow_id\":\"wf\",\"run_id\":\"\"}"[0..];
    const handle = client.cancelWorkflow(stub_client, payload);
    defer freePendingHandle(handle);

    try std.testing.expect(handle != null);
    const snapshot = errors.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "\"code\":3") != null);
    try std.testing.expect(std.mem.indexOf(u8, snapshot, "cancelWorkflow run_id must be a non-empty string") != null);
    errors.setLastError(""[0..0]);
}
