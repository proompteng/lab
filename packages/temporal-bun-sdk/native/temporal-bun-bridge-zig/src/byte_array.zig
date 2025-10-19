const std = @import("std");
const errors = @import("errors.zig");
const core = @import("core.zig");
const testing = std.testing;

// TODO(codex, zig-buf-02): Emit allocation telemetry and guardrails for Bun-facing buffers.

pub const ByteArray = extern struct {
    data_ptr: ?[*]u8,
    len: usize,
    cap: usize,
};

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
                        .data_ptr = null,
                        .len = 0,
                        .cap = 0,
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
                    .data_ptr = copy.ptr,
                    .len = bytes.len,
                    .cap = bytes.len,
                },
                .ownership = .duplicated,
            };
        },
        .adopt_core => |adoption| {
            const buf = adoption.byte_buf;
            container.* = .{
                .header = if (buf) |byte_buf| .{
                    .data_ptr = byte_buf.data_ptr,
                    .len = byte_buf.len,
                    .cap = byte_buf.cap,
                } else .{
                    .data_ptr = null,
                    .len = 0,
                    .cap = 0,
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
            if (handle.data_ptr) |ptr| {
                allocator.free(ptr[0..handle.len]);
            }
        },
        .temporal_core => |adopted| {
            if (adopted.destroy) |destroy_fn| {
                destroy_fn(adopted.byte_buf);
            }
        },
    }

    allocator.destroy(managed);
}

pub fn allocateFromSlice(bytes: []const u8) ?*ByteArray {
    return allocate(.{ .slice = bytes });
}

pub fn adoptCoreByteBuf(byte_buf: ?*core.ByteBuf, destroy: ?core.ByteBufDestroyFn) ?*ByteArray {
    // Callers should pass core.api.byte_buffer_destroy once Temporal core headers are linked.
    const resolved = destroy orelse core.api.byte_buffer_destroy;
    return allocate(.{ .adopt_core = .{ .byte_buf = byte_buf, .destroy = resolved } });
}

var destroy_call_count: usize = 0;

fn trackingDestroy(buf: ?*core.ByteBuf) void {
    destroy_call_count += 1;
    if (buf) |byte_buf| {
        byte_buf.data_ptr = null;
        byte_buf.len = 0;
        byte_buf.cap = 0;
    }
}

test "allocate duplicates slices into managed byte arrays" {
    destroy_call_count = 0;
    const payload = "temporal";
    const array_opt = allocate(.{ .slice = payload });
    try testing.expect(array_opt != null);
    const array_ptr = array_opt.?;

    try testing.expect(array_ptr.data_ptr != null);
    try testing.expect(array_ptr.data_ptr.? != payload.ptr);
    try testing.expectEqual(payload.len, array_ptr.len);
    try testing.expectEqual(payload.len, array_ptr.cap);
    try testing.expectEqualSlices(u8, payload, array_ptr.data_ptr.?[0..array_ptr.len]);

    // Freeing duplicated buffers should not trigger the core destructor hook.
    free(array_ptr);
    try testing.expectEqual(@as(usize, 0), destroy_call_count);
}

test "adopted core buffers reuse the underlying pointer and invoke destroy once" {
    destroy_call_count = 0;
    var storage = [_]u8{ 0xDE, 0xAD, 0xBE, 0xEF };
    var buf = core.ByteBuf{
        .data_ptr = &storage,
        .len = storage.len,
        .cap = storage.len,
    };

    const array_opt = allocate(.{ .adopt_core = .{ .byte_buf = &buf, .destroy = trackingDestroy } });
    try testing.expect(array_opt != null);
    const array_ptr = array_opt.?;

    try testing.expect(array_ptr.data_ptr != null);
    try testing.expect(array_ptr.data_ptr.? == &storage);
    try testing.expectEqual(buf.len, array_ptr.len);
    try testing.expectEqual(buf.cap, array_ptr.cap);

    array_ptr.data_ptr.?[0] = 0xAA;
    try testing.expectEqual(@as(u8, 0xAA), storage[0]);

    free(array_ptr);
    try testing.expectEqual(@as(usize, 1), destroy_call_count);
    try testing.expect(buf.data_ptr == null);
    try testing.expectEqual(@as(usize, 0), buf.len);
    try testing.expectEqual(@as(usize, 0), buf.cap);
}
