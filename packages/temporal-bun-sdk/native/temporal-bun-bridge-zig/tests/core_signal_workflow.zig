const std = @import("std");
const testing = std.testing;
const bridge = @import("root");
const core = bridge.core;

const SignalError = core.SignalWorkflowError;
const RpcCallOptions = core.RpcCallOptions;
const ClientRpcCallCallback = core.ClientRpcCallCallback;

const signal_rpc_name = "SignalWorkflowExecution";

fn fakeClient() ?*core.ClientOpaque {
    return @as(?*core.ClientOpaque, @ptrFromInt(@as(usize, 0x10)));
}

fn makeStaticByteArray(bytes: []const u8) core.ByteArray {
    return .{
        .data = bytes.ptr,
        .size = bytes.len,
        .cap = bytes.len,
        .disable_free = true,
    };
}

fn expectSignalRequest(options: *const RpcCallOptions, expected: []const u8) void {
    const rpc_slice = options.rpc.data[0..options.rpc.size];
    std.debug.assert(std.mem.eql(u8, rpc_slice, signal_rpc_name));

    const req_slice = options.req.data[0..options.req.size];
    std.debug.assert(std.mem.eql(u8, req_slice, expected));
}

fn resolveCallback(
    user_data: ?*anyopaque,
    callback: ClientRpcCallCallback,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
) void {
    callback(user_data, null, status_code, failure_message, null);
}

test "signalWorkflow resolves when Temporal core reports success" {
    const request = "{\"namespace\":\"default\",\"workflow_id\":\"zig\"}";

    const Stub = struct {
        pub fn call(
            client: *core.ClientOpaque,
            options: *const RpcCallOptions,
            user_data: ?*anyopaque,
            callback: ClientRpcCallCallback,
        ) callconv(.c) void {
            std.debug.assert(client != null);
            expectSignalRequest(options, request);
            resolveCallback(user_data, callback, 0, null);
        }
    };

    core.setClientRpcCallStubForTesting(Stub.call);
    defer core.resetClientRpcCallStubForTesting();

    try core.signalWorkflow(fakeClient(), request);
}

test "signalWorkflow surfaces not found errors" {
    const request = "{\"namespace\":\"default\",\"workflow_id\":\"missing\"}";

    const Stub = struct {
        pub fn call(
            _: *core.ClientOpaque,
            options: *const RpcCallOptions,
            user_data: ?*anyopaque,
            callback: ClientRpcCallCallback,
        ) callconv(.c) void {
            expectSignalRequest(options, request);
            resolveCallback(user_data, callback, 5, null);
        }
    };

    core.setClientRpcCallStubForTesting(Stub.call);
    defer core.resetClientRpcCallStubForTesting();

    try testing.expectError(SignalError.NotFound, core.signalWorkflow(fakeClient(), request));
}

test "signalWorkflow surfaces unavailable errors" {
    const request = "{\"namespace\":\"default\",\"workflow_id\":\"zig\"}";

    const Stub = struct {
        pub fn call(
            _: *core.ClientOpaque,
            options: *const RpcCallOptions,
            user_data: ?*anyopaque,
            callback: ClientRpcCallCallback,
        ) callconv(.c) void {
            expectSignalRequest(options, request);
            resolveCallback(user_data, callback, 14, null);
        }
    };

    core.setClientRpcCallStubForTesting(Stub.call);
    defer core.resetClientRpcCallStubForTesting();

    try testing.expectError(SignalError.ClientUnavailable, core.signalWorkflow(fakeClient(), request));
}

test "signalWorkflow treats unknown statuses as internal" {
    const request = "{\"namespace\":\"default\",\"workflow_id\":\"zig\"}";

    const Stub = struct {
        pub fn call(
            _: *core.ClientOpaque,
            options: *const RpcCallOptions,
            user_data: ?*anyopaque,
            callback: ClientRpcCallCallback,
        ) callconv(.c) void {
            expectSignalRequest(options, request);
            resolveCallback(user_data, callback, 9, null);
        }
    };

    core.setClientRpcCallStubForTesting(Stub.call);
    defer core.resetClientRpcCallStubForTesting();

    try testing.expectError(SignalError.Internal, core.signalWorkflow(fakeClient(), request));
}

test "signalWorkflow treats failure payloads with ok status as internal" {
    const request = "{\"namespace\":\"default\",\"workflow_id\":\"zig\"}";

    const Stub = struct {
        pub fn call(
            _: *core.ClientOpaque,
            options: *const RpcCallOptions,
            user_data: ?*anyopaque,
            callback: ClientRpcCallCallback,
        ) callconv(.c) void {
            expectSignalRequest(options, request);
            var failure = makeStaticByteArray("internal error");
            resolveCallback(user_data, callback, 0, &failure);
        }
    };

    core.setClientRpcCallStubForTesting(Stub.call);
    defer core.resetClientRpcCallStubForTesting();

    try testing.expectError(SignalError.Internal, core.signalWorkflow(fakeClient(), request));
}

test "signalWorkflow returns ClientUnavailable when core client pointer is null" {
    const request = "{\"namespace\":\"default\",\"workflow_id\":\"zig\"}";
    try testing.expectError(SignalError.ClientUnavailable, core.signalWorkflow(null, request));
}
