/*
 * pam_worksuite.so: WorkSuite directory sign-in as a native PAM module (SRS §14.4, WSOS-DIR-009).
 *
 * The directory logic (HTTPS to the enrolled server with the device credential, offline cache, account creation)
 * stays in the tested helper, worksuite-pam-directory. This module replaces pam_exec so that sign-in can talk to the
 * user through the PAM conversation: when the directory asks for a second factor, it prompts for the verification
 * code in whatever client is asking (greeter, gtklock, sudo, ssh) instead of requiring "password + code" in one field.
 *
 *   auth  [success=end default=ignore]  pam_worksuite.so [helper=/abs/path] [timeout=SECONDS]
 *
 * Secrets: the password (and code) go to the helper on a pipe only, NUL-terminated like pam_exec expose_authtok;
 * never argv, environment or logs. Buffers are wiped. The helper runs with a fixed, minimal environment.
 * Helper exit codes: 0 signed in, 10 second factor required, 11 password expired, 12 not a directory name,
 * anything else refused.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <syslog.h>
#include <time.h>
#include <unistd.h>

#define PAM_SM_AUTH
#include <security/pam_ext.h>
#include <security/pam_modules.h>

#ifndef WS_HELPER
#define WS_HELPER "/usr/libexec/worksuite/worksuite-pam-directory"
#endif
#define EXIT_MFA 10
#define EXIT_EXPIRED 11
#define EXIT_NOT_DIRECTORY 12
#define CODE_LEN 6

/* Directory names are user@domain (lower case); anything else is left to pam_unix without running the helper. */
static int directory_name(const char *u) {
  const char *at = strchr(u, '@');
  if (!at || at == u || !at[1] || strlen(u) > 256) return 0;
  for (const char *p = u; *p; p++)
    if (!(islower((unsigned char)*p) || isdigit((unsigned char)*p) || strchr("._-@", *p))) return 0;
  return strchr(at + 1, '@') == NULL;
}

/* Runs the helper with `secret` on stdin; returns its exit status, or -1. */
static int run_helper(pam_handle_t *pamh, const char *helper, const char *user, const char *secret, int timeout) {
  int fd[2];
  if (pipe2(fd, O_CLOEXEC) < 0) return -1;
  pid_t pid = fork();
  if (pid < 0) { close(fd[0]); close(fd[1]); return -1; }
  if (pid == 0) {
    if (dup2(fd[0], STDIN_FILENO) < 0) _exit(127);
    int devnull = open("/dev/null", O_RDWR);
    if (devnull >= 0) { dup2(devnull, STDOUT_FILENO); dup2(devnull, STDERR_FILENO); }
    closefrom(3);
    const char *service = NULL;
    pam_get_item(pamh, PAM_SERVICE, (const void **)&service);
    char e_user[300], e_service[300];
    snprintf(e_user, sizeof e_user, "PAM_USER=%s", user);
    snprintf(e_service, sizeof e_service, "PAM_SERVICE=%s", service ? service : "");
    char *const env[] = { "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "PAM_TYPE=auth", e_user, e_service, NULL };
    char *const argv[] = { (char *)helper, "auth", NULL };
    execve(helper, argv, env);
    _exit(127);
  }
  close(fd[0]);
  /* NUL-terminated, like pam_exec expose_authtok; the helper reads to EOF. */
  size_t n = strlen(secret) + 1;
  const char *p = secret;
  struct sigaction ign = { .sa_handler = SIG_IGN }, old;
  sigaction(SIGPIPE, &ign, &old);
  while (n > 0) { ssize_t w = write(fd[1], p, n); if (w < 0 && errno == EINTR) continue; if (w <= 0) break; p += w; n -= (size_t)w; }
  sigaction(SIGPIPE, &old, NULL);
  close(fd[1]);
  int status = 0;
  time_t end = time(NULL) + timeout;
  for (;;) {
    pid_t r = waitpid(pid, &status, WNOHANG);
    if (r == pid) break;
    if (r < 0 && errno != EINTR) return -1;
    if (time(NULL) >= end) { kill(pid, SIGKILL); waitpid(pid, &status, 0); pam_syslog(pamh, LOG_ERR, "directory helper timed out"); return -1; }
    struct timespec ts = { 0, 50 * 1000 * 1000 };
    nanosleep(&ts, NULL);
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static int valid_code(const char *c) {
  if (!c || strlen(c) != CODE_LEN) return 0;
  for (int i = 0; i < CODE_LEN; i++) if (!isdigit((unsigned char)c[i])) return 0;
  return 1;
}

PAM_EXTERN int pam_sm_authenticate(pam_handle_t *pamh, int flags, int argc, const char **argv) {
  (void)flags;
  const char *helper = WS_HELPER;
  int timeout = 30;
  for (int i = 0; i < argc; i++) {
    if (strncmp(argv[i], "helper=", 7) == 0 && argv[i][7] == '/') helper = argv[i] + 7;
    else if (strncmp(argv[i], "timeout=", 8) == 0) { int t = atoi(argv[i] + 8); if (t > 0 && t <= 300) timeout = t; }
    else pam_syslog(pamh, LOG_ERR, "unknown option %s", argv[i]);
  }
  const char *user = NULL;
  if (pam_get_user(pamh, &user, NULL) != PAM_SUCCESS || !user) return PAM_USER_UNKNOWN;
  if (!directory_name(user)) return PAM_IGNORE;
  const char *tok = NULL;
  int r = pam_get_authtok(pamh, PAM_AUTHTOK, &tok, NULL);
  if (r != PAM_SUCCESS) return r;
  if (!tok || !*tok) return PAM_AUTH_ERR;

  int rc = run_helper(pamh, helper, user, tok, timeout);
  if (rc == EXIT_MFA) {
    /* Second factor (OneAuth TOTP): ask in the client's own dialog, then send "password + code" as the helper expects. */
    char *code = NULL;
    if (pam_prompt(pamh, PAM_PROMPT_ECHO_ON, &code, "Verification code: ") != PAM_SUCCESS || !valid_code(code)) {
      if (code) { explicit_bzero(code, strlen(code)); free(code); }
      pam_info(pamh, "Enter the 6-digit code from your authenticator app.");
      return PAM_AUTH_ERR;
    }
    size_t n = strlen(tok) + CODE_LEN + 1;
    char *joined = malloc(n);
    if (!joined) { explicit_bzero(code, strlen(code)); free(code); return PAM_BUF_ERR; }
    snprintf(joined, n, "%s%s", tok, code);
    explicit_bzero(code, strlen(code)); free(code);
    rc = run_helper(pamh, helper, user, joined, timeout);
    explicit_bzero(joined, n); free(joined);
  }
  switch (rc) {
    case 0: return PAM_SUCCESS;
    case EXIT_NOT_DIRECTORY: return PAM_IGNORE;
    case EXIT_EXPIRED: pam_info(pamh, "Your password has expired. Choose a new one at the sign-in screen."); return PAM_AUTH_ERR;
    case EXIT_MFA: return PAM_AUTH_ERR;
    case -1: case 127: return PAM_AUTHINFO_UNAVAIL;
    default: return PAM_AUTH_ERR;
  }
}

PAM_EXTERN int pam_sm_setcred(pam_handle_t *pamh, int flags, int argc, const char **argv) {
  (void)pamh; (void)flags; (void)argc; (void)argv;
  return PAM_IGNORE;
}
