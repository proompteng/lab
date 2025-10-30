const std = @import("std");
const testing = std.testing;

const client = @import("client.zig");
const common = @import("client/common.zig");
const runtime = @import("runtime.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");
const byte_array = @import("byte_array.zig");
const errors = @import("errors.zig");

const allocator = std.heap.c_allocator;

var fake_runtime_storage: usize = 0;
var fake_client_storage: usize = 0;

var stub_response: []const u8 = ""[0..0];
var stub_status_code: u32 = 0;
var stub_failure_message: []const u8 = ""[0..0];
var last_rpc_name: []const u8 = ""[0..0];

const WaitError = error{
    PendingFailed,
    PendingTimeout,
};

fn stubByteArrayFree(_runtime: ?*core.RuntimeOpaque, _bytes: ?*const core.ByteArray) callconv(.c) void {
    _ = _runtime;
    _ = _bytes;
}

fn stubClientRpcCall(
    _client: ?*core.Client,
    options: *const core.RpcCallOptions,
    user_data: ?*anyopaque,
    callback: core.ClientRpcCallCallback,
) callconv(.c) void {
    _ = _client;
    if (options.rpc.size > 0) {
        if (options.rpc.data) |ptr| {
            last_rpc_name = ptr[0..options.rpc.size];
        } else {
            last_rpc_name = ""[0..0];
        }
    } else {
        last_rpc_name = ""[0..0];
    }

    if (callback) |cb| {
        if (stub_status_code == 0) {
            var success = core.ByteArray{
                .data = if (stub_response.len == 0) null else stub_response.ptr,
                .size = stub_response.len,
                .cap = stub_response.len,
                .disable_free = true,
            };
            cb(user_data, &success, 0, null, null);
        } else {
            var failure = core.ByteArray{
                .data = if (stub_failure_message.len == 0) null else stub_failure_message.ptr,
                .size = stub_failure_message.len,
                .cap = stub_failure_message.len,
                .disable_free = true,
            };
            cb(user_data, null, stub_status_code, &failure, null);
        }
    }
}

fn installStubCoreApi() core.Api {
    const original = core.api;
    var override = original;
    override.byte_array_free = stubByteArrayFree;
    override.client_rpc_call = stubClientRpcCall;
    override.client_free = original.client_free;
    core.api = override;
    return original;
}

fn makeRuntimeHandle() runtime.RuntimeHandle {
    return .{
        .id = 1,
        .config = ""[0..0],
        .core_runtime = @as(?*core.RuntimeOpaque, @ptrCast(&fake_runtime_storage)),
    };
}

fn makeClientHandle(rt: *runtime.RuntimeHandle) common.ClientHandle {
    return .{
        .id = 22,
        .runtime = rt,
        .config = ""[0..0],
        .core_client = @as(?*core.ClientOpaque, @ptrCast(&fake_client_storage)),
    };
}

fn waitForReady(handle: *pending.PendingByteArray) WaitError!void {
    var attempts: usize = 0;
    while (attempts < 500) : (attempts += 1) {
        const status = pending.poll(@ptrCast(handle));
        if (status == @intFromEnum(pending.Status.ready)) return;
        if (status == @intFromEnum(pending.Status.failed)) return WaitError.PendingFailed;
        std.Thread.sleep(1_000_000);
    }
    return WaitError.PendingTimeout;
}

test "describeNamespaceAsync resolves byte payload" {
    var runtime_handle = makeRuntimeHandle();
    var client_handle = makeClientHandle(&runtime_handle);

    const original_api = installStubCoreApi();
    defer core.api = original_api;

    stub_response = ""[0..0];
    stub_failure_message = ""[0..0];
    stub_status_code = 0;
    last_rpc_name = ""[0..0];
    stub_response = "namespace-proto";

    const payload = "{\"namespace\":\"zig-tests\"}";
    const pending_ptr = client.describeNamespaceAsync(&client_handle, payload) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_ptr)));

    try waitForReady(@as(*pending.PendingByteArray, @ptrCast(pending_ptr)));

    const consumed_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(pending_ptr))) orelse unreachable;
    const array_ptr = @as(*byte_array.ByteArray, @ptrCast(@alignCast(consumed_any)));
    defer byte_array.free(array_ptr);

    try testing.expectEqualStrings("namespace-proto", array_ptr.data.?[0..array_ptr.size]);
    try testing.expectEqualStrings("DescribeNamespace", last_rpc_name);
}

test "describeNamespaceAsync rejects malformed payload" {
    var runtime_handle = makeRuntimeHandle();
    var client_handle = makeClientHandle(&runtime_handle);

    stub_response = ""[0..0];
    stub_failure_message = ""[0..0];
    stub_status_code = 0;
    last_rpc_name = ""[0..0];

    const handle = client.describeNamespaceAsync(&client_handle, "{\"namespace\":true}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(handle)));

    const status = pending.poll(@as(?*pending.PendingHandle, @ptrCast(handle)));
    try testing.expectEqual(@intFromEnum(pending.Status.failed), status);
    const message = errors.snapshot();
    try testing.expect(std.mem.indexOf(u8, message, "namespace must be a non-empty string") != null);
}

test "describeNamespaceAsync rejects missing runtime handle" {
    var runtime_handle = makeRuntimeHandle();
    var client_handle = makeClientHandle(&runtime_handle);
    client_handle.runtime = null;

    stub_response = ""[0..0];
    stub_failure_message = ""[0..0];
    stub_status_code = 0;
    last_rpc_name = ""[0..0];

    const handle = client.describeNamespaceAsync(&client_handle, "{\"namespace\":\"zig-tests\"}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(handle)));

    try testing.expectError(WaitError.PendingFailed, waitForReady(@as(*pending.PendingByteArray, @ptrCast(handle))));
    const status = pending.poll(@as(?*pending.PendingHandle, @ptrCast(handle)));
    try testing.expectEqual(@intFromEnum(pending.Status.failed), status);
    const message = errors.snapshot();
    try testing.expect(std.mem.indexOf(u8, message, "missing runtime handle") != null);
}

test "describeNamespaceAsync surfaces core failure" {
    var runtime_handle = makeRuntimeHandle();
    var client_handle = makeClientHandle(&runtime_handle);

    const original_api = installStubCoreApi();
    defer core.api = original_api;

    stub_response = ""[0..0];
    stub_status_code = 14;
    stub_failure_message = "temporal core unavailable";
    last_rpc_name = ""[0..0];

    const handle = client.describeNamespaceAsync(&client_handle, "{\"namespace\":\"zig-tests\"}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(handle)));

    try testing.expectError(WaitError.PendingFailed, waitForReady(@as(*pending.PendingByteArray, @ptrCast(handle))));
    const status = pending.poll(@as(?*pending.PendingHandle, @ptrCast(handle)));
    try testing.expectEqual(@intFromEnum(pending.Status.failed), status);

    const message = errors.snapshot();
    try testing.expect(std.mem.indexOf(u8, message, "temporal core unavailable") != null);
}
