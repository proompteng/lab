const std = @import("std");
const builtin = @import("builtin");
const errors = @import("errors.zig");
const core = @import("core.zig");
const testing = std.testing;

const AtomicBool = std.atomic.Value(bool);
const AtomicU64 = std.atomic.Value(u64);
const AtomicUsize = std.atomic.Value(usize);

const Source = enum(u8) {
    slice,
    temporal_core,
};

const FailureReason = enum(u8) {
    container,
    buffer,
};

const source_count = std.meta.fields(Source).len;
const failure_count = std.meta.fields(FailureReason).len;

fn makeAtomicArrayU64(comptime count: usize) [count]AtomicU64 {
    var items: [count]AtomicU64 = undefined;
    inline for (&items) |*item| {
        item.* = AtomicU64.init(0);
    }
    return items;
}

fn makeAtomicArrayUsize(comptime count: usize) [count]AtomicUsize {
    var items: [count]AtomicUsize = undefined;
    inline for (&items) |*item| {
        item.* = AtomicUsize.init(0);
    }
    return items;
}

const MetricsState = struct {
    allocations: [source_count]AtomicU64,
    allocation_failures: [source_count][failure_count]AtomicU64,
    frees: [source_count]AtomicU64,
    double_free_preventions: [source_count]AtomicU64,
    active_buffers: AtomicUsize,

    fn init() MetricsState {
        return .{
            .allocations = makeAtomicArrayU64(source_count),
            .allocation_failures = initFailureCounters(),
            .frees = makeAtomicArrayU64(source_count),
            .double_free_preventions = makeAtomicArrayU64(source_count),
            .active_buffers = AtomicUsize.init(0),
        };
    }

    fn initFailureCounters() [source_count][failure_count]AtomicU64 {
        var outer: [source_count][failure_count]AtomicU64 = undefined;
        inline for (&outer) |*row| {
            row.* = makeAtomicArrayU64(failure_count);
        }
        return outer;
    }

    fn reset(self: *MetricsState) void {
        var source_idx: usize = 0;
        while (source_idx < source_count) : (source_idx += 1) {
            self.allocations[source_idx].store(0, .seq_cst);
            self.frees[source_idx].store(0, .seq_cst);
            self.double_free_preventions[source_idx].store(0, .seq_cst);

            var failure_idx: usize = 0;
            while (failure_idx < failure_count) : (failure_idx += 1) {
                self.allocation_failures[source_idx][failure_idx].store(0, .seq_cst);
            }
        }

        self.active_buffers.store(0, .seq_cst);
    }

    fn snapshot(self: *const MetricsState) MetricsSnapshot {
        var snap = MetricsSnapshot{};

        var alloc_idx: usize = 0;
        while (alloc_idx < source_count) : (alloc_idx += 1) {
            const source: Source = @enumFromInt(alloc_idx);
            const value = self.allocations[alloc_idx].load(.acquire);
            switch (source) {
                .slice => snap.sliceAllocations = value,
                .temporal_core => snap.coreAllocations = value,
            }
        }

        var failure_source_idx: usize = 0;
        while (failure_source_idx < source_count) : (failure_source_idx += 1) {
            const source: Source = @enumFromInt(failure_source_idx);
            var total: u64 = 0;
            var failure_idx: usize = 0;
            while (failure_idx < failure_count) : (failure_idx += 1) {
                const reason: FailureReason = @enumFromInt(failure_idx);
                const value = self.allocation_failures[failure_source_idx][failure_idx].load(.acquire);
                total += value;
                switch (source) {
                    .slice => switch (reason) {
                        .container => snap.sliceAllocationFailuresContainer = value,
                        .buffer => snap.sliceAllocationFailuresBuffer = value,
                    },
                    .temporal_core => switch (reason) {
                        .container => snap.coreAllocationFailuresContainer = value,
                        .buffer => snap.coreAllocationFailuresBuffer = value,
                    },
                }
            }
            switch (source) {
                .slice => snap.sliceAllocationFailures = total,
                .temporal_core => snap.coreAllocationFailures = total,
            }
        }

        var free_idx: usize = 0;
        while (free_idx < source_count) : (free_idx += 1) {
            const source: Source = @enumFromInt(free_idx);
            const value = self.frees[free_idx].load(.acquire);
            switch (source) {
                .slice => snap.sliceFrees = value,
                .temporal_core => snap.coreFrees = value,
            }
        }

        var double_free_idx: usize = 0;
        while (double_free_idx < source_count) : (double_free_idx += 1) {
            const source: Source = @enumFromInt(double_free_idx);
            const value = self.double_free_preventions[double_free_idx].load(.acquire);
            switch (source) {
                .slice => snap.sliceDoubleFreePreventions = value,
                .temporal_core => snap.coreDoubleFreePreventions = value,
            }
        }

        snap.activeBuffers = self.active_buffers.load(.acquire);
        snap.totalAllocations = snap.sliceAllocations + snap.coreAllocations;
        snap.totalAllocationFailures = snap.sliceAllocationFailures + snap.coreAllocationFailures;
        snap.totalFrees = snap.sliceFrees + snap.coreFrees;
        snap.doubleFreePreventions = snap.sliceDoubleFreePreventions + snap.coreDoubleFreePreventions;

        return snap;
    }
};

var metrics_state = MetricsState.init();

pub const MetricsSnapshot = struct {
    totalAllocations: u64 = 0,
    sliceAllocations: u64 = 0,
    coreAllocations: u64 = 0,
    totalAllocationFailures: u64 = 0,
    sliceAllocationFailures: u64 = 0,
    coreAllocationFailures: u64 = 0,
    sliceAllocationFailuresContainer: u64 = 0,
    sliceAllocationFailuresBuffer: u64 = 0,
    coreAllocationFailuresContainer: u64 = 0,
    coreAllocationFailuresBuffer: u64 = 0,
    totalFrees: u64 = 0,
    sliceFrees: u64 = 0,
    coreFrees: u64 = 0,
    doubleFreePreventions: u64 = 0,
    sliceDoubleFreePreventions: u64 = 0,
    coreDoubleFreePreventions: u64 = 0,
    activeBuffers: usize = 0,
};

const GuardEntry = struct {
    source: Source,
    freed: bool,
};

const GuardRegistry = struct {
    mutex: std.Thread.Mutex = .{},
    map: std.AutoHashMap(usize, GuardEntry),
    available: bool = true,

    fn init() GuardRegistry {
        return .{ .mutex = .{}, .map = std.AutoHashMap(usize, GuardEntry).init(std.heap.c_allocator), .available = true };
    }

    fn register(self: *GuardRegistry, ptr: *ByteArray, source: Source) void {
        self.mutex.lock();
        defer self.mutex.unlock();

        if (!self.available) {
            return;
        }

        const address = @intFromPtr(ptr);
        if (self.map.getPtr(address)) |entry| {
            entry.* = .{ .source = source, .freed = false };
            return;
        }

        self.map.put(address, .{ .source = source, .freed = false }) catch {
            self.available = false;
            self.map.clearRetainingCapacity();
            std.log.err("temporal-bun-bridge-zig: guard registry allocation failed; double-free protection disabled", .{});
        };
    }

    const GuardStatus = union(enum) {
        disabled,
        not_found,
        double_free: Source,
        ok: Source,
    };

    fn flagFreed(self: *GuardRegistry, ptr: *ByteArray) GuardStatus {
        self.mutex.lock();
        defer self.mutex.unlock();

        if (!self.available) {
            return .disabled;
        }

        const address = @intFromPtr(ptr);
        if (self.map.getPtr(address)) |entry| {
            const source = entry.source;
            if (entry.freed) {
                return .{ .double_free = source };
            }
            entry.freed = true;
            return .{ .ok = source };
        }

        return .not_found;
    }

    fn reset(self: *GuardRegistry) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.available = true;
        self.map.clearRetainingCapacity();
    }
};

var guard_registry = GuardRegistry.init();

const TelemetryHandles = struct {
    active: AtomicBool,
    ref_count: std.atomic.Value(u32),
    meter: ?*core.MetricMeter,
    allocation_metric: ?*core.Metric,
    allocation_attrs: [source_count]?*core.MetricAttributes,
    allocation_failure_metric: ?*core.Metric,
    allocation_failure_attrs: [source_count][failure_count]?*core.MetricAttributes,
    free_metric: ?*core.Metric,
    free_attrs: [source_count]?*core.MetricAttributes,
    double_free_metric: ?*core.Metric,
    double_free_attrs: [source_count]?*core.MetricAttributes,
    active_metric: ?*core.Metric,

    fn init() TelemetryHandles {
        return .{
            .active = AtomicBool.init(false),
            .ref_count = std.atomic.Value(u32).init(0),
            .meter = null,
            .allocation_metric = null,
            .allocation_attrs = [_]?*core.MetricAttributes{null} ** source_count,
            .allocation_failure_metric = null,
            .allocation_failure_attrs = initFailureAttrs(),
            .free_metric = null,
            .free_attrs = [_]?*core.MetricAttributes{null} ** source_count,
            .double_free_metric = null,
            .double_free_attrs = [_]?*core.MetricAttributes{null} ** source_count,
            .active_metric = null,
        };
    }

    fn initFailureAttrs() [source_count][failure_count]?*core.MetricAttributes {
        var outer: [source_count][failure_count]?*core.MetricAttributes = undefined;
        inline for (&outer) |*row| {
            row.* = [_]?*core.MetricAttributes{null} ** failure_count;
        }
        return outer;
    }
};

var telemetry_mutex: std.Thread.Mutex = .{};
var telemetry_handles = std.atomic.Value(?*TelemetryHandles).init(null);

fn byteArrayRef(slice: []const u8) core.ByteArrayRef {
    if (slice.len == 0) {
        return .{ .data = null, .size = 0 };
    }
    return .{ .data = slice.ptr, .size = slice.len };
}

fn metricAttributeForString(key: []const u8, value: []const u8) core.MetricAttribute {
    return .{
        .key = byteArrayRef(key),
        .value = .{ .string_value = .{ .data = value.ptr, .size = value.len } },
        .value_type = core.metric_attr_type_string,
    };
}

fn acquireTelemetryHandles() ?*TelemetryHandles {
    while (true) {
        const current = telemetry_handles.load(.acquire) orelse return null;
        if (!current.active.load(.acquire)) {
            std.Thread.yield() catch {};
            continue;
        }
        _ = current.ref_count.fetchAdd(1, .acq_rel);
        if (!current.active.load(.acquire)) {
            _ = current.ref_count.fetchSub(1, .acq_rel);
            continue;
        }
        return current;
    }
}

fn releaseTelemetryHandles(handles: *TelemetryHandles) void {
    _ = handles.ref_count.fetchSub(1, .acq_rel);
}

fn freeTelemetryHandles(handles: *TelemetryHandles) void {
    const alloc = std.heap.c_allocator;

    if (handles.allocation_metric) |metric| {
        core.metricFree(metric);
    }
    if (handles.allocation_failure_metric) |metric| {
        core.metricFree(metric);
    }
    if (handles.free_metric) |metric| {
        core.metricFree(metric);
    }
    if (handles.double_free_metric) |metric| {
        core.metricFree(metric);
    }
    if (handles.active_metric) |metric| {
        core.metricFree(metric);
    }

    inline for (handles.allocation_attrs) |maybe_attr| {
        if (maybe_attr) |attrs| {
            core.metricAttributesFree(attrs);
        }
    }

    inline for (handles.allocation_failure_attrs) |row| {
        inline for (row) |maybe_attr| {
            if (maybe_attr) |attrs| {
                core.metricAttributesFree(attrs);
            }
        }
    }

    inline for (handles.free_attrs) |maybe_attr| {
        if (maybe_attr) |attrs| {
            core.metricAttributesFree(attrs);
        }
    }

    inline for (handles.double_free_attrs) |maybe_attr| {
        if (maybe_attr) |attrs| {
            core.metricAttributesFree(attrs);
        }
    }

    if (handles.meter) |meter| {
        core.metricMeterFree(meter);
    }

    alloc.destroy(handles);
}

fn createTelemetryHandles(runtime_ptr: *core.RuntimeOpaque) !*TelemetryHandles {
    const alloc = std.heap.c_allocator;
    var handles = try alloc.create(TelemetryHandles);
    handles.* = TelemetryHandles.init();

    const meter = core.metricMeterNew(runtime_ptr) orelse return error.MeterUnavailable;
    handles.meter = meter;

    try configureMetricAllocations(handles, meter);
    try configureMetricAllocationFailures(handles, meter);
    try configureMetricFrees(handles, meter);
    try configureMetricDoubleFree(handles, meter);
    try configureMetricActive(handles, meter);

    return handles;
}

fn configureMetricAllocations(handles: *TelemetryHandles, meter: *core.MetricMeter) !void {
    const options = core.MetricOptions{
        .name = byteArrayRef("temporal_bun_byte_array_allocations_total"),
        .description = byteArrayRef("Count of Temporal Bun byte array allocations by source"),
        .unit = byteArrayRef("buffers"),
        .kind = core.metric_kind_counter_integer,
    };
    handles.allocation_metric = core.metricNew(meter, &options) orelse return error.MetricUnavailable;

    var source_idx: usize = 0;
    while (source_idx < source_count) : (source_idx += 1) {
        const source: Source = @enumFromInt(source_idx);
        const attr = [_]core.MetricAttribute{metricAttributeForString("source", sourceLabel(source))};
        handles.allocation_attrs[source_idx] = core.metricAttributesNew(meter, &attr) orelse return error.AttributeUnavailable;
    }
}

fn configureMetricAllocationFailures(handles: *TelemetryHandles, meter: *core.MetricMeter) !void {
    const options = core.MetricOptions{
        .name = byteArrayRef("temporal_bun_byte_array_allocation_failures_total"),
        .description = byteArrayRef("Count of Temporal Bun byte array allocation failures"),
        .unit = byteArrayRef("failures"),
        .kind = core.metric_kind_counter_integer,
    };
    handles.allocation_failure_metric = core.metricNew(meter, &options) orelse return error.MetricUnavailable;

    var source_idx2: usize = 0;
    while (source_idx2 < source_count) : (source_idx2 += 1) {
        const source: Source = @enumFromInt(source_idx2);
        var reason_idx: usize = 0;
        while (reason_idx < failure_count) : (reason_idx += 1) {
            const reason: FailureReason = @enumFromInt(reason_idx);
            const attrs = [_]core.MetricAttribute{
                metricAttributeForString("source", sourceLabel(source)),
                metricAttributeForString("reason", failureLabel(reason)),
            };
            handles.allocation_failure_attrs[source_idx2][reason_idx] =
                core.metricAttributesNew(meter, &attrs) orelse return error.AttributeUnavailable;
        }
    }
}

fn configureMetricFrees(handles: *TelemetryHandles, meter: *core.MetricMeter) !void {
    const options = core.MetricOptions{
        .name = byteArrayRef("temporal_bun_byte_array_frees_total"),
        .description = byteArrayRef("Count of Temporal Bun byte array frees by source"),
        .unit = byteArrayRef("buffers"),
        .kind = core.metric_kind_counter_integer,
    };
    handles.free_metric = core.metricNew(meter, &options) orelse return error.MetricUnavailable;

    var free_source_idx: usize = 0;
    while (free_source_idx < source_count) : (free_source_idx += 1) {
        const source: Source = @enumFromInt(free_source_idx);
        const attrs = [_]core.MetricAttribute{metricAttributeForString("source", sourceLabel(source))};
        handles.free_attrs[free_source_idx] = core.metricAttributesNew(meter, &attrs) orelse return error.AttributeUnavailable;
    }
}

fn configureMetricDoubleFree(handles: *TelemetryHandles, meter: *core.MetricMeter) !void {
    const options = core.MetricOptions{
        .name = byteArrayRef("temporal_bun_byte_array_double_free_total"),
        .description = byteArrayRef("Count of prevented Temporal Bun byte array double-free attempts"),
        .unit = byteArrayRef("events"),
        .kind = core.metric_kind_counter_integer,
    };
    handles.double_free_metric = core.metricNew(meter, &options) orelse return error.MetricUnavailable;

    var double_source_idx: usize = 0;
    while (double_source_idx < source_count) : (double_source_idx += 1) {
        const source: Source = @enumFromInt(double_source_idx);
        const attrs = [_]core.MetricAttribute{metricAttributeForString("source", sourceLabel(source))};
        handles.double_free_attrs[double_source_idx] =
            core.metricAttributesNew(meter, &attrs) orelse return error.AttributeUnavailable;
    }
}

fn configureMetricActive(handles: *TelemetryHandles, meter: *core.MetricMeter) !void {
    const options = core.MetricOptions{
        .name = byteArrayRef("temporal_bun_byte_array_active_buffers"),
        .description = byteArrayRef("Gauge of active Temporal Bun-managed byte arrays"),
        .unit = byteArrayRef("buffers"),
        .kind = core.metric_kind_gauge_integer,
    };
    handles.active_metric = core.metricNew(meter, &options) orelse return error.MetricUnavailable;
}

fn sourceLabel(source: Source) []const u8 {
    return switch (source) {
        .slice => "slice",
        .temporal_core => "temporal_core",
    };
}

fn failureLabel(reason: FailureReason) []const u8 {
    return switch (reason) {
        .container => "container",
        .buffer => "buffer",
    };
}

fn emitAllocation(source: Source, value: u64) void {
    if (value == 0) return;
    if (acquireTelemetryHandles()) |handles| {
        defer releaseTelemetryHandles(handles);
        if (handles.allocation_metric) |metric| {
            if (handles.allocation_attrs[@intFromEnum(source)]) |attrs| {
                core.metricRecordInteger(metric, value, attrs);
            }
        }
    }
}

fn emitAllocationFailure(source: Source, reason: FailureReason, value: u64) void {
    if (value == 0) return;
    if (acquireTelemetryHandles()) |handles| {
        defer releaseTelemetryHandles(handles);
        if (handles.allocation_failure_metric) |metric| {
            if (handles.allocation_failure_attrs[@intFromEnum(source)][@intFromEnum(reason)]) |attrs| {
                core.metricRecordInteger(metric, value, attrs);
            }
        }
    }
}

fn emitFree(source: Source, value: u64) void {
    if (value == 0) return;
    if (acquireTelemetryHandles()) |handles| {
        defer releaseTelemetryHandles(handles);
        if (handles.free_metric) |metric| {
            if (handles.free_attrs[@intFromEnum(source)]) |attrs| {
                core.metricRecordInteger(metric, value, attrs);
            }
        }
    }
}

fn emitDoubleFree(source: Source, value: u64) void {
    if (value == 0) return;
    if (acquireTelemetryHandles()) |handles| {
        defer releaseTelemetryHandles(handles);
        if (handles.double_free_metric) |metric| {
            if (handles.double_free_attrs[@intFromEnum(source)]) |attrs| {
                core.metricRecordInteger(metric, value, attrs);
            }
        }
    }
}

fn emitActive(value: usize) void {
    if (acquireTelemetryHandles()) |handles| {
        defer releaseTelemetryHandles(handles);
        if (handles.active_metric) |metric| {
            core.metricRecordInteger(metric, value, null);
        }
    }
}

fn configureTelemetryInternal(core_runtime: ?*core.RuntimeOpaque, telemetry_enabled: bool) void {
    telemetry_mutex.lock();
    defer telemetry_mutex.unlock();

    if (telemetry_handles.swap(null, .acq_rel)) |existing| {
        existing.active.store(false, .release);
        while (existing.ref_count.load(.acquire) != 0) {
            std.Thread.yield() catch {};
        }
        freeTelemetryHandles(existing);
    }

    if (!telemetry_enabled or core_runtime == null) {
        return;
    }

    const handles = createTelemetryHandles(core_runtime.?) catch |err| {
        std.log.err("temporal-bun-bridge-zig: failed to initialize byte array telemetry: {s}", .{@errorName(err)});
        return;
    };

    const snapshot_before = metrics_state.snapshot();
    emitInitialSnapshot(handles, snapshot_before);

    const snapshot_after = metrics_state.snapshot();
    emitDeltaSnapshot(handles, snapshot_before, snapshot_after);

    handles.active.store(true, .release);
    telemetry_handles.store(handles, .release);
}

fn emitInitialSnapshot(handles: *TelemetryHandles, snapshot: MetricsSnapshot) void {
    emitSnapshotWithHandles(handles, snapshot);
}

fn emitDeltaSnapshot(handles: *TelemetryHandles, before: MetricsSnapshot, after: MetricsSnapshot) void {
    emitSnapshotWithHandles(handles, snapshotDifference(before, after));
}

fn emitSnapshotWithHandles(handles: *TelemetryHandles, snapshot: MetricsSnapshot) void {
    if (snapshot.sliceAllocations > 0) {
        emitAllocationWithHandles(handles, .slice, snapshot.sliceAllocations);
    }
    if (snapshot.coreAllocations > 0) {
        emitAllocationWithHandles(handles, .temporal_core, snapshot.coreAllocations);
    }

    if (snapshot.sliceAllocationFailuresContainer > 0) {
        emitAllocationFailureWithHandles(handles, .slice, .container, snapshot.sliceAllocationFailuresContainer);
    }
    if (snapshot.sliceAllocationFailuresBuffer > 0) {
        emitAllocationFailureWithHandles(handles, .slice, .buffer, snapshot.sliceAllocationFailuresBuffer);
    }
    if (snapshot.coreAllocationFailuresContainer > 0) {
        emitAllocationFailureWithHandles(handles, .temporal_core, .container, snapshot.coreAllocationFailuresContainer);
    }
    if (snapshot.coreAllocationFailuresBuffer > 0) {
        emitAllocationFailureWithHandles(handles, .temporal_core, .buffer, snapshot.coreAllocationFailuresBuffer);
    }

    if (snapshot.sliceFrees > 0) {
        emitFreeWithHandles(handles, .slice, snapshot.sliceFrees);
    }
    if (snapshot.coreFrees > 0) {
        emitFreeWithHandles(handles, .temporal_core, snapshot.coreFrees);
    }

    if (snapshot.sliceDoubleFreePreventions > 0) {
        emitDoubleFreeWithHandles(handles, .slice, snapshot.sliceDoubleFreePreventions);
    }
    if (snapshot.coreDoubleFreePreventions > 0) {
        emitDoubleFreeWithHandles(handles, .temporal_core, snapshot.coreDoubleFreePreventions);
    }

    emitActiveWithHandles(handles, snapshot.activeBuffers);
}

fn emitAllocationWithHandles(handles: *TelemetryHandles, source: Source, value: u64) void {
    if (handles.allocation_metric) |metric| {
        if (handles.allocation_attrs[@intFromEnum(source)]) |attrs| {
            core.metricRecordInteger(metric, value, attrs);
        }
    }
}

fn emitAllocationFailureWithHandles(
    handles: *TelemetryHandles,
    source: Source,
    reason: FailureReason,
    value: u64,
) void {
    if (handles.allocation_failure_metric) |metric| {
        if (handles.allocation_failure_attrs[@intFromEnum(source)][@intFromEnum(reason)]) |attrs| {
            core.metricRecordInteger(metric, value, attrs);
        }
    }
}

fn emitFreeWithHandles(handles: *TelemetryHandles, source: Source, value: u64) void {
    if (handles.free_metric) |metric| {
        if (handles.free_attrs[@intFromEnum(source)]) |attrs| {
            core.metricRecordInteger(metric, value, attrs);
        }
    }
}

fn emitDoubleFreeWithHandles(handles: *TelemetryHandles, source: Source, value: u64) void {
    if (handles.double_free_metric) |metric| {
        if (handles.double_free_attrs[@intFromEnum(source)]) |attrs| {
            core.metricRecordInteger(metric, value, attrs);
        }
    }
}

fn emitActiveWithHandles(handles: *TelemetryHandles, value: usize) void {
    if (handles.active_metric) |metric| {
        core.metricRecordInteger(metric, value, null);
    }
}

fn snapshotDifference(before: MetricsSnapshot, after: MetricsSnapshot) MetricsSnapshot {
    return .{
        .totalAllocations = subtract(after.totalAllocations, before.totalAllocations),
        .sliceAllocations = subtract(after.sliceAllocations, before.sliceAllocations),
        .coreAllocations = subtract(after.coreAllocations, before.coreAllocations),
        .totalAllocationFailures = subtract(after.totalAllocationFailures, before.totalAllocationFailures),
        .sliceAllocationFailures = subtract(after.sliceAllocationFailures, before.sliceAllocationFailures),
        .coreAllocationFailures = subtract(after.coreAllocationFailures, before.coreAllocationFailures),
        .sliceAllocationFailuresContainer = subtract(after.sliceAllocationFailuresContainer, before.sliceAllocationFailuresContainer),
        .sliceAllocationFailuresBuffer = subtract(after.sliceAllocationFailuresBuffer, before.sliceAllocationFailuresBuffer),
        .coreAllocationFailuresContainer = subtract(after.coreAllocationFailuresContainer, before.coreAllocationFailuresContainer),
        .coreAllocationFailuresBuffer = subtract(after.coreAllocationFailuresBuffer, before.coreAllocationFailuresBuffer),
        .totalFrees = subtract(after.totalFrees, before.totalFrees),
        .sliceFrees = subtract(after.sliceFrees, before.sliceFrees),
        .coreFrees = subtract(after.coreFrees, before.coreFrees),
        .doubleFreePreventions = subtract(after.doubleFreePreventions, before.doubleFreePreventions),
        .sliceDoubleFreePreventions = subtract(after.sliceDoubleFreePreventions, before.sliceDoubleFreePreventions),
        .coreDoubleFreePreventions = subtract(after.coreDoubleFreePreventions, before.coreDoubleFreePreventions),
        .activeBuffers = subtract(after.activeBuffers, before.activeBuffers),
    };
}

fn subtract(a: anytype, b: @TypeOf(a)) @TypeOf(a) {
    return if (a >= b) a - b else 0;
}

fn allocator() std.mem.Allocator {
    if (builtin.is_test) {
        if (test_allocator_override) |override_allocator| {
            return override_allocator;
        }
    }
    return std.heap.c_allocator;
}

var test_allocator_override: ?std.mem.Allocator = null;

fn classifySource(source: AllocationSource) Source {
    return switch (source) {
        .slice => .slice,
        .adopt_core => .temporal_core,
    };
}

fn classifyOwnership(ownership: Ownership) Source {
    return switch (ownership) {
        .duplicated => .slice,
        .temporal_core => .temporal_core,
    };
}

fn incrementActive() usize {
    return metrics_state.active_buffers.fetchAdd(1, .acq_rel) + 1;
}

fn decrementActive() ?usize {
    var current = metrics_state.active_buffers.load(.acquire);
    while (true) {
        if (current == 0) {
            return null;
        }
        if (metrics_state.active_buffers.cmpxchgWeak(current, current - 1, .acq_rel, .acquire)) |next| {
            current = next;
            continue;
        }
        return current - 1;
    }
}

fn recordAllocationSuccess(source: Source) void {
    _ = metrics_state.allocations[@intFromEnum(source)].fetchAdd(1, .release);
    const active_value = incrementActive();
    emitAllocation(source, 1);
    emitActive(active_value);
}

fn recordAllocationFailure(source: Source, reason: FailureReason) void {
    _ = metrics_state.allocation_failures[@intFromEnum(source)][@intFromEnum(reason)].fetchAdd(1, .release);
    emitAllocationFailure(source, reason, 1);
}

fn recordFreeSuccess(source: Source) void {
    _ = metrics_state.frees[@intFromEnum(source)].fetchAdd(1, .release);
    if (decrementActive()) |value| {
        emitActive(value);
    } else {
        emitActive(0);
    }
    emitFree(source, 1);
}

fn recordDoubleFree(source: Source) void {
    _ = metrics_state.double_free_preventions[@intFromEnum(source)].fetchAdd(1, .release);
    emitDoubleFree(source, 1);
}

pub const ByteArray = extern struct {
    data: ?[*]const u8,
    size: usize,
    cap: usize,
    disable_free: bool,
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
    const alloc = allocator();
    const container = alloc.create(ManagedByteArray) catch |err| {
        recordAllocationFailure(classifySource(source), .container);
        errors.setLastErrorFmt(
            "temporal-bun-bridge-zig: failed to allocate byte array container: {}",
            .{err},
        );
        return null;
    };

    const classified = classifySource(source);

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
            } else {
                const copy = alloc.alloc(u8, bytes.len) catch |err| {
                    alloc.destroy(container);
                    recordAllocationFailure(classified, .buffer);
                    errors.setLastErrorFmt(
                        "temporal-bun-bridge-zig: failed to allocate byte array: {}",
                        .{err},
                    );
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
            }
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

    guard_registry.register(&container.header, classified);
    recordAllocationSuccess(classified);

    errors.setLastError(""[0..0]);
    return &container.header;
}

pub fn free(array: ?*ByteArray) void {
    if (array == null) {
        return;
    }

    const handle = array.?;

    switch (guard_registry.flagFreed(handle)) {
        .disabled => {
            freeWithoutGuard(handle);
        },
        .not_found => {
        std.log.warn(
            "temporal-bun-bridge-zig: byte array free invoked on untracked buffer (ptr=0x{x})",
            .{@intFromPtr(handle)},
        );
        recordDoubleFree(.slice);
        },
        .double_free => |source| {
            recordDoubleFree(source);
            std.log.warn(
                "temporal-bun-bridge-zig: double free prevented for byte array (ptr=0x{x}, source={s})",
                .{ @intFromPtr(handle), sourceLabel(source) },
            );
        },
        .ok => |source| {
            freeManaged(handle, source);
        },
    }
}

fn freeWithoutGuard(handle: *ByteArray) void {
    const managed = toManaged(handle);
    const source = classifyOwnership(managed.ownership);
    freeManaged(handle, source);
}

fn freeManaged(handle: *ByteArray, source: Source) void {
    const alloc = allocator();
    const managed = toManaged(handle);

    switch (managed.ownership) {
        .duplicated => {
            if (handle.data) |ptr| {
                alloc.free(@constCast(ptr)[0..handle.size]);
            }
        },
        .temporal_core => |adopted| {
            if (adopted.byte_buf) |buf| {
                if (adopted.destroy) |destroy_fn| {
                    destroy_fn(null, buf);
                }
            }
        },
    }

    recordFreeSuccess(source);

    alloc.destroy(managed);
}

pub fn allocateFromSlice(bytes: []const u8) ?*ByteArray {
    return allocate(.{ .slice = bytes });
}

pub fn adoptCoreByteBuf(byte_buf: ?*core.ByteBuf, destroy: ?core.ByteBufDestroyFn) ?*ByteArray {
    const resolved = destroy orelse core.api.byte_array_free;
    return allocate(.{ .adopt_core = .{ .byte_buf = byte_buf, .destroy = resolved } });
}

pub fn metricsSnapshot() MetricsSnapshot {
    return metrics_state.snapshot();
}

pub fn metricsSnapshotJson() ?*ByteArray {
    const snapshot = metrics_state.snapshot();
    const alloc = std.heap.c_allocator;
    const json_bytes = std.json.Stringify.valueAlloc(alloc, snapshot, .{}) catch {
        return null;
    };
    defer alloc.free(json_bytes);
    return allocate(.{ .slice = json_bytes });
}

pub fn resetMetricsForTest() void {
    if (!builtin.is_test) return;
    metrics_state.reset();
    guard_registry.reset();
    const alloc = allocator();
    _ = alloc; // silence unused in release builds.
}

pub fn configureTelemetry(core_runtime: ?*core.RuntimeOpaque, telemetry_enabled: bool) void {
    configureTelemetryInternal(core_runtime, telemetry_enabled);
}

pub fn testingOverrideAllocator(alloc: ?std.mem.Allocator) void {
    if (!builtin.is_test) return;
    test_allocator_override = alloc;
}

pub fn testingGuardRegistryAvailable() bool {
    return guard_registry.available;
}

pub fn testingInstallTelemetry(runtime_ptr: ?*core.RuntimeOpaque, telemetry_enabled: bool) void {
    configureTelemetryInternal(runtime_ptr, telemetry_enabled);
}

var destroy_call_count: usize = 0;

fn trackingDestroy(_runtime: ?*core.RuntimeOpaque, buf: ?*const core.ByteBuf) callconv(.c) void {
    _ = _runtime;
    destroy_call_count += 1;
    if (buf) |byte_buf| {
        const mutable = @constCast(byte_buf);
        mutable.data = null;
        mutable.size = 0;
        mutable.cap = 0;
    }
}

fn expectMetricsEqual(actual: MetricsSnapshot, expected: MetricsSnapshot) !void {
    try testing.expectEqual(expected.totalAllocations, actual.totalAllocations);
    try testing.expectEqual(expected.totalAllocationFailures, actual.totalAllocationFailures);
    try testing.expectEqual(expected.totalFrees, actual.totalFrees);
    try testing.expectEqual(expected.doubleFreePreventions, actual.doubleFreePreventions);
    try testing.expectEqual(expected.activeBuffers, actual.activeBuffers);
}

pub fn configureTelemetryForTest(runtime_ptr: ?*core.RuntimeOpaque, telemetry_enabled: bool) void {
    configureTelemetryInternal(runtime_ptr, telemetry_enabled);
}

fn recordInitialMetricsForTelemetry(handles: *TelemetryHandles) void {
    const snapshot = metrics_state.snapshot();
    emitSnapshotWithHandles(handles, snapshot);
}

fn recordOutstandingMetricsForTelemetry(handles: *TelemetryHandles, baseline: MetricsSnapshot) void {
    const after = metrics_state.snapshot();
    emitSnapshotWithHandles(handles, snapshotDifference(baseline, after));
}

pub fn metricsDifference(before: MetricsSnapshot, after: MetricsSnapshot) MetricsSnapshot {
    return snapshotDifference(before, after);
}

pub fn telemetryInstalled() bool {
    return telemetry_handles.load(.acquire) != null;
}

fn configureTelemetryFromRuntime(core_runtime: ?*core.RuntimeOpaque, telemetry_enabled: bool) void {
    configureTelemetryInternal(core_runtime, telemetry_enabled);
}

pub fn snapshotAsByteArray() ?*ByteArray {
    return metricsSnapshotJson();
}

pub const AllocationOutcome = enum {
    success,
    failure_container,
    failure_buffer,
};

fn recordFailureMetrics(source: Source, reason: FailureReason) void {
    recordAllocationFailure(source, reason);
}

pub fn currentActiveBuffers() usize {
    return metrics_state.active_buffers.load(.acquire);
}

pub fn guardRegistryAvailable() bool {
    guard_registry.mutex.lock();
    defer guard_registry.mutex.unlock();
    return guard_registry.available;
}

pub fn configureTelemetryForRuntime(core_runtime: ?*core.RuntimeOpaque, telemetry_enabled: bool) void {
    configureTelemetryInternal(core_runtime, telemetry_enabled);
}

pub fn telemetryHandlesInstalled() bool {
    return telemetry_handles.load(.acquire) != null;
}

pub fn doubleFreePreventionsFor(source: Source) u64 {
    return metrics_state.double_free_preventions[@intFromEnum(source)].load(.acquire);
}

pub fn activeCount() usize {
    return metrics_state.active_buffers.load(.acquire);
}

pub fn allocationCount(source: Source) u64 {
    return metrics_state.allocations[@intFromEnum(source)].load(.acquire);
}

test "allocate duplicates slices into managed byte arrays" {
    resetMetricsForTest();
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

    const snapshot = metricsSnapshot();
    try testing.expectEqual(@as(u64, 1), snapshot.totalAllocations);
    try testing.expectEqual(@as(usize, 1), snapshot.activeBuffers);

    free(array_ptr);
    try testing.expectEqual(@as(usize, 0), metricsSnapshot().activeBuffers);
    try testing.expectEqual(@as(usize, 0), destroy_call_count);
}

test "adopted core buffers reuse the underlying pointer and invoke destroy once" {
    resetMetricsForTest();
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

    @constCast(array_ptr.data.?)[0] = 0xAA;
    try testing.expectEqual(@as(u8, 0xAA), storage[0]);

    free(array_ptr);
    try testing.expectEqual(@as(usize, 1), destroy_call_count);
    try testing.expect(buf.data == null);
    try testing.expectEqual(@as(usize, 0), buf.size);
    try testing.expectEqual(@as(usize, 0), buf.cap);
}

test "allocation failure increments metrics and propagates null" {
    resetMetricsForTest();
    var backing: [@sizeOf(ManagedByteArray) - 1]u8 = undefined;
    var limited_allocator = std.heap.FixedBufferAllocator.init(&backing);
    testingOverrideAllocator(limited_allocator.allocator());
    defer testingOverrideAllocator(null);

    const result = allocate(.{ .slice = "abc" });
    try testing.expect(result == null);
    const snapshot = metricsSnapshot();
    try testing.expectEqual(@as(u64, 0), snapshot.totalAllocations);
    try testing.expectEqual(@as(u64, 1), snapshot.totalAllocationFailures);
}

test "double free detection increments metrics and logs" {
    resetMetricsForTest();
    const previous_level = std.testing.log_level;
    std.testing.log_level = .err;
    defer std.testing.log_level = previous_level;
    const array = allocate(.{ .slice = "guard" }) orelse return error.OutOfMemory;
    free(array);
    free(array);
    const snapshot = metricsSnapshot();
    try testing.expectEqual(@as(u64, 1), snapshot.doubleFreePreventions);
}

test "metrics snapshot json encodes counters" {
    resetMetricsForTest();
    const array = allocate(.{ .slice = "json" }) orelse return error.OutOfMemory;
    defer free(array);
    const json_ptr = metricsSnapshotJson() orelse return error.OutOfMemory;
    defer free(json_ptr);
    const slice = json_ptr.data.?[0..json_ptr.size];
    const parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, slice, .{});
    defer parsed.deinit();
    try testing.expect(parsed.value == .object);
}
