# installer

Calamares configuration (WSOS-INS-001…009). `settings.conf` → `/etc/calamares/`, `modules/*.conf` →
`/etc/calamares/modules/`, `branding/worksuite/` → `/usr/share/calamares/branding/worksuite/`; packaged as
`calamares-settings-worksuite` and placed on the live ISO only. Flow: language → keyboard → disk (erase, LUKS2
option) → account → summary (explicit confirm) → install → done. Still to qualify: typed disk-name confirmation
(WSOS-INS-003) and recovery-key display (WSOS-INS-004) need a small custom view module; enrollment (WSOS-INS-006, P2)
happens in the first-boot setup assistant.
