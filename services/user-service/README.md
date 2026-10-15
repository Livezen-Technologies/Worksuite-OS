# worksuite-user-services

User-level services packaged as `worksuite-user-services` (SRS §12.2): app catalog cache, Drive/files,
credentials broker and the sync service. The sync core is `services/sync`; this directory holds the session-bus
contract the shell uses (`dbus/lk.worksuite.Credentials1.xml`: `lk.worksuite.Credentials1` token broker and
`lk.worksuite.Sync1` status/per-record errors). The unit is `services/session/systemd/user/worksuite-sync.service`.

Rules: caller UID must equal the session UID (SRS §10.3); refresh tokens only in Secret Service; access tokens in
memory; `X-WS-Device` added to every desktop API call from the device credential, never from the user token.
