const std = @import("std");

/// Very small error utility used by the Zig bridge stub while we bootstrap the real implementation.
/// The concrete Temporal error wiring will replace this once the Rust core hooks are in place.
const empty_bytes = [_]u8{};
const empty_slice = empty_bytes[0..];

pub const StructuredError = struct {
    code: i32,
    message: []const u8,
    details: ?[]const u8 = null,
};

var last_error: []u8 = empty_slice;
var error_mutex: std.Thread.Mutex = .{};

fn replaceLastErrorLocked(buffer: []u8) void {
    const allocator = std.heap.c_allocator;
    if (last_error.len > 0) {
        allocator.free(last_error);
    }
    last_error = buffer;
}

fn toHexDigit(value: u8) u8 {
    return if (value < 10) '0' + value else 'a' + (value - 10);
}

fn writeJsonString(buffer: *std.ArrayList(u8), allocator: std.mem.Allocator, text: []const u8) std.mem.Allocator.Error!void {
    try buffer.append(allocator, '"');
    for (text) |byte| {
        switch (byte) {
            '"' => try buffer.appendSlice(allocator, "\\\""),
            '\\' => try buffer.appendSlice(allocator, "\\\\"),
            '\n' => try buffer.appendSlice(allocator, "\\n"),
            '\r' => try buffer.appendSlice(allocator, "\\r"),
            '\t' => try buffer.appendSlice(allocator, "\\t"),
            else => {
                if (byte < 0x20) {
                    var escape: [6]u8 = .{ '\\', 'u', '0', '0', 0, 0 };
                    escape[4] = toHexDigit((byte >> 4) & 0x0F);
                    escape[5] = toHexDigit(byte & 0x0F);
                    try buffer.appendSlice(allocator, escape[0..]);
                } else {
                    try buffer.append(allocator, byte);
                }
            },
        }
    }
    try buffer.append(allocator, '"');
}

fn setLastErrorLocked(message: []const u8) void {
    const allocator = std.heap.c_allocator;

    if (last_error.len > 0) {
        allocator.free(last_error);
    }

    if (message.len == 0) {
        last_error = empty_slice;
        return;
    }

    const copy = allocator.alloc(u8, message.len) catch {
        last_error = empty_slice;
        return;
    };

    @memcpy(copy, message);
    last_error = copy;
}

fn setStructuredErrorLocked(payload: StructuredError) void {
    const allocator = std.heap.c_allocator;
    var buffer = std.ArrayList(u8){ .items = &.{}, .capacity = 0 };
    defer buffer.deinit(allocator);

    buffer.appendSlice(allocator, "{\"code\":") catch {
        setLastErrorLocked(payload.message);
        return;
    };

    var code_scratch: [32]u8 = undefined;
    const code_fragment = std.fmt.bufPrint(&code_scratch, "{d}", .{payload.code}) catch {
        setLastErrorLocked(payload.message);
        return;
    };

    buffer.appendSlice(allocator, code_fragment) catch {
        setLastErrorLocked(payload.message);
        return;
    };

    buffer.appendSlice(allocator, ",\"message\":") catch {
        setLastErrorLocked(payload.message);
        return;
    };

    writeJsonString(&buffer, allocator, payload.message) catch {
        setLastErrorLocked(payload.message);
        return;
    };

    if (payload.details) |details| {
        buffer.appendSlice(allocator, ",\"details\":") catch {
            setLastErrorLocked(payload.message);
            return;
        };
        writeJsonString(&buffer, allocator, details) catch {
            setLastErrorLocked(payload.message);
            return;
        };
    }

    buffer.append(allocator, '}') catch {
        setLastErrorLocked(payload.message);
        return;
    };

    const encoded = buffer.toOwnedSlice(allocator) catch {
        setLastErrorLocked(payload.message);
        return;
    };

    replaceLastErrorLocked(encoded);
}

fn setStructuredErrorJsonLocked(payload: StructuredError) void {
    setStructuredErrorLocked(payload);
    setLastErrorFmtLocked("{{\"code\":{d},\"message\":\"{s}\"}}", .{ payload.code, payload.message });
}

fn setLastErrorFmtLocked(comptime fmt: []const u8, args: anytype) void {
    const allocator = std.heap.c_allocator;
    const formatted = std.fmt.allocPrint(allocator, fmt, args) catch {
        setLastErrorLocked("temporal-bun-bridge-zig: failed to format error message");
        return;
    };

    defer allocator.free(formatted);
    setLastErrorLocked(formatted);
}

pub fn setLastError(message: []const u8) void {
    error_mutex.lock();
    defer error_mutex.unlock();
    setLastErrorLocked(message);
}

pub fn setStructuredError(payload: StructuredError) void {
    error_mutex.lock();
    defer error_mutex.unlock();
    setStructuredErrorLocked(payload);
}

pub fn setStructuredErrorJson(payload: StructuredError) void {
    error_mutex.lock();
    defer error_mutex.unlock();
    setStructuredErrorJsonLocked(payload);
}

pub fn setLastErrorFmt(comptime fmt: []const u8, args: anytype) void {
    error_mutex.lock();
    defer error_mutex.unlock();
    setLastErrorFmtLocked(fmt, args);
}

pub fn snapshot() []const u8 {
    error_mutex.lock();
    defer error_mutex.unlock();
    return last_error;
}

pub fn takeForFfi(len_ptr: ?*u64) ?[*]u8 {
    error_mutex.lock();
    defer error_mutex.unlock();

    if (len_ptr) |ptr| {
        ptr.* = @intCast(last_error.len);
    }

    if (last_error.len == 0) {
        return null;
    }

    const allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, last_error.len) catch {
        if (len_ptr) |ptr| {
            ptr.* = 0;
        }
        return null;
    };

    @memcpy(copy, last_error);
    return copy.ptr;
}

pub fn freeFfiBuffer(ptr: ?[*]u8, len: u64) void {
    if (ptr == null or len == 0) {
        return;
    }

    const allocator = std.heap.c_allocator;
    const slice_len: usize = @intCast(len);
    allocator.free(ptr.?[0..slice_len]);
}
