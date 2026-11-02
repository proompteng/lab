#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void delay_wal(int fd) {
    char descriptor[64], path[4096];
    if (access("/proof/armed", F_OK) != 0) return;
    snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", fd);
    ssize_t length = readlink(descriptor, path, sizeof(path) - 1);
    if (length < 0) return;
    path[length] = '\0';
    if (length < 4 || strcmp(path + length - 4, ".log") != 0) return;
    int marker = open("/proof/injected", O_CREAT | O_WRONLY | O_APPEND, 0600);
    if (marker < 0) _exit(91);
    if (write(marker, "wal-sync\n", 9) != 9) _exit(92);
    close(marker);
    struct timespec delay = { .tv_sec = 2, .tv_nsec = 0 };
    while (nanosleep(&delay, &delay) != 0) {}
}

int fsync(int fd) {
    int (*real_fsync)(int) = dlsym(RTLD_NEXT, "fsync");
    if (real_fsync == NULL) _exit(93);
    delay_wal(fd);
    return real_fsync(fd);
}

int fdatasync(int fd) {
    int (*real_fdatasync)(int) = dlsym(RTLD_NEXT, "fdatasync");
    if (real_fdatasync == NULL) _exit(94);
    delay_wal(fd);
    return real_fdatasync(fd);
}
