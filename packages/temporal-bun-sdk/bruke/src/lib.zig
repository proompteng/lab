const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const byte_array = @import("byte_array.zig");
const pending = @import("pending.zig");
const worker = @import("worker.zig");
const test_helpers = @import("test_helpers.zig");

fn sliceFrom(ptr: ?[*]const u8, len: u64) []const u8 {
    if (ptr == null or len == 0) {
        return ""[0..0];
    }

    const size: usize = @intCast(len);
    return ptr.?[0..size];
}

fn toPendingHandle(ptr: ?*anyopaque) ?*pending.PendingHandle {
    return if (ptr) |nonNull| @as(?*pending.PendingHandle, @ptrCast(@alignCast(nonNull))) else null;
}

pub export fn temporal_bun_runtime_new(payload_ptr: ?[*]const u8, len: u64) ?*runtime.RuntimeHandle {
    const payload = sliceFrom(payload_ptr, len);
    return runtime.create(payload);
}

pub export fn temporal_bun_runtime_free(handle: ?*runtime.RuntimeHandle) void {
    runtime.destroy(handle);
}

pub export fn temporal_bun_runtime_update_telemetry(
    runtime_ptr: ?*runtime.RuntimeHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return runtime.updateTelemetry(runtime_ptr, payload);
}

pub export fn temporal_bun_runtime_set_logger(
    runtime_ptr: ?*runtime.RuntimeHandle,
    callback_ptr: ?*anyopaque,
) i32 {
    return runtime.setLogger(runtime_ptr, callback_ptr);
}

pub export fn temporal_bun_runtime_test_get_mode(handle: ?*runtime.RuntimeHandle) u32 {
    return runtime.telemetryModeForTest(handle);
}

pub export fn temporal_bun_runtime_test_get_metric_prefix(handle: ?*runtime.RuntimeHandle) ?*byte_array.ByteArray {
    return runtime.telemetryMetricPrefixForTest(handle);
}

pub export fn temporal_bun_runtime_test_get_socket_addr(handle: ?*runtime.RuntimeHandle) ?*byte_array.ByteArray {
    return runtime.telemetrySocketAddrForTest(handle);
}

pub export fn temporal_bun_runtime_test_get_attach_service_name(handle: ?*runtime.RuntimeHandle) i32 {
    return if (runtime.telemetryAttachServiceNameForTest(handle)) 1 else 0;
}

pub export fn temporal_bun_runtime_test_get_pending_worker_count(handle: ?*runtime.RuntimeHandle) usize {
    return runtime.pendingExecutorWorkerCountForTest(handle);
}

pub export fn temporal_bun_runtime_test_get_pending_queue_capacity(handle: ?*runtime.RuntimeHandle) usize {
    return runtime.pendingExecutorQueueCapacityForTest(handle);
}

pub export fn temporal_bun_runtime_test_get_byte_array_metrics() ?*byte_array.ByteArray {
    return byte_array.metricsSnapshotJson();
}

pub export fn temporal_bun_runtime_test_reset_byte_array_metrics() void {
    byte_array.resetMetricsForTest();
}

pub export fn temporal_bun_byte_array_test_allocate_from_slice(payload_ptr: ?[*]const u8, len: u64) ?*byte_array.ByteArray {
    const payload = sliceFrom(payload_ptr, len);
    return byte_array.allocateFromSlice(payload);
}

pub export fn temporal_bun_byte_array_test_free(array: ?*byte_array.ByteArray) void {
    byte_array.free(array);
}

pub export fn temporal_bun_runtime_test_register_client(handle: ?*runtime.RuntimeHandle) i32 {
    return if (runtime.registerClientForTest(handle)) 1 else 0;
}

pub export fn temporal_bun_runtime_test_unregister_client(handle: ?*runtime.RuntimeHandle) void {
    runtime.unregisterClientForTest(handle);
}

pub export fn temporal_bun_runtime_test_register_worker(handle: ?*runtime.RuntimeHandle) i32 {
    return if (runtime.registerWorkerForTest(handle)) 1 else 0;
}

pub export fn temporal_bun_runtime_test_unregister_worker(handle: ?*runtime.RuntimeHandle) void {
    runtime.unregisterWorkerForTest(handle);
}

pub export fn temporal_bun_error_message(len_ptr: ?*u64) ?[*]u8 {
    return errors.takeForFfi(len_ptr);
}

pub export fn temporal_bun_error_free(ptr: ?[*]u8, len: u64) void {
    errors.freeFfiBuffer(ptr, len);
}

pub export fn temporal_bun_client_connect_async(
    runtime_ptr: ?*runtime.RuntimeHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.connectAsync(runtime_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_free(handle: ?*client.ClientHandle) void {
    client.destroy(handle);
}

pub export fn temporal_bun_client_describe_namespace_async(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.describeNamespaceAsync(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_update_headers(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return client.updateHeaders(client_ptr, payload);
}

pub export fn temporal_bun_pending_client_poll(_handle: ?*anyopaque) i32 {
    const handle = toPendingHandle(_handle);
    return pending.poll(handle);
}

pub export fn temporal_bun_pending_client_consume(_handle: ?*anyopaque) ?*client.ClientHandle {
    const handle = toPendingHandle(_handle);
    if (pending.consume(handle)) |payload| {
        return @as(?*client.ClientHandle, @ptrCast(@alignCast(payload)));
    }
    return null;
}

pub export fn temporal_bun_pending_client_free(_handle: ?*anyopaque) void {
    const handle = toPendingHandle(_handle);
    pending.free(handle);
}

pub export fn temporal_bun_pending_byte_array_poll(_handle: ?*anyopaque) i32 {
    const handle = toPendingHandle(_handle);
    return pending.poll(handle);
}

pub export fn temporal_bun_pending_byte_array_consume(_handle: ?*anyopaque) ?*byte_array.ByteArray {
    const handle = toPendingHandle(_handle);
    if (pending.consume(handle)) |payload| {
        return @as(?*byte_array.ByteArray, @ptrCast(@alignCast(payload)));
    }
    return null;
}

pub export fn temporal_bun_pending_byte_array_free(_handle: ?*anyopaque) void {
    const handle = toPendingHandle(_handle);
    pending.free(handle);
}

pub export fn temporal_bun_byte_array_free(handle: ?*byte_array.ByteArray) void {
    byte_array.free(handle);
}

pub export fn temporal_bun_client_start_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*byte_array.ByteArray {
    const payload = sliceFrom(payload_ptr, len);
    return client.startWorkflow(client_ptr, payload);
}

pub export fn temporal_bun_client_terminate_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return client.terminateWorkflow(client_ptr, payload);
}

pub export fn temporal_bun_client_signal_with_start(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*byte_array.ByteArray {
    const payload = sliceFrom(payload_ptr, len);
    return client.signalWithStart(client_ptr, payload);
}

pub export fn temporal_bun_client_query_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.queryWorkflow(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_signal(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.signalWorkflow(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_cancel_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.cancelWorkflow(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_worker_new(
    runtime_ptr: ?*runtime.RuntimeHandle,
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*worker.WorkerHandle {
    const payload = sliceFrom(payload_ptr, len);
    return worker.create(runtime_ptr, client_ptr, payload);
}

pub export fn temporal_bun_worker_free(handle: ?*worker.WorkerHandle) i32 {
    return worker.destroy(handle);
}

pub export fn temporal_bun_worker_poll_workflow_task(handle: ?*worker.WorkerHandle) ?*anyopaque {
    if (worker.pollWorkflowTask(handle)) |pending_handle| {
        return @as(?*anyopaque, @ptrCast(pending_handle));
    }
    return null;
}

pub export fn temporal_bun_worker_complete_workflow_task(
    handle: ?*worker.WorkerHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    if (len > 0 and payload_ptr == null) {
        errors.setLastError("temporal-bun-bridge-zig: worker completion payload pointer was null");
        return -1;
    }
    const payload = sliceFrom(payload_ptr, len);
    return worker.completeWorkflowTask(handle, payload);
}

pub export fn temporal_bun_worker_poll_activity_task(handle: ?*worker.WorkerHandle) ?*anyopaque {
    if (worker.pollActivityTask(handle)) |pending_handle| {
        return @as(?*anyopaque, @ptrCast(pending_handle));
    }
    return null;
}

pub export fn temporal_bun_worker_complete_activity_task(
    handle: ?*worker.WorkerHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return worker.completeActivityTask(handle, payload);
}

pub export fn temporal_bun_worker_record_activity_heartbeat(
    handle: ?*worker.WorkerHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return worker.recordActivityHeartbeat(handle, payload);
}

pub export fn temporal_bun_worker_initiate_shutdown(handle: ?*worker.WorkerHandle) i32 {
    return worker.initiateShutdown(handle);
}

pub export fn temporal_bun_worker_finalize_shutdown(handle: ?*worker.WorkerHandle) i32 {
    return worker.finalizeShutdown(handle);
}

pub export fn temporal_bun_test_worker_install_poll_stub() void {
    test_helpers.installWorkerPollStub();
}

pub export fn temporal_bun_test_worker_install_completion_stub() void {
    test_helpers.installWorkerCompletionStub();
}

pub export fn temporal_bun_test_worker_set_poll_payload(payload_ptr: ?[*]const u8, len: u64) i32 {
    const size: usize = @intCast(len);
    const slice = if (size == 0 or payload_ptr == null)
        ""[0..0]
    else
        payload_ptr.?[0..size];
    return test_helpers.setWorkerPollWorkflowSuccessPayload(slice);
}

pub export fn temporal_bun_test_worker_take_completion_payload() ?*byte_array.ByteArray {
    return test_helpers.takeWorkerCompletionPayload();
}

pub export fn temporal_bun_test_worker_completion_count() usize {
    return test_helpers.workerCompletionCount();
}

pub export fn temporal_bun_test_worker_completion_size() usize {
    return test_helpers.workerCompletionSize();
}

pub export fn temporal_bun_test_worker_consume_completion(dest_ptr: ?[*]u8, len: u64) i32 {
    const size: usize = @intCast(len);
    return test_helpers.consumeWorkerCompletion(dest_ptr, size);
}

pub export fn temporal_bun_test_worker_set_mode(mode: u8) i32 {
    const converted = std.meta.intToEnum(test_helpers.PollMode, mode) catch {
        return -1;
    };
    test_helpers.setWorkerPollMode(converted);
    return 0;
}

pub export fn temporal_bun_test_worker_handle() ?*worker.WorkerHandle {
    return test_helpers.workerHandle();
}

pub export fn temporal_bun_test_worker_reset() void {
    test_helpers.resetWorkerState();
}

pub export fn temporal_bun_worker_test_handle_new() ?*worker.WorkerHandle {
    return worker.createTestHandle();
}

pub export fn temporal_bun_worker_test_handle_release(handle: ?*worker.WorkerHandle) void {
    worker.releaseTestHandle(handle);
}

test {
    _ = @import("client_describe_namespace_test.zig");
}
