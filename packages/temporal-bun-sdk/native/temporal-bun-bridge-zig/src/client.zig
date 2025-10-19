const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const byte_array = @import("byte_array.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");

pub const ClientHandle = struct {
    id: u64,
    runtime: ?*runtime.RuntimeHandle,
    config: []u8,
    core_client: ?*core.ClientOpaque,
};

var next_client_id: u64 = 1;

fn duplicateConfig(config_json: []const u8) ?[]u8 {
    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, config_json.len) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate client config: {}", .{err});
        return null;
    };
    @memcpy(copy, config_json);
    return copy;
}

fn destroyClientFromPending(ptr: ?*anyopaque) void {
    const handle: ?*ClientHandle = if (ptr) |nonNull| @as(?*ClientHandle, @ptrCast(@alignCast(nonNull))) else null;
    destroy(handle);
}

fn createClientError(message: []const u8) ?*pending.PendingClient {
    errors.setLastError(message);
    const handle = pending.createPendingError(message) orelse {
        errors.setLastError("temporal-bun-bridge-zig: failed to allocate pending client error handle");
        return null;
    };
    return @as(?*pending.PendingClient, handle);
}

fn createByteArrayError(message: []const u8) ?*pending.PendingByteArray {
    errors.setLastError(message);
    const handle = pending.createPendingError(message) orelse {
        errors.setLastError("temporal-bun-bridge-zig: failed to allocate pending byte array error handle");
        return null;
    };
    return @as(?*pending.PendingByteArray, handle);
}

pub fn connectAsync(runtime_ptr: ?*runtime.RuntimeHandle, config_json: []const u8) ?*pending.PendingClient {
    if (runtime_ptr == null) {
        return createClientError("temporal-bun-bridge-zig: connectAsync received null runtime handle");
    }

    const config_copy = duplicateConfig(config_json) orelse {
        return createClientError("temporal-bun-bridge-zig: client config allocation failed");
    };

    const allocator = std.heap.c_allocator;
    const handle = allocator.create(ClientHandle) catch |err| {
        allocator.free(config_copy);
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate client handle: {}", .{err});
        return createClientError("temporal-bun-bridge-zig: client handle allocation failed");
    };

    const id = next_client_id;
    next_client_id += 1;

    handle.* = .{
        .id = id,
        .runtime = runtime_ptr,
        .config = config_copy,
        .core_client = null,
    };

    // TODO(codex, zig-cl-01): Initialize Temporal core client via core bridge and populate core_client.
    const pending_handle = pending.createPendingReady(
        @as(?*anyopaque, @ptrCast(handle)),
        destroyClientFromPending,
    ) orelse {
        destroy(handle);
        errors.setLastError("temporal-bun-bridge-zig: failed to allocate pending client handle");
        return createClientError("temporal-bun-bridge-zig: pending client allocation failed");
    };

    return @as(?*pending.PendingClient, pending_handle);
}

pub fn destroy(handle: ?*ClientHandle) void {
    if (handle == null) {
        return;
    }

    var allocator = std.heap.c_allocator;
    const client = handle.?;

    if (client.core_client) |_| {
        // TODO(codex, zig-cl-04): Release Temporal core client once linked.
    }

    allocator.free(client.config);

    allocator.destroy(client);
}

pub fn describeNamespaceAsync(client_ptr: ?*ClientHandle, _payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return createByteArrayError("temporal-bun-bridge-zig: describeNamespace received null client");
    }

    // TODO(codex, zig-cl-02): Marshal namespace describe request via Temporal core.
    _ = _payload;
    return createByteArrayError("temporal-bun-bridge-zig: describeNamespace is not implemented yet");
}

pub fn startWorkflow(_client: ?*ClientHandle, _payload: []const u8) ?*byte_array.ByteArray {
    // TODO(codex, zig-wf-01): Marshal workflow start request into Temporal core and return run handles.
    _ = _client;
    _ = _payload;
    errors.setLastError("temporal-bun-bridge-zig: startWorkflow is not wired to Temporal core yet");
    return null;
}

pub fn signalWithStart(_client: ?*ClientHandle, _payload: []const u8) ?*byte_array.ByteArray {
    // TODO(codex, zig-wf-02): Implement signalWithStart once start + signal bridges exist.
    _ = _client;
    _ = _payload;
    errors.setLastError("temporal-bun-bridge-zig: signalWithStart is not implemented yet");
    return null;
}

pub fn terminateWorkflow(_client: ?*ClientHandle, _payload: []const u8) i32 {
    // TODO(codex, zig-wf-03): Wire termination RPC to Temporal core client.
    _ = _client;
    _ = _payload;
    errors.setLastError("temporal-bun-bridge-zig: terminateWorkflow is not implemented yet");
    return -1;
}

pub fn updateHeaders(_client: ?*ClientHandle, _payload: []const u8) i32 {
    // TODO(codex, zig-cl-03): Push metadata updates to Temporal core client.
    _ = _client;
    _ = _payload;
    errors.setLastError("temporal-bun-bridge-zig: updateHeaders is not implemented yet");
    return -1;
}

pub fn queryWorkflow(client_ptr: ?*ClientHandle, _payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return createByteArrayError("temporal-bun-bridge-zig: queryWorkflow received null client");
    }

    // TODO(codex, zig-wf-04): Implement workflow query bridge using pending byte arrays.
    _ = _payload;
    return createByteArrayError("temporal-bun-bridge-zig: queryWorkflow is not implemented yet");
}

pub fn signalWorkflow(_client: ?*ClientHandle, _payload: []const u8) ?*pending.PendingByteArray {
    // TODO(codex, zig-wf-05): Invoke Temporal core signal RPC and surface result via pending handle.
    _ = _client;
    _ = _payload;
    return createByteArrayError("temporal-bun-bridge-zig: signalWorkflow is not implemented yet");
}

pub fn cancelWorkflow(_client: ?*ClientHandle, _payload: []const u8) ?*pending.PendingByteArray {
    // TODO(codex, zig-wf-06): Route workflow cancellation through Temporal core client.
    _ = _client;
    _ = _payload;
    return createByteArrayError("temporal-bun-bridge-zig: cancelWorkflow is not implemented yet");
}
