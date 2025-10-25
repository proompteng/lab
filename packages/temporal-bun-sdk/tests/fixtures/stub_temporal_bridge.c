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

void temporal_bun_worker_free(void *handle) {
  (void)handle;
}

void *temporal_bun_worker_poll_activity_task(void *worker) {
  (void)worker;
  return NULL;
}
