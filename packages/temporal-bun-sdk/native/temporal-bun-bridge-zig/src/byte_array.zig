const std = @import("std");
const errors = @import("errors.zig");
const core = @import("core.zig");
const testing = std.testing;

// TODO(codex, zig-buf-01): Support zero-copy interop with Temporal core-owned buffers.

const AtomicOrdering = std.atomic.Ordering;
const AtomicU64 = std.atomic.Atomic(u64);

const MAX_BUFFER_CAPACITY: usize = 32 * 1024 * 1024;

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

pub const ByteArrayMetrics = extern struct {
    total_allocations: u64,
    current_allocations: u64,
    total_bytes: u64,
    current_bytes: u64,
    allocation_failures: u64,
    max_allocation_size: u64,
};

const Telemetry = struct {
    total_allocations: AtomicU64,
    current_allocations: AtomicU64,
    total_bytes: AtomicU64,
    current_bytes: AtomicU64,
    allocation_failures: AtomicU64,
    max_allocation_size: AtomicU64,

    fn init() Telemetry {
        return .{
            .total_allocations = AtomicU64.init(0),
            .current_allocations = AtomicU64.init(0),
            .total_bytes = AtomicU64.init(0),
            .current_bytes = AtomicU64.init(0),
            .allocation_failures = AtomicU64.init(0),
            .max_allocation_size = AtomicU64.init(0),
        };
    }
};

var telemetry = Telemetry.init();

fn recordFailure() void {
    _ = telemetry.allocation_failures.fetchAdd(1, .monotonic);
}

fn recordAllocation(len: usize) void {
    const size: u64 = @intCast(len);
    _ = telemetry.total_allocations.fetchAdd(1, .monotonic);
    _ = telemetry.current_allocations.fetchAdd(1, .monotonic);
    _ = telemetry.total_bytes.fetchAdd(size, .monotonic);
    _ = telemetry.current_bytes.fetchAdd(size, .monotonic);
    _ = telemetry.max_allocation_size.fetchMax(size, .monotonic);
}

fn clampSub(counter: *AtomicU64, value: u64) void {
    if (value == 0) {
        return;
    }

    const previous = counter.fetchSub(value, .monotonic);
    if (previous < value) {
        counter.store(0, .monotonic);
    }
}

fn recordFree(len: usize) void {
    clampSub(&telemetry.current_allocations, 1);
    const size: u64 = @intCast(len);
    clampSub(&telemetry.current_bytes, size);
}

pub fn metricsSnapshot() ByteArrayMetrics {
    return .{
        .total_allocations = telemetry.total_allocations.load(.acquire),
        .current_allocations = telemetry.current_allocations.load(.acquire),
        .total_bytes = telemetry.total_bytes.load(.acquire),
        .current_bytes = telemetry.current_bytes.load(.acquire),
        .allocation_failures = telemetry.allocation_failures.load(.acquire),
        .max_allocation_size = telemetry.max_allocation_size.load(.acquire),
    };
}

pub fn resetMetrics() void {
    const ordering = AtomicOrdering.release;
    telemetry.total_allocations.store(0, ordering);
    telemetry.current_allocations.store(0, ordering);
    telemetry.total_bytes.store(0, ordering);
    telemetry.current_bytes.store(0, ordering);
    telemetry.allocation_failures.store(0, ordering);
    telemetry.max_allocation_size.store(0, ordering);
}

pub fn allocate(source: AllocationSource) ?*ByteArray {
    var allocator = std.heap.c_allocator;

    const container = allocator.create(ManagedByteArray) catch |err| {
        recordFailure();
        errors.setLastErrorFmt("temporal-bun-bridge-zig: failed to allocate byte array container: {}", .{err});
        return null;
    };

    switch (source) {
        .slice => |bytes| {
            if (bytes.len > MAX_BUFFER_CAPACITY) {
                allocator.destroy(container);
                recordFailure();
                errors.setLastErrorFmt(
                    "temporal-bun-bridge-zig: requested byte array capacity {} exceeds guardrail ({} bytes)",
                    .{ bytes.len, MAX_BUFFER_CAPACITY },
                );
                return null;
            }

            if (bytes.len == 0) {
                container.* = .{
                    .header = .{
                        .data_ptr = null,
                        .len = 0,
                        .cap = 0,
                    },
                    .ownership = .duplicated,
                };
                recordAllocation(bytes.len);
                return &container.header;
            }

            const copy = allocator.alloc(u8, bytes.len) catch |err| {
                allocator.destroy(container);
                recordFailure();
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

            recordAllocation(bytes.len);
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
            recordFree(handle.cap);
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

test "free skips destroy when temporal core provided no buffer" {
    destroy_call_count = 0;

    const array_opt = allocate(.{ .adopt_core = .{ .byte_buf = null, .destroy = trackingDestroy } });
    try testing.expect(array_opt != null);
    const array_ptr = array_opt.?;

    try testing.expectEqual(@as(?[*]u8, null), array_ptr.data_ptr);
    try testing.expectEqual(@as(usize, 0), array_ptr.len);
    try testing.expectEqual(@as(usize, 0), array_ptr.cap);

    free(array_ptr);
    try testing.expectEqual(@as(usize, 0), destroy_call_count);
}

test "byte array metrics track allocation lifecycle" {
    resetMetrics();
    defer resetMetrics();

    const payload = "hello zig";
    const maybe_handle = allocateFromSlice(payload);
    try testing.expect(maybe_handle != null);
    const handle = maybe_handle.?;

    var snapshot = metricsSnapshot();
    try testing.expectEqual(@as(u64, payload.len), snapshot.total_bytes);
    try testing.expectEqual(@as(u64, payload.len), snapshot.current_bytes);
    try testing.expectEqual(@as(u64, 1), snapshot.total_allocations);
    try testing.expectEqual(@as(u64, 1), snapshot.current_allocations);
    try testing.expectEqual(@as(u64, 0), snapshot.allocation_failures);
    try testing.expectEqual(@as(u64, payload.len), snapshot.max_allocation_size);

    free(handle);
    snapshot = metricsSnapshot();
    try testing.expectEqual(@as(u64, 0), snapshot.current_allocations);
    try testing.expectEqual(@as(u64, 0), snapshot.current_bytes);
    try testing.expectEqual(@as(u64, payload.len), snapshot.total_bytes);
    try testing.expectEqual(@as(u64, 1), snapshot.total_allocations);
}

test "byte array allocation guardrail rejects oversize buffers" {
    resetMetrics();
    errors.setLastError("");

    const allocator = std.heap.c_allocator;
    const requested = MAX_BUFFER_CAPACITY + 1;
    const buffer = try allocator.alloc(u8, requested);
    defer allocator.free(buffer);

    const maybe_handle = allocateFromSlice(buffer);
    try testing.expect(maybe_handle == null);

    const snapshot = metricsSnapshot();
    try testing.expectEqual(@as(u64, 1), snapshot.allocation_failures);
    try testing.expectEqual(@as(u64, 0), snapshot.total_allocations);
    try testing.expectEqual(@as(u64, 0), snapshot.total_bytes);
    try testing.expectEqual(@as(u64, 0), snapshot.current_allocations);
    try testing.expectEqual(@as(u64, 0), snapshot.current_bytes);

    const message = errors.snapshot();
    try testing.expect(message.len > 0);
}

test "byte array metrics reset clears counters" {
    resetMetrics();

    const payload = "metrics-reset";
    const maybe_handle = allocateFromSlice(payload);
    try testing.expect(maybe_handle != null);
    free(maybe_handle.?);

    var snapshot = metricsSnapshot();
    try testing.expectEqual(@as(u64, 1), snapshot.total_allocations);
    try testing.expectEqual(@as(u64, payload.len), snapshot.total_bytes);

    resetMetrics();
    snapshot = metricsSnapshot();
    try testing.expectEqual(@as(u64, 0), snapshot.total_allocations);
    try testing.expectEqual(@as(u64, 0), snapshot.current_allocations);
    try testing.expectEqual(@as(u64, 0), snapshot.total_bytes);
    try testing.expectEqual(@as(u64, 0), snapshot.current_bytes);
    try testing.expectEqual(@as(u64, 0), snapshot.allocation_failures);
    try testing.expectEqual(@as(u64, 0), snapshot.max_allocation_size);
}
