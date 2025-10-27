const std = @import("std");
const common = @import("../common.zig");

pub const ArrayListManaged = common.ArrayListManaged;

pub const ProtoDecodeError = error{
    UnexpectedEof,
    UnsupportedWireType,
    Overflow,
};

pub const StartWorkflowRequestParts = struct {
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

pub const QueryWorkflowRequestParts = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    run_id: ?[]const u8 = null,
    first_execution_run_id: ?[]const u8 = null,
    query_name: []const u8,
    args: ?*std.json.Array = null,
};

pub const TerminateWorkflowRequestParts = struct {
    namespace: []const u8,
    workflow_id: []const u8,
    run_id: ?[]const u8 = null,
    first_execution_run_id: ?[]const u8 = null,
    reason: ?[]const u8 = null,
    details: ?*std.json.Array = null,
    identity: ?[]const u8 = null,
};

pub fn writeVarint(buffer: *ArrayListManaged(u8), value: u64) !void {
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

pub fn writeTag(buffer: *ArrayListManaged(u8), field_number: u32, wire_type: u3) !void {
    const key = (@as(u64, field_number) << 3) | wire_type;
    try writeVarint(buffer, key);
}

pub fn appendLengthDelimited(buffer: *ArrayListManaged(u8), field_number: u32, bytes: []const u8) !void {
    try writeTag(buffer, field_number, 2);
    try writeVarint(buffer, bytes.len);
    try buffer.appendSlice(bytes);
}

pub fn appendString(buffer: *ArrayListManaged(u8), field_number: u32, value: []const u8) !void {
    try appendLengthDelimited(buffer, field_number, value);
}

pub fn appendBytes(buffer: *ArrayListManaged(u8), field_number: u32, value: []const u8) !void {
    try appendLengthDelimited(buffer, field_number, value);
}

pub fn appendVarint(buffer: *ArrayListManaged(u8), field_number: u32, value: u64) !void {
    try writeTag(buffer, field_number, 0);
    try writeVarint(buffer, value);
}

pub fn appendBool(buffer: *ArrayListManaged(u8), field_number: u32, value: bool) !void {
    try appendVarint(buffer, field_number, if (value) 1 else 0);
}

pub fn appendDouble(buffer: *ArrayListManaged(u8), field_number: u32, value: f64) !void {
    try writeTag(buffer, field_number, 1);
    var storage: [8]u8 = undefined;
    const bits: u64 = @bitCast(value);
    std.mem.writeInt(u64, storage[0..], bits, .little);
    try buffer.appendSlice(&storage);
}

pub fn encodeDurationMillis(allocator: std.mem.Allocator, millis: u64) ![]u8 {
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

pub fn encodeMetadataEntry(allocator: std.mem.Allocator, key: []const u8, value: []const u8) ![]u8 {
    var entry = ArrayListManaged(u8).init(allocator);
    defer entry.deinit();

    try appendString(&entry, 1, key);
    try appendBytes(&entry, 2, value);

    return entry.toOwnedSlice();
}

pub fn encodeJsonPayload(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
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

pub fn encodePayloadsFromArray(allocator: std.mem.Allocator, array: *std.json.Array) !?[]u8 {
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

pub fn encodePayloadMap(allocator: std.mem.Allocator, map: *std.json.ObjectMap) !?[]u8 {
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

pub fn jsonValueToU64(value: std.json.Value) !u64 {
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

pub fn jsonValueToF64(value: std.json.Value) !f64 {
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

pub fn encodeRetryPolicyFromObject(allocator: std.mem.Allocator, map: *std.json.ObjectMap) !?[]u8 {
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

pub fn generateRequestId(allocator: std.mem.Allocator) ![]u8 {
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

pub fn encodeStartWorkflowRequest(allocator: std.mem.Allocator, params: StartWorkflowRequestParts) ![]u8 {
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
    try appendVarint(&task_queue_buf, 2, 1);
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

pub fn encodeQueryWorkflowRequest(allocator: std.mem.Allocator, params: QueryWorkflowRequestParts) ![]u8 {
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

pub fn encodeTerminateWorkflowRequest(allocator: std.mem.Allocator, params: TerminateWorkflowRequestParts) ![]u8 {
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

pub fn readVarint(buffer: []const u8, index: *usize) ProtoDecodeError!u64 {
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

pub fn skipField(buffer: []const u8, index: *usize, wire_type: u3) ProtoDecodeError!void {
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

pub fn parseStartWorkflowRunId(buffer: []const u8) ProtoDecodeError![]const u8 {
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
