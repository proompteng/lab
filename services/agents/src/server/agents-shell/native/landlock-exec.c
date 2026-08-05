#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/landlock.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

static void die(const char *message) {
  fprintf(stderr, "agents-shell-landlock: %s: %s\n", message, strerror(errno));
  exit(126);
}

static unsigned long long handled_access_for_abi(int abi) {
  unsigned long long access = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
                              LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |
                              LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
                              LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
                              LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) access |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) access |= LANDLOCK_ACCESS_FS_TRUNCATE;
  return access;
}

static void add_path_rule(int ruleset_fd, const char *path, unsigned long long allowed_access) {
  int path_fd = open(path, O_PATH | O_CLOEXEC);
  if (path_fd < 0) die(path);

  struct landlock_path_beneath_attr rule = {
      .allowed_access = allowed_access,
      .parent_fd = path_fd,
  };
  if (syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) {
    close(path_fd);
    die("landlock_add_rule");
  }
  close(path_fd);
}

static unsigned long parse_id(const char *value, const char *name) {
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') {
    fprintf(stderr, "agents-shell-landlock: invalid %s: %s\n", name, value);
    exit(126);
  }
  return parsed;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--check") == 0) {
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 3) {
      fprintf(stderr, "agents-shell-landlock: Landlock ABI 3+ required, got %d\n", abi);
      return 1;
    }
    printf("landlock-abi=%d\n", abi);
    return 0;
  }

  uid_t uid = 0;
  gid_t gid = 0;
  pid_t parent_pid = 0;
  int cwd_fd = -1;
  int have_uid = 0;
  int have_gid = 0;
  int have_parent_pid = 0;
  int have_cwd_fd = 0;
  const char *write_roots[32];
  size_t write_root_count = 0;
  const char *write_files[16];
  size_t write_file_count = 0;
  int read_only = 0;
  int command_index = -1;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      command_index = i + 1;
      break;
    }
    if (strcmp(argv[i], "--uid") == 0 && i + 1 < argc) {
      uid = (uid_t)parse_id(argv[++i], "uid");
      have_uid = 1;
      continue;
    }
    if (strcmp(argv[i], "--gid") == 0 && i + 1 < argc) {
      gid = (gid_t)parse_id(argv[++i], "gid");
      have_gid = 1;
      continue;
    }
    if (strcmp(argv[i], "--parent-pid") == 0 && i + 1 < argc) {
      parent_pid = (pid_t)parse_id(argv[++i], "parent-pid");
      have_parent_pid = 1;
      continue;
    }
    if (strcmp(argv[i], "--cwd-fd") == 0 && i + 1 < argc) {
      cwd_fd = (int)parse_id(argv[++i], "cwd-fd");
      have_cwd_fd = 1;
      continue;
    }
    if (strcmp(argv[i], "--write-root") == 0 && i + 1 < argc && write_root_count < 32) {
      write_roots[write_root_count++] = argv[++i];
      continue;
    }
    if (strcmp(argv[i], "--write-file") == 0 && i + 1 < argc && write_file_count < 16) {
      write_files[write_file_count++] = argv[++i];
      continue;
    }
    if (strcmp(argv[i], "--read-only") == 0) {
      read_only = 1;
      continue;
    }
    fprintf(stderr, "agents-shell-landlock: invalid argument: %s\n", argv[i]);
    return 126;
  }

  if (!have_uid || !have_gid || !have_parent_pid || !have_cwd_fd || (!read_only && write_root_count == 0) ||
      (read_only && write_file_count > 0) || command_index < 0 || command_index >= argc) {
    fprintf(stderr,
            "usage: agents-shell-landlock --uid UID --gid GID --parent-pid PID --cwd-fd FD --write-root PATH "
            "[--write-root PATH] [--write-file PATH] -- /absolute/command [args...]\n"
            "   or: agents-shell-landlock --uid UID --gid GID --parent-pid PID --cwd-fd FD --read-only -- "
            "[--write-root SCRATCH] -- /absolute/command [args...]\n");
    return 126;
  }
  if (argv[command_index][0] != '/') {
    fprintf(stderr, "agents-shell-landlock: command must be absolute\n");
    return 126;
  }

  struct stat cwd_stat;
  if (fstat(cwd_fd, &cwd_stat) < 0) die("fstat cwd-fd");
  if (!S_ISDIR(cwd_stat.st_mode)) {
    errno = ENOTDIR;
    die("cwd-fd");
  }
  if (fchdir(cwd_fd) < 0) die("fchdir cwd-fd");
  close(cwd_fd);

  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) {
    fprintf(stderr, "agents-shell-landlock: Landlock ABI 3+ required, got %d\n", abi);
    return 126;
  }

  unsigned long long handled_access = handled_access_for_abi(abi);
  struct landlock_ruleset_attr ruleset = {.handled_access_fs = handled_access};
  int ruleset_fd = syscall(SYS_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) die("landlock_create_ruleset");

  for (size_t i = 0; i < write_root_count; i++) {
    add_path_rule(ruleset_fd, write_roots[i], handled_access);
  }
  unsigned long long file_access = LANDLOCK_ACCESS_FS_WRITE_FILE;
  if (abi >= 3) file_access |= LANDLOCK_ACCESS_FS_TRUNCATE;
  for (size_t i = 0; i < write_file_count; i++) {
    add_path_rule(ruleset_fd, write_files[i], file_access);
  }

  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) < 0) die("PR_SET_PDEATHSIG");
  if (getppid() != parent_pid) {
    errno = ESRCH;
    die("parent process changed before confinement");
  }
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) < 0) die("PR_SET_DUMPABLE");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die("PR_SET_NO_NEW_PRIVS");
  if (syscall(SYS_landlock_restrict_self, ruleset_fd, 0) < 0) die("landlock_restrict_self");
  close(ruleset_fd);

  uid_t current_uid = geteuid();
  gid_t current_gid = getegid();
  if (current_uid == 0) {
    if (setgroups(0, NULL) < 0) die("setgroups");
    if (setresgid(gid, gid, gid) < 0) die("setresgid");
    if (setresuid(uid, uid, uid) < 0) die("setresuid");
  } else if (uid != current_uid || gid != current_gid) {
    errno = EPERM;
    die("unprivileged identity mismatch");
  }
  umask(0077);

  execv(argv[command_index], &argv[command_index]);
  die("execv");
  return 126;
}
