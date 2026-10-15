# Build: generate the pywayland protocol bindings. Test: unit + D-Bus tests (and a headless Labwc run when installed).
WAYLAND_XML ?= $(shell pkg-config --variable=pkgdatadir wayland-scanner 2>/dev/null || echo /usr/share/wayland)/wayland.xml
SCANNER ?= $(shell command -v pywayland-scanner || echo python3 -m pywayland.scanner)

all: protocols

protocols:
	rm -rf worksuite_bridge/protocol
	$(SCANNER) -i $(WAYLAND_XML) protocols/xdg-shell.xml protocols/wlr-foreign-toplevel-management-unstable-v1.xml protocols/wlr-layer-shell-unstable-v1.xml -o worksuite_bridge/protocol
	touch worksuite_bridge/protocol/__init__.py

test: protocols
	PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -t . -v

.PHONY: all protocols test
