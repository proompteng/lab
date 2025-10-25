const std = @import("std");
const client = @import("client.zig");
const runtime = @import("runtime.zig");
const pending = @import("pending.zig");
const byte_array = @import("byte_array.zig");
const core = @import("core.zig");
const errors = @import("errors.zig");
const c = @cImport({
    @cInclude("stdlib.h");
});

const ArrayList = std.ArrayList;

const PendingPollError = error{
    PendingFailed,
    PendingTimedOut,
};

var stub_response: []const u8 = ""[0..0];
var stub_failure_message: []const u8 = ""[0..0];
var stub_rpc_should_fail = false;
var stub_rpc_status_code: u32 = 0;
var stub_client_free_calls: usize = 0;
var fake_runtime_storage: usize = 0;
var fake_client_storage: usize = 0;

fn disableTemporalTestServerEnv() void {
    const name = "TEMPORAL_TEST_SERVER";
    const value = "0";
    _ = c.setenv(name, value, 1);
}

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

var stub_success_array: core.ByteArray = .{
    .data = null,
    .size = 0,
    .cap = 0,
    .disable_free = true,
};
var stub_failure_array: core.ByteArray = .{
    .data = null,
    .size = 0,
    .cap = 0,
    .disable_free = true,
};

fn writeVarint(buffer: *ArrayList(u8), value: u64) !void {
    var remaining = value;
    while (true) {
        var byte: u8 = @intCast(remaining & 0x7F);
        remaining >>= 7;
        if (remaining != 0) {
            byte |= 0x80;
        }
        try buffer.append(byte);
        if (remaining == 0) break;
    }
}

fn appendTag(buffer: *ArrayList(u8), field_number: u32, wire_type: u3) !void {
    const key = (@as(u64, field_number) << 3) | wire_type;
    try writeVarint(buffer, key);
}

fn appendLengthDelimited(buffer: *ArrayList(u8), field_number: u32, bytes: []const u8) !void {
    try appendTag(buffer, field_number, 2);
    try writeVarint(buffer, bytes.len);
    try buffer.appendSlice(bytes);
}

fn appendString(buffer: *ArrayList(u8), field_number: u32, value: []const u8) !void {
    try appendLengthDelimited(buffer, field_number, value);
}

fn encodeEncodingMetadata(allocator: std.mem.Allocator) ![]u8 {
    var entry = ArrayList(u8).init(allocator);
    defer entry.deinit();

    try appendString(&entry, 1, "encoding");
    try appendLengthDelimited(&entry, 2, "json/plain");

    return entry.toOwnedSlice();
}

fn encodeJsonPayloadValue(allocator: std.mem.Allocator, json_bytes: []const u8) ![]u8 {
    var payload = ArrayList(u8).init(allocator);
    defer payload.deinit();

    const metadata = try encodeEncodingMetadata(allocator);
    defer allocator.free(metadata);
    try appendLengthDelimited(&payload, 1, metadata);
    try appendLengthDelimited(&payload, 2, json_bytes);

    return payload.toOwnedSlice();
}

fn buildQueryWorkflowSuccessResponse(allocator: std.mem.Allocator, json_bytes: []const u8) ![]u8 {
    const payload_bytes = try encodeJsonPayloadValue(allocator, json_bytes);
    defer allocator.free(payload_bytes);

    var payloads = ArrayList(u8).init(allocator);
    defer payloads.deinit();
    try appendLengthDelimited(&payloads, 1, payload_bytes);
    const payloads_slice = try payloads.toOwnedSlice();
    defer allocator.free(payloads_slice);

    var response = ArrayList(u8).init(allocator);
    defer response.deinit();
    try appendLengthDelimited(&response, 1, payloads_slice);
    return response.toOwnedSlice();
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
        .data = if (stub_response.len > 0) stub_response.ptr else null,
        .size = stub_response.len,
        .cap = stub_response.len,
        .disable_free = true,
    };
    if (callback) |cb| {
        cb(user_data, &stub_success_array, 0, null, null);
    }
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

test "queryWorkflow resolves JSON payload for successful response" {
    disableTemporalTestServerEnv();
    errors.setLastError(""[0..0]);
    core.ensureExternalApiInstalled();
    const original_api = core.api;
    defer core.api = original_api;

    const allocator = std.heap.c_allocator;
    defer {
        allocator.free(stub_response);
        stub_response = ""[0..0];
    }

    const json_result = "\"initial-state\"";
    stub_response = try buildQueryWorkflowSuccessResponse(allocator, json_result);
    stub_rpc_should_fail = false;
    stub_failure_message = ""[0..0];
    stub_rpc_status_code = 0;
    stub_client_free_calls = 0;

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

    const query_payload = "{\"namespace\":\"default\",\"workflow_id\":\"wf-1\",\"query_name\":\"status\",\"args\":[]}";
    const query_pending = client.queryWorkflow(client_ptr, query_payload) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(query_pending)));

    try pollUntilReady(@as(?*pending.PendingHandle, @ptrCast(query_pending)));

    const array_any = pending.consume(@as(?*pending.PendingHandle, @ptrCast(query_pending))) orelse unreachable;
    const array_ptr = @as(*byte_array.ByteArray, @ptrCast(@alignCast(array_any)));
    defer byte_array.free(array_ptr);

    try std.testing.expect(array_ptr.data != null);
    try std.testing.expectEqual(stub_response.len, array_ptr.size);
    const ptr = array_ptr.data.?;
    try std.testing.expectEqualSlices(u8, stub_response, ptr[0..array_ptr.size]);
}
