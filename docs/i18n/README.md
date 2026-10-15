# Localisation and translation review

WorkSuite OS ships in English, Sinhala (සිංහල) and Tamil (தமிழ்) (SRS §11.5). English is the source language.
**The Sinhala and Tamil texts are machine-drafted.** They have not been checked by native speakers and must be
reviewed before a release that advertises them.

## Where the strings live

| Part | Source (English) | Sinhala / Tamil | Checked by |
|---|---|---|---|
| Shell (desktop, Settings, App Center, Files, Updates, Recovery, First run, lock, launcher, dialogs) | `shell/src/i18n/en.ts` | `shell/src/i18n/si.ts`, `ta.ts` | `shell/src/i18n/catalog.lint.test.ts`, `i18n.test.ts` |
| App windows (Mail, Calendar… sign-in and error states) | same catalog, read in the Electron main process through `shell/src/i18n/core.ts` | same | same |
| Installer (Calamares branding QML and the `worksuiteconfirm` module) | `qsTr()` / `tr()` in `installer/branding/worksuite/*.qml`, `installer/modules/worksuiteconfirm/*.cpp` | `installer/lang/calamares-worksuite_si.ts`, `_ta.ts` | `installer/tests/test_translations.py` |

Review status is recorded next to the translations:

- Shell: `export const review` in `si.ts` / `ta.ts` — `reviewed: false` for the whole locale, `reviewer`, and
  `reviewedKeys` for keys already signed off. The language picker (accessibility panel) labels an unreviewed locale
  "(draft)".
- Installer: Qt Linguist marks; a finished translation has no `type` attribute. Drafted entries are finished so that
  Calamares shows them, so the review state is tracked in this file (see the checklist below) rather than with
  `type="unfinished"`.

## Rules for strings

- Never write user-visible text in JSX or in code that produces UI text. Add a key to `en.ts` and use `t('key')`
  (`useT()` in components that must re-render on a language change; module-level tables use `messages({...})`).
- Keys are stable ids (`area.thing`); change the English text freely, but rename a key only together with every
  locale.
- Variables are `{name}` placeholders; translations must keep exactly the same placeholders. Write whole sentences
  with placeholders instead of joining fragments, and give singular and plural their own keys (`…One`, `…Many`).
- Dates, numbers, sizes and money go through `formatDate`, `formatNumber`, `formatBytes` and `formatCurrency`
  (Sri Lanka region: `en-GB`, `si-LK`, `ta-LK`; LKR, AED, USD, EUR, GBP).
- Brand and product names stay in Latin script: WorkSuite, WorkSuite OS, WorkSuite Cloud, OneAuth, Wi-Fi,
  Bluetooth, VPN, WireGuard, Flatpak, AppImage, USB, LUKS2, file formats and command lines.
- Literal text is allowed only where `ALLOW` in `catalog.lint.test.ts` says so (brand names, key caps, sample
  addresses, language names written in their own language; `Installer.tsx` is a design mock of the Calamares flow).

`npm test` in `shell/` fails when a JSX text node or a text attribute (`aria-label`, `title`, `placeholder`, `label`,
`alt`) is literal, when a key is missing from a locale or has different placeholders, or when code calls `t()` with a
key that doesn't exist. For the installer, run `python3 installer/lang/extract.py` after changing a `qsTr`/`tr` string
(it merges new sources into the `.ts` files and keeps existing translations), then translate the new entries;
`python3 -m unittest discover -s installer/tests` fails while any entry is unfinished or loses a `%1`/`%n`.
`installer/lang/build.sh` (run by `packaging/debian/rules`) compiles the `.ts` files with `lrelease` into the
branding's `lang/` directory as `calamares-worksuite_<lang>.qm`, which is where Calamares loads branding translations.

## Review process

1. **Reviewers.** One native speaker per language, fluent in technical Sinhala or Tamil as used in Sri Lanka, plus a
   second native speaker for a spot check of at least 20% of the strings. Record their names in the PR.
2. **Material.** Export the strings side by side:
   - shell: `en.ts` next to `si.ts` / `ta.ts` (keys are in the same order within each area);
   - installer: open the `.ts` files in Qt Linguist (`linguist installer/lang/calamares-worksuite_si.ts`).
   Screenshots: run the shell (`npm run dev` in `shell/`), switch the language in the accessibility panel, and walk
   through every screen; `?mode=recovery` shows the recovery screens. Truncated or overlapping text is a bug to
   report with the key.
3. **What to check.** Meaning matches the English; terminology is consistent (use the glossary below and extend it);
   tone is plain and polite (Sinhala: neutral "ඔබ" form; Tamil: polite "நீங்கள்" form); placeholders and brand names
   are untouched; plural keys read naturally; nothing reads as machine translation; Sinhala and Tamil digits are not
   used (the `Intl` formatters print Western digits for `si-LK` and `ta-LK`, which is the Sri Lankan norm).
4. **Recording sign-off.** Change the text in the locale file, then add each reviewed key to `reviewedKeys`. When
   every key is reviewed, set `reviewed: true` and `reviewer` (the test refuses `reviewed: true` while keys are
   missing from `reviewedKeys`). For the installer, tick the language in the checklist below in the same PR.
5. **New strings after sign-off.** A new or changed English string makes the locale unreviewed again: remove the key
   from `reviewedKeys`, set `reviewed: false`, and draft the translation so the UI never falls back to English mid
   screen. Release notes must say when a locale contains unreviewed strings.

### Glossary (draft — confirm during review)

| English | Sinhala | Tamil |
|---|---|---|
| Settings | සැකසුම් | அமைப்புகள் |
| Update | යාවත්කාලීනය | புதுப்பிப்பு |
| Sign in / Sign out | පුරනය වන්න / වරනය වන්න | உள்நுழை / வெளியேறு |
| Restart / Shut down | නැවත අරඹන්න / වසා දමන්න | மறுதொடக்கு / அணை |
| Driver | ධාවකය | இயக்கி |
| Recovery key | ප්‍රතිසාධන යතුර | மீட்பு விசை |
| Passphrase | මුරවැකිය | கடவுச்சொற்றொடர் |
| Sync | සමමුහුර්තය | ஒத்திசைவு |
| Enroll (a device) | ලියාපදිංචි කරන්න | பதிவுசெய் |
| Your organization | ඔබේ සංවිධානය | உங்கள் நிறுவனம் |

### Installer review checklist

- [ ] Sinhala (`calamares-worksuite_si.ts`, 104 strings) reviewed by: —
- [ ] Tamil (`calamares-worksuite_ta.ts`, 104 strings) reviewed by: —
