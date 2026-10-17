# pam_worksuite.so (WSOS-DIR-009). PAM_INCLUDE: extra header dir; LIBPAM: libpam to link (default -lpam).
OUT ?= $(CURDIR)
CFLAGS ?= -O2 -g
LIBPAM ?= -lpam
WS_CFLAGS = -Wall -Wextra -Werror -fPIC -D_FORTIFY_SOURCE=2 -fstack-protector-strong $(if $(PAM_INCLUDE),-I$(PAM_INCLUDE))

# Real targets live in $(OUT), so a build in the source dir never satisfies one for another OUT (the test's).
pam_worksuite.so: $(OUT)/pam_worksuite.so
test_harness: $(OUT)/test_harness

$(OUT)/pam_worksuite.so: pam_worksuite.c
	$(CC) $(CFLAGS) $(WS_CFLAGS) -shared -Wl,-z,relro,-z,now -o $@ $< $(LIBPAM)

$(OUT)/test_harness: test_harness.c
	$(CC) $(CFLAGS) $(WS_CFLAGS) -o $@ $< $(LIBPAM)

test:
	sh ./test.sh

.PHONY: test pam_worksuite.so test_harness
