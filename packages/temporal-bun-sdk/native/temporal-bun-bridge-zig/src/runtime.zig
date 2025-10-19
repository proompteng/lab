const std = @import("std");
const errors = @import("errors.zig");
const core = @import("core.zig");

const json = std.json;
const mem = std.mem;
const fmt = std.fmt;
const JsonObject = json.ObjectMap;

const empty_bytes = [_]u8{};
const empty_slice = empty_bytes[0..];

/// Placeholder handle that mirrors the pointer-based interface exposed by the Rust bridge.
pub const RuntimeHandle = struct {
    id: u64,
    /// Raw JSON payload passed from TypeScript; retained until the Rust runtime wiring is complete.
    config: []u8,
    core_runtime: ?*core.RuntimeOpaque,
    telemetry_snapshot: []u8,
    telemetry_state: TelemetryState,
};

var next_runtime_id: u64 = 1;

const TelemetryError = error{
    ValidationFailed,
    OutOfMemory,
};

const TelemetryState = union(enum) {
    none,
    prometheus: PrometheusState,
    otlp: OtlpState,
};

const PrometheusState = struct {
    bind_address: []u8,
    counters_total_suffix: bool,
    unit_suffix: bool,
    use_seconds_for_durations: bool,
};

const OtlpState = struct {
    url: []u8,
    protocol: ?OtlpProtocol,
    metric_temporality: ?MetricTemporality,
    metric_periodicity_ms: ?u64,
    use_seconds_for_durations: bool,
};

const OtlpProtocol = enum {
    http,
    grpc,
};

const MetricTemporality = enum {
    cumulative,
    delta,
};

const TelemetryParseResult = struct {
    state: TelemetryState,

    pub fn init() TelemetryParseResult {
        return .{
            .state = .none,
        };
    }

    pub fn deinit(self: *TelemetryParseResult) void {
        freeTelemetryState(&self.state);
    }
};

fn freeTelemetryState(state: *TelemetryState) void {
    var allocator = std.heap.c_allocator;
    switch (state.*) {
        .none => {},
        .prometheus => |prom| {
            if (prom.bind_address.len > 0) {
                allocator.free(prom.bind_address);
            }
        },
        .otlp => |otlp| {
            if (otlp.url.len > 0) {
                allocator.free(otlp.url);
            }
        },
    }

    state.* = .none;
}

fn parseTelemetryOptions(allocator: mem.Allocator, options_json: []const u8) TelemetryError!TelemetryParseResult {
    if (options_json.len == 0) {
        errors.setLastError("temporal-bun-bridge-zig: telemetry payload must not be empty");
        return error.ValidationFailed;
    }

    var tree = json.parseFromSlice(json.Value, allocator, options_json, .{
        .duplicate_field_behavior = .use_first,
    }) catch |err| switch (err) {
        error.OutOfMemory => {
            errors.setLastError("temporal-bun-bridge-zig: failed to allocate telemetry payload");
            return error.OutOfMemory;
        },
        else => {
            errors.setLastErrorFmt(
                "temporal-bun-bridge-zig: invalid telemetry payload: {s}",
                .{@errorName(err)},
            );
            return error.ValidationFailed;
        },
    };
    defer tree.deinit();

    const metrics_value = blk: {
        switch (tree.value) {
            .object => |object| {
                if (object.get("metrics")) |value| {
                    break :blk value;
                }
                errors.setLastError("temporal-bun-bridge-zig: telemetry payload must include metrics configuration");
                return error.ValidationFailed;
            },
            else => {
                errors.setLastError("temporal-bun-bridge-zig: telemetry payload must be a JSON object");
                return error.ValidationFailed;
            },
        }
    };

    const metrics_object = switch (metrics_value) {
        .object => |object| object,
        else => {
            errors.setLastError("temporal-bun-bridge-zig: telemetry.metrics must be an object");
            return error.ValidationFailed;
        },
    };

    const type_value = metrics_object.get("type") orelse {
        errors.setLastError("temporal-bun-bridge-zig: telemetry.metrics.type is required");
        return error.ValidationFailed;
    };

    const type_str = try expectString("telemetry.metrics.type", type_value);

    var result = TelemetryParseResult.init();
    errdefer result.deinit();

    if (mem.eql(u8, type_str, "prometheus")) {
        result.state = try parsePrometheus(allocator, metrics_object);
    } else if (mem.eql(u8, type_str, "otlp")) {
        result.state = try parseOtlp(allocator, metrics_object);
    } else {
        errors.setLastErrorFmt(
            "temporal-bun-bridge-zig: unsupported telemetry exporter \"{s}\" (expected \"prometheus\" or \"otlp\")",
            .{type_str},
        );
        return error.ValidationFailed;
    }

    return result;
}

fn parsePrometheus(allocator: mem.Allocator, metrics: JsonObject) TelemetryError!TelemetryState {
    const bind_value = metrics.get("bindAddress") orelse {
        errors.setLastError("temporal-bun-bridge-zig: telemetry.metrics.bindAddress is required");
        return error.ValidationFailed;
    };

    const bind_str = try expectString("telemetry.metrics.bindAddress", bind_value);
    try validatePrometheusAddress(bind_str);

    const bind_copy = allocator.dupe(u8, bind_str) catch |err| switch (err) {
        error.OutOfMemory => {
            errors.setLastError("temporal-bun-bridge-zig: failed to allocate Prometheus bind address");
            return error.OutOfMemory;
        },
        else => return err,
    };
    errdefer allocator.free(bind_copy);

    const counters_total_suffix = try parseOptionalBool(metrics, "countersTotalSuffix", false);
    const unit_suffix = try parseOptionalBool(metrics, "unitSuffix", false);
    const use_seconds = try parseOptionalBool(metrics, "useSecondsForDurations", false);

    if (metrics.get("globalTags")) |tags_value| {
        try validateStringMap("telemetry.metrics.globalTags", tags_value);
    }

    if (metrics.get("histogramBucketOverrides")) |overrides_value| {
        try validateHistogramOverrides("telemetry.metrics.histogramBucketOverrides", overrides_value);
    }

    return TelemetryState{
        .prometheus = .{
            .bind_address = bind_copy,
            .counters_total_suffix = counters_total_suffix,
            .unit_suffix = unit_suffix,
            .use_seconds_for_durations = use_seconds,
        },
    };
}

fn parseOtlp(allocator: mem.Allocator, metrics: JsonObject) TelemetryError!TelemetryState {
    const url_value = metrics.get("url") orelse {
        errors.setLastError("temporal-bun-bridge-zig: telemetry.metrics.url is required");
        return error.ValidationFailed;
    };

    const url_str = try expectString("telemetry.metrics.url", url_value);
    try validateOtlpUrl(url_str);

    const url_copy = allocator.dupe(u8, url_str) catch |err| switch (err) {
        error.OutOfMemory => {
            errors.setLastError("temporal-bun-bridge-zig: failed to allocate OTLP collector URL");
            return error.OutOfMemory;
        },
        else => return err,
    };
    errdefer allocator.free(url_copy);

    if (metrics.get("headers")) |headers_value| {
        try validateStringMap("telemetry.metrics.headers", headers_value);
    }

    if (metrics.get("globalTags")) |tags_value| {
        try validateStringMap("telemetry.metrics.globalTags", tags_value);
    }

    if (metrics.get("histogramBucketOverrides")) |overrides_value| {
        try validateHistogramOverrides("telemetry.metrics.histogramBucketOverrides", overrides_value);
    }

    const use_seconds = try parseOptionalBool(metrics, "useSecondsForDurations", false);
    const protocol = try parseOptionalProtocol(metrics);
    const temporality = try parseOptionalMetricTemporality(metrics);
    const period_ms = try parseOptionalMetricPeriodicity(metrics);

    return TelemetryState{
        .otlp = .{
            .url = url_copy,
            .protocol = protocol,
            .metric_temporality = temporality,
            .metric_periodicity_ms = period_ms,
            .use_seconds_for_durations = use_seconds,
        },
    };
}

fn parseOptionalBool(metrics: JsonObject, field: []const u8, default_value: bool) TelemetryError!bool {
    if (metrics.get(field)) |value| {
        return switch (value) {
            .bool => |flag| flag,
            else => {
                errors.setLastErrorFmt(
                    "temporal-bun-bridge-zig: telemetry.metrics.{s} must be a boolean",
                    .{field},
                );
                return error.ValidationFailed;
            },
        };
    }

    return default_value;
}

fn parseOptionalMetricPeriodicity(metrics: JsonObject) TelemetryError!?u64 {
    if (metrics.get("metricPeriodicityMs")) |value| {
        return switch (value) {
            .integer => |int_val| {
                if (int_val <= 0) {
                    errors.setLastError("temporal-bun-bridge-zig: otlp.metricPeriodicityMs must be greater than zero");
                    return error.ValidationFailed;
                }
                return @as(u64, @intCast(int_val));
            },
            else => {
                errors.setLastError("temporal-bun-bridge-zig: otlp.metricPeriodicityMs must be an integer");
                return error.ValidationFailed;
            },
        };
    }

    return null;
}

fn parseOptionalProtocol(metrics: JsonObject) TelemetryError!?OtlpProtocol {
    if (metrics.get("protocol")) |value| {
        const value_str = try expectString("telemetry.metrics.protocol", value);
        if (mem.eql(u8, value_str, "http")) {
            return .http;
        }
        if (mem.eql(u8, value_str, "grpc")) {
            return .grpc;
        }

        errors.setLastErrorFmt(
            "temporal-bun-bridge-zig: otlp.protocol must be \"http\" or \"grpc\"; received \"{s}\"",
            .{value_str},
        );
        return error.ValidationFailed;
    }

    return null;
}

fn parseOptionalMetricTemporality(metrics: JsonObject) TelemetryError!?MetricTemporality {
    if (metrics.get("metricTemporality")) |value| {
        const value_str = try expectString("telemetry.metrics.metricTemporality", value);
        if (mem.eql(u8, value_str, "cumulative")) {
            return .cumulative;
        }
        if (mem.eql(u8, value_str, "delta")) {
            return .delta;
        }

        errors.setLastErrorFmt(
            "temporal-bun-bridge-zig: otlp.metricTemporality must be \"cumulative\" or \"delta\"; received \"{s}\"",
            .{value_str},
        );
        return error.ValidationFailed;
    }

    return null;
}

fn expectString(field_label: []const u8, value: json.Value) TelemetryError![]const u8 {
    return switch (value) {
        .string => |str| str,
        else => {
            errors.setLastErrorFmt(
                "temporal-bun-bridge-zig: {s} must be a string",
                .{field_label},
            );
            return error.ValidationFailed;
        },
    };
}

fn validateStringMap(field_label: []const u8, value: json.Value) TelemetryError!void {
    switch (value) {
        .object => |object| {
            var it = object.iterator();
            while (it.next()) |entry| {
                switch (entry.value_ptr.*) {
                    .string => {},
                    else => {
                        errors.setLastErrorFmt(
                            "temporal-bun-bridge-zig: {s} values must be strings",
                            .{field_label},
                        );
                        return error.ValidationFailed;
                    },
                }
            }
        },
        else => {
            errors.setLastErrorFmt(
                "temporal-bun-bridge-zig: {s} must be an object",
                .{field_label},
            );
            return error.ValidationFailed;
        },
    }
}

fn validateHistogramOverrides(field_label: []const u8, value: json.Value) TelemetryError!void {
    switch (value) {
        .object => |object| {
            var it = object.iterator();
            while (it.next()) |entry| {
                switch (entry.value_ptr.*) {
                    .array => |arr| {
                        for (arr.items) |item| {
                            switch (item) {
                                .float => {},
                                .integer => {},
                                else => {
                                    errors.setLastErrorFmt(
                                        "temporal-bun-bridge-zig: {s} buckets must be numeric",
                                        .{field_label},
                                    );
                                    return error.ValidationFailed;
                                },
                            }
                        }
                    },
                    else => {
                        errors.setLastErrorFmt(
                            "temporal-bun-bridge-zig: {s} entries must be numeric arrays",
                            .{field_label},
                        );
                        return error.ValidationFailed;
                    },
                }
            }
        },
        else => {
            errors.setLastErrorFmt(
                "temporal-bun-bridge-zig: {s} must be an object",
                .{field_label},
            );
            return error.ValidationFailed;
        },
    }
}

fn validatePrometheusAddress(address: []const u8) TelemetryError!void {
    if (address.len == 0) {
        errors.setLastError("temporal-bun-bridge-zig: prometheus.bindAddress must be non-empty");
        return error.ValidationFailed;
    }

    var host_slice: []const u8 = address;
    var port_slice: []const u8 = address;

    if (address[0] == '[') {
        const closing = mem.indexOfScalar(u8, address, ']') orelse {
            errors.setLastError("temporal-bun-bridge-zig: invalid Prometheus bind address: missing closing bracket");
            return error.ValidationFailed;
        };

        if (closing + 1 >= address.len or address[closing + 1] != ':') {
            errors.setLastError("temporal-bun-bridge-zig: invalid Prometheus bind address: missing port separator");
            return error.ValidationFailed;
        }

        host_slice = address[1..closing];
        port_slice = address[(closing + 2)..];
    } else {
        const colon_idx = mem.lastIndexOfScalar(u8, address, ':') orelse {
            errors.setLastError("temporal-bun-bridge-zig: prometheus.bindAddress must include host and port");
            return error.ValidationFailed;
        };

        host_slice = address[0..colon_idx];
        port_slice = address[colon_idx + 1 ..];
    }

    if (host_slice.len == 0 or port_slice.len == 0) {
        errors.setLastError("temporal-bun-bridge-zig: prometheus.bindAddress must include host and port");
        return error.ValidationFailed;
    }

    _ = fmt.parseInt(u16, port_slice, 10) catch {
        errors.setLastErrorFmt(
            "temporal-bun-bridge-zig: invalid Prometheus bind address: invalid port \"{s}\"",
            .{port_slice},
        );
        return error.ValidationFailed;
    };
}

fn validateOtlpUrl(url: []const u8) TelemetryError!void {
    if (url.len == 0) {
        errors.setLastError("temporal-bun-bridge-zig: otlp.url must be non-empty");
        return error.ValidationFailed;
    }

    const scheme_idx = mem.indexOfScalar(u8, url, ':') orelse {
        errors.setLastError("temporal-bun-bridge-zig: invalid OTLP collector URL: missing scheme");
        return error.ValidationFailed;
    };

    if (scheme_idx == 0) {
        errors.setLastError("temporal-bun-bridge-zig: invalid OTLP collector URL: missing scheme");
        return error.ValidationFailed;
    }

    if (scheme_idx + 2 >= url.len or url[scheme_idx + 1] != '/' or url[scheme_idx + 2] != '/') {
        errors.setLastError("temporal-bun-bridge-zig: invalid OTLP collector URL: missing authority");
        return error.ValidationFailed;
    }

    if (scheme_idx + 3 >= url.len) {
        errors.setLastError("temporal-bun-bridge-zig: invalid OTLP collector URL: missing host");
        return error.ValidationFailed;
    }
}

pub fn create(options_json: []const u8) ?*RuntimeHandle {
    var allocator = std.heap.c_allocator;

    const copy = allocator.alloc(u8, options_json.len) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate runtime config: {}", .{err});
        return null;
    };
    @memcpy(copy, options_json);

    const handle = allocator.create(RuntimeHandle) catch |err| {
        allocator.free(copy);
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate runtime handle: {}", .{err});
        return null;
    };

    const id = next_runtime_id;
    next_runtime_id += 1;

    handle.* = .{
        .id = id,
        .config = copy,
        .core_runtime = null,
        .telemetry_snapshot = empty_slice,
        .telemetry_state = .none,
    };

    // TODO(codex, zig-rt-01): Initialize the Temporal core runtime through the Rust C-ABI
    // (`temporal_sdk_core_runtime_new`) and store the opaque pointer on the handle.

    return handle;
}

pub fn destroy(handle: ?*RuntimeHandle) void {
    if (handle == null) {
        return;
    }

    var allocator = std.heap.c_allocator;
    const runtime = handle.?;

    // TODO(codex, zig-rt-02): Call into the Temporal core to drop the runtime (`runtime.free`).
    if (runtime.core_runtime) |_| {
        // The Zig bridge does not yet link against Temporal core; release will be wired in zig-rt-02.
    }

    if (runtime.config.len > 0) {
        allocator.free(runtime.config);
    }

    if (runtime.telemetry_snapshot.len > 0) {
        allocator.free(runtime.telemetry_snapshot);
    }

    freeTelemetryState(&runtime.telemetry_state);

    allocator.destroy(runtime);
}

pub fn updateTelemetry(handle: ?*RuntimeHandle, options_json: []const u8) i32 {
    if (handle == null) {
        errors.setLastError("temporal-bun-bridge-zig: runtime telemetry received null handle");
        return -1;
    }

    var allocator = std.heap.c_allocator;
    const runtime = handle.?;

    var parse_result = parseTelemetryOptions(allocator, options_json) catch |err| {
        if (errors.snapshot().len == 0) {
            switch (err) {
                error.OutOfMemory => errors.setLastError("temporal-bun-bridge-zig: telemetry allocation failed"),
                else => errors.setLastError("temporal-bun-bridge-zig: telemetry configuration failed"),
            }
        }
        return -1;
    };
    defer parse_result.deinit();

    if (runtime.core_runtime) |core_runtime| {
        var new_snapshot: []u8 = empty_slice;
        if (options_json.len > 0) {
            const copy = allocator.alloc(u8, options_json.len) catch {
                errors.setLastError("temporal-bun-bridge-zig: failed to allocate telemetry snapshot");
                return -1;
            };
            @memcpy(copy, options_json);
            new_snapshot = copy;
        }

        if (runtime.telemetry_snapshot.len > 0) {
            allocator.free(runtime.telemetry_snapshot);
        }

        freeTelemetryState(&runtime.telemetry_state);

        runtime.telemetry_snapshot = new_snapshot;
        runtime.telemetry_state = parse_result.state;
        parse_result.state = .none;

        // TODO(codex, zig-rt-03): Invoke Temporal core telemetry bridge once the core runtime wiring lands.
        _ = core_runtime; // suppress unused pointer until zig-rt-03 is implemented.

        return 0;
    }

    // The Zig bridge does not yet embed the Temporal core runtime. Surface an explicit error so callers
    // do not treat telemetry updates as successful until zig-rt-03 wires the C-ABI.
    errors.setLastError("temporal-bun-bridge-zig: runtime telemetry requires Temporal core runtime");
    return -1;
}

pub fn setLogger(handle: ?*RuntimeHandle, _callback_ptr: ?*anyopaque) i32 {
    // TODO(codex, zig-rt-04): Forward Temporal core log events through the provided Bun callback.
    _ = handle;
    _ = _callback_ptr;
    errors.setLastError("temporal-bun-bridge-zig: runtime logger installation is not implemented yet");
    return -1;
}
