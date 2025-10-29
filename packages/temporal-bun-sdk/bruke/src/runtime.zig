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
    pending_lock: std.Thread.Mutex = .{},
    pending_condition: std.Thread.Condition = .{},
    pending_connects: usize = 0,
    destroying: bool = false,
};

var next_runtime_id: u64 = 1;

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

    var runtime_options = std.mem.zeroes(core.RuntimeOptions);
    var maybe_filter = parseLoggingFilter(options_json);
    var filter_owned: []u8 = ""[0..0];
    var filter_slice: []const u8 = default_log_filter;
    if (maybe_filter) |slice| {
        filter_owned = slice;
        filter_slice = slice;
        maybe_filter = null;
    }

    var logging_options = core.LoggingOptions{
        .filter = makeByteArrayRef(filter_slice),
        .forward_to = forwardLogToBun,
    };

    var telemetry_options = core.TelemetryOptions{
        .logging = &logging_options,
        .metrics = null,
    };

    runtime_options.telemetry = &telemetry_options;

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
        if (filter_owned.len > 0) {
            allocator.free(filter_owned);
        }
        allocator.free(copy);
        allocator.destroy(handle);
        return null;
    }

    handle.* = .{
        .id = id,
        .config = copy,
        .core_runtime = created.runtime,
        .logger_callback = null,
        .logger_filter = filter_owned,
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };
    filter_owned = ""[0..0];

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

    allocator.destroy(runtime);
}

pub fn updateTelemetry(handle: ?*RuntimeHandle, _options_json: []const u8) i32 {
    _ = handle;
    _ = _options_json;
    // TODO(codex, zig-runtime-02): Bridge telemetry configuration into Temporal core once the
    // upstream runtime exposes stable Prometheus/OTLP hooks.
    errors.setStructuredError(.{
        .code = grpc.unimplemented,
        .message = "temporal-bun-bridge-zig: runtime telemetry updates are not implemented yet",
    });
    return -1;
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
