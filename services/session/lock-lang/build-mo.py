#!/usr/bin/python3
"""Compiles services/session/lock-lang/<lang>.po into <out>/<lang>@worksuitepin/LC_MESSAGES/gtklock.mo.
The .po files hold plain one-line msgid/msgstr pairs; this writes the GNU .mo format without needing gettext's msgfmt.
Run by packaging/debian/rules:  python3 -I services/session/lock-lang/build-mo.py OUTDIR"""
import ast
import pathlib
import struct
import sys


def parse_po(text):
    msgs, key = {}, None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("msgid "):
            key = ast.literal_eval(line[6:])
        elif line.startswith("msgstr ") and key is not None:
            msgs[key] = ast.literal_eval(line[7:])
            key = None
    return msgs


def mo_bytes(msgs):
    keys = sorted(msgs)
    ids = [k.encode() for k in keys]
    strs = [msgs[k].encode() for k in keys]
    n = len(keys)
    start = 7 * 4 + 16 * n
    table, data = [], b""
    for b in ids:
        table.append((len(b), start + len(data))); data += b + b"\0"
    for b in strs:
        table.append((len(b), start + len(data))); data += b + b"\0"
    head = struct.pack("<7I", 0x950412DE, 0, n, 7 * 4, 7 * 4 + 8 * n, 0, 0)
    return head + b"".join(struct.pack("<2I", *t) for t in table) + data


def main(out):
    here = pathlib.Path(__file__).resolve().parent
    for po in sorted(here.glob("*.po")):
        d = pathlib.Path(out) / f"{po.stem}@worksuitepin" / "LC_MESSAGES"
        d.mkdir(parents=True, exist_ok=True)
        (d / "gtklock.mo").write_bytes(mo_bytes(parse_po(po.read_text(encoding="utf-8"))))


if __name__ == "__main__":
    main(sys.argv[1])
