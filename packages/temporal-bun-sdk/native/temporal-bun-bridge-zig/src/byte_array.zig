const std = @import("std");
const errors = @import("errors.zig");
const core = @import("core.zig");
const testing = std.testing;

// TODO(codex, zig-buf-02): Emit allocation telemetry and guardrails for Bun-facing buffers.

pub const ByteArray = core.ByteArray;

pub const AllocationSource = union(enum) {
    slice: []const u8,
    adopt_core: struct {
        byte_buf: ?*core.ByteBuf,
        destroy: ?core.ByteBufDestroyFn = null,
    },
};

const Ownership = union(enum) {
    duplicated,
    temporal_core: struct {
        byte_buf: ?*core.ByteBuf,
        destroy: ?core.ByteBufDestroyFn,
    },
};

const ManagedByteArray = struct {
    header: ByteArray,
    ownership: Ownership,
};

fn toManaged(array: *ByteArray) *ManagedByteArray {
    return @fieldParentPtr("header", array);
}

pub fn allocate(source: AllocationSource) ?*ByteArray {
    var allocator = std.heap.c_allocator;

    const container = allocator.create(ManagedByteArray) catch |err| {
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate byte array container: {}", .{err});
        return null;
    };

    switch (source) {
        .slice => |bytes| {
            if (bytes.len == 0) {
                container.* = .{
                    .header = .{
                        .data = null,
                        .size = 0,
                        .cap = 0,
                        .disable_free = false,
                    },
                    .ownership = .duplicated,
                };
                return &container.header;
            }

            const copy = allocator.alloc(u8, bytes.len) catch |err| {
                allocator.destroy(container);
                errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate byte array: {}", .{err});
                return null;
            };
            @memcpy(copy, bytes);

            container.* = .{
                .header = .{
                    .data = copy.ptr,
                    .size = bytes.len,
                    .cap = bytes.len,
                    .disable_free = false,
                },
                .ownership = .duplicated,
            };
        },
        .adopt_core => |adoption| {
            const buf = adoption.byte_buf;
            container.* = .{
                .header = if (buf) |byte_buf| .{
                    .data = byte_buf.data,
                    .size = byte_buf.size,
                    .cap = byte_buf.cap,
                    .disable_free = byte_buf.disable_free,
                } else .{
                    .data = null,
                    .size = 0,
                    .cap = 0,
                    .disable_free = false,
                },
                .ownership = .{ .temporal_core = .{
                    .byte_buf = buf,
                    .destroy = adoption.destroy,
                } },
            };
        },
    }

    return &container.header;
}

pub fn free(array: ?*ByteArray) void {
    if (array == null) {
        return;
    }

    var allocator = std.heap.c_allocator;
    const handle = array.?;
    const managed = toManaged(handle);

    switch (managed.ownership) {
        .duplicated => {
            if (handle.data) |ptr| {
                allocator.free(@constCast(ptr[0..handle.size]));
            }
        },
        .temporal_core => |adopted| {
            if (adopted.byte_buf) |buf| {
                if (adopted.destroy) |destroy_fn| {
                    destroy_fn(buf);
                }
            }
        },
    }

    allocator.destroy(managed);
}

pub fn allocateFromSlice(bytes: []const u8) ?*ByteArray {
    return allocate(.{ .slice = bytes });
}

pub fn adoptCoreByteBuf(byte_buf: ?*core.ByteBuf, destroy: ?core.ByteBufDestroyFn) ?*ByteArray {
    // Temporal core exposes runtime-scoped free hooks; callers can pass them here once wired.
    return allocate(.{ .adopt_core = .{ .byte_buf = byte_buf, .destroy = destroy } });
}

var destroy_call_count: usize = 0;

fn trackingDestroy(buf: ?*core.ByteBuf) void {
    destroy_call_count += 1;
    if (buf) |byte_buf| {
        byte_buf.data = null;
        byte_buf.size = 0;
        byte_buf.cap = 0;
    }
}

test "allocate duplicates slices into managed byte arrays" {
    destroy_call_count = 0;
    const payload = "temporal";
    const array_opt = allocate(.{ .slice = payload });
    try testing.expect(array_opt != null);
    const array_ptr = array_opt.?;

    try testing.expect(array_ptr.data != null);
    try testing.expect(array_ptr.data.? != payload.ptr);
    try testing.expectEqual(payload.len, array_ptr.size);
    try testing.expectEqual(payload.len, array_ptr.cap);
    try testing.expectEqualSlices(u8, payload, array_ptr.data.?[0..array_ptr.size]);

    // Freeing duplicated buffers should not trigger the core destructor hook.
    free(array_ptr);
    try testing.expectEqual(@as(usize, 0), destroy_call_count);
}

test "adopted core buffers reuse the underlying pointer and invoke destroy once" {
    destroy_call_count = 0;
    var storage = [_]u8{ 0xDE, 0xAD, 0xBE, 0xEF };
    var buf = core.ByteBuf{
        .data = &storage,
        .size = storage.len,
        .cap = storage.len,
        .disable_free = false,
    };

    const array_opt = allocate(.{ .adopt_core = .{ .byte_buf = &buf, .destroy = trackingDestroy } });
    try testing.expect(array_opt != null);
    const array_ptr = array_opt.?;

    try testing.expect(array_ptr.data != null);
    try testing.expect(array_ptr.data.? == &storage);
    try testing.expectEqual(buf.size, array_ptr.size);
    try testing.expectEqual(buf.cap, array_ptr.cap);

    const mutable_slice = @constCast(array_ptr.data.?[0..array_ptr.size]);
    mutable_slice[0] = 0xAA;
    try testing.expectEqual(@as(u8, 0xAA), storage[0]);

    free(array_ptr);
    try testing.expectEqual(@as(usize, 1), destroy_call_count);
    try testing.expect(buf.data == null);
    try testing.expectEqual(@as(usize, 0), buf.size);
    try testing.expectEqual(@as(usize, 0), buf.cap);
}

test "free skips destroy when temporal core provided no buffer" {
    destroy_call_count = 0;

    const array_opt = allocate(.{ .adopt_core = .{ .byte_buf = null, .destroy = trackingDestroy } });
    try testing.expect(array_opt != null);
    const array_ptr = array_opt.?;

    try testing.expectEqual(@as(?[*]const u8, null), array_ptr.data);
    try testing.expectEqual(@as(usize, 0), array_ptr.size);
    try testing.expectEqual(@as(usize, 0), array_ptr.cap);

    free(array_ptr);
    try testing.expectEqual(@as(usize, 0), destroy_call_count);
}
