const std = @import("std");
const errors = @import("../errors.zig");
const runtime = @import("../runtime.zig");
const byte_array = @import("../byte_array.zig");
const pending = @import("../pending.zig");
const core = @import("../core.zig");

pub const grpc = pending.GrpcStatus;
pub const ArrayListManaged = std.array_list.Managed;

pub const ClientHandle = struct {
    id: u64,
    runtime: ?*runtime.RuntimeHandle,
    config: []u8,
    core_client: ?*core.ClientOpaque,
};

var next_client_id: u64 = 1;
var next_client_id_mutex = std.Thread.Mutex{};

pub fn nextClientId() u64 {
    next_client_id_mutex.lock();
    defer next_client_id_mutex.unlock();
    const id = next_client_id;
    next_client_id += 1;
    return id;
}

pub const StringArena = struct {
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

pub fn makeByteArrayRef(slice: []const u8) core.ByteArrayRef {
    return .{ .data = slice.ptr, .size = slice.len };
}

pub fn emptyByteArrayRef() core.ByteArrayRef {
    return .{ .data = null, .size = 0 };
}

pub fn byteArraySlice(bytes_ptr: ?*const core.ByteArray) []const u8 {
    if (bytes_ptr == null) return ""[0..0];
    const bytes = bytes_ptr.?;
    if (bytes.data == null or bytes.size == 0) return ""[0..0];
    return bytes.data[0..bytes.size];
}

pub fn makeDefaultIdentity(arena: *StringArena) ![]const u8 {
    const pid = std.c.getpid();
    const pid_u64 = @as(u64, @intCast(pid));
    var buffer: [64]u8 = undefined;
    const written = try std.fmt.bufPrint(&buffer, "temporal-bun-sdk-{d}", .{pid_u64});
    return arena.dup(written);
}

pub fn extractStringField(config_json: []const u8, key: []const u8) ?[]const u8 {
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
                    if (std.mem.eql(u8, key_name, key)) {
                        var match_idx = idx + 1;
                        while (match_idx < config_json.len and std.ascii.isWhitespace(config_json[match_idx])) : (match_idx += 1) {}
                        if (match_idx >= config_json.len or config_json[match_idx] != ':') {
                            key_start = null;
                            in_string = false;
                            continue;
                        }
                        match_idx += 1;

                        while (match_idx < config_json.len and std.ascii.isWhitespace(config_json[match_idx])) : (match_idx += 1) {}
                        if (match_idx >= config_json.len or config_json[match_idx] != '"') {
                            key_start = null;
                            in_string = false;
                            continue;
                        }
                        match_idx += 1;

                        const value_start = match_idx;
                        var value_escape = false;
                        while (match_idx < config_json.len) : (match_idx += 1) {
                            const value_char = config_json[match_idx];
                            if (value_escape) {
                                value_escape = false;
                                continue;
                            }
                            if (value_char == '\\') {
                                value_escape = true;
                                continue;
                            }
                            if (value_char == '"') {
                                return config_json[value_start..match_idx];
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

pub fn extractOptionalStringField(config_json: []const u8, aliases: []const []const u8) ?[]const u8 {
    for (aliases) |alias| {
        if (extractStringField(config_json, alias)) |value| {
            return value;
        }
    }
    return null;
}

pub fn extractBoolField(config_json: []const u8, key: []const u8) ?bool {
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

pub fn duplicateSlice(allocator: std.mem.Allocator, slice: []const u8) ![]u8 {
    if (slice.len == 0) return ""[0..0];
    const copy = try allocator.alloc(u8, slice.len);
    @memcpy(copy, slice);
    return copy;
}

pub fn duplicateConfig(config_json: []const u8) ?[]u8 {
    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, config_json.len) catch {
        return null;
    };
    @memcpy(copy, config_json);
    return copy;
}

pub fn destroy(handle: ?*ClientHandle) void {
    if (handle == null) return;

    var allocator = std.heap.c_allocator;
    const client = handle.?;

    if (client.runtime) |runtime_handle| {
        runtime.unregisterClient(runtime_handle);
        client.runtime = null;
    }

    if (client.core_client) |core_client_ptr| {
        core.api.client_free(core_client_ptr);
        client.core_client = null;
    }

    allocator.free(client.config);
    allocator.destroy(client);
}

pub fn destroyClientFromPending(ptr: ?*anyopaque) void {
    const handle: ?*ClientHandle = if (ptr) |nonNull|
        @as(?*ClientHandle, @ptrCast(@alignCast(nonNull)))
    else
        null;
    destroy(handle);
}

pub fn createClientError(code: i32, message: []const u8) ?*pending.PendingClient {
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

pub fn createByteArrayError(code: i32, message: []const u8) ?*pending.PendingByteArray {
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
