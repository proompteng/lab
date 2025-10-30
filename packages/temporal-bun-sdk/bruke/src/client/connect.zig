const std = @import("std");
const common = @import("common.zig");
const errors = @import("../errors.zig");
const runtime = @import("../runtime.zig");
const pending = @import("../pending.zig");
const core = @import("../core.zig");

const grpc = common.grpc;
const StringArena = common.StringArena;
const ClientHandle = common.ClientHandle;

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
    if (core.api.client_connect == core.stub_api.client_connect) {
        return true;
    }

    const address = extractAddress(config_json) orelse return true;
    if (address.len == 0) {
        return true;
    }

    const host_port = parseHostPort(address) orelse return true;
    const allocator = std.heap.c_allocator;
    const require_live_server = wantsLiveTemporalServer(allocator);
    const stream = std.net.tcpConnectToHost(allocator, host_port.host, host_port.port) catch {
        if (!require_live_server) {
            return true;
        }
        return false;
    };
    defer stream.close();
    return true;
}

fn unreachableServerMessage(buffer: []u8, config_json: []const u8) []const u8 {
    if (extractAddress(config_json)) |address| {
        return std.fmt.bufPrint(
            buffer,
            "temporal-bun-bridge-zig: Temporal server unreachable at {s}",
            .{address},
        ) catch "temporal-bun-bridge-zig: Temporal server unreachable";
    }

    return "temporal-bun-bridge-zig: Temporal server unreachable";
}

const ConnectError = error{ConnectFailed};

const ConnectCallbackContext = struct {
    allocator: std.mem.Allocator,
    wait_group: std.Thread.WaitGroup = .{},
    result_client: ?*core.Client = null,
    error_message: []u8 = ""[0..0],
    runtime_handle: *runtime.RuntimeHandle,
    core_runtime: ?*core.RuntimeOpaque = null,
};

fn clientConnectCallback(
    user_data: ?*anyopaque,
    success: ?*core.Client,
    fail: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*ConnectCallbackContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    const core_runtime_ptr = context.core_runtime orelse context.runtime_handle.core_runtime;

    if (success) |client_ptr| {
        context.result_client = client_ptr;
        if (fail) |fail_ptr| {
            core.api.byte_array_free(core_runtime_ptr, fail_ptr);
        }
        return;
    }

    if (fail) |fail_ptr| {
        const slice = common.byteArraySlice(fail_ptr);
        if (slice.len > 0) {
            context.error_message = context.allocator.alloc(u8, slice.len) catch {
                core.api.byte_array_free(core_runtime_ptr, fail_ptr);
                return;
            };
            @memcpy(context.error_message, slice);
        }
        core.api.byte_array_free(core_runtime_ptr, fail_ptr);
    }
}

fn extractTlsObject(config_json: []const u8) ?[]const u8 {
    var depth: i32 = 0;
    var idx: usize = 0;
    var in_string = false;
    var escape_next = false;
    var key_start: ?usize = null;

    while (idx < config_json.len) : (idx += 1) {
        const char = config_json[idx];

        if (escape_next) {
            escape_next = false;
            continue;
        }

        if (char == '\\') {
            escape_next = true;
            continue;
        }

        if (char == '"') {
            if (!in_string) {
                key_start = idx;
            } else if (key_start) |start| {
                if (depth == 1 and idx > start + 1) {
                    const key_name = config_json[start + 1 .. idx];
                    if (std.mem.eql(u8, key_name, "tls")) {
                        var match_idx = idx + 1;
                        while (match_idx < config_json.len and std.ascii.isWhitespace(config_json[match_idx])) : (match_idx += 1) {}
                        if (match_idx >= config_json.len or config_json[match_idx] != ':') {
                            key_start = null;
                            in_string = false;
                            continue;
                        }
                        match_idx += 1;

                        while (match_idx < config_json.len and std.ascii.isWhitespace(config_json[match_idx])) : (match_idx += 1) {}
                        if (match_idx >= config_json.len or config_json[match_idx] != '{') {
                            key_start = null;
                            in_string = false;
                            continue;
                        }

                        const obj_start = match_idx;
                        var obj_depth: i32 = 0;
                        var obj_in_string = false;
                        var obj_escape = false;

                        while (match_idx < config_json.len) : (match_idx += 1) {
                            const obj_char = config_json[match_idx];

                            if (obj_escape) {
                                obj_escape = false;
                                continue;
                            }

                            if (obj_char == '\\') {
                                obj_escape = true;
                                continue;
                            }

                            if (obj_char == '"') {
                                obj_in_string = !obj_in_string;
                                continue;
                            }

                            if (obj_in_string) continue;

                            if (obj_char == '{') {
                                obj_depth += 1;
                            } else if (obj_char == '}') {
                                obj_depth -= 1;
                                if (obj_depth == 0) {
                                    return config_json[obj_start .. match_idx + 1];
                                }
                            }
                        }
                    }
                }
                key_start = null;
            }
            in_string = !in_string;
            continue;
        }

        if (in_string) continue;

        if (char == '{') {
            depth += 1;
        } else if (char == '}') {
            depth -= 1;
        }
    }
    return null;
}

fn connectCoreClient(
    allocator: std.mem.Allocator,
    runtime_handle: *runtime.RuntimeHandle,
    config_json: []const u8,
    arena: *StringArena,
) ConnectError!*core.Client {
    const address = common.extractStringField(config_json, "address") orelse {
        errors.setStructuredError(.{ .code = grpc.invalid_argument, .message = "temporal-bun-bridge-zig: client config missing address" });
        return ConnectError.ConnectFailed;
    };

    const identity = common.extractOptionalStringField(config_json, &.{"identity"}) orelse common.makeDefaultIdentity(arena) catch {
        errors.setStructuredError(.{ .code = grpc.internal, .message = "temporal-bun-bridge-zig: failed to allocate client identity" });
        return ConnectError.ConnectFailed;
    };

    const client_name = common.extractOptionalStringField(config_json, &.{ "clientName", "client_name" }) orelse "temporal-bun-sdk";
    const client_version = common.extractOptionalStringField(config_json, &.{ "clientVersion", "client_version" }) orelse "zig-bridge-dev";
    const api_key = common.extractOptionalStringField(config_json, &.{ "apiKey", "api_key" });

    var tls_opts: ?core.ClientTlsOptions = null;
    if (extractTlsObject(config_json)) |tls_json| {
        const server_root_ca = common.extractOptionalStringField(tls_json, &.{ "serverRootCACertificate", "server_root_ca_cert" });
        const domain = common.extractOptionalStringField(tls_json, &.{ "serverNameOverride", "server_name_override", "domain" });
        const client_cert = common.extractOptionalStringField(tls_json, &.{"client_cert"});
        const client_key = common.extractOptionalStringField(tls_json, &.{"client_private_key"});

        if (server_root_ca != null or domain != null or (client_cert != null and client_key != null)) {
            var opts = std.mem.zeroes(core.ClientTlsOptions);
            opts.server_root_ca_cert = if (server_root_ca) |ca| common.makeByteArrayRef(ca) else common.emptyByteArrayRef();
            opts.domain = if (domain) |d| common.makeByteArrayRef(d) else common.emptyByteArrayRef();
            opts.client_cert = if (client_cert) |cert| common.makeByteArrayRef(cert) else common.emptyByteArrayRef();
            opts.client_private_key = if (client_key) |key| common.makeByteArrayRef(key) else common.emptyByteArrayRef();
            tls_opts = opts;
        }
    }

    var options = std.mem.zeroes(core.ClientOptions);
    options.target_url = common.makeByteArrayRef(address);
    options.client_name = common.makeByteArrayRef(client_name);
    options.client_version = common.makeByteArrayRef(client_version);
    options.metadata = common.emptyByteArrayRef();
    options.identity = common.makeByteArrayRef(identity);
    options.api_key = if (api_key) |key| common.makeByteArrayRef(key) else common.emptyByteArrayRef();
    options.tls_options = if (tls_opts) |*opts| opts else null;
    options.retry_options = null;
    options.keep_alive_options = null;
    options.http_connect_proxy_options = null;
    options.grpc_override_callback = null;
    options.grpc_override_callback_user_data = null;

    const retained_core_runtime = runtime.retainCoreRuntime(runtime_handle) orelse {
        errors.setStructuredError(.{ .code = grpc.failed_precondition, .message = "temporal-bun-bridge-zig: runtime is shutting down" });
        return ConnectError.ConnectFailed;
    };
    defer runtime.releaseCoreRuntime(runtime_handle);

    var context = ConnectCallbackContext{
        .allocator = allocator,
        .runtime_handle = runtime_handle,
        .core_runtime = retained_core_runtime,
    };
    context.wait_group.start();
    core.api.client_connect(retained_core_runtime, &options, &context, clientConnectCallback);
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

const ConnectTask = struct {
    runtime: ?*runtime.RuntimeHandle,
    pending_handle: *pending.PendingClient,
    config: []u8,
};

fn connectAsyncWorker(task: *ConnectTask) void {
    const allocator = std.heap.c_allocator;
    defer allocator.destroy(task);

    const pending_handle = task.pending_handle;
    defer pending.release(pending_handle);
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

    const id = common.nextClientId();
    client_handle.* = .{
        .id = id,
        .runtime = runtime_ptr,
        .config = config_copy,
        .core_client = core_client,
    };

    if (!pending.resolveClient(
        pending_handle,
        @as(?*anyopaque, @ptrCast(client_handle)),
        common.destroyClientFromPending,
    )) {
        errors.setStructuredError(.{
            .code = grpc.internal,
            .message = "temporal-bun-bridge-zig: failed to resolve client handle",
        });
        common.destroy(client_handle);
        return;
    }

    errors.setLastError(""[0..0]);
}

pub fn connectAsync(runtime_ptr: ?*runtime.RuntimeHandle, config_json: []const u8) ?*pending.PendingClient {
    if (runtime_ptr == null) {
        return common.createClientError(grpc.invalid_argument, "temporal-bun-bridge-zig: connectAsync received null runtime handle");
    }

    const config_copy = common.duplicateConfig(config_json) orelse {
        return common.createClientError(grpc.resource_exhausted, "temporal-bun-bridge-zig: client config allocation failed");
    };

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        std.heap.c_allocator.free(config_copy);
        return common.createClientError(
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

    if (!pending.retain(pending_handle_ptr)) {
        allocator.free(config_copy);
        allocator.destroy(task);
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to retain pending client handle",
        });
        _ = pending.rejectClient(
            pending_handle,
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to retain pending client handle",
        );
        return @as(?*pending.PendingClient, pending_handle);
    }

    const thread = std.Thread.spawn(.{}, connectAsyncWorker, .{task}) catch |err| {
        allocator.free(config_copy);
        allocator.destroy(task);
        pending.release(pending_handle_ptr);
        pending.free(pending_handle_ptr);
        var scratch: [128]u8 = undefined;
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
