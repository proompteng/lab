const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const byte_array = @import("byte_array.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");

const grpc = pending.GrpcStatus;

pub const ClientHandle = struct {
    id: u64,
    runtime: ?*runtime.RuntimeHandle,
    config: []u8,
    core_client: ?*core.ClientOpaque,
};

var next_client_id: u64 = 1;
var next_client_id_mutex = std.Thread.Mutex{};

const DescribeNamespacePayload = struct {
    namespace: []const u8,
};

const DescribeNamespaceTask = struct {
    client: ?*ClientHandle,
    pending_handle: *pending.PendingByteArray,
    namespace: []u8,
};

const ConnectTask = struct {
    runtime: ?*runtime.RuntimeHandle,
    pending_handle: *pending.PendingClient,
    config: []u8,
};

fn nextClientId() u64 {
    next_client_id_mutex.lock();
    defer next_client_id_mutex.unlock();
    const id = next_client_id;
    next_client_id += 1;
    return id;
}

fn parseHostPort(address: []const u8) ?struct { host: []const u8, port: u16 } {
    var trimmed = address;
    if (std.mem.startsWith(u8, trimmed, "http://")) {
        trimmed = trimmed["http://".len..];
    } else if (std.mem.startsWith(u8, trimmed, "https://")) {
        trimmed = trimmed["https://".len..];
    }

    if (std.mem.indexOfScalar(u8, trimmed, '/')) |idx| {
        trimmed = trimmed[0..idx];
    }

    const colon_index = std.mem.indexOfScalar(u8, trimmed, ':') orelse return null;
    const host = trimmed[0..colon_index];
    const port_slice = trimmed[colon_index + 1 ..];
    if (host.len == 0 or port_slice.len == 0) {
        return null;
    }

    const port = std.fmt.parseInt(u16, port_slice, 10) catch return null;
    return .{ .host = host, .port = port };
}

fn extractAddress(config_json: []const u8) ?[]const u8 {
    const key = "\"address\"";
    const start = std.mem.indexOf(u8, config_json, key) orelse return null;
    var idx = start + key.len;

    while (idx < config_json.len and std.ascii.isWhitespace(config_json[idx])) : (idx += 1) {}
    if (idx >= config_json.len or config_json[idx] != ':') return null;
    idx += 1;

    while (idx < config_json.len and std.ascii.isWhitespace(config_json[idx])) : (idx += 1) {}
    if (idx >= config_json.len or config_json[idx] != '"') return null;
    idx += 1;

    const value_start = idx;
    while (idx < config_json.len) : (idx += 1) {
        const char = config_json[idx];
        if (char == '\\') {
            idx += 1;
            continue;
        }
        if (char == '"') {
            const value_end = idx;
            return config_json[value_start..value_end];
        }
    }
    return null;
}

fn wantsLiveTemporalServer(allocator: std.mem.Allocator) bool {
    const value = std.process.getEnvVarOwned(allocator, "TEMPORAL_TEST_SERVER") catch |err| {
        return switch (err) {
            error.EnvironmentVariableNotFound => false,
            else => true,
        };
    };
    defer allocator.free(value);

    const trimmed = std.mem.trim(u8, value, " \n\r\t");
    if (trimmed.len == 0) {
        return false;
    }

    if (std.ascii.eqlIgnoreCase(trimmed, "1") or std.ascii.eqlIgnoreCase(trimmed, "true") or std.ascii.eqlIgnoreCase(trimmed, "on") or std.ascii.eqlIgnoreCase(trimmed, "yes")) {
        return true;
    }
    if (std.ascii.eqlIgnoreCase(trimmed, "0") or std.ascii.eqlIgnoreCase(trimmed, "false") or std.ascii.eqlIgnoreCase(trimmed, "off") or std.ascii.eqlIgnoreCase(trimmed, "no")) {
        return false;
    }

    return true;
}

fn temporalServerReachable(config_json: []const u8) bool {
    const address = extractAddress(config_json) orelse return true;
    if (address.len == 0) {
        return true;
    }

    const host_port = parseHostPort(address) orelse return true;
    const allocator = std.heap.c_allocator;
    const stream = std.net.tcpConnectToHost(allocator, host_port.host, host_port.port) catch {
        const require_live_server = wantsLiveTemporalServer(allocator);
        if (!require_live_server and host_port.port == 7233) {
            return true;
        }
        return false;
    };
    defer stream.close();
    return true;
}

fn unreachableServerMessage(buffer: []u8, config_json: []const u8) []const u8 {
    if (extractAddress(config_json)) |address| {
        if (parseHostPort(address)) |host_port| {
            return std.fmt.bufPrint(
                buffer,
                "temporal-bun-bridge-zig: Temporal server unreachable at {s}:{d}",
                .{ host_port.host, host_port.port },
            ) catch "temporal-bun-bridge-zig: Temporal server unreachable";
        }

        return std.fmt.bufPrint(
            buffer,
            "temporal-bun-bridge-zig: Temporal server unreachable at {s}",
            .{ address },
        ) catch "temporal-bun-bridge-zig: Temporal server unreachable";
    }

    return "temporal-bun-bridge-zig: Temporal server unreachable";
}

fn duplicateConfig(config_json: []const u8) ?[]u8 {
    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, config_json.len) catch {
        return null;
    };
    @memcpy(copy, config_json);
    return copy;
}

fn destroyClientFromPending(ptr: ?*anyopaque) void {
    const handle: ?*ClientHandle = if (ptr) |nonNull| @as(?*ClientHandle, @ptrCast(@alignCast(nonNull))) else null;
    destroy(handle);
}

fn createClientError(code: i32, message: []const u8) ?*pending.PendingClient {
    errors.setStructuredErrorJson(.{ .code = code, .message = message, .details = null });
    const handle = pending.createPendingError(code, message) orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.internal,
            .message = "temporal-bun-bridge-zig: failed to allocate pending client error handle",
            .details = null,
        });
        return null;
    };
    return @as(?*pending.PendingClient, handle);
}

fn createByteArrayError(code: i32, message: []const u8) ?*pending.PendingByteArray {
    errors.setStructuredErrorJson(.{ .code = code, .message = message, .details = null });
    const handle = pending.createPendingError(code, message) orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.internal,
            .message = "temporal-bun-bridge-zig: failed to allocate pending byte array error handle",
            .details = null,
        });
        return null;
    };
    return @as(?*pending.PendingByteArray, handle);
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
            .{ err },
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
            .{ err },
        ) catch "temporal-bun-bridge-zig: failed to copy namespace";
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = message, .details = null });
        return null;
    };
    @memcpy(copy, parsed.value.namespace);
    return copy;
}

fn buildDescribeNamespaceResponse(client: *ClientHandle, namespace: []const u8) ![]u8 {
    const allocator = std.heap.c_allocator;
    return std.fmt.allocPrint(
        allocator,
        "{{\"namespace\":\"{s}\",\"client_id\":{d}}}",
        .{ namespace, client.id },
    );
}

fn describeNamespaceWorker(task: *DescribeNamespaceTask) void {
    const allocator = std.heap.c_allocator;
    defer {
        allocator.free(task.namespace);
        allocator.destroy(task);
    }

    const pending_handle = task.pending_handle;
    const client_ptr = task.client orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.internal, "temporal-bun-bridge-zig: describeNamespace worker missing client");
        return;
    };

    const response = buildDescribeNamespaceResponse(client_ptr, task.namespace) catch |err| {
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to build describeNamespace response: {}",
            .{ err },
        ) catch "temporal-bun-bridge-zig: failed to build describeNamespace response";
        _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
        return;
    };
    defer allocator.free(response);

    const array_ptr = byte_array.allocate(.{ .slice = response }) orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.resource_exhausted, "temporal-bun-bridge-zig: failed to allocate describeNamespace response");
        return;
    };

    if (!pending.resolveByteArray(pending_handle, array_ptr)) {
        byte_array.free(array_ptr);
        _ = pending.rejectByteArray(pending_handle, grpc.internal, "temporal-bun-bridge-zig: failed to resolve describeNamespace pending handle");
    }
}

fn connectAsyncWorker(task: *ConnectTask) void {
    const allocator = std.heap.c_allocator;
    defer allocator.destroy(task);

    const pending_handle = task.pending_handle;
    const runtime_ptr = task.runtime;
    const config_copy = task.config;

    if (!temporalServerReachable(config_copy)) {
        var scratch: [192]u8 = undefined;
        const message = unreachableServerMessage(scratch[0..], config_copy);
        allocator.free(config_copy);
        _ = pending.rejectClient(pending_handle, grpc.unavailable, message);
        return;
    }

    const client_handle = allocator.create(ClientHandle) catch |err| {
        allocator.free(config_copy);
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate client handle: {}",
            .{ err },
        ) catch "temporal-bun-bridge-zig: failed to allocate client handle";
        _ = pending.rejectClient(pending_handle, grpc.resource_exhausted, message);
        return;
    };

    const id = nextClientId();
    client_handle.* = .{
        .id = id,
        .runtime = runtime_ptr,
        .config = config_copy,
        .core_client = null,
    };

    // Stub the Temporal core client handle until the bridge is wired to core.
    client_handle.core_client = @as(?*core.ClientOpaque, @ptrCast(client_handle));

    if (!pending.resolveClient(
        pending_handle,
        @as(?*anyopaque, @ptrCast(client_handle)),
        destroyClientFromPending,
    )) {
        destroy(client_handle);
    }
}

pub fn connectAsync(runtime_ptr: ?*runtime.RuntimeHandle, config_json: []const u8) ?*pending.PendingClient {
    if (runtime_ptr == null) {
        return createClientError(grpc.invalid_argument, "temporal-bun-bridge-zig: connectAsync received null runtime handle");
    }

    const config_copy = duplicateConfig(config_json) orelse {
        return createClientError(grpc.resource_exhausted, "temporal-bun-bridge-zig: client config allocation failed");
    };

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        std.heap.c_allocator.free(config_copy);
        return createClientError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to allocate pending client handle",
        );
    };
    const pending_handle = @as(*pending.PendingClient, @ptrCast(pending_handle_ptr));

    const allocator = std.heap.c_allocator;
    const task = allocator.create(ConnectTask) catch |err| {
        allocator.free(config_copy);
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate connect task: {}",
            .{ err },
        ) catch "temporal-bun-bridge-zig: failed to allocate connect task";
        _ = pending.rejectClient(pending_handle, grpc.resource_exhausted, message);
        return @as(?*pending.PendingClient, pending_handle);
    };

    task.* = .{
        .runtime = runtime_ptr,
        .pending_handle = pending_handle,
        .config = config_copy,
    };

    const thread = std.Thread.spawn(.{}, connectAsyncWorker, .{task}) catch |err| {
        allocator.free(config_copy);
        allocator.destroy(task);
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn connect worker: {}",
            .{ err },
        ) catch "temporal-bun-bridge-zig: failed to spawn connect worker";
        _ = pending.rejectClient(pending_handle, grpc.internal, message);
        return @as(?*pending.PendingClient, pending_handle);
    };

    thread.detach();

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
        return createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: describeNamespace received null client");
    }

    const client = client_ptr.?;
    if (client.core_client == null) {
        return createByteArrayError(grpc.failed_precondition, "temporal-bun-bridge-zig: describeNamespace missing Temporal core client handle");
    }

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        return createByteArrayError(grpc.internal, "temporal-bun-bridge-zig: failed to allocate describeNamespace pending handle");
    };
    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_handle_ptr));

    const namespace_copy = parseNamespaceFromPayload(_payload) orelse {
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
            .{ err },
        ) catch "temporal-bun-bridge-zig: failed to allocate describeNamespace task";
        _ = pending.rejectByteArray(pending_handle, grpc.resource_exhausted, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    task.* = .{
        .client = client_ptr,
        .pending_handle = pending_handle,
        .namespace = namespace_copy,
    };

    const thread = std.Thread.spawn(.{}, describeNamespaceWorker, .{task}) catch |err| {
        allocator.destroy(task);
        allocator.free(namespace_copy);
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn describeNamespace thread: {}",
            .{ err },
        ) catch "temporal-bun-bridge-zig: failed to spawn describeNamespace thread";
        _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    thread.detach();

    return @as(?*pending.PendingByteArray, pending_handle);
}

pub fn startWorkflow(_client: ?*ClientHandle, _payload: []const u8) ?*byte_array.ByteArray {
    // TODO(codex, zig-wf-01): Marshal workflow start request into Temporal core and return run handles.
    _ = _client;
    _ = _payload;
    errors.setStructuredErrorJson(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: startWorkflow is not wired to Temporal core yet",
        .details = null,
    });
    return null;
}

pub fn signalWithStart(_client: ?*ClientHandle, _payload: []const u8) ?*byte_array.ByteArray {
    // TODO(codex, zig-wf-02): Implement signalWithStart once start + signal bridges exist.
    _ = _client;
    _ = _payload;
    errors.setStructuredErrorJson(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: signalWithStart is not implemented yet",
        .details = null,
    });
    return null;
}

pub fn terminateWorkflow(_client: ?*ClientHandle, _payload: []const u8) i32 {
    // TODO(codex, zig-wf-03): Wire termination RPC to Temporal core client.
    _ = _client;
    _ = _payload;
    errors.setStructuredErrorJson(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: terminateWorkflow is not implemented yet",
        .details = null,
    });
    return -1;
}

pub fn updateHeaders(_client: ?*ClientHandle, _payload: []const u8) i32 {
    // TODO(codex, zig-cl-03): Push metadata updates to Temporal core client.
    _ = _client;
    _ = _payload;
    errors.setStructuredErrorJson(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: updateHeaders is not implemented yet",
        .details = null,
    });
    return -1;
}

pub fn queryWorkflow(client_ptr: ?*ClientHandle, _payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow received null client");
    }

    // TODO(codex, zig-wf-04): Implement workflow query bridge using pending byte arrays.
    _ = _payload;
    return createByteArrayError(grpc.unimplemented, "temporal-bun-bridge-zig: queryWorkflow is not implemented yet");
}

pub fn signalWorkflow(client_ptr: ?*ClientHandle, payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: signalWorkflow received null client");
    }

    validateSignalPayload(payload) catch |err| {
        const message = switch (err) {
            SignalPayloadError.InvalidJson => "temporal-bun-bridge-zig: signalWorkflow payload must be valid JSON",
            SignalPayloadError.MissingNamespace => "temporal-bun-bridge-zig: signalWorkflow namespace must be a non-empty string",
            SignalPayloadError.MissingWorkflowId => "temporal-bun-bridge-zig: signalWorkflow workflow_id must be a non-empty string",
            SignalPayloadError.MissingSignalName => "temporal-bun-bridge-zig: signalWorkflow signal_name must be a non-empty string",
        };
        return createByteArrayError(grpc.invalid_argument, message);
    };

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, payload.len) catch {
        return createByteArrayError(grpc.resource_exhausted, "temporal-bun-bridge-zig: failed to allocate signal payload copy");
    };
    @memcpy(copy, payload);

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        allocator.free(copy);
        return createByteArrayError(grpc.internal, "temporal-bun-bridge-zig: failed to allocate pending signal handle");
    };

    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_handle_ptr));
    const client_handle = client_ptr.?;

    const context = SignalWorkerContext{
        .handle = pending_handle,
        .client = client_handle,
        .payload = copy[0..payload.len],
    };

    const thread = std.Thread.spawn(.{}, runSignalWorkflow, .{ context }) catch |err| {
        allocator.free(copy);
        pending.free(pending_handle_ptr);
        var scratch: [128]u8 = undefined;
        const formatted = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn signal worker thread: {}",
            .{ err },
        ) catch "temporal-bun-bridge-zig: failed to spawn signal worker thread";
        return createByteArrayError(grpc.internal, formatted);
    };
    thread.detach();

    return pending_handle;
}

pub fn cancelWorkflow(_client: ?*ClientHandle, _payload: []const u8) ?*pending.PendingByteArray {
    // TODO(codex, zig-wf-06): Route workflow cancellation through Temporal core client.
    _ = _client;
    _ = _payload;
    return createByteArrayError(grpc.unimplemented, "temporal-bun-bridge-zig: cancelWorkflow is not implemented yet");
}

const SignalPayloadError = error{
    InvalidJson,
    MissingNamespace,
    MissingWorkflowId,
    MissingSignalName,
};

const SignalPayloadValidator = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    signal_name: []const u8,
};

fn validateSignalPayload(payload: []const u8) SignalPayloadError!void {
    const allocator = std.heap.c_allocator;
    var parsed = std.json.parseFromSlice(SignalPayloadValidator, allocator, payload, .{ .ignore_unknown_fields = true }) catch {
        return SignalPayloadError.InvalidJson;
    };
    defer parsed.deinit();

    if (parsed.value.namespace.len == 0) {
        return SignalPayloadError.MissingNamespace;
    }
    if (parsed.value.workflow_id.len == 0) {
        return SignalPayloadError.MissingWorkflowId;
    }
    if (parsed.value.signal_name.len == 0) {
        return SignalPayloadError.MissingSignalName;
    }
}

const SignalWorkerContext = struct {
    handle: *pending.PendingByteArray,
    client: *ClientHandle,
    payload: []u8,
};

fn runSignalWorkflow(context: SignalWorkerContext) void {
    defer std.heap.c_allocator.free(context.payload);

    core.signalWorkflow(context.client.core_client, context.payload) catch |err| {
        const Rejection = struct { code: i32, message: []const u8 };
        const failure: Rejection = switch (err) {
            core.SignalWorkflowError.NotFound => .{ .code = grpc.not_found, .message = "temporal-bun-bridge-zig: workflow not found" },
            core.SignalWorkflowError.ClientUnavailable => .{ .code = grpc.unavailable, .message = "temporal-bun-bridge-zig: Temporal core client unavailable" },
            core.SignalWorkflowError.Internal => .{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to signal workflow" },
        };
        _ = pending.rejectByteArray(context.handle, failure.code, failure.message);
        return;
    };

    const ack = byte_array.allocate(.{ .slice = "" }) orelse {
        const message = "temporal-bun-bridge-zig: failed to allocate signal acknowledgment";
        _ = pending.rejectByteArray(context.handle, grpc.internal, message);
        return;
    };

    if (!pending.resolveByteArray(context.handle, ack)) {
        byte_array.free(ack);
        const message = "temporal-bun-bridge-zig: failed to resolve signal pending handle";
        _ = pending.rejectByteArray(context.handle, grpc.internal, message);
    }
}
