# worksuite-polkit-listener (WSOS-INT-010): polkit's listener in C for the Python agent. OUT: build directory.
OUT ?= $(CURDIR)
CFLAGS ?= -O2 -g
WS_CFLAGS = -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong $(shell pkg-config --cflags polkit-agent-1)
LIBS = $(shell pkg-config --libs polkit-agent-1)

worksuite-polkit-listener: $(OUT)/worksuite-polkit-listener

$(OUT)/worksuite-polkit-listener: worksuite-polkit-listener.c
	$(CC) $(CFLAGS) $(WS_CFLAGS) -Wl,-z,relro,-z,now -o $@ $< $(LIBS)

.PHONY: worksuite-polkit-listener
