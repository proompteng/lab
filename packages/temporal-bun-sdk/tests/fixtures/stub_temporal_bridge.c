#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static const char *kNoError = "stub";
static const void *kClientPendingHandle = (void *)0xcafe;
static const void *kClientHandle = (void *)0xdeadbeef;
static const char *kSuccessNeedle = "7233";
static int32_t g_client_poll_status = -1;

static int payload_contains(const char *bytes, uint64_t len, const char *needle) {
  if (!bytes || !needle) {
    return 0;
  }
  size_t needle_len = strlen(needle);
  if (len < needle_len) {
    return 0;
  }
  for (uint64_t index = 0; index <= len - needle_len; index++) {
    if (memcmp(bytes + index, needle, needle_len) == 0) {
      return 1;
    }
  }
  return 0;
}

void *temporal_bun_runtime_new(void *payload, uint64_t len) {
  (void)payload;
  (void)len;
  return (void *)0x1;
}

void temporal_bun_runtime_free(void *handle) {
  (void)handle;
}

int32_t temporal_bun_runtime_update_telemetry(void *handle, void *payload, uint64_t len) {
  (void)handle;
  (void)payload;
  (void)len;
  return 0;
}

int32_t temporal_bun_runtime_set_logger(void *handle, void *callback) {
  (void)handle;
  (void)callback;
  return 0;
}

uint32_t temporal_bun_runtime_test_get_mode(void *handle) {
  (void)handle;
  return 0;
}

void *temporal_bun_runtime_test_get_metric_prefix(void *handle) {
  (void)handle;
  return NULL;
}

void *temporal_bun_runtime_test_get_socket_addr(void *handle) {
  (void)handle;
  return NULL;
}

int32_t temporal_bun_runtime_test_get_attach_service_name(void *handle) {
  (void)handle;
  return 1;
}

int32_t temporal_bun_runtime_test_register_client(void *handle) {
  (void)handle;
  return 1;
}

void temporal_bun_runtime_test_unregister_client(void *handle) {
  (void)handle;
}

int32_t temporal_bun_runtime_test_register_worker(void *handle) {
  (void)handle;
  return 1;
}

void temporal_bun_runtime_test_unregister_worker(void *handle) {
  (void)handle;
}

void temporal_bun_runtime_test_emit_log(uint32_t level, const char *target_ptr, uint64_t target_len, const char *message_ptr, uint64_t message_len, uint64_t timestamp_millis, const char *fields_ptr, uint64_t fields_len) {
  (void)level;
  (void)target_ptr;
  (void)target_len;
  (void)message_ptr;
  (void)message_len;
  (void)timestamp_millis;
  (void)fields_ptr;
  (void)fields_len;
}

uint64_t temporal_bun_runtime_test_get_pending_worker_count(void *handle) {
  (void)handle;
  return 4;
}

uint64_t temporal_bun_runtime_test_get_pending_queue_capacity(void *handle) {
  (void)handle;
  return 64;
}

const char *temporal_bun_error_message(uint64_t *len_out) {
  if (len_out) {
    *len_out = (uint64_t)strlen(kNoError);
  }
  return kNoError;
}

void temporal_bun_error_free(const char *ptr, uint64_t len) {
  (void)ptr;
  (void)len;
}

void *temporal_bun_client_connect_async(void *runtime, void *payload, uint64_t len) {
  (void)runtime;
  const char *bytes = (const char *)(payload);
  g_client_poll_status = payload_contains(bytes, len, kSuccessNeedle) ? 1 : -1;
  return (void *)kClientPendingHandle;
}

void temporal_bun_client_free(void *handle) {
  (void)handle;
}

void *temporal_bun_client_describe_namespace_async(void *client, void *payload, uint64_t len) {
  (void)client;
  (void)payload;
  (void)len;
  return (void *)0x3;
}

int32_t temporal_bun_client_update_headers(void *client, void *payload, uint64_t len) {
  (void)client;
  (void)payload;
  (void)len;
  return 0;
}

int32_t temporal_bun_pending_client_poll(void *handle) {
  (void)handle;
  return g_client_poll_status;
}

void *temporal_bun_pending_client_consume(void *handle) {
  (void)handle;
  if (g_client_poll_status != 1) {
    return NULL;
  }
  return (void *)kClientHandle;
}

void temporal_bun_pending_client_free(void *handle) {
  (void)handle;
}

int32_t temporal_bun_pending_byte_array_poll(void *handle) {
  (void)handle;
  return -1;
}

void *temporal_bun_pending_byte_array_consume(void *handle) {
  (void)handle;
  return NULL;
}

void temporal_bun_pending_byte_array_free(void *handle) {
  (void)handle;
}

void temporal_bun_byte_array_free(void *handle) {
  (void)handle;
}

void *temporal_bun_client_start_workflow(void *client, void *payload, uint64_t len) {
  (void)client;
  (void)payload;
  (void)len;
  return NULL;
}

void *temporal_bun_client_signal_with_start(void *client, void *payload, uint64_t len) {
  (void)client;
  (void)payload;
  (void)len;
  return NULL;
}

int32_t temporal_bun_client_terminate_workflow(void *client, void *payload, uint64_t len) {
  (void)client;
  (void)payload;
  (void)len;
  return 0;
}

void *temporal_bun_client_query_workflow(void *client, void *payload, uint64_t len) {
  (void)client;
  (void)payload;
  (void)len;
  return NULL;
}

void *temporal_bun_client_signal(void *client, void *payload, uint64_t len) {
  (void)client;
  (void)payload;
  (void)len;
  return NULL;
}

void *temporal_bun_client_cancel_workflow(void *client, void *payload, uint64_t len) {
  (void)client;
  (void)payload;
  (void)len;
  return NULL;
}

void *temporal_bun_worker_new(void *runtime, void *client, void *payload, uint64_t len) {
  (void)runtime;
  (void)client;
  (void)payload;
  (void)len;
  return (void *)0x4;
}

int32_t temporal_bun_worker_free(void *handle) {
  (void)handle;
  return 0;
}

void *temporal_bun_worker_poll_workflow_task(void *worker) {
  (void)worker;
  return NULL;
}

int32_t temporal_bun_worker_complete_workflow_task(void *worker, void *payload, uint64_t len) {
  (void)worker;
  (void)payload;
  (void)len;
  return 0;
}

void *temporal_bun_worker_poll_activity_task(void *worker) {
  (void)worker;
  return NULL;
}

void *temporal_bun_worker_test_handle_new(void) {
  return (void *)0x5;
}

void temporal_bun_worker_test_handle_release(void *handle) {
  (void)handle;
}
