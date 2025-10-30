const std = @import("std");
const errors = @import("errors.zig");
const core = @import("core.zig");
const pending = @import("pending.zig");

const grpc = pending.GrpcStatus;

const allocator = std.heap.c_allocator;

const runtime_error_message = "temporal-bun-bridge-zig: runtime initialization failed";

const LoggerCallback = *const fn (
    level: u32,
    target_ptr: ?[*]const u8,
    target_len: usize,
    message_ptr: ?[*]const u8,
    message_len: usize,
    timestamp_millis: u64,
    fields_ptr: ?[*]const u8,
    fields_len: usize,
) callconv(.c) void;

const default_log_filter = "temporal_sdk_core=info,temporal_sdk=info";

const TelemetryMode = enum {
    none,
    prometheus,
    otlp,
};

const otel_temporality_cumulative = @as(core.OpenTelemetryMetricTemporality, 1);
const otel_temporality_delta = @as(core.OpenTelemetryMetricTemporality, 2);
const otel_protocol_grpc = @as(core.OpenTelemetryProtocol, 1);
const otel_protocol_http = @as(core.OpenTelemetryProtocol, 2);

const JsonObject = std.StringArrayHashMap(std.json.Value);

var logger_lock: std.Thread.Mutex = .{};
var global_logger_owner = std.atomic.Value(?*RuntimeHandle).init(null);
var global_logger_callback = std.atomic.Value(?LoggerCallback).init(null);

const fallback_error_array = core.ByteArray{
    .data = runtime_error_message.ptr,
    .size = runtime_error_message.len,
    .cap = runtime_error_message.len,
    .disable_free = true,
};

fn byteArraySlice(bytes_ptr: ?*const core.ByteArray) []const u8 {
    if (bytes_ptr == null) {
        return ""[0..0];
    }
    const bytes = bytes_ptr.?;
    if (bytes.data == null or bytes.size == 0) {
        return ""[0..0];
    }
    return bytes.data[0..bytes.size];
}

fn makeByteArrayRef(slice: []const u8) core.ByteArrayRef {
    if (slice.len == 0) {
        return .{ .data = null, .size = 0 };
    }
    return .{ .data = slice.ptr, .size = slice.len };
}

fn duplicateSlice(slice: []const u8) ?[]u8 {
    if (slice.len == 0) {
        return null;
    }
    const copy = allocator.alloc(u8, slice.len) catch return null;
    @memcpy(copy, slice);
    return copy;
}

fn freeOwnedSlice(slice: []u8) void {
    if (slice.len == 0) {
        return;
    }
    allocator.free(slice);
}

fn freeTelemetryBuffers(handle: *RuntimeHandle) void {
    freeOwnedSlice(handle.telemetry_metric_prefix);
    freeOwnedSlice(handle.telemetry_global_tags);
    freeOwnedSlice(handle.telemetry_histogram_overrides);
    freeOwnedSlice(handle.telemetry_headers);
    freeOwnedSlice(handle.telemetry_socket_addr);
    freeOwnedSlice(handle.telemetry_url);

    handle.telemetry_metric_prefix = ""[0..0];
    handle.telemetry_global_tags = ""[0..0];
    handle.telemetry_histogram_overrides = ""[0..0];
    handle.telemetry_headers = ""[0..0];
    handle.telemetry_socket_addr = ""[0..0];
    handle.telemetry_url = ""[0..0];
    handle.telemetry_mode = .none;
}

fn optionalPointer(ref: core.ByteArrayRef) ?[*]const u8 {
    if (ref.data == null or ref.size == 0) {
        return null;
    }
    return @ptrCast(ref.data.?);
}

fn parseLoggingFilter(options_json: []const u8) ?[]u8 {
    if (options_json.len == 0) {
        return null;
    }

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, options_json, .{
        .ignore_unknown_fields = true,
    }) catch return null;
    defer parsed.deinit();

    const root = parsed.value;
    if (root != .object) {
        return null;
    }

    const telemetry_ptr = root.object.getPtr("telemetry") orelse return null;
    if (telemetry_ptr.* != .object) {
        return null;
    }

    const logging_ptr = telemetry_ptr.object.getPtr("logging") orelse return null;
    if (logging_ptr.* != .object) {
        return null;
    }

    const filter_ptr = logging_ptr.object.getPtr("filter") orelse return null;
    if (filter_ptr.* != .string or filter_ptr.string.len == 0) {
        return null;
    }

    return duplicateSlice(filter_ptr.string);
}

fn clearLoggerForHandle(handle: *RuntimeHandle) void {
    logger_lock.lock();
    defer logger_lock.unlock();

    if (global_logger_owner.load(.seq_cst)) |owner| {
        if (owner == handle) {
            global_logger_callback.store(null, .seq_cst);
            global_logger_owner.store(null, .seq_cst);
        }
    }
    handle.logger_callback = null;
}

fn forwardLogToBun(level: core.ForwardedLogLevel, log_ptr: ?*const core.ForwardedLog) callconv(.c) void {
    const callback = global_logger_callback.load(.acquire) orelse return;
    const level_code: u32 = @intCast(level);

    if (log_ptr == null) {
        callback(level_code, null, 0, null, 0, 0, null, 0);
        return;
    }

    const target_ref = core.forwardedLogTarget(log_ptr);
    const message_ref = core.forwardedLogMessage(log_ptr);
    const fields_ref = core.forwardedLogFieldsJson(log_ptr);
    const timestamp = core.forwardedLogTimestampMillis(log_ptr);

    callback(level_code, optionalPointer(target_ref), target_ref.size, optionalPointer(message_ref), message_ref.size, timestamp, optionalPointer(fields_ref), fields_ref.size);
}

/// Placeholder handle that mirrors the pointer-based interface exposed by the Rust bridge.
pub const RuntimeHandle = struct {
    id: u64,
    /// Raw JSON payload passed from TypeScript; retained until the Rust runtime wiring is complete.
    config: []u8,
    core_runtime: ?*core.RuntimeOpaque,
    logger_callback: ?LoggerCallback = null,
    logger_filter: []u8 = ""[0..0],
    telemetry_mode: TelemetryMode = .none,
    telemetry_metric_prefix: []u8 = ""[0..0],
    telemetry_global_tags: []u8 = ""[0..0],
    telemetry_histogram_overrides: []u8 = ""[0..0],
    telemetry_headers: []u8 = ""[0..0],
    telemetry_socket_addr: []u8 = ""[0..0],
    telemetry_url: []u8 = ""[0..0],
    telemetry_attach_service_name: bool = true,
    telemetry_prom_counters_total_suffix: bool = false,
    telemetry_prom_unit_suffix: bool = false,
    telemetry_prom_use_seconds: bool = false,
    telemetry_otel_metric_periodicity_millis: u32 = 0,
    telemetry_otel_use_seconds: bool = false,
    telemetry_otel_temporality: core.OpenTelemetryMetricTemporality = otel_temporality_cumulative,
    telemetry_otel_protocol: core.OpenTelemetryProtocol = otel_protocol_grpc,
    pending_lock: std.Thread.Mutex = .{},
    pending_condition: std.Thread.Condition = .{},
    pending_connects: usize = 0,
    destroying: bool = false,
};

var next_runtime_id: u64 = 1;

const PreparedTelemetry = struct {
    allocator: std.mem.Allocator,
    filter_owned: []u8,
    attach_service_name: bool,
    metric_prefix: []u8,
    global_tags: []u8,
    histogram_overrides: []u8,
    headers: []u8,
    socket_addr: []u8,
    url: []u8,
    mode: TelemetryMode,
    prom_counters_total_suffix: bool,
    prom_unit_suffix: bool,
    prom_use_seconds: bool,
    otel_metric_periodicity_millis: u32,
    otel_use_seconds: bool,
    otel_temporality: core.OpenTelemetryMetricTemporality,
    otel_protocol: core.OpenTelemetryProtocol,

    pub fn deinit(self: *PreparedTelemetry) void {
        freeOwnedSlice(self.filter_owned);
        freeOwnedSlice(self.metric_prefix);
        freeOwnedSlice(self.global_tags);
        freeOwnedSlice(self.histogram_overrides);
        freeOwnedSlice(self.headers);
        freeOwnedSlice(self.socket_addr);
        freeOwnedSlice(self.url);
    }

    pub fn adopt(self: *PreparedTelemetry, handle: *RuntimeHandle) void {
        freeOwnedSlice(handle.logger_filter);
        handle.logger_filter = self.filter_owned;
        self.filter_owned = ""[0..0];

        freeTelemetryBuffers(handle);

        handle.telemetry_attach_service_name = self.attach_service_name;
        handle.telemetry_mode = self.mode;
        handle.telemetry_prom_counters_total_suffix = self.prom_counters_total_suffix;
        handle.telemetry_prom_unit_suffix = self.prom_unit_suffix;
        handle.telemetry_prom_use_seconds = self.prom_use_seconds;
        handle.telemetry_otel_metric_periodicity_millis = self.otel_metric_periodicity_millis;
        handle.telemetry_otel_use_seconds = self.otel_use_seconds;
        handle.telemetry_otel_temporality = self.otel_temporality;
        handle.telemetry_otel_protocol = self.otel_protocol;

        handle.telemetry_metric_prefix = self.metric_prefix;
        self.metric_prefix = ""[0..0];

        handle.telemetry_global_tags = self.global_tags;
        self.global_tags = ""[0..0];

        handle.telemetry_histogram_overrides = self.histogram_overrides;
        self.histogram_overrides = ""[0..0];

        handle.telemetry_headers = self.headers;
        self.headers = ""[0..0];

        handle.telemetry_socket_addr = self.socket_addr;
        self.socket_addr = ""[0..0];

        handle.telemetry_url = self.url;
        self.url = ""[0..0];
    }
};

const TelemetryParseError = error{
    InvalidShape,
    InvalidValue,
    MissingField,
    AllocationFailed,
};

fn allocSlice(slice: []const u8) TelemetryParseError![]u8 {
    if (slice.len == 0) {
        return ""[0..0];
    }
    const copy = allocator.alloc(u8, slice.len) catch return TelemetryParseError.AllocationFailed;
    @memcpy(copy, slice);
    return copy;
}

fn encodeStringPairs(map: *JsonObject) TelemetryParseError![]u8 {
    var builder = std.ArrayListUnmanaged(u8){};
    errdefer builder.deinit(allocator);

    var iter = map.iterator();
    var first = true;
    while (iter.next()) |entry| {
        const key = entry.key_ptr.*;
        const value = entry.value_ptr.*;
        if (value != .string) {
            return TelemetryParseError.InvalidValue;
        }
        if (!first) builder.append(allocator, '\n') catch return TelemetryParseError.AllocationFailed;
        first = false;
        builder.appendSlice(allocator, key) catch return TelemetryParseError.AllocationFailed;
        builder.append(allocator, '\n') catch return TelemetryParseError.AllocationFailed;
        builder.appendSlice(allocator, value.string) catch return TelemetryParseError.AllocationFailed;
    }

    if (builder.items.len == 0) {
        builder.deinit(allocator);
        return ""[0..0];
    }

    return builder.toOwnedSlice(allocator) catch TelemetryParseError.AllocationFailed;
}

fn encodeHistogramOverrides(map: *JsonObject) TelemetryParseError![]u8 {
    var builder = std.ArrayListUnmanaged(u8){};
    errdefer builder.deinit(allocator);

    var iter = map.iterator();
    var first_metric = true;
    while (iter.next()) |entry| {
        const key = entry.key_ptr.*;
        const value = entry.value_ptr.*;
        if (value != .array) {
            return TelemetryParseError.InvalidValue;
        }
        const values = value.array.items;
        if (!first_metric) builder.append(allocator, '\n') catch return TelemetryParseError.AllocationFailed;
        first_metric = false;
        builder.appendSlice(allocator, key) catch return TelemetryParseError.AllocationFailed;
        builder.append(allocator, '\n') catch return TelemetryParseError.AllocationFailed;

        var first_bucket = true;
        for (values) |bucket_value| {
            switch (bucket_value) {
                .integer => |int_value| {
                    if (!first_bucket) builder.append(allocator, ',') catch return TelemetryParseError.AllocationFailed;
                    first_bucket = false;
                    std.fmt.format(builder.writer(allocator), "{d}", .{int_value}) catch return TelemetryParseError.AllocationFailed;
                },
                .float => |float_value| {
                    if (!first_bucket) builder.append(allocator, ',') catch return TelemetryParseError.AllocationFailed;
                    first_bucket = false;
                    std.fmt.format(builder.writer(allocator), "{d}", .{float_value}) catch return TelemetryParseError.AllocationFailed;
                },
                else => return TelemetryParseError.InvalidValue,
            }
        }

        if (first_bucket) {
            // Empty array is invalid.
            return TelemetryParseError.InvalidValue;
        }
    }

    if (builder.items.len == 0) {
        builder.deinit(allocator);
        return ""[0..0];
    }

    return builder.toOwnedSlice(allocator) catch TelemetryParseError.AllocationFailed;
}

fn parseTelemetryConfig(
    options_json: []const u8,
    existing_filter: []const u8,
    existing: ?*const RuntimeHandle,
) TelemetryParseError!PreparedTelemetry {
    const parser = std.json.parseFromSlice(std.json.Value, allocator, options_json, .{
        .ignore_unknown_fields = true,
    }) catch return TelemetryParseError.InvalidShape;
    defer parser.deinit();

    const root = parser.value;
    if (root != .object) {
        return TelemetryParseError.InvalidShape;
    }

    const base_filter = if (existing_filter.len > 0) existing_filter else default_log_filter;

    const existing_handle = existing;

    const base_metric_prefix = if (existing_handle) |ex|
        if (ex.telemetry_metric_prefix.len > 0) ex.telemetry_metric_prefix else "temporal_"[0..]
    else
        "temporal_"[0..];

    const base_global_tags = if (existing_handle) |ex| ex.telemetry_global_tags else ""[0..0];
    const base_histogram_overrides = if (existing_handle) |ex| ex.telemetry_histogram_overrides else ""[0..0];
    const base_headers = if (existing_handle) |ex| ex.telemetry_headers else ""[0..0];
    const base_socket_addr = if (existing_handle) |ex| ex.telemetry_socket_addr else ""[0..0];
    const base_url = if (existing_handle) |ex| ex.telemetry_url else ""[0..0];

    var config = PreparedTelemetry{
        .allocator = allocator,
        .filter_owned = try allocSlice(base_filter),
        .attach_service_name = if (existing_handle) |ex| ex.telemetry_attach_service_name else true,
        .metric_prefix = try allocSlice(base_metric_prefix),
        .global_tags = try allocSlice(base_global_tags),
        .histogram_overrides = try allocSlice(base_histogram_overrides),
        .headers = try allocSlice(base_headers),
        .socket_addr = try allocSlice(base_socket_addr),
        .url = try allocSlice(base_url),
        .mode = if (existing_handle) |ex| ex.telemetry_mode else TelemetryMode.none,
        .prom_counters_total_suffix = if (existing_handle) |ex| ex.telemetry_prom_counters_total_suffix else false,
        .prom_unit_suffix = if (existing_handle) |ex| ex.telemetry_prom_unit_suffix else false,
        .prom_use_seconds = if (existing_handle) |ex| ex.telemetry_prom_use_seconds else false,
        .otel_metric_periodicity_millis = if (existing_handle) |ex| ex.telemetry_otel_metric_periodicity_millis else 0,
        .otel_use_seconds = if (existing_handle) |ex| ex.telemetry_otel_use_seconds else false,
        .otel_temporality = if (existing_handle) |ex| ex.telemetry_otel_temporality else otel_temporality_cumulative,
        .otel_protocol = if (existing_handle) |ex| ex.telemetry_otel_protocol else otel_protocol_grpc,
    };
    errdefer config.deinit();

    const root_obj = root.object;

    if (root_obj.getPtr("logExporter")) |log_exporter_ptr| {
        const log_exporter = log_exporter_ptr.*;
        if (log_exporter == .object) {
            const log_obj = log_exporter.object;
            if (log_obj.getPtr("filter")) |filter_ptr| {
                if (filter_ptr.* != .string or filter_ptr.string.len == 0) {
                    return TelemetryParseError.InvalidValue;
                }
                freeOwnedSlice(config.filter_owned);
                config.filter_owned = try allocSlice(filter_ptr.string);
            } else {
                return TelemetryParseError.MissingField;
            }
        } else {
            return TelemetryParseError.InvalidValue;
        }
    }

    if (root_obj.getPtr("telemetry")) |telemetry_ptr| {
        const telemetry_value = telemetry_ptr.*;
        if (telemetry_value != .object) {
            return TelemetryParseError.InvalidValue;
        }
        const telemetry_obj = telemetry_value.object;
        if (telemetry_obj.getPtr("metricPrefix")) |prefix_ptr| {
            if (prefix_ptr.* != .string) {
                return TelemetryParseError.InvalidValue;
            }
            freeOwnedSlice(config.metric_prefix);
            config.metric_prefix = try allocSlice(prefix_ptr.string);
        }
        if (telemetry_obj.getPtr("attachServiceName")) |attach_ptr| {
            if (attach_ptr.* != .bool) {
                return TelemetryParseError.InvalidValue;
            }
            config.attach_service_name = attach_ptr.bool;
        }
    }

    if (root_obj.getPtr("metricsExporter")) |metrics_ptr| {
        const metrics_value = metrics_ptr.*;
        if (metrics_value == .null) {
            // Explicitly disable metrics.
            config.mode = .none;
            config.prom_counters_total_suffix = false;
            config.prom_unit_suffix = false;
            config.prom_use_seconds = false;
            config.otel_metric_periodicity_millis = 0;
            config.otel_use_seconds = false;
            config.otel_temporality = otel_temporality_cumulative;
            config.otel_protocol = otel_protocol_grpc;

            freeOwnedSlice(config.global_tags);
            config.global_tags = ""[0..0];

            freeOwnedSlice(config.histogram_overrides);
            config.histogram_overrides = ""[0..0];

            freeOwnedSlice(config.headers);
            config.headers = ""[0..0];

            freeOwnedSlice(config.socket_addr);
            config.socket_addr = ""[0..0];

            freeOwnedSlice(config.url);
            config.url = ""[0..0];
        } else if (metrics_value == .object) {
            const metrics_obj = metrics_value.object;
            const type_ptr = metrics_obj.getPtr("type") orelse return TelemetryParseError.MissingField;
            if (type_ptr.* != .string) {
                return TelemetryParseError.InvalidValue;
            }
            const exporter_type = type_ptr.string;
            if (std.mem.eql(u8, exporter_type, "prometheus")) {
                const socket_ptr = metrics_obj.getPtr("socketAddr") orelse return TelemetryParseError.MissingField;
                if (socket_ptr.* != .string or socket_ptr.string.len == 0) {
                    return TelemetryParseError.InvalidValue;
                }
                freeOwnedSlice(config.socket_addr);
                config.socket_addr = try allocSlice(socket_ptr.string);

                if (metrics_obj.getPtr("globalTags")) |tags_ptr| {
                    if (tags_ptr.* != .object) {
                        return TelemetryParseError.InvalidValue;
                    }
                    freeOwnedSlice(config.global_tags);
                    config.global_tags = try encodeStringPairs(&tags_ptr.object);
                } else {
                    freeOwnedSlice(config.global_tags);
                    config.global_tags = ""[0..0];
                }

                if (metrics_obj.getPtr("histogramBucketOverrides")) |hist_ptr| {
                    if (hist_ptr.* != .object) {
                        return TelemetryParseError.InvalidValue;
                    }
                    freeOwnedSlice(config.histogram_overrides);
                    config.histogram_overrides = try encodeHistogramOverrides(&hist_ptr.object);
                } else {
                    freeOwnedSlice(config.histogram_overrides);
                    config.histogram_overrides = ""[0..0];
                }

                config.prom_counters_total_suffix = if (metrics_obj.getPtr("countersTotalSuffix")) |ptr| switch (ptr.*) {
                    .bool => ptr.bool,
                    else => return TelemetryParseError.InvalidValue,
                } else false;

                config.prom_unit_suffix = if (metrics_obj.getPtr("unitSuffix")) |ptr| switch (ptr.*) {
                    .bool => ptr.bool,
                    else => return TelemetryParseError.InvalidValue,
                } else false;

                config.prom_use_seconds = if (metrics_obj.getPtr("useSecondsForDurations")) |ptr| switch (ptr.*) {
                    .bool => ptr.bool,
                    else => return TelemetryParseError.InvalidValue,
                } else false;

                freeOwnedSlice(config.url);
                config.url = ""[0..0];

                freeOwnedSlice(config.headers);
                config.headers = ""[0..0];

                config.otel_metric_periodicity_millis = 0;
                config.otel_use_seconds = false;
                config.otel_temporality = otel_temporality_cumulative;
                config.otel_protocol = otel_protocol_grpc;

                config.mode = .prometheus;
            } else if (std.mem.eql(u8, exporter_type, "otel") or std.mem.eql(u8, exporter_type, "otlp")) {
                const url_ptr = metrics_obj.getPtr("url") orelse return TelemetryParseError.MissingField;
                if (url_ptr.* != .string or url_ptr.string.len == 0) {
                    return TelemetryParseError.InvalidValue;
                }
                freeOwnedSlice(config.url);
                config.url = try allocSlice(url_ptr.string);

                if (metrics_obj.getPtr("headers")) |headers_ptr| {
                    if (headers_ptr.* != .object) {
                        return TelemetryParseError.InvalidValue;
                    }
                    freeOwnedSlice(config.headers);
                    config.headers = try encodeStringPairs(&headers_ptr.object);
                } else {
                    freeOwnedSlice(config.headers);
                    config.headers = ""[0..0];
                }

                if (metrics_obj.getPtr("globalTags")) |tags_ptr| {
                    if (tags_ptr.* != .object) {
                        return TelemetryParseError.InvalidValue;
                    }
                    freeOwnedSlice(config.global_tags);
                    config.global_tags = try encodeStringPairs(&tags_ptr.object);
                } else {
                    freeOwnedSlice(config.global_tags);
                    config.global_tags = ""[0..0];
                }

                if (metrics_obj.getPtr("histogramBucketOverrides")) |hist_ptr| {
                    if (hist_ptr.* != .object) {
                        return TelemetryParseError.InvalidValue;
                    }
                    freeOwnedSlice(config.histogram_overrides);
                    config.histogram_overrides = try encodeHistogramOverrides(&hist_ptr.object);
                } else {
                    freeOwnedSlice(config.histogram_overrides);
                    config.histogram_overrides = ""[0..0];
                }

                config.otel_use_seconds = if (metrics_obj.getPtr("useSecondsForDurations")) |ptr| switch (ptr.*) {
                    .bool => ptr.bool,
                    else => return TelemetryParseError.InvalidValue,
                } else false;

                config.otel_metric_periodicity_millis = if (metrics_obj.getPtr("metricPeriodicity")) |ptr| switch (ptr.*) {
                    .integer => |value| if (value < 0) return TelemetryParseError.InvalidValue else @intCast(value),
                    else => return TelemetryParseError.InvalidValue,
                } else 0;

                if (metrics_obj.getPtr("metricTemporality")) |ptr| {
                    if (ptr.* != .string) {
                        return TelemetryParseError.InvalidValue;
                    }
                    if (std.mem.eql(u8, ptr.string, "cumulative")) {
                        config.otel_temporality = otel_temporality_cumulative;
                    } else if (std.mem.eql(u8, ptr.string, "delta")) {
                        config.otel_temporality = otel_temporality_delta;
                    } else {
                        return TelemetryParseError.InvalidValue;
                    }
                }

                if (metrics_obj.getPtr("protocol")) |ptr| {
                    if (ptr.* != .string) {
                        return TelemetryParseError.InvalidValue;
                    }
                    if (std.mem.eql(u8, ptr.string, "http")) {
                        config.otel_protocol = otel_protocol_http;
                    } else if (std.mem.eql(u8, ptr.string, "grpc")) {
                        config.otel_protocol = otel_protocol_grpc;
                    } else {
                        return TelemetryParseError.InvalidValue;
                    }
                }

                config.mode = .otlp;

                freeOwnedSlice(config.socket_addr);
                config.socket_addr = ""[0..0];

                config.prom_counters_total_suffix = false;
                config.prom_unit_suffix = false;
                config.prom_use_seconds = false;
            } else {
                return TelemetryParseError.InvalidValue;
            }
        } else {
            return TelemetryParseError.InvalidValue;
        }
    }

    return config;
}

pub fn create(options_json: []const u8) ?*RuntimeHandle {
    const copy = allocator.alloc(u8, options_json.len) catch |err| {
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate runtime config: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate runtime config";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        return null;
    };
    @memcpy(copy, options_json);

    const handle = allocator.create(RuntimeHandle) catch |err| {
        allocator.free(copy);
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate runtime handle: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: failed to allocate runtime handle";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        return null;
    };

    const id = next_runtime_id;
    next_runtime_id += 1;

    core.ensureExternalApiInstalled();

    var telemetry_config = parseTelemetryConfig(options_json, ""[0..0], null) catch |err| {
        allocator.free(copy);
        allocator.destroy(handle);

        var scratch: [256]u8 = undefined;
        const message = switch (err) {
            TelemetryParseError.AllocationFailed => std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: failed to allocate telemetry configuration",
                .{},
            ) catch "temporal-bun-bridge-zig: failed to allocate telemetry configuration",
            TelemetryParseError.InvalidShape => std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: telemetry payload must be a JSON object",
                .{},
            ) catch "temporal-bun-bridge-zig: telemetry payload must be a JSON object",
            TelemetryParseError.MissingField => std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: telemetry configuration is missing a required field",
                .{},
            ) catch "temporal-bun-bridge-zig: telemetry configuration is missing a required field",
            TelemetryParseError.InvalidValue => std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: telemetry configuration contains an invalid value",
                .{},
            ) catch "temporal-bun-bridge-zig: telemetry configuration contains an invalid value",
        };

        const code: i32 = switch (err) {
            TelemetryParseError.AllocationFailed => grpc.resource_exhausted,
            else => grpc.invalid_argument,
        };

        errors.setStructuredError(.{ .code = code, .message = message });
        return null;
    };

    var logging_options = core.LoggingOptions{
        .filter = makeByteArrayRef(telemetry_config.filter_owned),
        .forward_to = forwardLogToBun,
    };

    var metrics_options_storage: core.MetricsOptions = undefined;
    var prometheus_options_storage: core.PrometheusOptions = undefined;
    var otel_options_storage: core.OpenTelemetryOptions = undefined;

    var telemetry_options = core.TelemetryOptions{
        .logging = &logging_options,
        .metrics = null,
    };

    switch (telemetry_config.mode) {
        .none => {},
        .prometheus => {
            prometheus_options_storage = .{
                .bind_address = makeByteArrayRef(telemetry_config.socket_addr),
                .counters_total_suffix = telemetry_config.prom_counters_total_suffix,
                .unit_suffix = telemetry_config.prom_unit_suffix,
                .durations_as_seconds = telemetry_config.prom_use_seconds,
                .histogram_bucket_overrides = makeByteArrayRef(telemetry_config.histogram_overrides),
            };

            metrics_options_storage = .{
                .opentelemetry = null,
                .prometheus = &prometheus_options_storage,
                .custom_meter = null,
                .attach_service_name = telemetry_config.attach_service_name,
                .global_tags = makeByteArrayRef(telemetry_config.global_tags),
                .metric_prefix = makeByteArrayRef(telemetry_config.metric_prefix),
            };

            telemetry_options.metrics = &metrics_options_storage;
        },
        .otlp => {
            otel_options_storage = .{
                .url = makeByteArrayRef(telemetry_config.url),
                .headers = makeByteArrayRef(telemetry_config.headers),
                .metric_periodicity_millis = telemetry_config.otel_metric_periodicity_millis,
                .metric_temporality = telemetry_config.otel_temporality,
                .durations_as_seconds = telemetry_config.otel_use_seconds,
                .protocol = telemetry_config.otel_protocol,
                .histogram_bucket_overrides = makeByteArrayRef(telemetry_config.histogram_overrides),
            };

            metrics_options_storage = .{
                .opentelemetry = &otel_options_storage,
                .prometheus = null,
                .custom_meter = null,
                .attach_service_name = telemetry_config.attach_service_name,
                .global_tags = makeByteArrayRef(telemetry_config.global_tags),
                .metric_prefix = makeByteArrayRef(telemetry_config.metric_prefix),
            };

            telemetry_options.metrics = &metrics_options_storage;
        },
    }

    var runtime_options = core.RuntimeOptions{
        .telemetry = &telemetry_options,
    };

    const created = core.api.runtime_new(&runtime_options);
    if (created.runtime == null) {
        const message_slice = byteArraySlice(created.fail orelse &fallback_error_array);
        const message = if (message_slice.len > 0)
            message_slice
        else
            "temporal-bun-bridge-zig: failed to create Temporal runtime";

        errors.setStructuredError(.{ .code = grpc.internal, .message = message });
        if (created.fail) |fail_ptr| {
            core.api.byte_array_free(null, fail_ptr);
        }
        telemetry_config.deinit();
        allocator.free(copy);
        allocator.destroy(handle);
        return null;
    }

    handle.* = .{
        .id = id,
        .config = copy,
        .core_runtime = created.runtime,
        .logger_callback = null,
        .logger_filter = ""[0..0],
        .telemetry_mode = .none,
        .telemetry_metric_prefix = ""[0..0],
        .telemetry_global_tags = ""[0..0],
        .telemetry_histogram_overrides = ""[0..0],
        .telemetry_headers = ""[0..0],
        .telemetry_socket_addr = ""[0..0],
        .telemetry_url = ""[0..0],
        .telemetry_attach_service_name = true,
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    telemetry_config.adopt(handle);
    telemetry_config.deinit();

    if (created.fail) |fail_ptr| {
        core.api.byte_array_free(handle.core_runtime, fail_ptr);
    }

    errors.setLastError(""[0..0]);
    return handle;
}

pub fn destroy(handle: ?*RuntimeHandle) void {
    if (handle == null) {
        return;
    }

    const runtime = handle.?;

    runtime.pending_lock.lock();
    runtime.destroying = true;
    while (runtime.pending_connects != 0) {
        runtime.pending_condition.wait(&runtime.pending_lock);
    }
    runtime.pending_lock.unlock();

    clearLoggerForHandle(runtime);

    if (runtime.core_runtime) |core_runtime_ptr| {
        core.api.runtime_free(core_runtime_ptr);
    }

    if (runtime.config.len > 0) {
        allocator.free(runtime.config);
    }

    if (runtime.logger_filter.len > 0) {
        allocator.free(runtime.logger_filter);
        runtime.logger_filter = ""[0..0];
    }

    freeTelemetryBuffers(runtime);

    allocator.destroy(runtime);
}

pub fn updateTelemetry(handle: ?*RuntimeHandle, options_json: []const u8) i32 {
    if (handle == null) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: runtime handle was null during telemetry update",
        });
        return -1;
    }

    const runtime = handle.?;

    runtime.pending_lock.lock();
    if (runtime.destroying or runtime.pending_connects != 0) {
        runtime.pending_lock.unlock();
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is busy; cannot update telemetry",
        });
        return -1;
    }
    runtime.destroying = true;
    runtime.pending_lock.unlock();
    defer {
        runtime.pending_lock.lock();
        runtime.destroying = false;
        runtime.pending_lock.unlock();
    }

    const existing_filter = if (runtime.logger_filter.len > 0)
        runtime.logger_filter
    else
        default_log_filter;

    var telemetry_config = parseTelemetryConfig(options_json, existing_filter, runtime) catch |err| {
        var scratch: [256]u8 = undefined;
        const message = switch (err) {
            TelemetryParseError.AllocationFailed => std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: failed to allocate telemetry configuration",
                .{},
            ) catch "temporal-bun-bridge-zig: failed to allocate telemetry configuration",
            TelemetryParseError.InvalidShape => std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: telemetry payload must be a JSON object",
                .{},
            ) catch "temporal-bun-bridge-zig: telemetry payload must be a JSON object",
            TelemetryParseError.MissingField => std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: telemetry configuration is missing a required field",
                .{},
            ) catch "temporal-bun-bridge-zig: telemetry configuration is missing a required field",
            TelemetryParseError.InvalidValue => std.fmt.bufPrint(
                &scratch,
                "temporal-bun-bridge-zig: telemetry configuration contains an invalid value",
                .{},
            ) catch "temporal-bun-bridge-zig: telemetry configuration contains an invalid value",
        };
        const code: i32 = switch (err) {
            TelemetryParseError.AllocationFailed => grpc.resource_exhausted,
            else => grpc.invalid_argument,
        };
        errors.setStructuredError(.{ .code = code, .message = message });
        return -1;
    };

    var logging_options = core.LoggingOptions{
        .filter = makeByteArrayRef(telemetry_config.filter_owned),
        .forward_to = forwardLogToBun,
    };

    var metrics_options_storage: core.MetricsOptions = undefined;
    var prometheus_options_storage: core.PrometheusOptions = undefined;
    var otel_options_storage: core.OpenTelemetryOptions = undefined;

    var telemetry_options = core.TelemetryOptions{
        .logging = &logging_options,
        .metrics = null,
    };

    switch (telemetry_config.mode) {
        .none => {},
        .prometheus => {
            prometheus_options_storage = .{
                .bind_address = makeByteArrayRef(telemetry_config.socket_addr),
                .counters_total_suffix = telemetry_config.prom_counters_total_suffix,
                .unit_suffix = telemetry_config.prom_unit_suffix,
                .durations_as_seconds = telemetry_config.prom_use_seconds,
                .histogram_bucket_overrides = makeByteArrayRef(telemetry_config.histogram_overrides),
            };

            metrics_options_storage = .{
                .opentelemetry = null,
                .prometheus = &prometheus_options_storage,
                .custom_meter = null,
                .attach_service_name = telemetry_config.attach_service_name,
                .global_tags = makeByteArrayRef(telemetry_config.global_tags),
                .metric_prefix = makeByteArrayRef(telemetry_config.metric_prefix),
            };

            telemetry_options.metrics = &metrics_options_storage;
        },
        .otlp => {
            otel_options_storage = .{
                .url = makeByteArrayRef(telemetry_config.url),
                .headers = makeByteArrayRef(telemetry_config.headers),
                .metric_periodicity_millis = telemetry_config.otel_metric_periodicity_millis,
                .metric_temporality = telemetry_config.otel_temporality,
                .durations_as_seconds = telemetry_config.otel_use_seconds,
                .protocol = telemetry_config.otel_protocol,
                .histogram_bucket_overrides = makeByteArrayRef(telemetry_config.histogram_overrides),
            };

            metrics_options_storage = .{
                .opentelemetry = &otel_options_storage,
                .prometheus = null,
                .custom_meter = null,
                .attach_service_name = telemetry_config.attach_service_name,
                .global_tags = makeByteArrayRef(telemetry_config.global_tags),
                .metric_prefix = makeByteArrayRef(telemetry_config.metric_prefix),
            };

            telemetry_options.metrics = &metrics_options_storage;
        },
    }

    var runtime_options = core.RuntimeOptions{
        .telemetry = &telemetry_options,
    };

    const created = core.api.runtime_new(&runtime_options);
    if (created.runtime == null) {
        const message_slice = byteArraySlice(created.fail orelse &fallback_error_array);
        const message = if (message_slice.len > 0)
            message_slice
        else
            "temporal-bun-bridge-zig: failed to create Temporal runtime";

        errors.setStructuredError(.{ .code = grpc.internal, .message = message });
        if (created.fail) |fail_ptr| {
            core.api.byte_array_free(null, fail_ptr);
        }
        telemetry_config.deinit();
        return -1;
    }

    const new_config_copy = allocator.alloc(u8, options_json.len) catch |alloc_err| {
        core.api.runtime_free(created.runtime.?);
        telemetry_config.deinit();
        var scratch: [128]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: failed to allocate telemetry payload: {}",
            .{alloc_err},
        ) catch "temporal-bun-bridge-zig: failed to allocate telemetry payload";
        errors.setStructuredError(.{ .code = grpc.resource_exhausted, .message = message });
        return -1;
    };
    @memcpy(new_config_copy, options_json);

    if (runtime.core_runtime) |old_runtime| {
        core.api.runtime_free(old_runtime);
    }
    runtime.core_runtime = created.runtime;

    if (runtime.config.len > 0) {
        allocator.free(runtime.config);
    }
    runtime.config = new_config_copy;

    telemetry_config.adopt(runtime);
    telemetry_config.deinit();

    if (created.fail) |fail_ptr| {
        core.api.byte_array_free(runtime.core_runtime, fail_ptr);
    }

    errors.setLastError(""[0..0]);
    return 0;
}

pub fn beginPendingClientConnect(handle: *RuntimeHandle) bool {
    handle.pending_lock.lock();
    defer handle.pending_lock.unlock();

    if (handle.destroying) {
        return false;
    }

    handle.pending_connects += 1;
    return true;
}

pub fn endPendingClientConnect(handle: *RuntimeHandle) void {
    handle.pending_lock.lock();
    defer handle.pending_lock.unlock();

    if (handle.pending_connects > 0) {
        handle.pending_connects -= 1;
    }

    if (handle.destroying and handle.pending_connects == 0) {
        handle.pending_condition.broadcast();
    }
}

pub fn setLogger(handle: ?*RuntimeHandle, callback_ptr: ?*anyopaque) i32 {
    if (handle == null) {
        errors.setStructuredError(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: runtime handle was null during logger installation",
        });
        return -1;
    }

    const runtime_handle = handle.?;

    logger_lock.lock();
    defer logger_lock.unlock();

    const current_owner = global_logger_owner.load(.seq_cst);

    if (callback_ptr == null) {
        if (current_owner) |owner| {
            if (owner == runtime_handle) {
                global_logger_callback.store(null, .seq_cst);
                global_logger_owner.store(null, .seq_cst);
            }
        }
        runtime_handle.logger_callback = null;
        errors.setLastError(""[0..0]);
        return 0;
    }

    if (runtime_handle.destroying) {
        errors.setStructuredError(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime is shutting down; cannot install logger",
        });
        return -1;
    }

    const callback = @as(LoggerCallback, @ptrFromInt(@intFromPtr(callback_ptr.?)));

    if (current_owner) |owner| {
        if (owner != runtime_handle) {
            errors.setStructuredError(.{
                .code = grpc.already_exists,
                .message = "temporal-bun-bridge-zig: a logger is already registered for another runtime",
            });
            return -1;
        }
    }

    runtime_handle.logger_callback = callback;
    global_logger_callback.store(callback, .seq_cst);
    global_logger_owner.store(runtime_handle, .seq_cst);

    errors.setLastError(""[0..0]);
    return 0;
}

pub export fn temporal_bun_runtime_test_emit_log(
    level_value: u32,
    target_ptr: ?[*]const u8,
    target_len: usize,
    message_ptr: ?[*]const u8,
    message_len: usize,
    timestamp_millis: u64,
    fields_ptr: ?[*]const u8,
    fields_len: usize,
) void {
    const callback = global_logger_callback.load(.acquire) orelse return;
    callback(
        level_value,
        target_ptr,
        target_len,
        message_ptr,
        message_len,
        timestamp_millis,
        fields_ptr,
        fields_len,
    );
}

test "parseTelemetryConfig preserves metrics when payload omits metricsExporter" {
    const initial_payload =
        "{\n"
        ++ "  \"logExporter\": { \"filter\": \"temporal_sdk_core=info\" },\n"
        ++ "  \"telemetry\": { \"metricPrefix\": \"bun_\", \"attachServiceName\": false },\n"
        ++ "  \"metricsExporter\": {\n"
        ++ "    \"type\": \"prometheus\",\n"
        ++ "    \"socketAddr\": \"127.0.0.1:0\",\n"
        ++ "    \"countersTotalSuffix\": true,\n"
        ++ "    \"unitSuffix\": true,\n"
        ++ "    \"useSecondsForDurations\": true,\n"
        ++ "    \"globalTags\": { \"env\": \"test\", \"platform\": \"bun\" },\n"
        ++ "    \"histogramBucketOverrides\": { \"temporal.metric\": [1, 2, 3] }\n"
        ++ "  }\n"
        ++ "}";

    var prepared = try parseTelemetryConfig(initial_payload, ""[0..0], null);
    defer prepared.deinit();

    var handle = RuntimeHandle{
        .id = 1,
        .config = ""[0..0],
        .core_runtime = null,
        .logger_callback = null,
        .logger_filter = ""[0..0],
        .telemetry_mode = .none,
        .telemetry_metric_prefix = ""[0..0],
        .telemetry_global_tags = ""[0..0],
        .telemetry_histogram_overrides = ""[0..0],
        .telemetry_headers = ""[0..0],
        .telemetry_socket_addr = ""[0..0],
        .telemetry_url = ""[0..0],
        .telemetry_attach_service_name = true,
        .telemetry_prom_counters_total_suffix = false,
        .telemetry_prom_unit_suffix = false,
        .telemetry_prom_use_seconds = false,
        .telemetry_otel_metric_periodicity_millis = 0,
        .telemetry_otel_use_seconds = false,
        .telemetry_otel_temporality = otel_temporality_cumulative,
        .telemetry_otel_protocol = otel_protocol_grpc,
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    prepared.adopt(&handle);
    defer {
        freeTelemetryBuffers(&handle);
        freeOwnedSlice(handle.logger_filter);
        handle.logger_filter = ""[0..0];
    }

    const update_payload =
        "{\n"
        ++ "  \"logExporter\": { \"filter\": \"temporal_sdk_core=debug\" }\n"
        ++ "}";

    var merged = try parseTelemetryConfig(update_payload, handle.logger_filter, &handle);
    defer merged.deinit();

    try std.testing.expectEqual(TelemetryMode.prometheus, merged.mode);
    try std.testing.expectEqualStrings("temporal_sdk_core=debug", merged.filter_owned);
    try std.testing.expectEqualStrings("bun_", merged.metric_prefix);
    try std.testing.expect(!merged.attach_service_name);
    try std.testing.expectEqualStrings("127.0.0.1:0", merged.socket_addr);
    try std.testing.expectEqualStrings("env\ntest\nplatform\nbun", merged.global_tags);
    try std.testing.expectEqualStrings("temporal.metric\n1,2,3", merged.histogram_overrides);
    try std.testing.expect(merged.prom_counters_total_suffix);
    try std.testing.expect(merged.prom_unit_suffix);
    try std.testing.expect(merged.prom_use_seconds);
}
