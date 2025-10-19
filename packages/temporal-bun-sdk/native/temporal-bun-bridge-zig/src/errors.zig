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

fn replaceLastError(buffer: []u8) void {
    const allocator = std.heap.c_allocator;
    if (last_error.len > 0) {
        allocator.free(last_error);
    }
    last_error = buffer;
}

pub fn setLastError(message: []const u8) void {
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

pub fn setStructuredError(payload: StructuredError) void {
    const allocator = std.heap.c_allocator;
    const Encodable = struct {
        code: i32,
        message: []const u8,
        details: ?[]const u8 = null,
    };

    const encodable = Encodable{
        .code = payload.code,
        .message = payload.message,
        .details = payload.details,
    };

    const encoded = std.json.stringifyAlloc(allocator, encodable, .{ .whitespace = .minified }) catch {
        // Fall back to the raw message if JSON encoding fails.
        setLastError(payload.message);
        return;
    };

    replaceLastError(encoded);
}

pub fn setLastErrorFmt(comptime fmt: []const u8, args: anytype) void {
    const allocator = std.heap.c_allocator;
    const formatted = std.fmt.allocPrint(allocator, fmt, args) catch {
        setLastError("temporal-bun-bridge-zig: failed to format error message");
        return;
    };

    defer allocator.free(formatted);
    setLastError(formatted);
}

pub fn snapshot() []const u8 {
    return last_error;
}

pub fn takeForFfi(len_ptr: ?*u64) ?[*]u8 {
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
