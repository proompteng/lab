const std = @import("std");
const client = @import("client.zig");
const runtime = @import("runtime.zig");
const core = @import("core.zig");
const byte_array = @import("byte_array.zig");
const testing = std.testing;

var stub_runtime_storage: usize = 0;
var stub_client_storage: usize = 0;
var stub_client_free_calls: usize = 0;
var stub_rpc_call_count: usize = 0;

var stub_response_buffer: [64]u8 = undefined;
var stub_response_slice: []const u8 = ""[0..0];
var stub_response_array: core.ByteArray = .{
    .data = null,
    .size = 0,
    .cap = 0,
    .disable_free = true,
};

fn stubRuntimeNew(_options: *const core.RuntimeOptions) callconv(.c) core.RuntimeOrFail {
    _ = _options;
    return .{ .runtime = @ptrCast(&stub_runtime_storage), .fail = null };
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
        cb(user_data, @ptrCast(&stub_client_storage), null);
    }
}

fn stubClientFree(_client: ?*core.Client) callconv(.c) void {
    _ = _client;
    stub_client_free_calls += 1;
}

fn encodeVarint(value: u64, buffer: *[10]u8) []const u8 {
    var idx: usize = 0;
    var remaining = value;
    while (true) : (idx += 1) {
        var byte: u8 = @intCast(remaining & 0x7F);
        remaining >>= 7;
        if (remaining != 0) byte |= 0x80;
        buffer[idx] = byte;
        if (remaining == 0) break;
    }
    return buffer[0 .. idx + 1];
}

fn readVarint(bytes: []const u8, index: *usize) u64 {
    var result: u64 = 0;
    var shift: u6 = 0;
    while (true) {
        const byte = bytes[index.*];
        index.* += 1;
        result |= (@as(u64, byte & 0x7F) << shift);
        if ((byte & 0x80) == 0) break;
        shift += 7;
    }
    return result;
}

fn skipField(bytes: []const u8, index: *usize, wire_type: u3) void {
    switch (wire_type) {
        0 => {
            _ = readVarint(bytes, index);
        },
        1 => index.* += 8,
        2 => {
            const length = readVarint(bytes, index);
            index.* += @intCast(length);
        },
        5 => index.* += 4,
        else => @panic("unsupported wire type"),
    }
}

fn findStringField(bytes: []const u8, field_number: u32) []const u8 {
    var index: usize = 0;
    while (index < bytes.len) {
        const key = readVarint(bytes, &index);
        const field = @as(u32, @intCast(key >> 3));
        const wire: u3 = @intCast(key & 0x07);
        if (field == field_number and wire == 2) {
            const length = readVarint(bytes, &index);
            const start = index;
            const end = index + @intCast(length);
            return bytes[start..end];
        }
        skipField(bytes, &index, wire);
    }
    return ""[0..0];
}

fn stubClientRpcCall(
    _client: ?*core.Client,
    options: *const core.RpcCallOptions,
    user_data: ?*anyopaque,
    callback: core.ClientRpcCallCallback,
) callconv(.c) void {
    _ = _client;
    stub_rpc_call_count += 1;

    const rpc_slice = options.rpc.data[0..options.rpc.size];
    std.debug.assert(std.mem.eql(u8, rpc_slice, "StartWorkflowExecution"));
    std.debug.assert(options.service == 1);

    const request_slice = options.req.data[0..options.req.size];
    const namespace = findStringField(request_slice, 1);
    const workflow_id = findStringField(request_slice, 2);
    const identity = findStringField(request_slice, 9);
    const request_id = findStringField(request_slice, 10);

    std.debug.assert(std.mem.eql(u8, namespace, "default"));
    std.debug.assert(std.mem.eql(u8, workflow_id, "workflow-42"));
    std.debug.assert(std.mem.eql(u8, identity, "zig-client"));
    std.debug.assert(request_id.len != 0);

    const run_id = "run-stub-001";
    var varint_buf: [10]u8 = undefined;
    stub_response_buffer[0] = 0x0A;
    const length_bytes = encodeVarint(run_id.len, &varint_buf);
    @memcpy(stub_response_buffer[1 .. 1 + length_bytes.len], length_bytes);
    const payload_start = 1 + length_bytes.len;
    @memcpy(stub_response_buffer[payload_start .. payload_start + run_id.len], run_id);
    stub_response_slice = stub_response_buffer[0 .. payload_start + run_id.len];
    stub_response_array = .{
        .data = stub_response_slice.ptr,
        .size = stub_response_slice.len,
        .cap = stub_response_slice.len,
        .disable_free = true,
    };

    if (callback) |cb| {
        cb(user_data, &stub_response_array, 0, null, null);
    }
}

test "startWorkflow marshals request and returns metadata" {
    core.ensureExternalApiInstalled();
    const original_api = core.api;
    defer core.api = original_api;

    stub_client_free_calls = 0;
    stub_rpc_call_count = 0;

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

    const allocator = std.heap.c_allocator;
    const handle = allocator.create(client.ClientHandle) catch unreachable;
    const empty_config = allocator.alloc(u8, 0) catch unreachable;
    handle.* = .{
        .id = 1,
        .runtime = runtime_handle,
        .config = empty_config,
        .core_client = @ptrCast(&stub_client_storage),
    };

    const payload = "{" ++
        "\"namespace\":\"default\"," ++
        "\"workflow_id\":\"workflow-42\"," ++
        "\"workflow_type\":\"Example\"," ++
        "\"task_queue\":\"queue\"," ++
        "\"identity\":\"zig-client\"," ++
        "\"args\":[\"payload\"]" ++
        "}";

    const result = client.startWorkflow(handle, payload) orelse unreachable;
    defer byte_array.free(result);

    try testing.expectEqual(@as(usize, 1), stub_rpc_call_count);

    if (result.data) |ptr| {
        const slice = ptr[0..result.size];
        const parsed = try std.json.parseFromSlice(std.json.Value, allocator, slice, .{});
        defer parsed.deinit();
        try testing.expect(parsed.value.object.get("runId") != null);
        const workflow_id_field = parsed.value.object.get("workflowId").?.string;
        try testing.expectEqualSlices(u8, "workflow-42", workflow_id_field);
        const namespace_field = parsed.value.object.get("namespace").?.string;
        try testing.expectEqualSlices(u8, "default", namespace_field);
    } else {
        return testing.expect(false, "result byte array missing data pointer");
    }

    client.destroy(handle);
    try testing.expectEqual(@as(usize, 1), stub_client_free_calls);
}
