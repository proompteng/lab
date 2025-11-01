const std = @import("std");
const pending = @import("pending.zig");

const StressContext = struct {
    counter: *std.atomic.Value(u32),
};

fn stressTask(context_any: ?*anyopaque) void {
    const raw = context_any orelse return;
    const ctx = @as(*StressContext, @ptrCast(@alignCast(raw)));
    std.Thread.sleep(100 * std.time.ns_per_ms);
    _ = ctx.counter.fetchAdd(1, .seq_cst);
}

pub fn main() !void {
    const pid = std.c.getpid();
    std.debug.print("stress-start pid={d}\n", .{pid});

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var executor = pending.PendingExecutor{};
    try executor.init(allocator, .{
        .worker_count = pending.recommendedExecutorWorkerCount(),
        .queue_capacity = pending.recommendedExecutorWorkerCount() * 8,
    });
    defer executor.shutdown();

    const worker_count = executor.workerCount();
    const queue_capacity = executor.queueCapacity();

    var counter = std.atomic.Value(u32).init(0);
    const total: usize = queue_capacity * 2;
    const contexts = try allocator.alloc(StressContext, total);
    defer allocator.free(contexts);

    for (contexts) |*ctx| {
        ctx.* = .{ .counter = &counter };
    }

    std.debug.print(
        "stress-dispatch total={d} workers={d} queue={d}\n",
        .{ total, worker_count, queue_capacity },
    );

    for (contexts) |*ctx| {
        executor.submit(.{
            .run = stressTask,
            .context = @as(?*anyopaque, @ptrCast(@alignCast(ctx))),
        }) catch unreachable;
    }

    const expected: u32 = @intCast(total);
    var attempts: usize = 0;
    while (counter.load(.seq_cst) != expected and attempts < 5000) : (attempts += 1) {
        std.Thread.sleep(50 * std.time.ns_per_ms);
    }

    const completed = counter.load(.seq_cst);
    std.debug.print("stress-complete executed={d} attempts={d}\n", .{ completed, attempts });

    if (completed != expected) {
        return error.IncompleteExecution;
    }
}
