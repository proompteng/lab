#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static const char *kNoError = "stub";

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
  (void)payload;
  (void)len;
  return (void *)0x2;
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
  return -1;
}

void *temporal_bun_pending_client_consume(void *handle) {
  (void)handle;
  return NULL;
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
