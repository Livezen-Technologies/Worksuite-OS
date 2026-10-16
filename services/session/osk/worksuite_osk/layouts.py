"""Key layouts. Sinhala and Tamil type Unicode letters directly (wvkbd has neither): a vowel key right after a consonant
gives the vowel sign (pili / uyir-mei), as in Tamil99 and the Sinhala phonetic layouts."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Key:
    label: str
    action: str           # "text:<s>", "key:<keysym>", or a control: shift, page:<name>, emoji, clipboard, hide, lang, mode
    width: float = 1.0
    alt: str = ""          # long-press alternative (shown small in the corner, as on the board)

    @property
    def special(self) -> bool:
        return not self.action.startswith("text:")


def T(chars: str, alts: str = "") -> list[Key]:
    a = alts.split() if alts else []
    return [Key(c, "text:" + c, alt=a[i] if i < len(a) else "") for i, c in enumerate(chars.split())]


SHIFT = Key("⇧", "shift", 1.5)
BACK = Key("⌫", "key:BackSpace", 1.5)
ENTER = Key("↵", "key:Return", 1.8)
SPACE = Key("", "text: ", 5)
SYM = Key("?123", "page:symbols", 1.5)
ABC = Key("ABC", "page:letters", 1.5)

QWERTY = [T("q w e r t y u i o p", "1 2 3 4 5 6 7 8 9 0"), T("a s d f g h j k l"), [SHIFT] + T("z x c v b n m") + [BACK]]
SYMBOLS = [T("1 2 3 4 5 6 7 8 9 0"), T("@ # ₹ _ & - + ( ) /"), [Key("=\\<", "page:symbols2", 1.5)] + T("* \" ' : ; ! ?") + [BACK]]
SYMBOLS2 = [T("~ ` | • √ π ÷ × ¶ Δ"), T("£ € $ ¢ ^ ° = { } \\"), [Key("?123", "page:symbols", 1.5)] + T("% © ® ™ ✓ [ ]") + [BACK]]

# Sinhala: common consonants and vowels first; Shift gives the rest (aspirates, prenasalised, rarer vowels, ZWJ for
# yansaya and rakaransaya).
SINHALA = [T("ක ග ච ජ ට ඩ ත ද ප බ"), T("ම ය ර ල ව ස හ න ණ ළ"), [SHIFT] + T("අ ආ ඇ ඉ ඊ උ එ ඔ ් ං") + [BACK]]
SINHALA_SHIFT = [T("ඛ ඝ ඡ ඣ ඨ ඪ ථ ධ ඵ භ"), T("ශ ෂ ඤ ඞ ඟ ඬ ඳ ඹ ෆ ඃ"), [SHIFT] + T("ඈ ඌ ඒ ඕ ඓ ඖ ෘ ෲ") + [Key("ZWJ", "text:‍"), BACK]]
SI_CONSONANTS = set("කඛගඝඞඟචඡජඣඤඥටඨඩඪණඬතථදධනඳපඵබභමඹයරලවශෂසහළෆ")
SI_SIGNS = {"ආ": "ා", "ඇ": "ැ", "ඈ": "ෑ", "ඉ": "ි", "ඊ": "ී", "උ": "ු", "ඌ": "ූ", "එ": "ෙ", "ඒ": "ේ", "ඔ": "ො", "ඕ": "ෝ", "ඓ": "ෛ", "ඖ": "ෞ", "අ": ""}

# Tamil99 rows.
TAMIL = [T("ஆ ஈ ஊ ஐ ஏ ள ற ன ட ண ச ஞ"), T("அ இ உ ் எ க ப ம த ந ய"), [SHIFT] + T("ஔ ஓ ஒ வ ங ல ர ழ") + [BACK]]
TAMIL_SHIFT = [T("ஜ ஷ ஸ ஹ க்ஷ ஸ்ரீ ஃ ௐ"), T("௧ ௨ ௩ ௪ ௫ ௬ ௭ ௮ ௯ ௦"), [SHIFT] + T("ௗ ௳ ௴ ௵ ௶ ௷ ௸ ௹") + [BACK]]
TA_CONSONANTS = set("கஙசஞடணதநபமயரலவழளறனஜஷஸஹ")
TA_SIGNS = {"ஆ": "ா", "இ": "ி", "ஈ": "ீ", "உ": "ு", "ஊ": "ூ", "எ": "ெ", "ஏ": "ே", "ஐ": "ை", "ஒ": "ொ", "ஓ": "ோ", "ஔ": "ௌ", "அ": ""}

LANGS = {
    "en": {"name": "EN", "rows": QWERTY, "shift": None, "consonants": set(), "signs": {}},
    "si": {"name": "සිං", "rows": SINHALA, "shift": SINHALA_SHIFT, "consonants": SI_CONSONANTS, "signs": SI_SIGNS},
    "ta": {"name": "தமி", "rows": TAMIL, "shift": TAMIL_SHIFT, "consonants": TA_CONSONANTS, "signs": TA_SIGNS},
}

# Field-type layouts (OSKVariants): number/PIN pad, phone, and extra keys for e-mail and URL fields.
NUMPAD = [T("1 2 3"), T("4 5 6"), T("7 8 9"), [Key(".", "text:."), Key("0", "text:0"), Key("⌫", "key:BackSpace")]]
PIN = [T("1 2 3"), T("4 5 6"), T("7 8 9"), [Key("", "noop"), Key("0", "text:0"), Key("⌫", "key:BackSpace")]]
PHONE = [T("1 2 3"), T("4 5 6"), T("7 8 9"), [Key("+", "text:+"), Key("0", "text:0"), Key("⌫", "key:BackSpace")]]
EMOJI = [T("😀 😂 😊 😍 🤔 😢 😮 😴 🙏 👍"), T("👋 👏 🙌 💪 🎉 ❤️ 🔥 ✅ ⭐ ☕"), T("📎 📅 📞 📧 🏠 🚗 ✈️ 💡 📌 🔒")]
