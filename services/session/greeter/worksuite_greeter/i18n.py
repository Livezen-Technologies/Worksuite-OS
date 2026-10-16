"""Greeter strings in Sinhala and Tamil (English is the source, in the code). Machine drafts, not reviewed yet, like
the shell's catalogs (docs/i18n/README.md). The language is the system's (worksuite-greeter exports LANG from
/etc/default/locale); tests/test_i18n.py checks that every string in the greeter has both translations with the same
{placeholders}."""
import os

from .i18n_si import SI, SI_PLURAL
from .i18n_ta import TA, TA_PLURAL

CATALOGS = {"si": (SI, SI_PLURAL), "ta": (TA, TA_PLURAL)}


def language(env=None):
    env = os.environ if env is None else env
    for var in ("LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"):
        v = (env.get(var) or "").split(":")[0]
        if v:
            return v[:2].lower()
    return "en"


class Catalog:
    def __init__(self, lang=None):
        self.lang = lang or language()
        self.single, self.plural = CATALOGS.get(self.lang, ({}, {}))

    def gettext(self, s):
        return self.single.get(s, s)

    def ngettext(self, one, many, n):
        forms = self.plural.get(one)
        if forms:
            return forms[0] if n == 1 else forms[1]
        return one if n == 1 else many


def translation(lang=None):
    return Catalog(lang)
