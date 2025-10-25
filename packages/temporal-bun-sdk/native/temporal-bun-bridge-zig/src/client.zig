const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const byte_array = @import("byte_array.zig");
const pending = @import("pending.zig");
const core = @import("core.zig");

const grpc = pending.GrpcStatus;
const ArrayListManaged = std.array_list.Managed;

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

const ProtoDecodeError = error{
    UnexpectedEof,
    UnsupportedWireType,
    Overflow,
};

fn writeVarint(buffer: *ArrayListManaged(u8), value: u64) !void {
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

fn writeTag(buffer: *ArrayListManaged(u8), field_number: u32, wire_type: u3) !void {
    const key = (@as(u64, field_number) << 3) | wire_type;
    try writeVarint(buffer, key);
}

fn appendLengthDelimited(buffer: *ArrayListManaged(u8), field_number: u32, bytes: []const u8) !void {
    try writeTag(buffer, field_number, 2);
    try writeVarint(buffer, bytes.len);
    try buffer.appendSlice(bytes);
}

fn appendString(buffer: *ArrayListManaged(u8), field_number: u32, value: []const u8) !void {
    try appendLengthDelimited(buffer, field_number, value);
}

fn appendBytes(buffer: *ArrayListManaged(u8), field_number: u32, value: []const u8) !void {
    try appendLengthDelimited(buffer, field_number, value);
}

fn appendVarint(buffer: *ArrayListManaged(u8), field_number: u32, value: u64) !void {
    try writeTag(buffer, field_number, 0);
    try writeVarint(buffer, value);
}

fn appendBool(buffer: *ArrayListManaged(u8), field_number: u32, value: bool) !void {
    try appendVarint(buffer, field_number, if (value) 1 else 0);
}

fn appendDouble(buffer: *ArrayListManaged(u8), field_number: u32, value: f64) !void {
    try writeTag(buffer, field_number, 1);
    var storage: [8]u8 = undefined;
    const bits: u64 = @bitCast(value);
    std.mem.writeInt(u64, storage[0..], bits, .little);
    try buffer.appendSlice(&storage);
}

fn duplicateSlice(allocator: std.mem.Allocator, slice: []const u8) ![]u8 {
    if (slice.len == 0) return ""[0..0];
    const copy = try allocator.alloc(u8, slice.len);
    @memcpy(copy, slice);
    return copy;
}

fn encodeDurationMillis(allocator: std.mem.Allocator, millis: u64) ![]u8 {
    var buf = ArrayListManaged(u8).init(allocator);
    defer buf.deinit();

    const seconds: u64 = millis / 1_000;
    const nanos: u32 = @intCast((millis % 1_000) * 1_000_000);

    if (seconds != 0) {
        try appendVarint(&buf, 1, seconds);
    }
    if (nanos != 0) {
        try appendVarint(&buf, 2, nanos);
    }

    return buf.toOwnedSlice();
}

fn encodeMetadataEntry(allocator: std.mem.Allocator, key: []const u8, value: []const u8) ![]u8 {
    var entry = ArrayListManaged(u8).init(allocator);
    defer entry.deinit();

    try appendString(&entry, 1, key);
    try appendBytes(&entry, 2, value);

    return entry.toOwnedSlice();
}

fn encodeJsonPayload(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    const json_bytes = try std.json.Stringify.valueAlloc(allocator, value, .{});
    defer allocator.free(json_bytes);

    var payload = ArrayListManaged(u8).init(allocator);
    defer payload.deinit();

    const metadata_entry = try encodeMetadataEntry(allocator, "encoding", "json/plain");
    defer allocator.free(metadata_entry);
    try appendLengthDelimited(&payload, 1, metadata_entry);
    try appendBytes(&payload, 2, json_bytes);

    return payload.toOwnedSlice();
}

fn encodePayloadsFromArray(allocator: std.mem.Allocator, array: *std.json.Array) !?[]u8 {
    if (array.items.len == 0) return null;

    var payloads = ArrayListManaged(u8).init(allocator);
    defer payloads.deinit();

    for (array.items) |item| {
        const payload_bytes = try encodeJsonPayload(allocator, item);
        defer allocator.free(payload_bytes);
        try appendLengthDelimited(&payloads, 1, payload_bytes);
    }

    const owned = try payloads.toOwnedSlice();
    const result: ?[]u8 = owned;
    return result;
}

fn encodePayloadMap(allocator: std.mem.Allocator, map: *std.json.ObjectMap) !?[]u8 {
    if (map.count() == 0) return null;

    var encoded = ArrayListManaged(u8).init(allocator);
    defer encoded.deinit();

    var cursor = map.iterator();
    while (cursor.next()) |entry| {
        const payload_bytes = try encodeJsonPayload(allocator, entry.value_ptr.*);
        defer allocator.free(payload_bytes);

        var field_entry = ArrayListManaged(u8).init(allocator);
        defer field_entry.deinit();
        try appendString(&field_entry, 1, entry.key_ptr.*);
        try appendLengthDelimited(&field_entry, 2, payload_bytes);
        const field_bytes = try field_entry.toOwnedSlice();
        defer allocator.free(field_bytes);
        try appendLengthDelimited(&encoded, 1, field_bytes);
    }

    const owned = try encoded.toOwnedSlice();
    const result: ?[]u8 = owned;
    return result;
}

fn jsonValueToU64(value: std.json.Value) !u64 {
    return switch (value) {
        .integer => |int| blk: {
            if (int < 0) return error.InvalidNumber;
            const converted: u64 = @intCast(int);
            break :blk converted;
        },
        .float => error.InvalidNumber,
        .number_string => |digits| blk: {
            const parsed = std.fmt.parseInt(u64, digits, 10) catch return error.InvalidNumber;
            break :blk parsed;
        },
        else => error.InvalidNumber,
    };
}

fn jsonValueToF64(value: std.json.Value) !f64 {
    return switch (value) {
        .float => |flt| blk: {
            if (!std.math.isFinite(flt)) return error.InvalidNumber;
            break :blk flt;
        },
        .integer => |int| blk: {
            const converted: f64 = @floatFromInt(int);
            break :blk converted;
        },
        .number_string => |digits| blk: {
            const parsed = std.fmt.parseFloat(f64, digits) catch return error.InvalidNumber;
            if (!std.math.isFinite(parsed)) return error.InvalidNumber;
            break :blk parsed;
        },
        else => error.InvalidNumber,
    };
}

fn encodeRetryPolicyFromObject(allocator: std.mem.Allocator, map: *std.json.ObjectMap) !?[]u8 {
    var payload = ArrayListManaged(u8).init(allocator);
    defer payload.deinit();

    if (map.getPtr("initial_interval_ms")) |value_ptr| {
        const millis = try jsonValueToU64(value_ptr.*);
        const duration = try encodeDurationMillis(allocator, millis);
        defer allocator.free(duration);
        try appendLengthDelimited(&payload, 1, duration);
    }

    if (map.getPtr("backoff_coefficient")) |value_ptr| {
        const coeff = try jsonValueToF64(value_ptr.*);
        try appendDouble(&payload, 2, coeff);
    }

    if (map.getPtr("maximum_interval_ms")) |value_ptr| {
        const millis = try jsonValueToU64(value_ptr.*);
        const duration = try encodeDurationMillis(allocator, millis);
        defer allocator.free(duration);
        try appendLengthDelimited(&payload, 3, duration);
    }

    if (map.getPtr("maximum_attempts")) |value_ptr| {
        const attempts = try jsonValueToU64(value_ptr.*);
        try appendVarint(&payload, 4, attempts);
    }

    if (map.getPtr("non_retryable_error_types")) |value_ptr| {
        if (value_ptr.* != .array) return error.InvalidRetryPolicy;
        for (value_ptr.*.array.items) |entry| {
            const str = switch (entry) {
                .string => |s| s,
                else => return error.InvalidRetryPolicy,
            };
            try appendString(&payload, 5, str);
        }
    }

    if (payload.items.len == 0) return null;
    const owned = try payload.toOwnedSlice();
    const result: ?[]u8 = owned;
    return result;
}

fn generateRequestId(allocator: std.mem.Allocator) ![]u8 {
    var random_bytes: [16]u8 = undefined;
    std.crypto.random.bytes(&random_bytes);
    random_bytes[6] = (random_bytes[6] & 0x0F) | 0x40;
    random_bytes[8] = (random_bytes[8] & 0x3F) | 0x80;

    var scratch: [36]u8 = undefined;
    const hex = std.fmt.bytesToHex(random_bytes, .lower);
    const formatted = try std.fmt.bufPrint(&scratch, "{s}-{s}-{s}-{s}-{s}", .{
        hex[0..8],
        hex[8..12],
        hex[12..16],
        hex[16..20],
        hex[20..32],
    });

    const copy = try allocator.alloc(u8, formatted.len);
    @memcpy(copy, formatted);
    return copy;
}

const StartWorkflowRequestParts = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    workflow_type: []const u8,
    task_queue: []const u8,
    identity: []const u8,
    request_id: []const u8,
    cron_schedule: ?[]const u8 = null,
    workflow_execution_timeout_ms: ?u64 = null,
    workflow_run_timeout_ms: ?u64 = null,
    workflow_task_timeout_ms: ?u64 = null,
    args: ?*std.json.Array = null,
    memo: ?*std.json.ObjectMap = null,
    search_attributes: ?*std.json.ObjectMap = null,
    headers: ?*std.json.ObjectMap = null,
    retry_policy: ?*std.json.ObjectMap = null,
};

fn encodeStartWorkflowRequest(allocator: std.mem.Allocator, params: StartWorkflowRequestParts) ![]u8 {
    var request = ArrayListManaged(u8).init(allocator);
    defer request.deinit();

    try appendString(&request, 1, params.namespace);
    try appendString(&request, 2, params.workflow_id);

    var workflow_type_buf = ArrayListManaged(u8).init(allocator);
    defer workflow_type_buf.deinit();
    try appendString(&workflow_type_buf, 1, params.workflow_type);
    const workflow_type_bytes = try workflow_type_buf.toOwnedSlice();
    defer allocator.free(workflow_type_bytes);
    try appendLengthDelimited(&request, 3, workflow_type_bytes);

    var task_queue_buf = ArrayListManaged(u8).init(allocator);
    defer task_queue_buf.deinit();
    try appendString(&task_queue_buf, 1, params.task_queue);
    try appendVarint(&task_queue_buf, 2, 1); // TaskQueueKind::Normal
    const task_queue_bytes = try task_queue_buf.toOwnedSlice();
    defer allocator.free(task_queue_bytes);
    try appendLengthDelimited(&request, 4, task_queue_bytes);

    if (params.args) |array_ptr| {
        if (try encodePayloadsFromArray(allocator, array_ptr)) |payload_bytes| {
            defer allocator.free(payload_bytes);
            try appendLengthDelimited(&request, 5, payload_bytes);
        }
    }

    if (params.workflow_execution_timeout_ms) |millis| {
        const duration = try encodeDurationMillis(allocator, millis);
        defer allocator.free(duration);
        try appendLengthDelimited(&request, 6, duration);
    }

    if (params.workflow_run_timeout_ms) |millis| {
        const duration = try encodeDurationMillis(allocator, millis);
        defer allocator.free(duration);
        try appendLengthDelimited(&request, 7, duration);
    }

    if (params.workflow_task_timeout_ms) |millis| {
        const duration = try encodeDurationMillis(allocator, millis);
        defer allocator.free(duration);
        try appendLengthDelimited(&request, 8, duration);
    }

    try appendString(&request, 9, params.identity);
    try appendString(&request, 10, params.request_id);

    if (params.retry_policy) |policy_map| {
        if (try encodeRetryPolicyFromObject(allocator, policy_map)) |encoded_retry| {
            defer allocator.free(encoded_retry);
            try appendLengthDelimited(&request, 12, encoded_retry);
        }
    }

    if (params.cron_schedule) |schedule| {
        if (schedule.len != 0) {
            try appendString(&request, 13, schedule);
        }
    }

    if (params.memo) |memo_map| {
        if (try encodePayloadMap(allocator, memo_map)) |memo_bytes| {
            defer allocator.free(memo_bytes);
            try appendLengthDelimited(&request, 14, memo_bytes);
        }
    }

    if (params.search_attributes) |search_map| {
        if (try encodePayloadMap(allocator, search_map)) |search_bytes| {
            defer allocator.free(search_bytes);
            try appendLengthDelimited(&request, 15, search_bytes);
        }
    }

    if (params.headers) |header_map| {
        if (try encodePayloadMap(allocator, header_map)) |header_bytes| {
            defer allocator.free(header_bytes);
            try appendLengthDelimited(&request, 16, header_bytes);
        }
    }

    return request.toOwnedSlice();
}

const QueryWorkflowRequestParts = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    run_id: ?[]const u8 = null,
    first_execution_run_id: ?[]const u8 = null,
    query_name: []const u8,
    args: ?*std.json.Array = null,
};

fn encodeWorkflowExecution(
    allocator: std.mem.Allocator,
    workflow_id: []const u8,
    run_id: ?[]const u8,
) ![]u8 {
    var execution = ArrayListManaged(u8).init(allocator);
    defer execution.deinit();

    try appendString(&execution, 1, workflow_id);
    if (run_id) |value| {
        if (value.len != 0) {
            try appendString(&execution, 2, value);
        }
    }

    return execution.toOwnedSlice();
}

fn encodeWorkflowQuery(
    allocator: std.mem.Allocator,
    params: QueryWorkflowRequestParts,
) ![]u8 {
    var query = ArrayListManaged(u8).init(allocator);
    defer query.deinit();

    try appendString(&query, 1, params.query_name);

    if (params.args) |array_ptr| {
        if (try encodePayloadsFromArray(allocator, array_ptr)) |payloads| {
            defer allocator.free(payloads);
            try appendLengthDelimited(&query, 2, payloads);
        }
    }

    return query.toOwnedSlice();
}

fn encodeQueryWorkflowRequest(allocator: std.mem.Allocator, params: QueryWorkflowRequestParts) ![]u8 {
    var request = ArrayListManaged(u8).init(allocator);
    defer request.deinit();

    try appendString(&request, 1, params.namespace);

    const execution_bytes = try encodeWorkflowExecution(
        allocator,
        params.workflow_id,
        params.run_id,
    );
    defer allocator.free(execution_bytes);
    try appendLengthDelimited(&request, 2, execution_bytes);

    // first_execution_run_id is a top-level field on QueryWorkflowRequest (field 5)
    if (params.first_execution_run_id) |value| {
        if (value.len != 0) {
            try appendString(&request, 5, value);
        }
    }

    const query_bytes = try encodeWorkflowQuery(allocator, params);
    defer allocator.free(query_bytes);
    try appendLengthDelimited(&request, 3, query_bytes);

    return request.toOwnedSlice();
}

const TerminateWorkflowRequestParts = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    run_id: ?[]const u8 = null,
    first_execution_run_id: ?[]const u8 = null,
    reason: ?[]const u8 = null,
    details: ?*std.json.Array = null,
    identity: ?[]const u8 = null,
};

fn encodeTerminateWorkflowRequest(allocator: std.mem.Allocator, params: TerminateWorkflowRequestParts) ![]u8 {
    var request = ArrayListManaged(u8).init(allocator);
    defer request.deinit();

    try appendString(&request, 1, params.namespace);

    const execution_bytes = try encodeWorkflowExecution(allocator, params.workflow_id, params.run_id);
    defer allocator.free(execution_bytes);
    try appendLengthDelimited(&request, 2, execution_bytes);

    if (params.reason) |reason_slice| {
        try appendString(&request, 3, reason_slice);
    }

    if (params.details) |details_array| {
        if (try encodePayloadsFromArray(allocator, details_array)) |payload_bytes| {
            defer allocator.free(payload_bytes);
            try appendLengthDelimited(&request, 4, payload_bytes);
        }
    }

    if (params.identity) |identity_slice| {
        if (identity_slice.len != 0) {
            try appendString(&request, 5, identity_slice);
        }
    }

    if (params.first_execution_run_id) |first_slice| {
        if (first_slice.len != 0) {
            try appendString(&request, 6, first_slice);
        }
    }

    return request.toOwnedSlice();
}

fn readVarint(buffer: []const u8, index: *usize) ProtoDecodeError!u64 {
    var result: u64 = 0;
    var shift: u6 = 0;
    while (true) {
        if (index.* >= buffer.len) return error.UnexpectedEof;
        const byte = buffer[index.*];
        index.* += 1;
        const bits = @as(u64, byte & 0x7F) << shift;
        result |= bits;
        if ((byte & 0x80) == 0) break;
        shift += 7;
        if (shift >= 64) return error.Overflow;
    }
    return result;
}

fn skipField(buffer: []const u8, index: *usize, wire_type: u3) ProtoDecodeError!void {
    switch (wire_type) {
        0 => {
            _ = try readVarint(buffer, index);
        },
        1 => {
            if (buffer.len - index.* < 8) return error.UnexpectedEof;
            index.* += 8;
        },
        2 => {
            const length = try readVarint(buffer, index);
            if (buffer.len - index.* < length) return error.UnexpectedEof;
            const len_usize: usize = @intCast(length);
            index.* += len_usize;
        },
        5 => {
            if (buffer.len - index.* < 4) return error.UnexpectedEof;
            index.* += 4;
        },
        else => return error.UnsupportedWireType,
    }
}

fn parseStartWorkflowRunId(buffer: []const u8) ProtoDecodeError![]const u8 {
    var index: usize = 0;
    while (index < buffer.len) {
        const key = try readVarint(buffer, &index);
        const field_number: u32 = @intCast(key >> 3);
        const wire_type: u3 = @intCast(key & 0x07);

        if (field_number == 1 and wire_type == 2) {
            const length = try readVarint(buffer, &index);
            if (buffer.len - index < length) return error.UnexpectedEof;
            const start = index;
            const len_usize: usize = @intCast(length);
            const end = index + len_usize;
            index = end;
            return buffer[start..end];
        }

        try skipField(buffer, &index, wire_type);
    }

    return ""[0..0];
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

    var tls_opts: ?core.ClientTlsOptions = null;
    if (extractTlsObject(config_json)) |tls_json| {
        const server_root_ca = extractOptionalStringField(tls_json, &.{ "serverRootCACertificate", "server_root_ca_cert" });
        const domain = extractOptionalStringField(tls_json, &.{ "serverNameOverride", "server_name_override", "domain" });
        const client_cert = extractOptionalStringField(tls_json, &.{"client_cert"});
        const client_key = extractOptionalStringField(tls_json, &.{"client_private_key"});

        if (server_root_ca != null or domain != null or (client_cert != null and client_key != null)) {
            var opts = std.mem.zeroes(core.ClientTlsOptions);
            opts.server_root_ca_cert = if (server_root_ca) |ca| makeByteArrayRef(ca) else emptyByteArrayRef();
            opts.domain = if (domain) |d| makeByteArrayRef(d) else emptyByteArrayRef();
            opts.client_cert = if (client_cert) |cert| makeByteArrayRef(cert) else emptyByteArrayRef();
            opts.client_private_key = if (client_key) |key| makeByteArrayRef(key) else emptyByteArrayRef();
            tls_opts = opts;
        }
    }

    var options = std.mem.zeroes(core.ClientOptions);
    options.target_url = makeByteArrayRef(address);
    options.client_name = makeByteArrayRef(client_name);
    options.client_version = makeByteArrayRef(client_version);
    options.metadata = emptyByteArrayRef();
    options.identity = makeByteArrayRef(identity);
    options.api_key = if (api_key) |key| makeByteArrayRef(key) else emptyByteArrayRef();
    options.tls_options = if (tls_opts) |*opts| opts else null;
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

    const code: i32 = if (status_code == 0) grpc.internal else @as(i32, @intCast(status_code));
    const message_slice = if (failure_message) |msg| byteArraySlice(msg) else "temporal-bun-bridge-zig: describeNamespace failed"[0..];
    _ = pending.rejectByteArray(context.pending_handle, code, message_slice);
    errors.setStructuredError(.{ .code = code, .message = message_slice });
    if (success) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    if (failure_message) |msg| core.api.byte_array_free(context.runtime_handle.core_runtime, msg);
    if (failure_details) |details| core.api.byte_array_free(context.runtime_handle.core_runtime, details);
}

const StartWorkflowRpcContext = struct {
    allocator: std.mem.Allocator,
    wait_group: std.Thread.WaitGroup = .{},
    runtime_handle: *runtime.RuntimeHandle,
    response: []u8 = ""[0..0],
    error_message_owned: bool = false,
    error_message: []const u8 = ""[0..0],
    success: bool = false,
    error_code: i32 = grpc.internal,
};

fn freeContextSlice(ctx: *StartWorkflowRpcContext, slice: []const u8) void {
    if (slice.len > 0) {
        ctx.allocator.free(@constCast(slice));
    }
}

fn clientStartWorkflowCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
    failure_details: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*StartWorkflowRpcContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    defer {
        if (failure_message) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
        if (failure_details) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    }

    if (success != null and status_code == 0) {
        const slice = byteArraySlice(success.?);

        if (slice.len == 0) {
            if (success) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
            context.error_code = grpc.internal;
            if (context.error_message_owned) {
                freeContextSlice(context, context.error_message);
                context.error_message_owned = false;
            }
            context.error_message = "temporal-bun-bridge-zig: startWorkflow returned empty response";
            context.success = false;
            return;
        }

        const copy = context.allocator.alloc(u8, slice.len) catch {
            if (success) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
            context.error_code = grpc.resource_exhausted;
            if (context.error_message_owned) {
                freeContextSlice(context, context.error_message);
                context.error_message_owned = false;
            }
            context.error_message = "temporal-bun-bridge-zig: failed to allocate startWorkflow response";
            context.success = false;
            return;
        };

        @memcpy(copy, slice);
        if (success) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
        freeContextSlice(context, context.response);
        context.response = copy;
        context.success = true;
        context.error_code = grpc.ok;
        if (context.error_message_owned) {
            freeContextSlice(context, context.error_message);
            context.error_message_owned = false;
        }
        context.error_message = ""[0..0];
        return;
    }

    if (success) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    const code: i32 = if (status_code == 0) grpc.internal else @as(i32, @intCast(status_code));
    context.error_code = code;

    if (context.error_message_owned) {
        freeContextSlice(context, context.error_message);
        context.error_message_owned = false;
    }

    const message_slice = if (failure_message) |ptr| byteArraySlice(ptr) else "temporal-bun-bridge-zig: startWorkflow failed"[0..];
    if (message_slice.len == 0) {
        context.error_message = ""[0..0];
    } else {
        const copy = context.allocator.alloc(u8, message_slice.len) catch {
            context.error_message = "temporal-bun-bridge-zig: failed to duplicate startWorkflow error";
            context.error_message_owned = false;
            context.success = false;
            context.error_code = code;
            return;
        };
        @memcpy(copy, message_slice);
        context.error_message = copy;
        context.error_message_owned = true;
    }
    context.success = false;
}

const terminate_workflow_failure_default = "temporal-bun-bridge-zig: terminateWorkflow failed";

const TerminateWorkflowRpcContext = struct {
    allocator: std.mem.Allocator,
    wait_group: std.Thread.WaitGroup = .{},
    runtime_handle: *runtime.RuntimeHandle,
    error_message_owned: bool = false,
    error_message: []const u8 = ""[0..0],
    success: bool = false,
    error_code: i32 = grpc.internal,
};

fn releaseTerminateMessage(context: *TerminateWorkflowRpcContext) void {
    if (context.error_message_owned and context.error_message.len > 0) {
        context.allocator.free(@constCast(context.error_message));
        context.error_message_owned = false;
    }
    if (!context.error_message_owned) {
        context.error_message = ""[0..0];
    }
}

fn clientTerminateWorkflowCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
    failure_details: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*TerminateWorkflowRpcContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    defer {
        if (failure_details) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    }

    if (success) |ptr| {
        core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    }

    if (status_code == 0) {
        releaseTerminateMessage(context);
        context.success = true;
        context.error_code = 0;
        context.error_message = ""[0..0];
        if (failure_message) |ptr| {
            core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
        }
        return;
    }

    const code: i32 = @intCast(status_code);

    var message_slice: []const u8 = terminate_workflow_failure_default;
    var owned_copy: ?[]u8 = null;

    if (failure_message) |ptr| {
        const slice = byteArraySlice(ptr);
        if (slice.len != 0) {
            owned_copy = context.allocator.alloc(u8, slice.len) catch null;
            if (owned_copy) |copy| {
                @memcpy(copy, slice);
                message_slice = copy;
            }
        }
        core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    }

    releaseTerminateMessage(context);

    if (owned_copy) |copy| {
        context.error_message = copy;
        context.error_message_owned = true;
    } else {
        context.error_message = message_slice;
        context.error_message_owned = false;
    }

    context.success = false;
    context.error_code = code;
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

const QueryWorkflowTask = struct {
    client: ?*ClientHandle,
    pending_handle: *pending.PendingByteArray,
    payload: []u8,
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
const start_workflow_rpc = "StartWorkflowExecution";
const query_workflow_rpc = "QueryWorkflow";
const terminate_workflow_rpc = "TerminateWorkflowExecution";

fn describeNamespaceWorker(task: *DescribeNamespaceTask) void {
    const allocator = std.heap.c_allocator;
    defer {
        allocator.free(task.namespace);
        allocator.destroy(task);
    }

    const pending_handle = task.pending_handle;
    defer pending.release(pending_handle);
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

const QueryWorkflowRpcContext = struct {
    allocator: std.mem.Allocator,
    pending_handle: *pending.PendingByteArray,
    runtime_handle: *runtime.RuntimeHandle,
    wait_group: std.Thread.WaitGroup = .{},
};

fn clientQueryWorkflowCallback(
    user_data: ?*anyopaque,
    success: ?*const core.ByteArray,
    status_code: u32,
    failure_message: ?*const core.ByteArray,
    failure_details: ?*const core.ByteArray,
) callconv(.c) void {
    if (user_data == null) return;
    const context = @as(*QueryWorkflowRpcContext, @ptrCast(@alignCast(user_data.?)));
    defer context.wait_group.finish();

    defer {
        if (failure_message) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
        if (failure_details) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);
    }

    if (success != null and status_code == 0) {
        const slice = byteArraySlice(success.?);

        if (slice.len == 0) {
            core.api.byte_array_free(context.runtime_handle.core_runtime, success.?);
            _ = pending.rejectByteArray(
                context.pending_handle,
                grpc.internal,
                "temporal-bun-bridge-zig: queryWorkflow returned empty payload",
            );
            errors.setStructuredError(.{
                .code = grpc.internal,
                .message = "temporal-bun-bridge-zig: queryWorkflow returned empty payload",
            });
            return;
        }

        const array_ptr = byte_array.allocate(.{ .slice = slice }) orelse {
            core.api.byte_array_free(context.runtime_handle.core_runtime, success.?);
            _ = pending.rejectByteArray(
                context.pending_handle,
                grpc.resource_exhausted,
                "temporal-bun-bridge-zig: failed to allocate queryWorkflow response",
            );
            errors.setStructuredError(.{
                .code = grpc.resource_exhausted,
                .message = "temporal-bun-bridge-zig: failed to allocate queryWorkflow response",
            });
            return;
        };

        core.api.byte_array_free(context.runtime_handle.core_runtime, success.?);

        if (!pending.resolveByteArray(context.pending_handle, array_ptr)) {
            byte_array.free(array_ptr);
            errors.setStructuredError(.{
                .code = grpc.internal,
                .message = "temporal-bun-bridge-zig: failed to resolve queryWorkflow handle",
            });
            _ = pending.rejectByteArray(
                context.pending_handle,
                grpc.internal,
                "temporal-bun-bridge-zig: failed to resolve queryWorkflow handle",
            );
            return;
        }

        errors.setLastError(""[0..0]);
        return;
    }

    if (success) |ptr| core.api.byte_array_free(context.runtime_handle.core_runtime, ptr);

    const code: i32 = if (status_code == 0) grpc.internal else @as(i32, @intCast(status_code));
    const message_slice = if (failure_message) |ptr| byteArraySlice(ptr) else "temporal-bun-bridge-zig: queryWorkflow failed"[0..];

    _ = pending.rejectByteArray(context.pending_handle, code, message_slice);
    errors.setStructuredError(.{ .code = code, .message = message_slice });
}

fn queryWorkflowWorker(task: *QueryWorkflowTask) void {
    const allocator = std.heap.c_allocator;
    defer {
        allocator.free(task.payload);
        allocator.destroy(task);
    }

    const pending_handle = task.pending_handle;
    defer pending.release(pending_handle);

    const client_ptr = task.client orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.internal, "temporal-bun-bridge-zig: queryWorkflow worker missing client");
        return;
    };

    const runtime_handle = client_ptr.runtime orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: queryWorkflow missing runtime handle");
        return;
    };

    if (runtime_handle.core_runtime == null) {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: runtime core handle is not initialized");
        return;
    }

    const core_client = client_ptr.core_client orelse {
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: client core handle is not initialized");
        return;
    };

    if (!runtime.beginPendingClientConnect(runtime_handle)) {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.failed_precondition, "temporal-bun-bridge-zig: runtime is shutting down");
        return;
    }
    defer runtime.endPendingClientConnect(runtime_handle);

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer {
        const status = gpa.deinit();
        switch (status) {
            .ok => {},
            .leak => {},
        }
    }
    const arena = gpa.allocator();

    var parsed = std.json.parseFromSlice(std.json.Value, arena, task.payload, .{ .ignore_unknown_fields = true }) catch |err| {
        var scratch: [192]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: queryWorkflow payload must be valid JSON: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: queryWorkflow payload must be valid JSON";
        errors.setStructuredError(.{ .code = grpc.invalid_argument, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, message);
        return;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow payload must be a JSON object",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow payload must be a JSON object");
        return;
    }

    var object = parsed.value.object;

    const namespace_ptr = object.getPtr("namespace") orelse {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow namespace is required",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow namespace is required");
        return;
    };
    const namespace_slice = switch (namespace_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredError(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: queryWorkflow namespace must be a string",
            });
            _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow namespace must be a string");
            return;
        },
    };
    if (namespace_slice.len == 0) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow namespace must be non-empty",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow namespace must be non-empty");
        return;
    }

    const workflow_id_ptr = object.getPtr("workflow_id") orelse {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow workflow_id is required",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow workflow_id is required");
        return;
    };
    const workflow_id_slice = switch (workflow_id_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredError(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: queryWorkflow workflow_id must be a string",
            });
            _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow workflow_id must be a string");
            return;
        },
    };
    if (workflow_id_slice.len == 0) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow workflow_id must be non-empty",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow workflow_id must be non-empty");
        return;
    }

    const query_name_ptr = object.getPtr("query_name") orelse {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow query_name is required",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow query_name is required");
        return;
    };
    const query_name_slice = switch (query_name_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredError(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: queryWorkflow query_name must be a string",
            });
            _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow query_name must be a string");
            return;
        },
    };
    if (query_name_slice.len == 0) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: queryWorkflow query_name must be non-empty",
        });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow query_name must be non-empty");
        return;
    }

    var run_id_slice: ?[]const u8 = null;
    if (object.getPtr("run_id")) |run_id_ptr| {
        const as_string = switch (run_id_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredError(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: queryWorkflow run_id must be a string",
                });
                _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow run_id must be a string");
                return;
            },
        };
        if (as_string.len != 0) {
            run_id_slice = as_string;
        }
    }

    var first_execution_run_id_slice: ?[]const u8 = null;
    if (object.getPtr("first_execution_run_id")) |first_ptr| {
        const as_string = switch (first_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredError(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: queryWorkflow first_execution_run_id must be a string",
                });
                _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow first_execution_run_id must be a string");
                return;
            },
        };
        if (as_string.len != 0) {
            first_execution_run_id_slice = as_string;
        }
    }

    var args_array: ?*std.json.Array = null;
    if (object.getPtr("args")) |args_ptr| {
        switch (args_ptr.*) {
            .array => |*arr| args_array = arr,
            else => {
                errors.setStructuredError(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: queryWorkflow args must be an array",
                });
                _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow args must be an array");
                return;
            },
        }
    }

    const request_bytes = encodeQueryWorkflowRequest(allocator, .{
        .namespace = namespace_slice,
        .workflow_id = workflow_id_slice,
        .run_id = run_id_slice,
        .first_execution_run_id = first_execution_run_id_slice,
        .query_name = query_name_slice,
        .args = args_array,
    }) catch {
        const message = "temporal-bun-bridge-zig: failed to encode queryWorkflow request";
        errors.setStructuredError(.{ .code = grpc.invalid_argument, .message = message });
        _ = pending.rejectByteArray(pending_handle, grpc.invalid_argument, message);
        return;
    };
    defer allocator.free(request_bytes);

    var context = QueryWorkflowRpcContext{
        .allocator = allocator,
        .pending_handle = pending_handle,
        .runtime_handle = runtime_handle,
    };
    context.wait_group.start();

    var call_options = std.mem.zeroes(core.RpcCallOptions);
    call_options.service = 1; // Workflow service
    call_options.rpc = makeByteArrayRef(query_workflow_rpc);
    call_options.req = makeByteArrayRef(request_bytes);
    call_options.retry = true;
    call_options.metadata = emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &call_options, &context, clientQueryWorkflowCallback);
    context.wait_group.wait();
}

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

    if (!pending.retain(pending_handle_ptr)) {
        allocator.destroy(task);
        allocator.free(namespace_copy);
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to retain describeNamespace pending handle",
        });
        _ = pending.rejectByteArray(
            pending_handle,
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to retain describeNamespace pending handle",
        );
        return @as(?*pending.PendingByteArray, pending_handle);
    }

    const thread = std.Thread.spawn(.{}, describeNamespaceWorker, .{task}) catch |err| {
        allocator.destroy(task);
        allocator.free(namespace_copy);
        pending.release(pending_handle_ptr);
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
    if (_client == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow received null client",
            .details = null,
        });
        return null;
    }

    if (_payload.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow payload must be non-empty",
            .details = null,
        });
        return null;
    }

    const client_ptr = _client.?;
    const runtime_handle = client_ptr.runtime orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: startWorkflow missing runtime handle",
            .details = null,
        });
        return null;
    };

    if (runtime_handle.core_runtime == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime core handle is not initialized",
            .details = null,
        });
        return null;
    }

    const core_client = client_ptr.core_client orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: client core handle is not initialized",
            .details = null,
        });
        return null;
    };

    const allocator = std.heap.c_allocator;

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, _payload, .{}) catch |err| {
        var scratch: [192]u8 = undefined;
        const msg = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: startWorkflow payload must be valid JSON: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: startWorkflow payload must be valid JSON";
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = msg, .details = null });
        return null;
    };
    defer parsed.deinit();

    const root = parsed.value;
    if (root != .object) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow payload must be a JSON object",
            .details = null,
        });
        return null;
    }

    var object = root.object;

    const namespace_value_ptr = object.getPtr("namespace") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow namespace is required",
            .details = null,
        });
        return null;
    };
    const namespace_slice = switch (namespace_value_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow namespace must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (namespace_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow namespace must be non-empty",
            .details = null,
        });
        return null;
    }

    const workflow_id_ptr = object.getPtr("workflow_id") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow workflow_id is required",
            .details = null,
        });
        return null;
    };
    const workflow_id_slice = switch (workflow_id_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_id must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (workflow_id_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow workflow_id must be non-empty",
            .details = null,
        });
        return null;
    }

    const workflow_type_ptr = object.getPtr("workflow_type") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow workflow_type is required",
            .details = null,
        });
        return null;
    };
    const workflow_type_slice = switch (workflow_type_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_type must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (workflow_type_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow workflow_type must be non-empty",
            .details = null,
        });
        return null;
    }

    const task_queue_ptr = object.getPtr("task_queue") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow task_queue is required",
            .details = null,
        });
        return null;
    };
    const task_queue_slice = switch (task_queue_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow task_queue must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (task_queue_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow task_queue must be non-empty",
            .details = null,
        });
        return null;
    }

    const identity_ptr = object.getPtr("identity") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow identity is required",
            .details = null,
        });
        return null;
    };
    const identity_slice = switch (identity_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow identity must be a string",
                .details = null,
            });
            return null;
        },
    };
    if (identity_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: startWorkflow identity must be non-empty",
            .details = null,
        });
        return null;
    }

    var args_array: ?*std.json.Array = null;
    if (object.getPtr("args")) |args_ptr| {
        switch (args_ptr.*) {
            .array => |*arr| args_array = arr,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow args must be an array",
                    .details = null,
                });
                return null;
            },
        }
    }

    var memo_map: ?*std.json.ObjectMap = null;
    if (object.getPtr("memo")) |memo_ptr| {
        switch (memo_ptr.*) {
            .object => |*map| memo_map = map,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow memo must be an object",
                    .details = null,
                });
                return null;
            },
        }
    }

    var search_map: ?*std.json.ObjectMap = null;
    if (object.getPtr("search_attributes")) |search_ptr| {
        switch (search_ptr.*) {
            .object => |*map| search_map = map,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow search_attributes must be an object",
                    .details = null,
                });
                return null;
            },
        }
    }

    var header_map: ?*std.json.ObjectMap = null;
    if (object.getPtr("headers")) |headers_ptr| {
        switch (headers_ptr.*) {
            .object => |*map| header_map = map,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow headers must be an object",
                    .details = null,
                });
                return null;
            },
        }
    }

    var retry_policy_map: ?*std.json.ObjectMap = null;
    if (object.getPtr("retry_policy")) |retry_ptr| {
        switch (retry_ptr.*) {
            .object => |*map| retry_policy_map = map,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow retry_policy must be an object",
                    .details = null,
                });
                return null;
            },
        }
    }

    var cron_schedule: ?[]const u8 = null;
    if (object.getPtr("cron_schedule")) |cron_ptr| {
        const cron_slice = switch (cron_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow cron_schedule must be a string",
                    .details = null,
                });
                return null;
            },
        };
        cron_schedule = cron_slice;
    }

    var exec_timeout_ms: ?u64 = null;
    if (object.getPtr("workflow_execution_timeout_ms")) |value_ptr| {
        exec_timeout_ms = jsonValueToU64(value_ptr.*) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_execution_timeout_ms must be a non-negative integer",
                .details = null,
            });
            return null;
        };
    }

    var run_timeout_ms: ?u64 = null;
    if (object.getPtr("workflow_run_timeout_ms")) |value_ptr| {
        run_timeout_ms = jsonValueToU64(value_ptr.*) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_run_timeout_ms must be a non-negative integer",
                .details = null,
            });
            return null;
        };
    }

    var task_timeout_ms: ?u64 = null;
    if (object.getPtr("workflow_task_timeout_ms")) |value_ptr| {
        task_timeout_ms = jsonValueToU64(value_ptr.*) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow workflow_task_timeout_ms must be a non-negative integer",
                .details = null,
            });
            return null;
        };
    }

    var request_id_owned: ?[]u8 = null;
    defer if (request_id_owned) |owned| allocator.free(owned);

    var request_id_slice: []const u8 = ""[0..0];
    if (object.getPtr("request_id")) |request_ptr| {
        const req_slice = switch (request_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: startWorkflow request_id must be a string",
                    .details = null,
                });
                return null;
            },
        };
        if (req_slice.len == 0) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: startWorkflow request_id must be non-empty",
                .details = null,
            });
            return null;
        }
        request_id_slice = req_slice;
    } else {
        request_id_owned = generateRequestId(allocator) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.resource_exhausted,
                .message = "temporal-bun-bridge-zig: failed to allocate workflow request_id",
                .details = null,
            });
            return null;
        };
        request_id_slice = request_id_owned.?;
    }

    const namespace_copy = duplicateSlice(allocator, namespace_slice) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate namespace copy",
            .details = null,
        });
        return null;
    };
    defer if (namespace_copy.len > 0) allocator.free(namespace_copy);

    const workflow_id_copy = duplicateSlice(allocator, workflow_id_slice) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate workflow_id copy",
            .details = null,
        });
        return null;
    };
    defer if (workflow_id_copy.len > 0) allocator.free(workflow_id_copy);

    const params = StartWorkflowRequestParts{
        .namespace = namespace_slice,
        .workflow_id = workflow_id_slice,
        .workflow_type = workflow_type_slice,
        .task_queue = task_queue_slice,
        .identity = identity_slice,
        .request_id = request_id_slice,
        .cron_schedule = cron_schedule,
        .workflow_execution_timeout_ms = exec_timeout_ms,
        .workflow_run_timeout_ms = run_timeout_ms,
        .workflow_task_timeout_ms = task_timeout_ms,
        .args = args_array,
        .memo = memo_map,
        .search_attributes = search_map,
        .headers = header_map,
        .retry_policy = retry_policy_map,
    };

    const request_bytes = encodeStartWorkflowRequest(allocator, params) catch |err| {
        const message = switch (err) {
            error.InvalidNumber => "temporal-bun-bridge-zig: startWorkflow payload contains invalid numeric values",
            error.InvalidRetryPolicy => "temporal-bun-bridge-zig: startWorkflow retry_policy contains invalid values",
            else => "temporal-bun-bridge-zig: failed to encode startWorkflow request",
        };
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = message, .details = null });
        return null;
    };
    defer allocator.free(request_bytes);

    var context = StartWorkflowRpcContext{
        .allocator = allocator,
        .runtime_handle = runtime_handle,
    };
    context.wait_group.start();

    var call_options = std.mem.zeroes(core.RpcCallOptions);
    call_options.service = 1; // Workflow service
    call_options.rpc = makeByteArrayRef(start_workflow_rpc);
    call_options.req = makeByteArrayRef(request_bytes);
    call_options.retry = true;
    call_options.metadata = emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &call_options, &context, clientStartWorkflowCallback);
    context.wait_group.wait();

    const response_bytes = context.response;
    defer if (response_bytes.len > 0) allocator.free(response_bytes);

    const error_message_bytes = context.error_message;
    defer if (context.error_message_owned and error_message_bytes.len > 0) allocator.free(error_message_bytes);

    if (!context.success or response_bytes.len == 0) {
        const message = if (error_message_bytes.len > 0)
            error_message_bytes
        else
            "temporal-bun-bridge-zig: startWorkflow failed"[0..];
        errors.setStructuredErrorJson(.{
            .code = context.error_code,
            .message = message,
            .details = null,
        });
        return null;
    }

    const run_id_slice = parseStartWorkflowRunId(response_bytes) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.internal,
            .message = "temporal-bun-bridge-zig: failed to decode startWorkflow response",
            .details = null,
        });
        return null;
    };

    const run_id_copy = duplicateSlice(allocator, run_id_slice) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate workflow run_id",
            .details = null,
        });
        return null;
    };
    defer if (run_id_copy.len > 0) allocator.free(run_id_copy);

    const ResponsePayload = struct {
        runId: []const u8,
        workflowId: []const u8,
        namespace: []const u8,
    };

    const response_json = std.json.Stringify.valueAlloc(allocator, ResponsePayload{
        .runId = run_id_copy,
        .workflowId = workflow_id_copy,
        .namespace = namespace_copy,
    }, .{}) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to encode startWorkflow metadata",
            .details = null,
        });
        return null;
    };
    defer allocator.free(response_json);

    const result_array = byte_array.allocate(.{ .slice = response_json }) orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate startWorkflow response",
            .details = null,
        });
        return null;
    };

    errors.setLastError(""[0..0]);
    return result_array;
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
    if (_client == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow received null client",
            .details = null,
        });
        return -1;
    }

    if (_payload.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow payload must be non-empty",
            .details = null,
        });
        return -1;
    }

    const client_ptr = _client.?;
    const runtime_handle = client_ptr.runtime orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: terminateWorkflow missing runtime handle",
            .details = null,
        });
        return -1;
    };

    if (runtime_handle.core_runtime == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime core handle is not initialized",
            .details = null,
        });
        return -1;
    }

    const core_client = client_ptr.core_client orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: client core handle is not initialized",
            .details = null,
        });
        return -1;
    };

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer {
        const status = gpa.deinit();
        switch (status) {
            .ok => {},
            .leak => {},
        }
    }
    const allocator = gpa.allocator();

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, _payload, .{ .ignore_unknown_fields = true }) catch |err| {
        var scratch: [192]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: terminateWorkflow payload must be valid JSON: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: terminateWorkflow payload must be valid JSON";
        errors.setStructuredErrorJson(.{ .code = grpc.invalid_argument, .message = message, .details = null });
        return -1;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow payload must be a JSON object",
            .details = null,
        });
        return -1;
    }

    var object = parsed.value.object;

    const namespace_ptr = object.getPtr("namespace") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow namespace is required",
            .details = null,
        });
        return -1;
    };
    const namespace_slice = switch (namespace_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: terminateWorkflow namespace must be a string",
                .details = null,
            });
            return -1;
        },
    };
    if (namespace_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow namespace must be non-empty",
            .details = null,
        });
        return -1;
    }

    const workflow_id_ptr = object.getPtr("workflow_id") orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow workflow_id is required",
            .details = null,
        });
        return -1;
    };
    const workflow_id_slice = switch (workflow_id_ptr.*) {
        .string => |s| s,
        else => {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: terminateWorkflow workflow_id must be a string",
                .details = null,
            });
            return -1;
        },
    };
    if (workflow_id_slice.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: terminateWorkflow workflow_id must be non-empty",
            .details = null,
        });
        return -1;
    }

    var run_id: ?[]const u8 = null;
    if (object.getPtr("run_id")) |run_ptr| {
        const slice = switch (run_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow run_id must be a string",
                    .details = null,
                });
                return -1;
            },
        };
        if (slice.len == 0) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: terminateWorkflow run_id must be non-empty",
                .details = null,
            });
            return -1;
        }
        run_id = slice;
    }

    var first_execution_run_id: ?[]const u8 = null;
    if (object.getPtr("first_execution_run_id")) |first_ptr| {
        const slice = switch (first_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow first_execution_run_id must be a string",
                    .details = null,
                });
                return -1;
            },
        };
        if (slice.len == 0) {
            errors.setStructuredErrorJson(.{
                .code = grpc.invalid_argument,
                .message = "temporal-bun-bridge-zig: terminateWorkflow first_execution_run_id must be non-empty",
                .details = null,
            });
            return -1;
        }
        first_execution_run_id = slice;
    }

    var reason_slice: ?[]const u8 = null;
    if (object.getPtr("reason")) |reason_ptr| {
        const slice = switch (reason_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow reason must be a string",
                    .details = null,
                });
                return -1;
            },
        };
        reason_slice = slice;
    }

    var details_array: ?*std.json.Array = null;
    if (object.getPtr("details")) |details_ptr| {
        switch (details_ptr.*) {
            .array => |*arr| details_array = arr,
            .null => {},
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow details must be an array",
                    .details = null,
                });
                return -1;
            },
        }
    }

    var identity_slice: ?[]const u8 = null;
    if (object.getPtr("identity")) |identity_ptr| {
        const slice = switch (identity_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: terminateWorkflow identity must be a string",
                    .details = null,
                });
                return -1;
            },
        };
        if (slice.len != 0) {
            identity_slice = slice;
        }
    }

    if (identity_slice == null) {
        identity_slice = extractOptionalStringField(client_ptr.config, &.{"identity"});
    }

    const params = TerminateWorkflowRequestParts{
        .namespace = namespace_slice,
        .workflow_id = workflow_id_slice,
        .run_id = run_id,
        .first_execution_run_id = first_execution_run_id,
        .reason = reason_slice,
        .details = details_array,
        .identity = identity_slice,
    };

    const request_bytes = encodeTerminateWorkflowRequest(allocator, params) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate terminateWorkflow request",
            .details = null,
        });
        return -1;
    };
    defer allocator.free(request_bytes);

    if (!runtime.beginPendingClientConnect(runtime_handle)) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down",
            .details = null,
        });
        return -1;
    }
    defer runtime.endPendingClientConnect(runtime_handle);

    var context = TerminateWorkflowRpcContext{
        .allocator = allocator,
        .runtime_handle = runtime_handle,
    };
    context.wait_group.start();

    var call_options = std.mem.zeroes(core.RpcCallOptions);
    call_options.service = 1; // Workflow service
    call_options.rpc = makeByteArrayRef(terminate_workflow_rpc);
    call_options.req = makeByteArrayRef(request_bytes);
    call_options.retry = true;
    call_options.metadata = emptyByteArrayRef();
    call_options.timeout_millis = 0;
    call_options.cancellation_token = null;

    core.api.client_rpc_call(core_client, &call_options, &context, clientTerminateWorkflowCallback);
    context.wait_group.wait();

    const error_message = context.error_message;
    defer {
        if (context.error_message_owned and error_message.len > 0) {
            allocator.free(@constCast(error_message));
        }
    }

    if (!context.success) {
        const message = if (error_message.len > 0) error_message else terminate_workflow_failure_default;
        errors.setStructuredErrorJson(.{ .code = context.error_code, .message = message, .details = null });
        return -1;
    }

    errors.setLastError(""[0..0]);
    return 0;
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

pub fn queryWorkflow(client_ptr: ?*ClientHandle, payload: []const u8) ?*pending.PendingByteArray {
    if (client_ptr == null) {
        return createByteArrayError(grpc.invalid_argument, "temporal-bun-bridge-zig: queryWorkflow received null client");
    }

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, payload.len) catch {
        return createByteArrayError(grpc.resource_exhausted, "temporal-bun-bridge-zig: failed to allocate query payload copy");
    };
    @memcpy(copy, payload);

    const pending_handle_ptr = pending.createPendingInFlight() orelse {
        allocator.free(copy);
        return createByteArrayError(grpc.internal, "temporal-bun-bridge-zig: failed to allocate pending query handle");
    };

    const pending_handle = @as(*pending.PendingByteArray, @ptrCast(pending_handle_ptr));

    const task = allocator.create(QueryWorkflowTask) catch |err| {
        allocator.free(copy);
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate queryWorkflow task: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate queryWorkflow task";
        _ = pending.rejectByteArray(pending_handle, grpc.resource_exhausted, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    task.* = .{
        .client = client_ptr,
        .pending_handle = pending_handle,
        .payload = copy,
    };

    if (!pending.retain(pending_handle_ptr)) {
        allocator.free(copy);
        allocator.destroy(task);
        errors.setStructuredError(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to retain queryWorkflow pending handle",
        });
        _ = pending.rejectByteArray(
            pending_handle,
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to retain queryWorkflow pending handle",
        );
        return @as(?*pending.PendingByteArray, pending_handle);
    }

    const thread = std.Thread.spawn(.{}, queryWorkflowWorker, .{task}) catch |err| {
        allocator.free(copy);
        allocator.destroy(task);
        pending.release(pending_handle_ptr);
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to spawn queryWorkflow worker: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to spawn queryWorkflow worker";
        _ = pending.rejectByteArray(pending_handle, grpc.internal, message);
        return @as(?*pending.PendingByteArray, pending_handle);
    };

    thread.detach();
    return @as(?*pending.PendingByteArray, pending_handle);
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

    if (!pending.retain(pending_handle_ptr)) {
        allocator.free(copy);
        pending.free(pending_handle_ptr);
        return createByteArrayError(
            grpc.resource_exhausted,
            "temporal-bun-bridge-zig: failed to retain pending signal handle",
        );
    }

    const thread = std.Thread.spawn(.{}, runSignalWorkflow, .{context}) catch |err| {
        allocator.free(copy);
        pending.release(pending_handle_ptr);
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
    defer pending.release(context.handle);

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
