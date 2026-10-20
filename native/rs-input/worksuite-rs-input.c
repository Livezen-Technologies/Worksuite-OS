/*
 * worksuite-rs-input: remote support input on labwc/wlroots (issue #37, follow-up to #19).
 *
 * The shell (shell/electron/rsInput.ts) starts this helper only while the person at the device has granted remote
 * control, and stops it the moment control is revoked or the session ends. It turns one-line commands on stdin into
 * wlr-virtual-pointer-unstable-v1 and virtual-keyboard-unstable-v1 requests, so the compositor sees a real pointer
 * and keyboard with separate press/release (drag, Shift+click and held keys work). Nothing reads or writes
 * /dev/input; the compositor stays in charge (the lock screen and greeter don't accept these devices' focus).
 *
 * Commands (ASCII, one per line, unknown or malformed lines are answered "err ..." and ignored):
 *   o <output-name>|-          map absolute motion to one output (wl_output name, e.g. HDMI-A-1), "-" = whole layout
 *   m <x> <y> <w> <h>          absolute motion: x in [0,w], y in [0,h] (the shared stream's pixel size)
 *   b <evdev-button> <0|1>     button release/press (BTN_LEFT 272, BTN_RIGHT 273, BTN_MIDDLE 274)
 *   a <v|h> <steps>            discrete wheel steps (-10..10)
 *   k <keysym-hex> <0|1>       key release/press by X keysym (layout independent: the keymap is built on the fly)
 *   r                          release every held key, button and modifier
 *   q                          quit (also on EOF)
 * Output: "ready" once both devices exist, "ok" after each applied command (so the caller can pace itself).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

#define MAX_KEYS 240
#define MAX_OUTPUTS 16

struct output { struct wl_output *o; uint32_t id; char name[64]; };

static struct wl_display *dpy;
static struct wl_seat *seat;
static struct zwlr_virtual_pointer_manager_v1 *pmgr;
static uint32_t pmgr_version;
static struct zwp_virtual_keyboard_manager_v1 *kmgr;
static struct zwlr_virtual_pointer_v1 *ptr;
static struct zwp_virtual_keyboard_v1 *kbd;
static struct output outputs[MAX_OUTPUTS];
static int noutputs;

static uint32_t keysyms[MAX_KEYS];   /* evdev keycode i+1 <-> keysyms[i] in the uploaded keymap */
static int nkeys;
static int key_down[MAX_KEYS];
static uint32_t mods_depressed, mods_locked;
static int buttons_down[3];

static uint32_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint32_t)(t.tv_sec * 1000 + t.tv_nsec / 1000000);
}

static void out_name(void *data, struct wl_output *o, const char *name) {
  (void)o;
  struct output *x = data;
  snprintf(x->name, sizeof x->name, "%s", name);
}
static void out_geometry(void *d, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph, int32_t sp, const char *mk, const char *md, int32_t tr) {
  (void)d; (void)o; (void)x; (void)y; (void)pw; (void)ph; (void)sp; (void)mk; (void)md; (void)tr;
}
static void out_mode(void *d, struct wl_output *o, uint32_t f, int32_t w, int32_t h, int32_t r) { (void)d; (void)o; (void)f; (void)w; (void)h; (void)r; }
static void out_done(void *d, struct wl_output *o) { (void)d; (void)o; }
static void out_scale(void *d, struct wl_output *o, int32_t s) { (void)d; (void)o; (void)s; }
static void out_description(void *d, struct wl_output *o, const char *s) { (void)d; (void)o; (void)s; }
static const struct wl_output_listener output_listener = { out_geometry, out_mode, out_done, out_scale, out_name, out_description };

static void global(void *data, struct wl_registry *r, uint32_t id, const char *iface, uint32_t version) {
  (void)data;
  if (!strcmp(iface, wl_seat_interface.name) && !seat) seat = wl_registry_bind(r, id, &wl_seat_interface, 1);
  else if (!strcmp(iface, zwlr_virtual_pointer_manager_v1_interface.name)) {
    pmgr_version = version < 2 ? version : 2;
    pmgr = wl_registry_bind(r, id, &zwlr_virtual_pointer_manager_v1_interface, pmgr_version);
  } else if (!strcmp(iface, zwp_virtual_keyboard_manager_v1_interface.name)) kmgr = wl_registry_bind(r, id, &zwp_virtual_keyboard_manager_v1_interface, 1);
  else if (!strcmp(iface, wl_output_interface.name) && noutputs < MAX_OUTPUTS && version >= 4) {
    struct output *x = &outputs[noutputs++];
    x->id = id;
    x->o = wl_registry_bind(r, id, &wl_output_interface, 4);
    wl_output_add_listener(x->o, &output_listener, x);
  }
}
static void global_remove(void *data, struct wl_registry *r, uint32_t id) { (void)data; (void)r; (void)id; }
static const struct wl_registry_listener registry_listener = { global, global_remove };

/* The keymap: one key per keysym seen so far, keycodes 9.. (evdev 1..). Hex keysyms are valid in xkb_symbols. */
static int upload_keymap(void) {
  size_t cap = 512 + (size_t)nkeys * 64, len = 0;
  char *s = malloc(cap);
  if (!s) return -1;
  len += snprintf(s + len, cap - len, "xkb_keymap {\nxkb_keycodes \"ws\" {\nminimum = 8;\nmaximum = %d;\n", nkeys + 9 > 255 ? 255 : nkeys + 9);
  for (int i = 0; i < nkeys; i++) len += snprintf(s + len, cap - len, "<K%d> = %d;\n", i, i + 9);
  len += snprintf(s + len, cap - len, "};\nxkb_types \"ws\" { include \"complete\" };\nxkb_compatibility \"ws\" { include \"complete\" };\nxkb_symbols \"ws\" {\n");
  for (int i = 0; i < nkeys; i++) len += snprintf(s + len, cap - len, "key <K%d> {[ 0x%x ]};\n", i, keysyms[i]);
  len += snprintf(s + len, cap - len, "};\n};\n");
  int fd = memfd_create("ws-rs-keymap", MFD_CLOEXEC);
  if (fd < 0) { free(s); return -1; }
  ssize_t w = write(fd, s, len + 1);   /* includes the terminating NUL, as the protocol expects */
  free(s);
  if (w != (ssize_t)(len + 1)) { close(fd); return -1; }
  zwp_virtual_keyboard_v1_keymap(kbd, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)(len + 1));
  close(fd);
  wl_display_roundtrip(dpy);
  return 0;
}

/* Modifier keysyms are sent as modifier state (Shift 1, Lock 2, Control 4, Mod1/Alt 8, Mod4/Super 64). */
static uint32_t modifier_mask(uint32_t sym) {
  switch (sym) {
    case 0xffe1: case 0xffe2: return 1;
    case 0xffe3: case 0xffe4: return 4;
    case 0xffe9: case 0xffea: case 0xffe7: case 0xffe8: return 8;
    case 0xffeb: case 0xffec: return 64;
    default: return 0;
  }
}

static void send_mods(void) { zwp_virtual_keyboard_v1_modifiers(kbd, mods_depressed, 0, mods_locked, 0); }

static int key(uint32_t sym, int down) {
  uint32_t m = modifier_mask(sym);
  if (m) { if (down) mods_depressed |= m; else mods_depressed &= ~m; send_mods(); return 0; }
  if (sym == 0xffe5) { if (down) { mods_locked ^= 2; send_mods(); } return 0; }   /* Caps Lock toggles */
  int i;
  for (i = 0; i < nkeys && keysyms[i] != sym; i++) {}
  if (i == nkeys) {
    if (!down) return 0;                         /* release of a key we never pressed */
    if (nkeys == MAX_KEYS) {                      /* full: start a fresh keymap once nothing is held */
      for (int j = 0; j < nkeys; j++) if (key_down[j]) return -1;
      nkeys = 0;
    }
    keysyms[nkeys] = sym; key_down[nkeys] = 0; i = nkeys++;
    if (upload_keymap()) return -1;
  }
  if (!down && !key_down[i]) return 0;
  key_down[i] = down;
  zwp_virtual_keyboard_v1_key(kbd, now_ms(), (uint32_t)i + 1, down ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
  return 0;
}

static int make_pointer(const char *output) {
  struct wl_output *o = NULL;
  if (output && strcmp(output, "-")) {
    for (int i = 0; i < noutputs; i++) if (!strcmp(outputs[i].name, output)) o = outputs[i].o;
    if (!o) return -1;
    if (pmgr_version < 2) return -1;
  }
  if (ptr) zwlr_virtual_pointer_v1_destroy(ptr);
  ptr = o ? zwlr_virtual_pointer_manager_v1_create_virtual_pointer_with_output(pmgr, seat, o) : zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pmgr, seat);
  return ptr ? 0 : -1;
}

static const uint32_t BTN[3] = { 272, 273, 274 };

static void release_all(void) {
  for (int i = 0; i < nkeys; i++) if (key_down[i]) { key_down[i] = 0; zwp_virtual_keyboard_v1_key(kbd, now_ms(), (uint32_t)i + 1, WL_KEYBOARD_KEY_STATE_RELEASED); }
  if (mods_depressed) { mods_depressed = 0; send_mods(); }
  for (int b = 0; b < 3; b++) if (buttons_down[b]) {
    buttons_down[b] = 0;
    zwlr_virtual_pointer_v1_button(ptr, now_ms(), BTN[b], WL_POINTER_BUTTON_STATE_RELEASED);
    zwlr_virtual_pointer_v1_frame(ptr);
  }
}

static int command(char *line) {
  char op = line[0], arg[64];
  unsigned x, y, w, h, code, sym;
  int st, steps;
  char axis;
  if (op == 'o' && sscanf(line, "o %63s", arg) == 1) return make_pointer(arg);
  if (op == 'm' && sscanf(line, "m %u %u %u %u", &x, &y, &w, &h) == 4 && w > 0 && h > 0 && w <= 65535 && h <= 65535 && x <= w && y <= h) {
    zwlr_virtual_pointer_v1_motion_absolute(ptr, now_ms(), x, y, w, h);
    zwlr_virtual_pointer_v1_frame(ptr);
    return 0;
  }
  if (op == 'b' && sscanf(line, "b %u %d", &code, &st) == 2 && (st == 0 || st == 1)) {
    int i = code == 272 ? 0 : code == 273 ? 1 : code == 274 ? 2 : -1;
    if (i < 0) return -1;
    if (!st && !buttons_down[i]) return 0;
    buttons_down[i] = st;
    zwlr_virtual_pointer_v1_button(ptr, now_ms(), code, st ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
    zwlr_virtual_pointer_v1_frame(ptr);
    return 0;
  }
  if (op == 'a' && sscanf(line, "a %c %d", &axis, &steps) == 2 && (axis == 'v' || axis == 'h') && steps >= -10 && steps <= 10 && steps) {
    uint32_t ax = axis == 'v' ? WL_POINTER_AXIS_VERTICAL_SCROLL : WL_POINTER_AXIS_HORIZONTAL_SCROLL;
    zwlr_virtual_pointer_v1_axis_source(ptr, WL_POINTER_AXIS_SOURCE_WHEEL);
    zwlr_virtual_pointer_v1_axis_discrete(ptr, now_ms(), ax, wl_fixed_from_int(steps * 15), steps);
    zwlr_virtual_pointer_v1_frame(ptr);
    return 0;
  }
  if (op == 'k' && sscanf(line, "k %x %d", &sym, &st) == 2 && (st == 0 || st == 1) && sym > 0 && sym <= 0x0110ffff) return key(sym, st);
  if (op == 'r') { release_all(); return 0; }
  return -1;
}

int main(void) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  dpy = wl_display_connect(NULL);
  if (!dpy) { printf("err no_wayland_display\n"); return 2; }
  struct wl_registry *reg = wl_display_get_registry(dpy);
  wl_registry_add_listener(reg, &registry_listener, NULL);
  wl_display_roundtrip(dpy);
  wl_display_roundtrip(dpy);   /* output names */
  if (!seat || !pmgr || !kmgr) { printf("err unsupported_compositor\n"); return 3; }
  kbd = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(kmgr, seat);
  if (make_pointer(NULL) || !kbd || upload_keymap()) { printf("err create_failed\n"); return 3; }
  printf("ready\n");
  char line[256];
  while (fgets(line, sizeof line, stdin)) {
    if (line[0] == 'q') break;
    int rc = command(line);
    if (wl_display_flush(dpy) < 0 && errno != EAGAIN) { printf("err display_lost\n"); return 4; }
    printf(rc ? "err bad_command\n" : "ok\n");
  }
  release_all();
  wl_display_roundtrip(dpy);
  zwp_virtual_keyboard_v1_destroy(kbd);
  zwlr_virtual_pointer_v1_destroy(ptr);
  wl_display_roundtrip(dpy);
  wl_display_disconnect(dpy);
  return 0;
}
