# Release rings and Update Center channels

WorkSuite OS has three release rings. A build goes through them in order, never skipping one:
`development` → `pilot` → `stable`.

The one mapping is `tools/release/rings.mjs`. `tools/release/rings.test.mjs` (CI `os-scripts` job) checks that every
other list of ring names or suites in this repository matches it: the server, device agent, package service, API
contract, shell, the APT publish script, the image workflow and the table below.

| OS ring (canonical) | Also accepted | Update Center channel | APT suite |
| --- | --- | --- | --- |
| `development` | `canary`, `dev` | DEV | `trixie-dev` |
| `pilot` | `beta` | BETA | `trixie-pilot` |
| `stable` | — | STABLE | `trixie-stable` |

## Where each name is used

- **Devices** use the canonical names only: policy `update_ring`, `/etc/worksuite/updates.json` `update_ring`, signed
  release manifests (`ring`), the update status file and the manifest URL
  `https://<update host>/os/manifests/<ring>/<arch>.json`. Images ship on `stable`.
- **WorkSuite server** (`services/server`) stores, signs, promotes and validates canonical names only
  (`release-promote --from pilot --to stable`, the console's Update ring picker, `PUT /admin/api/policy`).
- **Update Center** (Livezen-Technologies/worksite-download) keeps the canonical names in its database and in the
  manifests it signs, shows them as the channels DEV / BETA / STABLE, and accepts `canary`, `dev` and `beta` as
  aliases when CI publishes. It is the Update Center's own server-update rings (`canary`, `early`, `broad`,
  `conservative`) that are a different thing; they do not apply to WorkSuite OS.
- **CI** (`.github/workflows/image.yml`, job `update-center`) reads the `UPDATE_CENTER_RING` variable, which may be a
  canonical name or an alias. `tools/release/rings.mjs ci-suite` turns it into the APT suite to sign, and
  `tools/release/publish-update-center.mjs` sends the Update Center the canonical name. CI publishes to `development`
  and `pilot` only; `stable` is reached by promotion in the Update Center.

## Renaming

Nothing is renamed: the canonical names are what devices in the field have in their policy and configuration, and
what the Update Center stores. The aliases exist only on the publishing side (CI and the Update Center's API), so
both names keep working there. To add an alias, add it to `rings.mjs` and to the table above; the Update Center's
alias list (`OsUpdateService::ALIASES`) must accept it too.
