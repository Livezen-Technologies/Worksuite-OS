# pam_worksuite.so (WSOS-DIR-009). PAM_INCLUDE: extra header dir; LIBPAM: libpam to link (default -lpam).
OUT ?= .
CFLAGS ?= -O2 -g
LIBPAM ?= -lpam
WS_CFLAGS = -Wall -Wextra -Werror -fPIC -D_FORTIFY_SOURCE=2 -fstack-protector-strong $(if $(PAM_INCLUDE),-I$(PAM_INCLUDE))

pam_worksuite.so: pam_worksuite.c
	$(CC) $(CFLAGS) $(WS_CFLAGS) -shared -Wl,-z,relro,-z,now -o $(OUT)/$@ $< $(LIBPAM)

test_harness: test_harness.c
	$(CC) $(CFLAGS) $(WS_CFLAGS) -o $(OUT)/$@ $< $(LIBPAM)

test:
	sh ./test.sh

.PHONY: test
