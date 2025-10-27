const std = @import("std");
const testing = std.testing;
const update_headers = @import("client/update_headers.zig");
const common = @import("client/common.zig");
const runtime = @import("runtime.zig");
const core = @import("core.zig");
const errors = @import("errors.zig");

var captured_metadata: []u8 = ""[0..0];
var captured_call_count: usize = 0;

fn resetCapturedMetadata() void {
    if (captured_metadata.len > 0) {
        std.heap.c_allocator.free(captured_metadata);
    }
    captured_metadata = ""[0..0];
    captured_call_count = 0;
}

fn stubClientUpdateMetadata(_client: ?*core.Client, metadata: core.ByteArrayRef) callconv(.c) void {
    _ = _client;
    resetCapturedMetadata();
    captured_call_count += 1;
    if (metadata.size == 0 or metadata.data == null) {
        return;
    }
    const slice = metadata.data.?[0..metadata.size];
    const copy = std.heap.c_allocator.alloc(u8, slice.len) catch {
        @panic("failed to allocate metadata copy");
    };
    @memcpy(copy, slice);
    captured_metadata = copy;
}

fn makeClientHandle(runtime_handle: *runtime.RuntimeHandle, client_storage: *usize) common.ClientHandle {
    return .{
        .id = 1,
        .runtime = runtime_handle,
        .config = @constCast(""[0..0]),
        .core_client = @ptrCast(client_storage),
    };
}

fn makeRuntimeHandle(storage: *usize) runtime.RuntimeHandle {
    return .{
        .id = 1,
        .config = @constCast(""[0..0]),
        .core_runtime = @ptrCast(storage),
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };
}

test "updateHeaders encodes metadata into newline-delimited payload" {
    resetCapturedMetadata();
    defer resetCapturedMetadata();
    defer errors.setLastError(""[0..0]);

    const original_api = core.api;
    defer core.api = original_api;

    var stub_api = core.stub_api;
    stub_api.client_update_metadata = stubClientUpdateMetadata;
    core.api = stub_api;

    var runtime_storage: usize = 0;
    var client_storage: usize = 0;
    var runtime_handle = makeRuntimeHandle(&runtime_storage);
    var client_handle = makeClientHandle(&runtime_handle, &client_storage);

    const payload =
        "{\"authorization\":\"Bearer token\",\"user-agent\":\"temporal-bun-sdk/1.0\",\"x-json-bin\":\"eyJoZWxsbyI6IndvcmxkIn0=\",\"x-trace-bin\":\"3q2+7w==\"}";

    const result = update_headers.updateHeaders(&client_handle, payload);
    try testing.expectEqual(@as(i32, 0), result);
    try testing.expectEqual(@as(usize, 1), captured_call_count);
    const expected = "authorization\nBearer token\nuser-agent\ntemporal-bun-sdk/1.0\nx-json-bin\neyJoZWxsbyI6IndvcmxkIn0=\nx-trace-bin\n3q2+7w==";
    try testing.expectEqualStrings(expected, captured_metadata);
}

test "updateHeaders rejects payloads with non-string values" {
    resetCapturedMetadata();
    defer resetCapturedMetadata();
    defer errors.setLastError(""[0..0]);

    const original_api = core.api;
    defer core.api = original_api;

    var stub_api = core.stub_api;
    stub_api.client_update_metadata = stubClientUpdateMetadata;
    core.api = stub_api;

    var runtime_storage: usize = 0;
    var client_storage: usize = 0;
    var runtime_handle = makeRuntimeHandle(&runtime_storage);
    var client_handle = makeClientHandle(&runtime_handle, &client_storage);

    const payload = "{\"authorization\":42}";

    const result = update_headers.updateHeaders(&client_handle, payload);
    try testing.expectEqual(@as(i32, -1), result);
    try testing.expectEqual(@as(usize, 0), captured_call_count);
    const snapshot = errors.snapshot();
    try testing.expect(std.mem.indexOf(u8, snapshot, "values must be strings") != null);
}

test "updateHeaders clears metadata when payload object is empty" {
    resetCapturedMetadata();
    defer resetCapturedMetadata();
    defer errors.setLastError(""[0..0]);

    const original_api = core.api;
    defer core.api = original_api;

    var stub_api = core.stub_api;
    stub_api.client_update_metadata = stubClientUpdateMetadata;
    core.api = stub_api;

    var runtime_storage: usize = 0;
    var client_storage: usize = 0;
    var runtime_handle = makeRuntimeHandle(&runtime_storage);
    var client_handle = makeClientHandle(&runtime_handle, &client_storage);

    const result = update_headers.updateHeaders(&client_handle, "{}");
    try testing.expectEqual(@as(i32, 0), result);
    try testing.expectEqual(@as(usize, 1), captured_call_count);
    try testing.expectEqual(@as(usize, 0), captured_metadata.len);
}
