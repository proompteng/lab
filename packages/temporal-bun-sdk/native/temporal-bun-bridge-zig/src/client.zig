const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const byte_array = @import("byte_array.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");

const grpc = pending.GrpcStatus;
const json = std.json;
const mem = std.mem;
const ascii = std.ascii;
const fmt = std.fmt;
const c = std.c;
const ArenaAllocator = std.heap.ArenaAllocator;

pub const ClientHandle = struct {
    id: u64,
    runtime: ?*runtime.RuntimeHandle,
    config: []u8,
    core_client: ?*core.Client,
};

var next_client_id: u64 = 1;

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

const ConnectContext = struct {
    allocator: std.mem.Allocator,
    pending: *pending.PendingClient,
    client: *ClientHandle,
    runtime_handle: *runtime.RuntimeHandle,
    runtime_core: *core.Runtime,
    options: core.ClientOptions,
    tls_options: core.ClientTlsOptions,
    has_tls: bool,
    address_buf: []u8,
    client_name_buf: []u8,
    client_version_buf: []u8,
    identity_buf: []u8,
    api_key_buf: ?[]u8,
    tls_server_root_ca_buf: ?[]u8,
    tls_domain_buf: ?[]u8,
    tls_client_cert_buf: ?[]u8,
    tls_client_private_key_buf: ?[]u8,
};

fn duplicateOptionalSlice(slice: ?[]const u8) ?[]u8 {
    if (slice) |value| {
        if (value.len == 0) {
            return null;
        }
        return duplicateConfig(value);
    }
    return null;
}

fn makeByteArrayRef(bytes: []const u8) core.ByteArrayRef {
    return .{
        .data = if (bytes.len == 0) null else bytes.ptr,
        .size = bytes.len,
    };
}

fn makeOptionalByteArrayRef(bytes: ?[]const u8) core.ByteArrayRef {
    if (bytes) |value| {
        if (value.len == 0) {
            return .{ .data = null, .size = 0 };
        }
        return .{ .data = value.ptr, .size = value.len };
    }
    return .{ .data = null, .size = 0 };
}

fn getFirstString(map: *json.ObjectMap, keys: []const []const u8) ?[]const u8 {
    for (keys) |key| {
        if (map.get(key)) |value| {
            switch (value) {
                .string => |s| return s,
                else => {},
            }
        }
    }
    return null;
}

fn getObjectField(map: *json.ObjectMap, key: []const u8) ?*json.ObjectMap {
    if (map.getPtr(key)) |value_ptr| {
        switch (value_ptr.*) {
            .object => |*child| return child,
            else => {},
        }
    }
    return null;
}

fn sliceFromCoreByteArray(bytes: ?*const core.ByteArray) []const u8 {
    if (bytes == null) {
        return ""[0..0];
    }

    const array = bytes.?;
    if (array.data == null or array.size == 0) {
        return ""[0..0];
    }

    const len: usize = @intCast(array.size);
    return array.data[0..len];
}

fn mapGrpcStatusName(name: []const u8) i32 {
    if (mem.eql(u8, name, "Cancelled")) return grpc.cancelled;
    if (mem.eql(u8, name, "Unknown")) return grpc.unknown;
    if (mem.eql(u8, name, "InvalidArgument")) return grpc.invalid_argument;
    if (mem.eql(u8, name, "NotFound")) return grpc.not_found;
    if (mem.eql(u8, name, "AlreadyExists")) return grpc.already_exists;
    if (mem.eql(u8, name, "ResourceExhausted")) return grpc.resource_exhausted;
    if (mem.eql(u8, name, "FailedPrecondition")) return grpc.failed_precondition;
    if (mem.eql(u8, name, "Unimplemented")) return grpc.unimplemented;
    if (mem.eql(u8, name, "Internal")) return grpc.internal;
    if (mem.eql(u8, name, "Unavailable")) return grpc.unavailable;
    return grpc.internal;
}

fn mapGrpcStatusFromMessage(message: []const u8) i32 {
    const needle = "Status { code: ";
    if (mem.indexOf(u8, message, needle)) |start| {
        var index = start + needle.len;
        while (index < message.len and ascii.isAlphabetic(message[index])) {
            index += 1;
        }
        if (index > start + needle.len) {
            const name = message[(start + needle.len)..index];
            return mapGrpcStatusName(name);
        }
    }
    return grpc.internal;
}

fn finalizeConnectContext(context: *ConnectContext) void {
    const alloc = context.allocator;

    if (context.address_buf.len != 0) {
        alloc.free(context.address_buf);
    }
    if (context.client_name_buf.len != 0) {
        alloc.free(context.client_name_buf);
    }
    if (context.client_version_buf.len != 0) {
        alloc.free(context.client_version_buf);
    }
    if (context.identity_buf.len != 0) {
        alloc.free(context.identity_buf);
    }

    if (context.api_key_buf) |buf| {
        if (buf.len != 0) {
            alloc.free(buf);
        }
    }
    if (context.tls_server_root_ca_buf) |buf| {
        if (buf.len != 0) {
            alloc.free(buf);
        }
    }
    if (context.tls_domain_buf) |buf| {
        if (buf.len != 0) {
            alloc.free(buf);
        }
    }
    if (context.tls_client_cert_buf) |buf| {
        if (buf.len != 0) {
            alloc.free(buf);
        }
    }
    if (context.tls_client_private_key_buf) |buf| {
        if (buf.len != 0) {
            alloc.free(buf);
        }
    }

    alloc.destroy(context);
}

fn runClientConnect(context: *ConnectContext) void {
    core.api.client_connect(
        context.runtime_core,
        &context.options,
        context,
        clientConnectCallback,
    );
}

fn clientConnectCallback(
    user_data: ?*anyopaque,
    success: ?*core.Client,
    fail: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) {
        return;
    }

    const context = @as(*ConnectContext, @ptrCast(@alignCast(user_data.?)));
    defer finalizeConnectContext(context);
    defer pending.release(context.pending);
    defer runtime.endPendingClientConnect(context.runtime_handle);

    if (pending.isCancelled(context.pending)) {
        if (success) |client_ptr| {
            core.api.client_free(client_ptr);
        } else if (fail != null) {
            core.api.byte_array_free(context.runtime_core, fail);
        }
        destroy(context.client);
        return;
    }

    if (success) |client_ptr| {
        if (pending.isCancelled(context.pending)) {
            core.api.client_free(client_ptr);
            destroy(context.client);
            return;
        }

        context.client.core_client = client_ptr;
        const payload_ptr = @as(?*anyopaque, @ptrCast(@alignCast(context.client)));
        if (!pending.resolveClient(context.pending, payload_ptr, destroyClientFromPending)) {
            if (pending.isCancelled(context.pending)) {
                context.client.core_client = null;
                core.api.client_free(client_ptr);
                destroy(context.client);
                return;
            }
            context.client.core_client = null;
            core.api.client_free(client_ptr);
            destroy(context.client);
            _ = pending.rejectClient(
                context.pending,
                grpc.internal,
                "temporal-bun-bridge-zig: failed to resolve client pending handle",
            );
        }
        return;
    }

    if (pending.isCancelled(context.pending)) {
        if (fail != null) {
            core.api.byte_array_free(context.runtime_core, fail);
        }
        destroy(context.client);
        return;
    }

    const raw_message = sliceFromCoreByteArray(fail);
    const status_code = mapGrpcStatusFromMessage(raw_message);
    const message_copy = if (raw_message.len != 0) duplicateConfig(raw_message) else null;

    if (fail != null) {
        core.api.byte_array_free(context.runtime_core, fail);
    }

    destroy(context.client);

    const fallback = "temporal-bun-bridge-zig: Temporal core client connect failed";
    const message_slice = message_copy orelse fallback[0..];
    _ = pending.rejectClient(context.pending, status_code, message_slice);

    if (message_copy) |owned| {
        std.heap.c_allocator.free(owned);
    }
}

pub fn connectAsync(runtime_ptr: ?*runtime.RuntimeHandle, config_json: []const u8) ?*pending.PendingClient {
    if (runtime_ptr == null) {
        return createClientError(grpc.invalid_argument, "temporal-bun-bridge-zig: connectAsync received null runtime handle");
    }

    const runtime_handle = runtime_ptr.?;
    const core_runtime = runtime_handle.core_runtime orelse {
        return createClientError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: Temporal core runtime not initialized",
        );
    };

    if (!runtime.beginPendingClientConnect(runtime_handle)) {
        return createClientError(
            grpc.failed_precondition,
            "temporal-bun-bridge-zig: Temporal core runtime is shutting down",
        );
    }

    var release_runtime_pending = true;
    defer if (release_runtime_pending) runtime.endPendingClientConnect(runtime_handle);

    const config_copy = duplicateConfig(config_json) orelse {
        return createClientError(grpc.resource_exhausted, "temporal-bun-bridge-zig: client config allocation failed");
    };

    const allocator = std.heap.c_allocator;
    const handle = allocator.create(ClientHandle) catch |err| {
        allocator.free(config_copy);
        var scratch: [128]u8 = undefined;
        const formatted = fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate client handle: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate client handle";
        errors.setStructuredErrorJson(.{ .code = grpc.resource_exhausted, .message = formatted, .details = null });
        return createClientError(grpc.resource_exhausted, formatted);
    };

    var cleanup_handle = true;
    defer if (cleanup_handle) destroy(handle);

    const id = next_client_id;
    next_client_id += 1;

    handle.* = .{
        .id = id,
        .runtime = runtime_ptr,
        .config = config_copy,
        .core_client = null,
    };

    var pending_handle_raw: *pending.PendingHandle = undefined;
    var cleanup_pending = false;
    defer if (cleanup_pending) pending.free(pending_handle_raw);
    var cleanup_pending_worker_ref = false;
    defer if (cleanup_pending_worker_ref) pending.release(pending_handle_raw);

    pending_handle_raw = pending.createPendingInFlight() orelse {
        return createClientError(
            grpc.internal,
            "temporal-bun-bridge-zig: failed to allocate pending client handle",
        );
    };
    cleanup_pending = true;

    if (!pending.retain(pending_handle_raw)) {
        return createClientError(
            grpc.internal,
            "temporal-bun-bridge-zig: failed to retain pending client handle",
        );
    }
    cleanup_pending_worker_ref = true;

    const pending_handle = @as(*pending.PendingClient, @ptrCast(@alignCast(pending_handle_raw)));

    var arena = ArenaAllocator.init(allocator);
    defer arena.deinit();

    var parsed = json.parseFromSlice(json.Value, arena.allocator(), config_json, .{}) catch {
        return createClientError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: client config must be valid JSON",
        );
    };
    defer parsed.deinit();

    const root_object = switch (parsed.value) {
        .object => |*map| map,
        else => return createClientError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: client config must be a JSON object",
        ),
    };

    const address_slice = getFirstString(root_object, &.{"address"}) orelse {
        return createClientError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: client config requires address field",
        );
    };
    if (address_slice.len == 0) {
        return createClientError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: client config address must be a non-empty string",
        );
    }

    const namespace_slice = getFirstString(root_object, &.{"namespace"}) orelse {
        return createClientError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: client config requires namespace field",
        );
    };
    if (namespace_slice.len == 0) {
        return createClientError(
            grpc.invalid_argument,
            "temporal-bun-bridge-zig: client config namespace must be a non-empty string",
        );
    }

    const raw_client_name = getFirstString(root_object, &.{ "client_name", "clientName" });
    const client_name_source = blk: {
        if (raw_client_name) |value| {
            break :blk if (value.len != 0) value else "temporal-bun-sdk"[0..];
        }
        break :blk "temporal-bun-sdk"[0..];
    };

    const raw_client_version = getFirstString(root_object, &.{ "client_version", "clientVersion" });
    const client_version_source = blk: {
        if (raw_client_version) |value| {
            break :blk if (value.len != 0) value else "0.0.0"[0..];
        }
        break :blk "0.0.0"[0..];
    };

    const identity_source_opt = getFirstString(root_object, &.{"identity"});
    const api_key_source_opt = getFirstString(root_object, &.{ "api_key", "apiKey" });

    var tls_server_root_ca_source: ?[]const u8 = null;
    var tls_domain_source: ?[]const u8 = null;
    var tls_client_cert_source: ?[]const u8 = null;
    var tls_client_key_source: ?[]const u8 = null;

    if (getObjectField(root_object, "tls")) |tls_object| {
        tls_server_root_ca_source = getFirstString(
            tls_object,
            &.{ "server_root_ca_cert", "serverRootCACertificate" },
        );
        tls_domain_source = getFirstString(
            tls_object,
            &.{ "server_name_override", "serverNameOverride" },
        );
        tls_client_cert_source = getFirstString(
            tls_object,
            &.{ "client_cert", "clientCert" },
        );
        tls_client_key_source = getFirstString(
            tls_object,
            &.{ "client_private_key", "clientPrivateKey" },
        );
    }

    var address_buf: []u8 = ""[0..0];
    var free_address = false;
    defer if (free_address and address_buf.len != 0) allocator.free(address_buf);

    address_buf = duplicateConfig(address_slice) orelse {
        return createClientError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to duplicate client address",
        );
    };
    free_address = true;

    var client_name_buf: []u8 = ""[0..0];
    var free_client_name = false;
    defer if (free_client_name and client_name_buf.len != 0) allocator.free(client_name_buf);

    client_name_buf = duplicateConfig(client_name_source) orelse {
        return createClientError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to duplicate client name",
        );
    };
    free_client_name = true;

    var client_version_buf: []u8 = ""[0..0];
    var free_client_version = false;
    defer if (free_client_version and client_version_buf.len != 0) allocator.free(client_version_buf);

    client_version_buf = duplicateConfig(client_version_source) orelse {
        return createClientError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to duplicate client version",
        );
    };
    free_client_version = true;

    var identity_buf: []u8 = ""[0..0];
    var free_identity = false;
    defer if (free_identity and identity_buf.len != 0) allocator.free(identity_buf);

    if (identity_source_opt) |identity_slice| {
        const effective_identity = if (identity_slice.len != 0) identity_slice else "temporal-bun-sdk"[0..];
        identity_buf = duplicateConfig(effective_identity) orelse {
            return createClientError(
                grpc.resource_exhausted,
                "temporal-bun-bridge-zig: failed to duplicate client identity",
            );
        };
    } else {
        identity_buf = fmt.allocPrint(
            allocator,
            "temporal-bun-sdk-{d}",
            .{@as(u64, @intCast(c.getpid()))},
        ) catch {
            return createClientError(
                grpc.resource_exhausted,
                "temporal-bun-bridge-zig: failed to allocate default client identity",
            );
        };
    }
    free_identity = true;

    var api_key_buf: ?[]u8 = null;
    var free_api_key = false;
    defer if (free_api_key) {
        if (api_key_buf) |buf| {
            allocator.free(buf);
        }
    };

    if (duplicateOptionalSlice(api_key_source_opt)) |copy| {
        api_key_buf = copy;
        free_api_key = true;
    }

    var tls_server_root_ca_buf: ?[]u8 = null;
    var free_tls_root = false;
    defer if (free_tls_root) {
        if (tls_server_root_ca_buf) |buf| {
            allocator.free(buf);
        }
    };

    if (duplicateOptionalSlice(tls_server_root_ca_source)) |copy| {
        tls_server_root_ca_buf = copy;
        free_tls_root = true;
    }

    var tls_domain_buf: ?[]u8 = null;
    var free_tls_domain = false;
    defer if (free_tls_domain) {
        if (tls_domain_buf) |buf| {
            allocator.free(buf);
        }
    };

    if (duplicateOptionalSlice(tls_domain_source)) |copy| {
        tls_domain_buf = copy;
        free_tls_domain = true;
    }

    var tls_client_cert_buf: ?[]u8 = null;
    var free_tls_cert = false;
    defer if (free_tls_cert) {
        if (tls_client_cert_buf) |buf| {
            allocator.free(buf);
        }
    };

    if (duplicateOptionalSlice(tls_client_cert_source)) |copy| {
        tls_client_cert_buf = copy;
        free_tls_cert = true;
    }

    var tls_client_key_buf: ?[]u8 = null;
    var free_tls_key = false;
    defer if (free_tls_key) {
        if (tls_client_key_buf) |buf| {
            allocator.free(buf);
        }
    };

    if (duplicateOptionalSlice(tls_client_key_source)) |copy| {
        tls_client_key_buf = copy;
        free_tls_key = true;
    }

    var context: *ConnectContext = undefined;
    var cleanup_context = false;
    defer if (cleanup_context) finalizeConnectContext(context);

    context = allocator.create(ConnectContext) catch {
        return createClientError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to allocate client connect context",
        );
    };

    context.* = .{
        .allocator = allocator,
        .pending = pending_handle,
        .client = handle,
        .runtime_handle = runtime_handle,
        .runtime_core = core_runtime,
        .options = undefined,
        .tls_options = undefined,
        .has_tls = false,
        .address_buf = address_buf,
        .client_name_buf = client_name_buf,
        .client_version_buf = client_version_buf,
        .identity_buf = identity_buf,
        .api_key_buf = api_key_buf,
        .tls_server_root_ca_buf = tls_server_root_ca_buf,
        .tls_domain_buf = tls_domain_buf,
        .tls_client_cert_buf = tls_client_cert_buf,
        .tls_client_private_key_buf = tls_client_key_buf,
    };

    free_address = false;
    free_client_name = false;
    free_client_version = false;
    free_identity = false;
    free_api_key = false;
    free_tls_root = false;
    free_tls_domain = false;
    free_tls_cert = false;
    free_tls_key = false;

    context.options = core.ClientOptions{
        .target_url = makeByteArrayRef(context.address_buf),
        .client_name = makeByteArrayRef(context.client_name_buf),
        .client_version = makeByteArrayRef(context.client_version_buf),
        .metadata = .{ .data = null, .size = 0 },
        .api_key = makeOptionalByteArrayRef(if (context.api_key_buf) |buf| buf else null),
        .identity = makeByteArrayRef(context.identity_buf),
        .tls_options = null,
        .retry_options = null,
        .keep_alive_options = null,
        .http_connect_proxy_options = null,
        .grpc_override_callback = null,
        .grpc_override_callback_user_data = null,
    };

    const has_tls = (context.tls_server_root_ca_buf != null) or
        (context.tls_domain_buf != null) or
        (context.tls_client_cert_buf != null) or
        (context.tls_client_private_key_buf != null);

    context.has_tls = has_tls;
    if (has_tls) {
        context.tls_options = core.ClientTlsOptions{
            .server_root_ca_cert = makeOptionalByteArrayRef(if (context.tls_server_root_ca_buf) |buf| buf else null),
            .domain = makeOptionalByteArrayRef(if (context.tls_domain_buf) |buf| buf else null),
            .client_cert = makeOptionalByteArrayRef(if (context.tls_client_cert_buf) |buf| buf else null),
            .client_private_key = makeOptionalByteArrayRef(if (context.tls_client_private_key_buf) |buf| buf else null),
        };
        context.options.tls_options = &context.tls_options;
    }

    cleanup_context = true;

    const thread = std.Thread.spawn(.{}, runClientConnect, .{context}) catch |err| {
        var scratch: [128]u8 = undefined;
        const formatted = fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn client connect worker: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to spawn client connect worker";
        return createClientError(grpc.internal, formatted);
    };
    thread.detach();

    cleanup_context = false;
    cleanup_pending = false;
    cleanup_pending_worker_ref = false;
    cleanup_handle = false;
    release_runtime_pending = false;

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

    // TODO(codex, zig-cl-02): Marshal namespace describe request via Temporal core.
    _ = _payload;
    return createByteArrayError(grpc.unimplemented, "temporal-bun-bridge-zig: describeNamespace is not implemented yet");
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
