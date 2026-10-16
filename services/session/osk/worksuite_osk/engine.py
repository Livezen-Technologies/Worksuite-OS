"""Keyboard state and logic, no toolkit: layout for the focused field, shift, pages, suggestions, vowel signs.

press() returns output actions for the output module (wtype): ("text", s), ("key", keysym), ("paste",), ("hide",).
Field type comes from text-input-v3 content purpose/hints (directly, or as the shell maps an HTML field to them);
password and PIN fields and fields marked sensitive get no suggestions and teach the word list nothing.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

from .layouts import ABC, BACK, EMOJI, ENTER, LANGS, NUMPAD, PHONE, PIN, SPACE, SYM, SYMBOLS, SYMBOLS2, Key

# zwp_text_input_v3 content_purpose
PURPOSE = {"normal": 0, "alpha": 1, "digits": 2, "number": 3, "phone": 4, "url": 5, "email": 6, "name": 7, "password": 8,
           "pin": 9, "date": 10, "time": 11, "datetime": 12, "terminal": 13}
# zwp_text_input_v3 content_hint bits
HINT_COMPLETION, HINT_SPELLCHECK, HINT_AUTOCAP = 0x1, 0x2, 0x4
HINT_LOWERCASE, HINT_HIDDEN, HINT_SENSITIVE, HINT_LATIN = 0x8, 0x40, 0x80, 0x100

WORDS = {
    "en": "the to and of a in is it you that for on this with be are have not was we can will your at but from as all "
          "meeting tomorrow today thanks thank please review report team project schedule morning afternoon evening "
          "next week month update question answer message email document file calendar office time call later "
          "available about would could should their there they what when where which while work worksuite".split(),
    "si": "ඔබ මම අපි ඔවුන් ස්තූතියි කරුණාකර හෙට අද ඊයේ රැස්වීම වැඩ කාර්යාලය ලිපිය ගොනුව දුරකථනය සතිය මාසය උදේ හවස "
          "හොඳයි ඔව් නැහැ කවදා කොහේද මොකද්ද".split(),
    "ta": "நான் நீங்கள் நாங்கள் அவர்கள் நன்றி தயவுசெய்து நாளை இன்று நேற்று கூட்டம் வேலை அலுவலகம் கடிதம் கோப்பு "
          "தொலைபேசி வாரம் மாதம் காலை மாலை சரி ஆம் இல்லை எப்போது எங்கே என்ன".split(),
}
MODES = ("full", "split", "floating")


@dataclass
class Keyboard:
    lang: str = "en"
    langs: tuple[str, ...] = ("en", "si", "ta")
    mode: str = "full"
    suggestions_on: bool = True
    learned_path: str | None = None
    purpose: int = 0
    hints: int = 0
    shift: int = 0          # 0 off, 1 once, 2 caps lock
    page: str = "letters"   # letters | symbols | symbols2 | emoji
    word: str = ""          # the word being typed (since the last space or field change)
    prev: str = ""          # last character typed, for vowel signs
    learned: dict[str, int] = field(default_factory=dict)

    def __post_init__(self):
        if self.learned_path:
            try:
                with open(self.learned_path) as f:
                    d = json.load(f)
                self.learned = {k: int(v) for k, v in d.items() if isinstance(k, str) and isinstance(v, int)} if isinstance(d, dict) else {}
            except (OSError, ValueError):
                self.learned = {}

    # ---- field type -------------------------------------------------------------------------------------
    def set_field(self, purpose: int = 0, hints: int = 0) -> None:
        self.purpose, self.hints = purpose, hints
        self.page, self.word, self.prev = "letters", "", ""
        self.shift = 1 if hints & HINT_AUTOCAP and not hints & HINT_LOWERCASE and self.lang == "en" else 0

    @property
    def private(self) -> bool:
        return self.purpose in (PURPOSE["password"], PURPOSE["pin"]) or bool(self.hints & (HINT_HIDDEN | HINT_SENSITIVE))

    def kind(self) -> str:
        """Which board: pin, number, phone, email, url or text (OSKVariants)."""
        p = self.purpose
        if p == PURPOSE["pin"]:
            return "pin"
        if p in (PURPOSE["digits"], PURPOSE["number"], PURPOSE["date"], PURPOSE["time"], PURPOSE["datetime"]):
            return "number"
        if p == PURPOSE["phone"]:
            return "phone"
        if p == PURPOSE["email"]:
            return "email"
        if p == PURPOSE["url"]:
            return "url"
        return "text"

    def latin_only(self) -> bool:
        return self.kind() in ("email", "url") or self.purpose in (PURPOSE["password"], PURPOSE["terminal"]) or bool(self.hints & HINT_LATIN)

    # ---- rows -------------------------------------------------------------------------------------------
    def rows(self) -> list[list[Key]]:
        k = self.kind()
        if k == "pin":
            return PIN
        if k == "number":
            return NUMPAD
        if k == "phone":
            return PHONE
        if self.page == "emoji":
            return EMOJI + [[ABC, SPACE, BACK]]
        if self.page in ("symbols", "symbols2"):
            body = SYMBOLS if self.page == "symbols" else SYMBOLS2
            return body + [self._bottom(ABC)]
        lang = "en" if self.latin_only() else self.lang
        L = LANGS[lang]
        body = L["shift"] if self.shift and L["shift"] else L["rows"]
        if lang == "en" and self.shift:
            body = [[Key(x.label.upper(), "text:" + x.label.upper(), x.width, x.alt) if not x.special else x for x in r] for r in body]
        return [list(r) for r in body] + [self._bottom(SYM)]

    def _bottom(self, first: Key) -> list[Key]:
        k = self.kind()
        enter = Key("Go", "key:Return", 1.6) if k == "url" else ENTER
        lang_key = [] if self.latin_only() or len(self.langs) < 2 else [Key(LANGS[self.lang]["name"], "lang", 1.2)]
        if k == "email":
            return [first, Key("@", "text:@"), Key(".", "text:."), SPACE, Key(".com", "text:.com", 1.5), enter]
        if k == "url":
            return [first, Key("/", "text:/"), Key(".", "text:."), Key(".com", "text:.com", 1.5), enter]
        return [first, Key(",", "text:,")] + lang_key + [SPACE, Key(".", "text:."), enter]

    def halves(self) -> list[list[list[Key]]]:
        """Split layout (thumb keyboard): each row cut in two."""
        rows = self.rows()
        if self.mode != "split" or self.kind() != "text":
            return [rows]
        cut = [((len(r) + 1) // 2) for r in rows]
        return [[r[:c] for r, c in zip(rows, cut)], [r[c:] for r, c in zip(rows, cut)]]

    # ---- input ------------------------------------------------------------------------------------------
    def press(self, key: Key) -> list[tuple]:
        a = key.action
        if a == "shift":
            self.shift = {0: 1, 1: 2, 2: 0}[self.shift]
            return []
        if a.startswith("page:"):
            self.page = a[5:]
            return []
        if a == "emoji":
            self.page = "emoji"
            return []
        if a == "lang":
            i = self.langs.index(self.lang) if self.lang in self.langs else 0
            self.lang = self.langs[(i + 1) % len(self.langs)]
            self.shift, self.word, self.prev = 0, "", ""
            return []
        if a == "mode":
            self.mode = MODES[(MODES.index(self.mode) + 1) % len(MODES)]
            return []
        if a == "clipboard":
            self.word, self.prev = "", ""
            return [("paste",)]
        if a == "hide":
            return [("hide",)]
        if a == "noop":
            return []
        if a == "key:BackSpace":
            self.word, self.prev = self.word[:-1], ""
            return [("key", "BackSpace")]
        if a.startswith("key:"):
            self._end_word()
            return [("key", a[4:])]
        text = a[5:]
        out = self._compose(text)
        if text == " " or re.fullmatch(r"[\s.,!?;:]", text):
            self._end_word()
        else:
            self.word += out
        if self.shift == 1 and text.strip():
            self.shift = 0
        if self.page == "emoji":
            self.page = "letters"
        return [("text", out)]

    def _compose(self, text: str) -> str:
        L = LANGS.get(self.lang, LANGS["en"])
        if self.prev and self.prev in L["consonants"] and text in L["signs"]:
            self.prev = ""
            return L["signs"][text]
        self.prev = text[-1:] if text else ""
        return text

    def _end_word(self) -> None:
        w = self.word.strip()
        if w and not self.private and len(w) > 1 and len(w) <= 40:
            self.learned[w] = self.learned.get(w, 0) + 1
            if len(self.learned) > 2000:
                for k, _ in sorted(self.learned.items(), key=lambda x: x[1])[:200]:
                    del self.learned[k]
            self._save()
        self.word, self.prev = "", ""

    def _save(self) -> None:
        if not self.learned_path:
            return
        try:
            os.makedirs(os.path.dirname(self.learned_path), mode=0o700, exist_ok=True)
            tmp = self.learned_path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(self.learned, f, ensure_ascii=False)
            os.replace(tmp, self.learned_path)
        except OSError:
            pass

    # ---- suggestion bar ---------------------------------------------------------------------------------
    def suggestions(self, n: int = 3) -> list[str]:
        if not self.suggestions_on or self.private or self.kind() != "text":
            return []
        lang = "en" if self.latin_only() else self.lang
        prefix = self.word
        if not prefix:
            return []
        cands = list(self.learned) + WORDS.get(lang, [])
        lower = prefix.lower()
        seen, out = set(), []
        for w in sorted(cands, key=lambda w: (-self.learned.get(w, 0), len(w))):
            if w.lower().startswith(lower) and w.lower() != lower and w not in seen:
                seen.add(w)
                out.append(w if not prefix[:1].isupper() else w[:1].upper() + w[1:])
            if len(out) == n:
                break
        return out

    def pick(self, word: str) -> list[tuple]:
        """Replaces the word being typed with a suggestion and a space."""
        acts = [("key", "BackSpace")] * len(self.word) + [("text", word + " ")]
        self.word = word
        self._end_word()
        return acts
