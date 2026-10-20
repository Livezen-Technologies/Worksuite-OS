# worksuite-guard (issue #38): protected folders, ransomware burst detection, executable deny list on fanotify.
OUT ?= $(CURDIR)
CFLAGS ?= -O2 -g
WS_CFLAGS = -std=gnu11 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE

worksuite-guard: $(OUT)/worksuite-guard

$(OUT)/worksuite-guard: worksuite-guard.c sha256.h
	$(CC) $(CFLAGS) $(WS_CFLAGS) -pie -Wl,-z,relro,-z,now -o $@ $<

test:
	sh ./test.sh

.PHONY: test worksuite-guard
