/*
 * worksuite-guard: protected folders, ransomware burst detection and the executable deny list (issue #38).
 * A small root helper on fanotify, run by worksuite-guard.service from the configuration the device agent writes
 * (/etc/worksuite/guard.conf, services/device-agent/src/protection.ts renderGuardConf).
 *
 *  - Protected folders: an open for writing (O_WRONLY, O_RDWR, O_CREAT, O_TRUNC; creat()) of a file under a protected
 *    folder is refused unless the program is a system or app executable: root-owned, not writable by group or others,
 *    outside the user-writable trees (/home, /tmp, /var/tmp, /dev/shm, /run/user), or listed with "allow". The write
 *    intent comes from /proc/<tid>/syscall while the opening thread waits for our answer (FAN_OPEN_PERM does not say
 *    whether the open is for writing). Unknown intent is allowed: the helper never makes files unreadable.
 *  - Ransomware: renames and deletions under protected folders (and writes, for programs that are not system
 *    executables) are counted per process; a process over "burst <count> <seconds>" is suspended (SIGSTOP) and
 *    reported. Only "allow" entries are exempt: interpreters such as python are system executables, so the burst
 *    check is what covers scripts.
 *  - Application control: executing a file listed by "deny-path" or whose SHA-256 is listed by "deny-sha256" is
 *    refused (FAN_OPEN_EXEC_PERM), on every file system that holds programs users can start.
 *
 * Every decision is one JSON line on stdout (the journal); the device agent follows it and raises the alert.
 * "mode audit" reports what would be refused without refusing. --selftest runs the pure parts.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fanotify.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>
#include "sha256.h"

#define MAX_PROTECT 64
#define MAX_ALLOW 256
#define MAX_DENY_PATH 1024
#define MAX_DENY_SHA 4096

struct cfg {
  char *protect[MAX_PROTECT]; int nprotect;
  char *allow[MAX_ALLOW]; int nallow;
  char *deny_path[MAX_DENY_PATH]; int ndeny_path;
  char deny_sha[MAX_DENY_SHA][65]; int ndeny_sha;
  int burst_count, burst_seconds;
  int enforce;
};

/* ---- pure parts (selftest) ---- */

/* path is dir or below it. dir has no trailing slash ("/" itself matches everything). */
static int under(const char *path, const char *dir) {
  size_t n = strlen(dir);
  if (n == 1 && dir[0] == '/') return path[0] == '/';
  return strncmp(path, dir, n) == 0 && (path[n] == 0 || path[n] == '/');
}

static void strip_slash(char *s) { size_t n = strlen(s); while (n > 1 && s[n - 1] == '/') s[--n] = 0; }

static int listed(char *const *list, int n, const char *path) {
  for (int i = 0; i < n; i++) {
    size_t l = strlen(list[i]);
    /* "allow /opt/vendor/" = everything below; otherwise the exact file. */
    if (l > 1 && list[i][l - 1] == '/') { if (strncmp(path, list[i], l) == 0) return 1; }
    else if (strcmp(path, list[i]) == 0) return 1;
  }
  return 0;
}

static int is_protected(const struct cfg *c, const char *path) {
  for (int i = 0; i < c->nprotect; i++) if (under(path, c->protect[i])) return 1;
  return 0;
}

static const char *const USER_TREES[] = { "/home", "/tmp", "/var/tmp", "/dev/shm", "/run/user", "/media", "/mnt", NULL };

/* A program that may write to protected folders: listed, or a system/app file nobody but root could have changed. */
static int exe_trusted(const struct cfg *c, const char *exe, uid_t owner, mode_t mode) {
  if (listed(c->allow, c->nallow, exe)) return 1;
  if (listed(c->deny_path, c->ndeny_path, exe)) return 0;
  if (owner != 0 || (mode & 022)) return 0;
  for (int i = 0; USER_TREES[i]; i++) if (under(exe, USER_TREES[i])) return 0;
  return 1;
}

static int sha_denied(const struct cfg *c, const char *hex) {
  for (int i = 0; i < c->ndeny_sha; i++) if (strcmp(c->deny_sha[i], hex) == 0) return 1;
  return 0;
}

static int write_flags(unsigned long long f) { return (f & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC)) != 0; }

/* /proc/<tid>/syscall of a thread blocked in open*: 1 = for writing, 0 = read-only, -1 = unknown. */
static int write_intent(const char *line, pid_t tid) {
  long nr; unsigned long long a[6];
  if (sscanf(line, "%ld %llx %llx %llx %llx %llx %llx", &nr, &a[0], &a[1], &a[2], &a[3], &a[4], &a[5]) < 4) return -1;
#ifdef SYS_open
  if (nr == SYS_open) return write_flags(a[1]);
#endif
#ifdef SYS_creat
  if (nr == SYS_creat) return 1;
#endif
  if (nr == SYS_openat) return write_flags(a[2]);
#ifdef SYS_openat2
  if (nr == SYS_openat2) {
    /* struct open_how starts with u64 flags; read it from the caller (it is stopped in the syscall). */
    unsigned long long flags;
    struct iovec l = { &flags, sizeof flags }, r = { (void *)(uintptr_t)a[2], sizeof flags };
    if (tid > 0 && syscall(SYS_process_vm_readv, tid, &l, 1, &r, 1, 0) == (long)sizeof flags) return write_flags(flags);
    return -1;
  }
#endif
  return -1;
}

static int parse_line(struct cfg *c, char *line) {
  char *nl = strchr(line, '\n'); if (nl) *nl = 0;
  if (!*line || *line == '#') return 0;
  char *sp = strchr(line, ' ');
  if (!sp) return -1;
  *sp = 0; char *v = sp + 1;
  if (!strcmp(line, "protect") && v[0] == '/' && c->nprotect < MAX_PROTECT) { c->protect[c->nprotect] = strdup(v); strip_slash(c->protect[c->nprotect++]); }
  else if (!strcmp(line, "allow") && v[0] == '/' && c->nallow < MAX_ALLOW) c->allow[c->nallow++] = strdup(v);
  else if (!strcmp(line, "deny-path") && v[0] == '/' && c->ndeny_path < MAX_DENY_PATH) c->deny_path[c->ndeny_path++] = strdup(v);
  else if (!strcmp(line, "deny-sha256") && strlen(v) == 64 && c->ndeny_sha < MAX_DENY_SHA) {
    for (int i = 0; i < 64; i++) { if (!isxdigit((unsigned char)v[i])) return -1; c->deny_sha[c->ndeny_sha][i] = (char)tolower((unsigned char)v[i]); }
    c->deny_sha[c->ndeny_sha++][64] = 0;
  }
  else if (!strcmp(line, "burst")) { if (sscanf(v, "%d %d", &c->burst_count, &c->burst_seconds) != 2 || c->burst_count < 1 || c->burst_seconds < 1) return -1; }
  else if (!strcmp(line, "mode")) { if (!strcmp(v, "enforce")) c->enforce = 1; else if (!strcmp(v, "audit")) c->enforce = 0; else return -1; }
  else return -1;
  return 0;
}

static void cfg_defaults(struct cfg *c) { memset(c, 0, sizeof *c); c->burst_count = 200; c->burst_seconds = 10; c->enforce = 1; }

/* Per-process counts for the burst check: a fixed window per process, reported once. */
#define TRACK 512
struct track { pid_t pid; time_t start; int count; int reported; };
static struct track tracks[TRACK];

/* Returns 1 exactly once, when pid crosses the threshold inside one window. */
static int burst_hit(const struct cfg *c, pid_t pid, time_t now, int *count) {
  struct track *t = NULL, *oldest = &tracks[0];
  for (int i = 0; i < TRACK; i++) {
    if (tracks[i].pid == pid) { t = &tracks[i]; break; }
    if (tracks[i].start < oldest->start) oldest = &tracks[i];
  }
  if (!t) { t = oldest; t->pid = pid; t->start = now; t->count = 0; t->reported = 0; }
  if (now - t->start >= c->burst_seconds) { t->start = now; t->count = 0; t->reported = 0; }
  *count = ++t->count;
  if (t->count >= c->burst_count && !t->reported) { t->reported = 1; return 1; }
  return 0;
}

static void json_str(FILE *f, const char *s) {
  fputc('"', f);
  for (; *s; s++) {
    unsigned char ch = (unsigned char)*s;
    if (ch == '"' || ch == '\\') fprintf(f, "\\%c", ch);
    else if (ch < 0x20) fprintf(f, "\\u%04x", ch);
    else fputc(ch, f);
  }
  fputc('"', f);
}

/* ---- the running helper ---- */

static struct cfg C;
static pid_t self;

static void emit(const char *event, pid_t pid, const char *exe, const char *path, const char *extra_key, const char *extra, long n) {
  printf("{\"event\":\"%s\",\"pid\":%d,\"enforced\":%s,\"exe\":", event, (int)pid, C.enforce ? "true" : "false");
  json_str(stdout, exe ? exe : "");
  printf(",\"path\":"); json_str(stdout, path ? path : "");
  if (extra_key) { printf(",\"%s\":", extra_key); json_str(stdout, extra); }
  if (n >= 0) printf(",\"count\":%ld", n);
  printf("}\n");
  fflush(stdout);
}

static int proc_link(pid_t pid, const char *what, char *out, size_t n) {
  char p[64]; snprintf(p, sizeof p, "/proc/%d/%s", (int)pid, what);
  ssize_t r = readlink(p, out, n - 1);
  if (r < 0) return -1;
  out[r] = 0; return 0;
}

static int fd_path(int fd, char *out, size_t n) {
  char p[64]; snprintf(p, sizeof p, "/proc/self/fd/%d", fd);
  ssize_t r = readlink(p, out, n - 1);
  if (r < 0) return -1;
  out[r] = 0; return 0;
}

static pid_t tgid_of(pid_t tid) {
  char p[64], line[256]; snprintf(p, sizeof p, "/proc/%d/status", (int)tid);
  FILE *f = fopen(p, "re"); pid_t t = tid;
  if (!f) return tid;
  while (fgets(line, sizeof line, f)) if (!strncmp(line, "Tgid:", 5)) { t = (pid_t)atoi(line + 5); break; }
  fclose(f); return t;
}

/* Field 22 of /proc/<pid>/stat: the start time, so the agent can tell a reused pid from the suspended process. */
static unsigned long long start_ticks(pid_t pid) {
  char p[64], buf[1024]; snprintf(p, sizeof p, "/proc/%d/stat", (int)pid);
  int fd = open(p, O_RDONLY | O_CLOEXEC); if (fd < 0) return 0;
  ssize_t r = read(fd, buf, sizeof buf - 1); close(fd); if (r <= 0) return 0;
  buf[r] = 0; char *s = strrchr(buf, ')'); if (!s) return 0;
  unsigned long long v = 0; int field = 2;
  for (char *tok = strtok(s + 1, " "); tok; tok = strtok(NULL, " ")) if (++field == 22) { v = strtoull(tok, NULL, 10); break; }
  return v;
}

struct hcache { dev_t dev; ino_t ino; long long mtime; off_t size; char hex[65]; };
static struct hcache hc[256]; static int hc_next;

static const char *file_sha(int fd) {
  struct stat st; if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size > (512LL << 20)) return NULL;
  long long mt = (long long)st.st_mtim.tv_sec * 1000000000LL + st.st_mtim.tv_nsec;
  for (int i = 0; i < 256; i++) if (hc[i].ino == st.st_ino && hc[i].dev == st.st_dev && hc[i].mtime == mt && hc[i].size == st.st_size && hc[i].hex[0]) return hc[i].hex;
  sha256_ctx s; sha256_init(&s);
  static char buf[1 << 16]; off_t off = 0; ssize_t r;
  while ((r = pread(fd, buf, sizeof buf, off)) > 0) { sha256_update(&s, buf, (size_t)r); off += r; }
  if (r < 0) return NULL;
  struct hcache *e = &hc[hc_next++ & 255];
  e->dev = st.st_dev; e->ino = st.st_ino; e->mtime = mt; e->size = st.st_size; sha256_hex(&s, e->hex);
  return e->hex;
}

static void answer(int gfd, int fd, int allow) {
  struct fanotify_response r = { .fd = fd, .response = allow ? FAN_ALLOW : FAN_DENY };
  if (write(gfd, &r, sizeof r) != sizeof r) perror("worksuite-guard: response");
}

static void on_perm(int gfd, struct fanotify_event_metadata *m) {
  int allow = 1;
  if (m->fd < 0) return;
  pid_t tid = m->pid, pid = tgid_of(tid);
  if (pid == self) { answer(gfd, m->fd, 1); close(m->fd); return; }
  char path[PATH_MAX] = "", exe[PATH_MAX] = "";
  fd_path(m->fd, path, sizeof path);
  if (m->mask & FAN_OPEN_EXEC_PERM) {
    const char *hex = C.ndeny_sha ? file_sha(m->fd) : NULL;
    int denied = listed(C.deny_path, C.ndeny_path, path) || (hex && sha_denied(&C, hex));
    if (denied) { proc_link(pid, "exe", exe, sizeof exe); emit("exec_blocked", pid, exe, path, "sha256", hex ? hex : "", -1); if (C.enforce) allow = 0; }
  } else if ((m->mask & FAN_OPEN_PERM) && is_protected(&C, path)) {
    char sp[64], line[512] = ""; snprintf(sp, sizeof sp, "/proc/%d/syscall", (int)tid);
    int sfd = open(sp, O_RDONLY | O_CLOEXEC);
    if (sfd >= 0) { ssize_t r = read(sfd, line, sizeof line - 1); if (r > 0) line[r] = 0; close(sfd); }
    if (write_intent(line, tid) == 1 && proc_link(pid, "exe", exe, sizeof exe) == 0) {
      char pe[64]; struct stat st; snprintf(pe, sizeof pe, "/proc/%d/exe", (int)pid);
      if (stat(pe, &st) == 0 && !exe_trusted(&C, exe, st.st_uid, st.st_mode)) {
        static pid_t last_pid; static time_t last_at;
        time_t now = time(NULL);
        if (pid != last_pid || now != last_at) emit("write_blocked", pid, exe, path, NULL, NULL, -1);   /* one line per process per second */
        last_pid = pid; last_at = now;
        if (C.enforce) allow = 0;
      }
    }
  }
  answer(gfd, m->fd, allow);
  close(m->fd);
}

/* Mount fds per file system (fsid) for open_by_handle_at in the burst group. */
struct fsmount { __kernel_fsid_t fsid; int fd; };
static struct fsmount mounts[MAX_PROTECT]; static int nmounts;

static void on_notify(struct fanotify_event_metadata *m) {
  struct fanotify_event_info_fid *fid = (struct fanotify_event_info_fid *)(m + 1);
  if ((char *)fid >= (char *)m + m->event_len || fid->hdr.info_type != FAN_EVENT_INFO_TYPE_DFID_NAME) return;
  if (m->pid == self) return;
  struct file_handle *fh = (struct file_handle *)fid->handle;
  const char *name = (const char *)(fh->f_handle + fh->handle_bytes);
  int mfd = -1;
  for (int i = 0; i < nmounts; i++) if (!memcmp(&mounts[i].fsid, &fid->fsid, sizeof fid->fsid)) { mfd = mounts[i].fd; break; }
  if (mfd < 0) return;
  int dfd = (int)syscall(SYS_open_by_handle_at, mfd, fh, O_PATH | O_CLOEXEC);
  if (dfd < 0) return;
  char dir[PATH_MAX], path[PATH_MAX + NAME_MAX + 2];
  int ok = fd_path(dfd, dir, sizeof dir) == 0;
  close(dfd);
  if (!ok) return;
  snprintf(path, sizeof path, "%s/%s", dir, name);
  if (!is_protected(&C, path)) return;
  char exe[PATH_MAX] = "";
  proc_link(m->pid, "exe", exe, sizeof exe);
  if (listed(C.allow, C.nallow, exe)) return;
  /* Writes by system programs (tar extracting, an office suite saving) are not destructive on their own; renames and
     deletions count for everyone, and writes for programs that are not system executables. */
  if (m->mask & FAN_CLOSE_WRITE) {
    char pe[64]; struct stat st; snprintf(pe, sizeof pe, "/proc/%d/exe", (int)m->pid);
    if (stat(pe, &st) == 0 && exe_trusted(&C, exe, st.st_uid, st.st_mode)) return;
  }
  int count;
  if (!burst_hit(&C, m->pid, time(NULL), &count)) return;
  char st[32]; snprintf(st, sizeof st, "%llu", start_ticks(m->pid));
  if (C.enforce && kill(m->pid, SIGSTOP) != 0) perror("worksuite-guard: SIGSTOP");
  emit("burst_suspended", m->pid, exe, path, "start", st, count);
}

static int add_fs_mark(int g, unsigned long long mask, const char *path) {
  if (syscall(SYS_fanotify_mark, g, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, mask, AT_FDCWD, path) == 0) return 0;
  fprintf(stderr, "worksuite-guard: cannot watch %s: %s\n", path, strerror(errno));
  return -1;
}

static int selftest(void);

int main(int argc, char **argv) {
  const char *conf = "/etc/worksuite/guard.conf";
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--selftest")) return selftest();
    if (!strcmp(argv[i], "--config") && i + 1 < argc) conf = argv[++i];
  }
  cfg_defaults(&C);
  FILE *f = fopen(conf, "re");
  if (!f) { fprintf(stderr, "worksuite-guard: %s: %s\n", conf, strerror(errno)); return 2; }
  char line[PATH_MAX + 32]; int ln = 0;
  while (fgets(line, sizeof line, f)) { ln++; if (parse_line(&C, line)) fprintf(stderr, "worksuite-guard: %s:%d ignored\n", conf, ln); }
  fclose(f);
  self = getpid();
  setvbuf(stdout, NULL, _IOLBF, 0);

  int perm = -1, notif = -1;
  unsigned long long pmask = (C.nprotect ? FAN_OPEN_PERM : 0);
  if (C.nprotect || C.ndeny_path || C.ndeny_sha) {
    perm = (int)syscall(SYS_fanotify_init, FAN_CLASS_CONTENT | FAN_CLOEXEC | FAN_REPORT_TID, O_RDONLY | O_LARGEFILE | O_CLOEXEC);
    if (perm < 0) { perror("worksuite-guard: fanotify_init (permission)"); return 3; }
    /* One mark per file system; execution is checked wherever users can put programs. */
    const char *execfs[] = { "/", "/home", "/tmp", "/var/tmp", "/dev/shm", NULL };
    dev_t seen[MAX_PROTECT + 8]; int nseen = 0;
    const char *paths[MAX_PROTECT + 8]; int np = 0;
    if (C.ndeny_path || C.ndeny_sha) for (int i = 0; execfs[i]; i++) paths[np++] = execfs[i];
    for (int i = 0; i < C.nprotect; i++) paths[np++] = C.protect[i];
    for (int i = 0; i < np; i++) {
      struct stat st; if (stat(paths[i], &st)) continue;
      int dup = 0; for (int j = 0; j < nseen; j++) if (seen[j] == st.st_dev) dup = 1;
      if (dup) continue;
      seen[nseen++] = st.st_dev;
      unsigned long long mask = 0;
      if (C.ndeny_path || C.ndeny_sha) mask |= FAN_OPEN_EXEC_PERM;
      for (int k = 0; k < C.nprotect; k++) { struct stat ps; if (!stat(C.protect[k], &ps) && ps.st_dev == st.st_dev) mask |= pmask; }
      add_fs_mark(perm, mask, paths[i]);
    }
  }
  if (C.nprotect) {
    notif = (int)syscall(SYS_fanotify_init, FAN_CLASS_NOTIF | FAN_CLOEXEC | FAN_REPORT_DFID_NAME, O_RDONLY | O_LARGEFILE | O_CLOEXEC);
    if (notif < 0) perror("worksuite-guard: fanotify_init (burst)");
    for (int i = 0; notif >= 0 && i < C.nprotect && nmounts < MAX_PROTECT; i++) {
      struct statfs sf; int fd = open(C.protect[i], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
      if (fd < 0 || fstatfs(fd, &sf)) { if (fd >= 0) close(fd); continue; }
      int dup = 0; for (int j = 0; j < nmounts; j++) if (!memcmp(&mounts[j].fsid, &sf.f_fsid, sizeof sf.f_fsid)) dup = 1;
      if (dup) { close(fd); continue; }
      memcpy(&mounts[nmounts].fsid, &sf.f_fsid, sizeof sf.f_fsid); mounts[nmounts++].fd = fd;
      add_fs_mark(notif, FAN_MOVED_FROM | FAN_DELETE | FAN_CLOSE_WRITE, C.protect[i]);
    }
  }
  printf("{\"event\":\"started\",\"pid\":%d,\"enforced\":%s,\"protect\":%d,\"deny\":%d}\n", (int)self, C.enforce ? "true" : "false", C.nprotect, C.ndeny_path + C.ndeny_sha);
  if (perm < 0 && notif < 0) { pause(); return 0; }   /* nothing to do: stay up so the unit reads "active" */

  static char buf[64 * 1024] __attribute__((aligned(__alignof__(struct fanotify_event_metadata))));
  struct pollfd pf[2] = { { perm, POLLIN, 0 }, { notif, POLLIN, 0 } };
  for (;;) {
    if (poll(pf, 2, -1) < 0) { if (errno == EINTR) continue; perror("poll"); return 4; }
    for (int k = 0; k < 2; k++) {
      if (pf[k].fd < 0 || !(pf[k].revents & POLLIN)) continue;
      ssize_t len = read(pf[k].fd, buf, sizeof buf);
      if (len <= 0) continue;
      for (struct fanotify_event_metadata *m = (void *)buf; FAN_EVENT_OK(m, len); m = FAN_EVENT_NEXT(m, len)) {
        if (m->vers != FANOTIFY_METADATA_VERSION) { fprintf(stderr, "worksuite-guard: fanotify ABI mismatch\n"); return 5; }
        if (k == 0) on_perm(perm, m); else on_notify(m);
      }
    }
  }
}

/* ---- selftest ---- */
#define T(x) do { if (!(x)) { fprintf(stderr, "selftest failed: %s (line %d)\n", #x, __LINE__); return 1; } } while (0)
static int selftest(void) {
  struct cfg c; cfg_defaults(&c);
  char l1[] = "protect /home/a/Documents/\n", l2[] = "allow /opt/backup/\n", l3[] = "deny-sha256 E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855\n";
  char l4[] = "burst 50 5\n", l5[] = "mode audit\n", l6[] = "bogus x\n", l7[] = "deny-path /home/a/evil\n", l8[] = "# comment\n";
  T(!parse_line(&c, l1) && !parse_line(&c, l2) && !parse_line(&c, l3) && !parse_line(&c, l4) && !parse_line(&c, l5) && parse_line(&c, l6) && !parse_line(&c, l7) && !parse_line(&c, l8));
  T(!strcmp(c.protect[0], "/home/a/Documents") && c.burst_count == 50 && c.burst_seconds == 5 && !c.enforce);
  T(is_protected(&c, "/home/a/Documents") && is_protected(&c, "/home/a/Documents/x.odt") && !is_protected(&c, "/home/a/DocumentsX/y"));
  T(under("/x", "/") && !under("/ab", "/a"));
  /* trust: root-owned system files yes; user-writable or user-tree files no; allow overrides; deny-path wins over trust */
  T(exe_trusted(&c, "/usr/bin/libreoffice", 0, 0755));
  T(!exe_trusted(&c, "/usr/bin/x", 1000, 0755) && !exe_trusted(&c, "/usr/bin/x", 0, 0777));
  T(!exe_trusted(&c, "/home/a/.local/bin/tool", 0, 0755) && !exe_trusted(&c, "/tmp/x", 0, 0755));
  T(exe_trusted(&c, "/opt/backup/bin/agent", 1000, 0777));
  T(!exe_trusted(&c, "/home/a/evil", 0, 0755));
  /* SHA-256 vectors */
  sha256_ctx s; char hex[65];
  sha256_init(&s); sha256_hex(&s, hex); T(sha_denied(&c, hex));
  sha256_init(&s); sha256_update(&s, "abc", 3); sha256_hex(&s, hex); T(!strcmp(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  static char a1k[1000]; memset(a1k, 'a', sizeof a1k);
  sha256_init(&s); for (int i = 0; i < 1000; i++) sha256_update(&s, a1k, sizeof a1k);
  sha256_hex(&s, hex); T(!strcmp(hex, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));
  /* write intent from /proc/<tid>/syscall lines */
  char ln[128];
  snprintf(ln, sizeof ln, "%d 0xffffff9c 0x7ffd 0x%x 0x0 0x0 0x0 0x7ffc 0x7f00", SYS_openat, O_RDONLY); T(write_intent(ln, 0) == 0);
  snprintf(ln, sizeof ln, "%d 0xffffff9c 0x7ffd 0x%x 0x1b6 0x0 0x0 0x7ffc 0x7f00", SYS_openat, O_WRONLY | O_CREAT | O_TRUNC); T(write_intent(ln, 0) == 1);
  snprintf(ln, sizeof ln, "%d 0xffffff9c 0x7ffd 0x%x 0x0 0x0 0x0 0x7ffc 0x7f00", SYS_openat, O_RDWR); T(write_intent(ln, 0) == 1);
#ifdef SYS_open
  snprintf(ln, sizeof ln, "%d 0x7ffd 0x%x 0x0 0x0 0x0 0x0 0x7ffc 0x7f00", SYS_open, O_APPEND | O_WRONLY); T(write_intent(ln, 0) == 1);
#endif
  T(write_intent("running", 0) == -1);
  snprintf(ln, sizeof ln, "%d 0x1 0x2 0x3 0x0 0x0 0x0 0x0 0x0", SYS_read); T(write_intent(ln, 0) == -1);
  /* burst: 50 events in one 5 s window → reported once; a new window starts over */
  int n, hits = 0;
  for (int i = 0; i < 120; i++) hits += burst_hit(&c, 4242, 1000, &n);
  T(hits == 1 && n == 120);
  T(!burst_hit(&c, 4242, 1005, &n) && n == 1);
  for (int i = 0; i < 49; i++) hits += burst_hit(&c, 4243, 2000 + i / 10, &n);
  T(hits == 1);
  /* JSON escaping */
  char *jb = NULL; size_t jl = 0; FILE *jf = open_memstream(&jb, &jl);
  json_str(jf, "a\"b\\c\n"); fclose(jf); T(!strcmp(jb, "\"a\\\"b\\\\c\\u000a\"")); free(jb);
  puts("worksuite-guard selftest: ok");
  return 0;
}
