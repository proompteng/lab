const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const byte_array = @import("byte_array.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");

const grpc = pending.GrpcStatus;

const StringArena = struct {
    allocator: std.mem.Allocator,
    store: std.ArrayListUnmanaged([]u8) = .{},

    pub fn init(allocator: std.mem.Allocator) StringArena {
        return .{ .allocator = allocator, .store = .{} };
    }

    pub fn dup(self: *StringArena, bytes: []const u8) ![]const u8 {
        const copy = try self.allocator.alloc(u8, bytes.len);
        @memcpy(copy, bytes);
        try self.store.append(self.allocator, copy);
        return copy;
    }

    pub fn deinit(self: *StringArena) void {
        for (self.store.items) |buf| {
            self.allocator.free(buf);
        }
        self.store.deinit(self.allocator);
    }
};

fn makeByteArrayRef(slice: []const u8) core.ByteArrayRef {
    return .{ .data = slice.ptr, .size = slice.len };
}

fn emptyByteArrayRef() core.ByteArrayRef {
    return .{ .data = null, .size = 0 };
}

fn byteArraySlice(bytes_ptr: ?*const core.ByteArray) []const u8 {
    if (bytes_ptr == null) return ""[0..0];
    const bytes = bytes_ptr.?;
    if (bytes.data == null or bytes.size == 0) return ""[0..0];
    return bytes.data[0..bytes.size];
}

fn makeDefaultIdentity(arena: *StringArena) ![]const u8 {
    const pid = std.c.getpid();
    const pid_u64 = @as(u64, @intCast(pid));
    var buffer: [64]u8 = undefined;
    const written = try std.fmt.bufPrint(&buffer, "temporal-bun-sdk-{d}", .{pid_u64});
    return arena.dup(written);
}

fn extractStringField(config_json: []const u8, key: []const u8) ?[]const u8 {
    var pattern_buf: [96]u8 = undefined;
    if (key.len + 2 > pattern_buf.len) return null;
    const pattern = std.fmt.bufPrint(&pattern_buf, "\"{s}\"", .{key}) catch return null;
    const start = std.mem.indexOf(u8, config_json, pattern) orelse return null;
    var idx = start + pattern.len;

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

fn extractOptionalStringField(config_json: []const u8, aliases: []const []const u8) ?[]const u8 {
    for (aliases) |alias| {
        if (extractStringField(config_json, alias)) |value| {
            return value;
        }
    }
    return null;
}

fn extractBoolField(config_json: []const u8, key: []const u8) ?bool {
    var pattern_buf: [96]u8 = undefined;
    if (key.len + 2 > pattern_buf.len) return null;
    const pattern = std.fmt.bufPrint(&pattern_buf, "\"{s}\"", .{key}) catch return null;
    const start = std.mem.indexOf(u8, config_json, pattern) orelse return null;
    var idx = start + pattern.len;
    while (idx < config_json.len and std.ascii.isWhitespace(config_json[idx])) : (idx += 1) {}
    if (idx >= config_json.len or config_json[idx] != ':') return null;
    idx += 1;
    while (idx < config_json.len and std.ascii.isWhitespace(config_json[idx])) : (idx += 1) {}
    if (idx + 4 <= config_json.len and std.ascii.eqlIgnoreCase(config_json[idx .. idx + 4], "true")) {
        return true;
    }
    if (idx + 5 <= config_json.len and std.ascii.eqlIgnoreCase(config_json[idx .. idx + 5], "false")) {
        return false;
    }
    return null;
}

fn encodeDescribeNamespaceRequest(allocator: std.mem.Allocator, namespace: []const u8) ![]u8 {
    var length_buffer: [10]u8 = undefined;
    var length_index: usize = 0;
    var remaining = namespace.len;
    while (true) {
        const byte: u8 = @as(u8, @intCast(remaining & 0x7F));
        remaining >>= 7;
        if (remaining == 0) {
            length_buffer[length_index] = byte;
            length_index += 1;
            break;
        }
        length_buffer[length_index] = byte | 0x80;
        length_index += 1;
    }

    const total_len = 1 + length_index + namespace.len;
    const out = try allocator.alloc(u8, total_len);
    out[0] = 0x0A;
    @memcpy(out[1 .. 1 + length_index], length_buffer[0..length_index]);
    @memcpy(out[1 + length_index ..], namespace);
    return out;
}

const ConnectError = error{ConnectFailed};

const ConnectCallbackContext = struct {
    allocator: std.mem.Allocator,
    wait_group: std.Thread.WaitGroup = .{},
    result_client: ?*core.Client = null,
    error_message: []u8 = ""[0..0],
    runtime_handle: *runtime.RuntimeHandle,
};

fn clientConnectCallback(
    user_data: ?*anyopaque,
    success: ?*core.Client,
    fail: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*ConnectCallbackContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    if (success) |client_ptr| {
        context.result_client = client_ptr;
        if (fail) |fail_ptr| {
            core.api.byte_array_free(context.runtime_handle.core_runtime, fail_ptr);
        }
        return;
    }

    if (fail) |fail_ptr| {
        const slice = byteArraySlice(fail_ptr);
        if (slice.len > 0) {
            context.error_message = context.allocator.alloc(u8, slice.len) catch {
                core.api.byte_array_free(context.runtime_handle.core_runtime, fail_ptr);
                return;
            };
            @memcpy(context.error_message, slice);
        }
        core.api.byte_array_free(context.runtime_handle.core_runtime, fail_ptr);
    }
}

fn connectCoreClient(
    allocator: std.mem.Allocator,
    runtime_handle: *runtime.RuntimeHandle,
    config_json: []const u8,
    arena: *StringArena,
) ConnectError!*core.Client {
    const address = extractStringField(config_json, "address") orelse {
        errors.setStructuredError(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: client config missing address" });
        return ConnectError.ConnectFailed;
    };

    const identity = extractOptionalStringField(config_json, &.{"identity"}) orelse makeDefaultIdentity(arena) catch {
        errors.setStructuredError(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to allocate client identity" });
        return ConnectError.ConnectFailed;
    };

    const client_name = extractOptionalStringField(config_json, &.{ "clientName", "client_name" }) orelse "temporal-bun-sdk";
    const client_version = extractOptionalStringField(config_json, &.{ "clientVersion", "client_version" }) orelse "zig-bridge-dev";
    const api_key = extractOptionalStringField(config_json, &.{ "apiKey", "api_key" });

    var options = std.mem.zeroes(core.ClientOptions);
    options.target_url = makeByteArrayRef(address);
    options.client_name = makeByteArrayRef(client_name);
    options.client_version = makeByteArrayRef(client_version);
    options.metadata = emptyByteArrayRef();
    options.identity = makeByteArrayRef(identity);
    options.api_key = if (api_key) |key| makeByteArrayRef(key) else emptyByteArrayRef();
    options.tls_options = null;
    options.retry_options = null;
    options.keep_alive_options = null;
    options.http_connect_proxy_options = null;
    options.grpc_override_callback = null;
    options.grpc_override_callback_user_data = null;

    var context = ConnectCallbackContext{ .allocator = allocator, .runtime_handle = runtime_handle };
    context.wait_group.start();
    core.api.client_connect(runtime_handle.core_runtime, &options, &context, clientConnectCallback);
    context.wait_group.wait();

    defer if (context.error_message.len > 0) allocator.free(context.error_message);

    if (context.result_client) |client_ptr| {
        return client_ptr;
    }

    const message = if (context.error_message.len > 0)
        context.error_message
    else
        "temporal-bun-bridge-zig: Temporal core client connect failed";

    errors.setStructuredError(.{ .code = grpc.unavailable, .message = message });
    return ConnectError.ConnectFailed;
}

const RpcCallContext = struct {
    allocator: std.mem.Allocator,
    pending_handle: *pending.PendingByteArray,
    wait_group: std.Thread.WaitGroup = .{},
    runtime_handle: *runtime.RuntimeHandle,
};

fn clientDescribeCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
    failure_details: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*RpcCallContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    if (success != null and status_code == 0) {
        const slice = byteArraySlice(success.?);
        if (slice.len == 0) {
            errors.setStructuredError(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: describeNamespace returned empty payload" });
            _ = pending.rejectByteArray(context.pending_handle, grpc.internal, "temporal-bun-bridge-zig: describeNamespace returned empty payload");
        } else if (byte_array.allocateFromSlice(slice)) |array_ptr| {
            if (!pending.resolveByteArray(context.pending_handle, array_ptr)) {
                byte_array.free(array_ptr);
            } else {
                errors.setLastError(""[0..0]);
            }
        } else {
            errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = "temporal-bun-bridge-zig: failed to allocate describeNamespace response" });
            _ = pending.rejectByteArray(context.pending_handle, grpc.resource_exhausted, "temporal-bun-bridge-zig: failed to allocate describeNamespace response");
        }
        core.api.byte_array_free(context.runtime_handle.core_runtime, success.?);
        if (failure_message) |msg| core.api.byte_array_free(context.runtime_handle.core_runtime, msg);
        if (failure_details) |details| core.api.byte_array_free(context.runtime_handle.core_runtime, details);
        return;
    }

    const code: i32 = if (status_code == 0) grpc.internal else @intCast(status_code);
    const message_slice = if (failure_message) |msg| byteArraySlice(msg) else "temporal-bun-bridge-zig: describeNamespace failed"[0..];
    _ = pending.rejectByteArray(context.pending_handle, code, message_slice);
    errors.setStructuredError(.{ .code = code, .message = message_slice });
    if (success) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    if (failure_message) |msg| core.api.byte_array_free(context.runtime_handle.core_runtime, msg);
    if (failure_details) |details| core.api.byte_array_free(context.runtime_handle.core_runtime, details);
}

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
            .{address},
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
            .{err},
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
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to copy namespace";
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = message, .details = null });
        return null;
    };
    @memcpy(copy, parsed.value.namespace);
    return copy;
}

const describe_namespace_rpc = "DescribeNamespace";

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
    const runtime_handle = client_ptr.runtime orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: describeNamespace missing runtime handle");
        return;
    };
    if (runtime_handle.core_runtime == null) {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: runtime core handle is not initialized");
        return;
    }

    if (!runtime.beginPendingClientConnect(runtime_handle)) {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: runtime is shutting down");
        return;
    }
    defer runtime.endPendingClientConnect(runtime_handle);

    const core_client = client_ptr.core_client orelse {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: client core handle is not initialized",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: client core handle is not initialized");
        return;
    };

    const request_bytes = encodeDescribeNamespaceRequest(allocator, task.namespace) catch |err| {
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(&scratch, "temporal-bun-bridge-zig: failed to encode describeNamespace payload: {}", .{err}) catch "temporal-bun-bridge-zig: failed to encode describeNamespace payload";
        _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
        return;
    };
    defer allocator.free(request_bytes);

    var rpc_context = RpcCallContext{ .allocator = allocator, .pending_handle = pending_handle, .runtime_handle = runtime_handle };
    rpc_context.wait_group.start();

    var call_options = std.mem.zeroes(core.RpcCallOptions);
    call_options.service = @as(core.RpcService, 1); // Workflow service
    call_options.rpc = makeByteArrayRef(describe_namespace_rpc);
    call_options.req = makeByteArrayRef(request_bytes);
    call_options.retry = true;
    call_options.metadata = emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &call_options, &rpc_context, clientDescribeCallback);
    rpc_context.wait_group.wait();
}

fn connectAsyncWorker(task: *ConnectTask) void {
    const allocator = std.heap.c_allocator;
    defer allocator.destroy(task);

    const pending_handle = task.pending_handle;
    const config_copy = task.config;
    const runtime_ptr = task.runtime orelse {
        allocator.free(config_copy);
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: connectAsync received null runtime handle",
        });
        _ = pending.rejectClient(
            pending_handle,
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: connectAsync received null runtime handle",
        );
        return;
    };

    if (!temporalServerReachable(config_copy)) {
        var scratch: [192]u8 = undefined;
        const message = unreachableServerMessage(scratch[0..], config_copy);
        allocator.free(config_copy);
        errors.setStructuredError(.{ .code = grpc.unavailable, .message = message });
        _ = pending.rejectClient(pending_handle, grpc.unavailable, message);
        return;
    }

    if (runtime_ptr.core_runtime == null) {
        allocator.free(config_copy);
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime core handle is not initialized",
        });
        _ = pending.rejectClient(
            pending_handle,
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: runtime core handle is not initialized",
        );
        return;
    }

    if (!runtime.beginPendingClientConnect(runtime_ptr)) {
        allocator.free(config_copy);
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
        });
        _ = pending.rejectClient(
            pending_handle,
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: runtime is shutting down",
        );
        return;
    }
    defer runtime.endPendingClientConnect(runtime_ptr);

    var arena = StringArena.init(allocator);
    defer arena.deinit();

    const core_client = connectCoreClient(allocator, runtime_ptr, config_copy, &arena) catch {
        const message = errors.snapshot();
        allocator.free(config_copy);
        _ = pending.rejectClient(pending_handle, grpc.unavailable, message);
        return;
    };

    const client_handle = allocator.create(ClientHandle) catch |err| {
        allocator.free(config_copy);
        core.api.client_free(core_client);
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate client handle: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate client handle";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        _ = pending.rejectClient(pending_handle, grpc.resource_exhausted, message);
        return;
    };

    const id = nextClientId();
    client_handle.* = .{
        .id = id,
        .runtime = runtime_ptr,
        .config = config_copy,
        .core_client = core_client,
    };

    if (!pending.resolveClient(
        pending_handle,
        @as(?*anyopaque, @ptrCast(client_handle)),
        destroyClientFromPending,
    )) {
        errors.setStructuredError(.{
            .code = grpc.internal,
            .message = "temporal-bun-bridge-zig: failed to resolve client handle",
        });
        destroy(client_handle);
        return;
    }

    errors.setLastError(""[0..0]);
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
            .{err},
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
            .{err},
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

    if (client.core_client) |core_client_ptr| {
        core.api.client_free(core_client_ptr);
        client.core_client = null;
    }

    allocator.free(client.config);

    allocator.destroy(client);
}

pub fn describeNamespaceAsync(client_ptr: ?*ClientHandle, _payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: describeNamespace received null client");
    }

    const client = client_ptr.?;
    if (client.runtime == null) {
        return createByteArrayError(grpc.failed_precondition, "temporal-bun-bridge-zig: describeNamespace missing runtime handle");
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
            .{err},
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
            .{err},
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

    const thread = std.Thread.spawn(.{}, runSignalWorkflow, .{context}) catch |err| {
        allocator.free(copy);
        pending.free(pending_handle_ptr);
        var scratch: [128]u8 = undefined;
        const formatted = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn signal worker thread: {}",
            .{err},
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
