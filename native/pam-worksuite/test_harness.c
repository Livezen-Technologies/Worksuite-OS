/* Test driver: runs the "wstest" PAM service from a private config dir with scripted answers. Not installed. */
#define _GNU_SOURCE
#include <security/pam_appl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int conv(int n, const struct pam_message **msg, struct pam_response **resp, void *data) {
  (void)data;
  struct pam_response *r = calloc((size_t)n, sizeof *r);
  if (!r) return PAM_BUF_ERR;
  for (int i = 0; i < n; i++) {
    const char *m = msg[i]->msg;
    if (msg[i]->msg_style == PAM_PROMPT_ECHO_OFF) { printf("prompt-off: %s\n", m); r[i].resp = strdup(getenv("WS_PASSWORD") ? getenv("WS_PASSWORD") : ""); }
    else if (msg[i]->msg_style == PAM_PROMPT_ECHO_ON) { printf("prompt-on: %s\n", m); r[i].resp = strdup(getenv("WS_CODE") ? getenv("WS_CODE") : ""); }
    else printf("info: %s\n", m);
  }
  *resp = r;
  return PAM_SUCCESS;
}

int main(int argc, char **argv) {
  if (argc != 3) { fprintf(stderr, "usage: test_harness CONFDIR USER\n"); return 2; }
  struct pam_conv c = { conv, NULL };
  pam_handle_t *h = NULL;
  int r = pam_start_confdir("wstest", argv[2], &c, argv[1], &h);
  if (r != PAM_SUCCESS) { printf("start: %s\n", pam_strerror(h, r)); return 2; }
  r = pam_authenticate(h, 0);
  printf("result: %s\n", pam_strerror(h, r));
  pam_end(h, r);
  return r == PAM_SUCCESS ? 0 : 1;
}
