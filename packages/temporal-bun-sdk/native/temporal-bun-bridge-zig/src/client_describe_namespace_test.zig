const std = @import("std");
const client = @import("client.zig");
const runtime = @import("runtime.zig");
const pending = @import("pending.zig");
const byte_array = @import("byte_array.zig");
const errors = @import("errors.zig");
const core = @import("core.zig");
const c = @cImport({
    @cInclude("stdlib.h");
});

const PendingPollError = error{
    PendingFailed,
    PendingTimedOut,
};

var stub_response: []const u8 = "";
var stub_success_array: core.ByteArray = .{
    .data = null,
    .size = 0,
    .cap = 0,
    .disable_free = true,
};
var stub_failure_message: []const u8 = ""[0..0];
var stub_failure_array: core.ByteArray = .{
    .data = null,
    .size = 0,
    .cap = 0,
    .disable_free = true,
};
var stub_rpc_should_fail = false;
var stub_rpc_status_code: u32 = 0;
var stub_client_free_calls: usize = 0;

const temporal_env_name = [_:0]u8{
    'T', 'E', 'M', 'P', 'O', 'R', 'A', 'L', '_', 'T', 'E', 'S', 'T', '_', 'S', 'E', 'R', 'V', 'E', 'R', 0,
};
const temporal_env_disabled = [_:0]u8{ '0', 0 };

var fake_runtime_storage: usize = 0;
var fake_client_storage: usize = 0;

fn stubRuntimeNew(_options: *const core.RuntimeOptions) callconv(.c) core.RuntimeOrFail {
    _ = _options;
    return .{ .runtime = @ptrCast(&fake_runtime_storage), .fail = null };
}

fn stubRuntimeFree(_runtime: ?*core.Runtime) callconv(.c) void {
    _ = _runtime;
}

fn stubByteArrayFree(_runtime: ?*core.Runtime, _bytes: ?*const core.ByteArray) callconv(.c) void {
    _ = _runtime;
    _ = _bytes;
}

fn stubClientConnect(
    _runtime: ?*core.Runtime,
    _options: *const core.ClientOptions,
    user_data: ?*anyopaque,
    callback: core.ClientConnectCallback,
) callconv(.c) void {
    _ = _runtime;
    _ = _options;
    if (callback) |cb| {
        cb(user_data, @ptrCast(&fake_client_storage), null);
    }
}

fn stubClientFree(_client: ?*core.Client) callconv(.c) void {
    _ = _client;
    stub_client_free_calls += 1;
}

fn stubClientRpcCall(
    _client: ?*core.Client,
    _options: *const core.RpcCallOptions,
    user_data: ?*anyopaque,
    callback: core.ClientRpcCallCallback,
) callconv(.c) void {
    _ = _client;
    _ = _options;
    if (stub_rpc_should_fail) {
        stub_failure_array = .{
            .data = if (stub_failure_message.len > 0) stub_failure_message.ptr else null,
            .size = stub_failure_message.len,
            .cap = stub_failure_message.len,
            .disable_free = true,
        };
        if (callback) |cb| {
            const failure_ptr = if (stub_failure_message.len > 0) &stub_failure_array else null;
            cb(user_data, null, stub_rpc_status_code, failure_ptr, null);
        }
        return;
    }

    stub_success_array = .{
        .data = stub_response.ptr,
        .size = stub_response.len,
        .cap = stub_response.len,
        .disable_free = true,
    };
    if (callback) |cb| {
        cb(user_data, &stub_success_array, 0, null, null);
    }
}

fn disableTemporalTestServerEnv() void {
    const name_ptr: [*:0]const u8 = @ptrCast(&temporal_env_name);
    const value_ptr: [*:0]const u8 = @ptrCast(&temporal_env_disabled);
    _ = c.setenv(name_ptr, value_ptr, 1);
}

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
    disableTemporalTestServerEnv();
    core.ensureExternalApiInstalled();
    const original_api = core.api;
    defer core.api = original_api;
    stub_response = "temporal-proto";
    stub_client_free_calls = 0;
    stub_rpc_should_fail = false;
    stub_rpc_status_code = 0;
    stub_failure_message = ""[0..0];
    core.api = .{
        .runtime_new = stubRuntimeNew,
        .runtime_free = stubRuntimeFree,
        .byte_array_free = stubByteArrayFree,
        .client_connect = stubClientConnect,
        .client_free = stubClientFree,
        .client_update_metadata = original_api.client_update_metadata,
        .client_update_api_key = original_api.client_update_api_key,
        .client_rpc_call = stubClientRpcCall,
    };

    const runtime_handle = runtime.create("{}") orelse unreachable;
    defer runtime.destroy(runtime_handle);

    const pending_client = client.connectAsync(runtime_handle, "{\"address\":\"http://127.0.0.1:7233\"}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    try pollUntilReady(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    const client_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(pending_client))) orelse unreachable;
    const client_ptr = @as(*client.ClientHandle, @ptrCast(@alignCast(client_any)));
    defer {
        client.destroy(client_ptr);
        std.testing.expectEqual(@as(usize, 1), stub_client_free_calls) catch unreachable;
        stub_client_free_calls = 0;
    }
    try std.testing.expect(client_ptr.core_client != null);

    const payload = "{\"namespace\":\"zig-tests\"}";
    const describe_pending = client.describeNamespaceAsync(client_ptr, payload) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));

    try pollUntilReady(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));

    const array_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(describe_pending))) orelse unreachable;
    const array_ptr = @as(*byte_array.ByteArray, @ptrCast(@alignCast(array_any)));
    defer byte_array.free(array_ptr);

    try std.testing.expect(array_ptr.size > 0);
}

test "describeNamespaceAsync returns failed handle for empty payload" {
    disableTemporalTestServerEnv();
    const original_api = core.api;
    defer core.api = original_api;
    stub_response = "temporal-proto";
    core.ensureExternalApiInstalled();
    stub_client_free_calls = 0;
    stub_rpc_should_fail = false;
    stub_rpc_status_code = 0;
    stub_failure_message = ""[0..0];
    core.api = .{
        .runtime_new = stubRuntimeNew,
        .runtime_free = stubRuntimeFree,
        .byte_array_free = stubByteArrayFree,
        .client_connect = stubClientConnect,
        .client_free = stubClientFree,
        .client_update_metadata = original_api.client_update_metadata,
        .client_update_api_key = original_api.client_update_api_key,
        .client_rpc_call = stubClientRpcCall,
    };

    const runtime_handle = runtime.create("{}") orelse unreachable;
    defer runtime.destroy(runtime_handle);

    const pending_client = client.connectAsync(runtime_handle, "{\"address\":\"http://127.0.0.1:7233\"}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    try pollUntilReady(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    const client_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(pending_client))) orelse unreachable;
    const client_ptr = @as(*client.ClientHandle, @ptrCast(@alignCast(client_any)));
    defer {
        client.destroy(client_ptr);
        std.testing.expectEqual(@as(usize, 1), stub_client_free_calls) catch unreachable;
        stub_client_free_calls = 0;
    }

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

test "describeNamespaceAsync rejects when runtime handle is missing" {
    disableTemporalTestServerEnv();
    const original_api = core.api;
    defer core.api = original_api;
    stub_response = "temporal-proto";
    core.ensureExternalApiInstalled();
    stub_client_free_calls = 0;
    stub_rpc_should_fail = false;
    stub_rpc_status_code = 0;
    stub_failure_message = ""[0..0];
    core.api = .{
        .runtime_new = stubRuntimeNew,
        .runtime_free = stubRuntimeFree,
        .byte_array_free = stubByteArrayFree,
        .client_connect = stubClientConnect,
        .client_free = stubClientFree,
        .client_update_metadata = original_api.client_update_metadata,
        .client_update_api_key = original_api.client_update_api_key,
        .client_rpc_call = stubClientRpcCall,
    };

    const runtime_handle = runtime.create("{}") orelse unreachable;
    defer runtime.destroy(runtime_handle);

    const pending_client = client.connectAsync(runtime_handle, "{\"address\":\"http://127.0.0.1:7233\"}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    try pollUntilReady(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    const client_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(pending_client))) orelse unreachable;
    const client_ptr = @as(*client.ClientHandle, @ptrCast(@alignCast(client_any)));
    defer {
        client.destroy(client_ptr);
        std.testing.expectEqual(@as(usize, 1), stub_client_free_calls) catch unreachable;
        stub_client_free_calls = 0;
    }

    client_ptr.runtime = null;

    const payload = "{\"namespace\":\"zig-tests\"}";
    const describe_pending = client.describeNamespaceAsync(client_ptr, payload) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));

    const status = pending.poll(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));
    try std.testing.expectEqual(@intFromEnum(pending.Status.failed), status);
    const message = errors.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, message, "missing runtime handle") != null);
}

test "describeNamespaceAsync surfaces core RPC failure" {
    disableTemporalTestServerEnv();
    core.ensureExternalApiInstalled();
    const original_api = core.api;
    defer core.api = original_api;
    stub_client_free_calls = 0;
    stub_rpc_should_fail = true;
    stub_rpc_status_code = 14;
    const failure_text = "temporal-core-rpc failure";
    stub_failure_message = failure_text;
    defer {
        stub_rpc_should_fail = false;
        stub_rpc_status_code = 0;
        stub_failure_message = ""[0..0];
    }
    core.api = .{
        .runtime_new = stubRuntimeNew,
        .runtime_free = stubRuntimeFree,
        .byte_array_free = stubByteArrayFree,
        .client_connect = stubClientConnect,
        .client_free = stubClientFree,
        .client_update_metadata = original_api.client_update_metadata,
        .client_update_api_key = original_api.client_update_api_key,
        .client_rpc_call = stubClientRpcCall,
    };

    const runtime_handle = runtime.create("{}") orelse unreachable;
    defer runtime.destroy(runtime_handle);

    const pending_client = client.connectAsync(runtime_handle, "{\"address\":\"http://127.0.0.1:7233\"}") orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    try pollUntilReady(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    const client_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(pending_client))) orelse unreachable;
    const client_ptr = @as(*client.ClientHandle, @ptrCast(@alignCast(client_any)));
    defer {
        client.destroy(client_ptr);
        std.testing.expectEqual(@as(usize, 1), stub_client_free_calls) catch unreachable;
        stub_client_free_calls = 0;
    }

    const payload = "{\"namespace\":\"zig-tests\"}";
    const describe_pending = client.describeNamespaceAsync(client_ptr, payload) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(describe_pending)));

    try std.testing.expectError(
        error.PendingFailed,
        pollUntilReady(@as(?*pending.PendingHandle, @ptrCast(describe_pending))),
    );

    const message = errors.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, message, failure_text) != null);
}
