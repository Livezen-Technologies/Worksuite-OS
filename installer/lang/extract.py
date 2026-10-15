#!/usr/bin/env python3
"""Installer string extraction (SRS §11.5), a small stand-in for lupdate.

Collects qsTr("…") from the branding QML (context = file name, as lupdate does) and tr("…") from the
worksuiteconfirm view module (context = WorksuiteConfirmViewStep), and merges them into
installer/lang/calamares-worksuite_<lang>.ts, keeping existing translations. build.sh compiles the .ts
files into the branding's lang/ directory, where Calamares loads calamares-<componentName>_<lang>.qm.

  extract.py           update the .ts files
  extract.py --check   exit 1 if a .ts file is missing a source string (used by the tests)
"""
from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSTALLER = HERE.parent
LANGS = ("si", "ta")
STR = r'"(?:[^"\\]|\\.)*"'
QML_RE = re.compile(r"\bqsTr\(\s*(" + STR + r")")
CPP_RE = re.compile(r"\btr\(\s*((?:" + STR + r"\s*)+)")


def unescape(lit: str) -> str:
    body = "".join(re.findall(STR, lit))
    parts = [p[1:-1] for p in re.findall(STR, body)]
    s = "".join(parts)
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), s)


def sources() -> dict[str, list[str]]:
    """context → source strings, in file order, without duplicates."""
    out: dict[str, list[str]] = {}
    for f in sorted((INSTALLER / "branding" / "worksuite").glob("*.qml")):
        for m in QML_RE.finditer(f.read_text(encoding="utf-8")):
            out.setdefault(f.stem, [])
            s = unescape(m.group(1))
            if s not in out[f.stem]:
                out[f.stem].append(s)
    for f in sorted((INSTALLER / "modules" / "worksuiteconfirm").glob("*.cpp")):
        ctx = f.stem
        for m in CPP_RE.finditer(f.read_text(encoding="utf-8")):
            out.setdefault(ctx, [])
            s = unescape(m.group(1))
            if s not in out[ctx]:
                out[ctx].append(s)
    return out


def ts_path(lang: str) -> Path:
    return HERE / f"calamares-worksuite_{lang}.ts"


def existing(lang: str) -> dict[tuple[str, str], str]:
    p = ts_path(lang)
    if not p.exists():
        return {}
    root = ET.parse(p).getroot()
    found = {}
    for ctx in root.iter("context"):
        name = ctx.findtext("name", "")
        for msg in ctx.iter("message"):
            t = msg.find("translation")
            if t is not None and (t.text or "") and t.get("type") not in ("unfinished", "obsolete"):
                found[(name, msg.findtext("source", ""))] = t.text or ""
    return found


def write(lang: str, src: dict[str, list[str]]) -> None:
    done = existing(lang)
    root = ET.Element("TS", version="2.1", language={"si": "si_LK", "ta": "ta_LK"}.get(lang, lang))
    for ctx, strings in src.items():
        c = ET.SubElement(root, "context")
        ET.SubElement(c, "name").text = ctx
        for s in strings:
            m = ET.SubElement(c, "message")
            ET.SubElement(m, "source").text = s
            tr = ET.SubElement(m, "translation")
            if (ctx, s) in done:
                tr.text = done[(ctx, s)]
            else:
                tr.set("type", "unfinished")
    ET.indent(root)
    body = ET.tostring(root, encoding="unicode")
    ts_path(lang).write_text('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE TS>\n' + body + "\n", encoding="utf-8")


def missing(lang: str, src: dict[str, list[str]]) -> list[str]:
    p = ts_path(lang)
    if not p.exists():
        return [f"{p.name} missing"]
    root = ET.parse(p).getroot()
    have = {(ctx.findtext("name", ""), m.findtext("source", "")) for ctx in root.iter("context") for m in ctx.iter("message")}
    return [f"{lang}: {c}: {s!r}" for c, ss in src.items() for s in ss if (c, s) not in have]


def main(argv: list[str]) -> int:
    src = sources()
    if "--check" in argv:
        gaps = [g for lang in LANGS for g in missing(lang, src)]
        print("\n".join(gaps) or f"{sum(map(len, src.values()))} strings in {len(src)} contexts, all present")
        return 1 if gaps else 0
    for lang in LANGS:
        write(lang, src)
    print(f"{sum(map(len, src.values()))} strings → {', '.join(ts_path(l).name for l in LANGS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
