# worksuite-rs-input: wlr virtual pointer/keyboard helper for remote support control (issue #37).
OUT ?= $(CURDIR)
CFLAGS ?= -O2 -g
SCANNER ?= wayland-scanner
WS_CFLAGS = -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong -I$(OUT)
PROTOS = virtual-keyboard-unstable-v1 wlr-virtual-pointer-unstable-v1

worksuite-rs-input: $(OUT)/worksuite-rs-input

$(OUT)/%-client-protocol.h: protocols/%.xml
	$(SCANNER) client-header $< $@
$(OUT)/%-protocol.c: protocols/%.xml
	$(SCANNER) private-code $< $@

$(OUT)/worksuite-rs-input: worksuite-rs-input.c $(PROTOS:%=$(OUT)/%-client-protocol.h) $(PROTOS:%=$(OUT)/%-protocol.c)
	$(CC) $(CFLAGS) $(WS_CFLAGS) -Wl,-z,relro,-z,now -o $@ $< $(PROTOS:%=$(OUT)/%-protocol.c) $$(pkg-config --cflags --libs wayland-client)

test: worksuite-rs-input
	sh ./test.sh

clean:
	rm -f worksuite-rs-input *-client-protocol.h *-protocol.c

.PHONY: worksuite-rs-input test clean
