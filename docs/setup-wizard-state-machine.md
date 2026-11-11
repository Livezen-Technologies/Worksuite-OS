# Setup state machine, transition rules, checkpoint and rollback boundaries

Source of truth: `shell/src/components/setup-wizard/core/states.ts` (data) and `SetupStateMachine.ts` (enforcement).
Tests: `SetupStateMachine.test.ts`. This page explains the rules; if they disagree, the code wins and this page is wrong.

## Modes

| Mode | Where | Runs |
| --- | --- | --- |
| `install` | live ISO | every main state |
| `firstRun` | installed OS | skips `STORAGE_CONFIGURATION` and `INSTALLING_OS` |

## Main flow

`INITIALIZING → WELCOME → LANGUAGE_REGION → NETWORK_SETUP → ACCOUNT_TYPE → ACCOUNT_AUTHENTICATION → DEVICE_ENROLLMENT →
STORAGE_CONFIGURATION* → SECURITY_CONFIGURATION → WORKSUITE_APP_SELECTION → THIRD_PARTY_APP_SELECTION →
AI_MCP_CONFIGURATION → REVIEW_CONFIGURATION → PRE_INSTALL_VALIDATION → INSTALLING_OS* → INSTALLING_APPLICATIONS →
VERIFYING_INSTALLATION → FINAL_CONFIGURATION → SETUP_COMPLETED` (* install only)

Two kinds of main state:

- **Question states** wait for the person. They leave forward on `NEXT`, and only when every field in `requires` validates (`SetupValidation.ts`).
- **Work states** (`INITIALIZING`, `PRE_INSTALL_VALIDATION`, `INSTALLING_OS`, `INSTALLING_APPLICATIONS`, `VERIFYING_INSTALLATION`, `FINAL_CONFIGURATION`) run on their own. They leave forward on `WORK_DONE` from the host. `NEXT` is refused.

## Transition rules (main states)

| Event | Rule |
| --- | --- |
| `NEXT` | Question state, answers valid → next state in the mode's flow. Missing or invalid answers → refused with `fieldErrors`. |
| `WORK_DONE` | Work state → next state. |
| `BACK` | → previous state, only before the point of no return (`PRE_INSTALL_VALIDATION`). Never to `INITIALIZING`. |
| `GOTO to` | Edit from the review: only to an **earlier** state of the same mode, before the point of no return. |
| `WORK_FAILED` / `TIMEOUT` | attempts + 1. If retryable and attempts ≤ `retry.max` → `RETRYING` with `retryInMs = backoff × factor^(attempts−1)`. Otherwise → the state's `onExhausted` (`FAILED` or `RECOVERY_MODE`). `TIMEOUT` is refused for states with `timeoutMs = 0`. |
| `NETWORK_LOST` | State with `network: required` → `WAITING_FOR_NETWORK`. `optional`/`none` → stays (works offline, queues downloads). |
| entering a `network: required` state while offline | → `WAITING_FOR_NETWORK`, resumes into it on `NETWORK_RESTORED`. |
| `PAUSE` | → `PAUSED`. **Refused in `INSTALLING_OS`.** |
| `NEED_USER` / `NEED_APPROVAL` | → `WAITING_FOR_USER` / `WAITING_FOR_ADMIN_APPROVAL`. |
| `ENTER_RECOVERY` | → `RECOVERY_MODE` (host runs `collectLogs`). |
| `CANCEL` | → `CANCELLED`. **Refused in `INSTALLING_OS`** (a half-written disk is unusable) and after completion. |

Attempts are counted per step. They reset when the flow moves to another main state, when a checkpoint is restored, and after a rollback. They are kept across `RETRYING`, `PAUSED` and recovery round trips into the same step.

## Transition rules (side states)

`@resume` = back to the interrupted main state (`resumeTo`). Its entry actions run again, so they must be idempotent. Any event not listed is refused.

| From | Event → To |
| --- | --- |
| `PAUSED` | RESUME → @resume · CANCEL → CANCELLED · ENTER_RECOVERY → RECOVERY_MODE |
| `WAITING_FOR_NETWORK` | NETWORK_RESTORED → @resume · PAUSE → PAUSED · TIMEOUT → RECOVERY_MODE · CANCEL · ENTER_RECOVERY |
| `WAITING_FOR_USER` | USER_DONE → @resume · CANCEL · ENTER_RECOVERY |
| `WAITING_FOR_ADMIN_APPROVAL` | APPROVED → @resume · DENIED / TIMEOUT → FAILED · NETWORK_LOST → WAITING_FOR_NETWORK · CANCEL |
| `RETRYING` | RETRY_NOW / TIMEOUT → @resume · PAUSE · NETWORK_LOST → WAITING_FOR_NETWORK · CANCEL |
| `FAILED` | ENTER_RECOVERY → RECOVERY_MODE · RESTART_SETUP → INITIALIZING · CANCEL |
| `RECOVERY_MODE` | RESUME / RETRY_NOW → @resume · RESTORE_CHECKPOINT → state after the checkpoint · ROLLBACK → ROLLING_BACK (only with a verified rollback point) · RESTART_SETUP → INITIALIZING · CANCEL |
| `ROLLING_BACK` | ROLLBACK_DONE → ROLLED_BACK · ROLLBACK_FAILED → RECOVERY_MODE |
| `ROLLED_BACK` | RESUME → @resume (the step after the rollback point) · RESTART_SETUP · ENTER_RECOVERY |
| `CANCELLED` | RESTART_SETUP → INITIALIZING |

`@resume` into a `network: required` state while offline goes to (or stays in) `WAITING_FOR_NETWORK`.

## Startup (crash, reboot, power loss)

| Persisted state found | Result |
| --- | --- |
| none | `INITIALIZING`, fresh. |
| question state | resumes there with all answers (`startReason: resumed`). |
| work state, `RETRYING` or `ROLLING_BACK` | **`RECOVERY_MODE`**, never a silent re-run (`interrupted`). Retry re-enters the step. |
| checksum mismatch or another schema version | `RECOVERY_MODE` with nothing trusted (`corrupt` / `version`). |
| `SETUP_COMPLETED` | stays completed. |

Every successful transition is written through `SetupPersistence` before the host acts on it. In the installer the setup service keeps the file on durable storage: the target root's `/var/lib/worksuite/setup/` once it exists, the ESP before that, and never only the live session's tmpfs.

## Checkpoint boundaries

A checkpoint (answers plus an optional rollback handle) is taken when the flow moves forward out of:

- every question state with `checkpoint: true` (all except `INITIALIZING` and `WELCOME`), once its answers validate. This is the "verified" point.
- every state next to a reversible or destructive one, so the host can attach the handle for the step about to run (`attachRollback`).

Restoring a checkpoint does three things:

1. It brings back its answers and drops the later checkpoints.
2. It reopens the step after it.
3. If that path will run `INSTALLING_OS` again, it clears `diskConfirmed`, so the person must type the disk name again. Files already on the disk are never "restored".

## Rollback boundaries

| State | Effect | Rollback handle | Undo (by the setup service, never the UI) |
| --- | --- | --- | --- |
| `DEVICE_ENROLLMENT` | reversible | `enrollment` (not provided yet) | the device agent has no unenroll, so the service registers no provider and rollback of enrollment is **not offered**; an administrator revokes the device in the console |
| `INSTALLING_OS` | **destructive** | `snapshot` / `ab-slot` only | boot the previous system from a snapshot or A/B slot taken **and verified before** installing |
| `INSTALLING_APPLICATIONS` | reversible | `package-transaction` | remove packages this setup installed, reverse dependency order |
| `FINAL_CONFIGURATION` | reversible | `config-backup` | restore the configuration files saved before changing them |
| all others | none | — | nothing to undo; use Restore checkpoint |

Rollback is **offered only** when a checkpoint with a `verified` handle exists before the failed step (`RollbackManager.planRollback`). The plan lists what will be undone and, separately, what will **not** be undone. An erased disk without a pre-install snapshot is always reported as "not restored; restore from your backup". `RESTART_SETUP` forgets answers and checkpoints and says plainly that nothing on the disk is restored.

## Setup service (`services/setup`, `lk.worksuite.Setup1`)

The privileged half of the machine. Root, system bus, started by D-Bus activation only, packaged as `worksuite-setup`. It is not yet in the desktop metapackage: the UI adopts it in phase 3.

- **Machine:** `src/machine/` is a byte-identical copy of the shell's `core/` and `recovery/`, made by `npm run sync-machine`. `test/machine-sync.test.ts` fails when the copies differ.
- **Durable state** (`src/store.ts`):
  - every write is atomic (temp file, fsync, rename, directory fsync), with root-only files (0600 in a 0700 directory);
  - during an install it is mirrored to the ESP (`/boot/efi/worksuite-setup`) and to the target root once Calamares reports it with `TargetMounted`;
  - the newest valid copy wins, so a torn copy falls back to the other;
  - if no copy can be written, setup stops rather than continuing as if it were saved.
- **API:**

  | Method | Who may call it |
  | --- | --- |
  | `GetState`, `GetRecoveryOptions`, `GetLog` | anyone (read-only) |
  | `Send(event)`, `SetAnswer(key, value)` | polkit `lk.worksuite.setup.manage` |
  | `ConnectivityChanged`, `TargetMounted`, `WorkResult` | uid 0 only (NetworkManager dispatcher, Calamares) |

  Signal: `StateChanged`.
- **Input rules** (`src/validate.ts`):
  - The UI may send only person-driven events. `WORK_DONE`, `WORK_FAILED`, `TIMEOUT`, `ROLLBACK_*` and `NETWORK_*` come only from the service itself, so the UI cannot skip verification.
  - Answers must use known keys with a fixed shape.
  - Any key that looks like a password, passphrase, token, secret or PIN is refused anywhere in a value. Secrets go straight to the job that needs them and are never written to the state file. The enrollment token is one of them: the UI enrolls through `DeviceAgent1.Enroll`, and the service only verifies enrollment.
- **Actions:** only allowlisted privileged actions run (`SERVICE_ACTIONS`). The UI's own actions come back in `uiActions`. `partitionAndCopy` is external: the service waits for Calamares to report `WorkResult`, which is refused unless setup is in that step. A failed disk step goes to recovery and is never retried silently.
- **Rollback handles** (`src/rollback.ts`), taken before each reversible step (the first handle of a step is kept across retries):
  - `package-transaction`: the dpkg package set before the step; undo removes only the packages added since.
  - `config-backup`: copies with a sha256 manifest; undo restores them and deletes files that did not exist before.
  - `snapshot`: a read-only btrfs snapshot, only when the root is btrfs; undo sets it as the default subvolume for the next boot. On ext4 there is no handle, so no OS rollback is offered.
- **Not yet real** (phase 4): `queueInstalls` records the selection for the App Center and says so in the log. It never reports applications as installed.

## Security boundary

The React UI only holds the machine and sends events. Partitioning, package transactions, snapshots, enrollment revocation and the state file are owned by the native setup service: today `services/package-service` (polkit-gated D-Bus jobs) for packages, and Calamares jobs for the disk. The UI talks to it through a validated API, never shell commands.

## Phases

1. **Done here:** states, explicit rules, checkpoint and rollback boundaries, persistence format, recovery and rollback planning, tests.
2. **Done:** the setup service above.
3. **Done:** the UI on the machine (`shell/src/components/setup-wizard/`).
   - `SetupWizard`: one screen per main state; answers via `SetAnswer`, Continue/Back as `NEXT`/`BACK`, Review's "Change" as `GOTO`. Unattended steps, waiting, retries and cancellation show the service's state, and the rail shows progress.
   - `recovery/RecoveryScreen`: the options from `GetRecoveryOptions`, each with what it keeps and what it changes. Rollback appears only when a verified rollback point exists, and always asks for confirmation listing what is and isn't undone. `recovery/InstallationLogViewer` shows `GetLog`, with a problems-only filter.
   - `SetupGate`: first run uses the wizard only while the setup service answers and setup hasn't finished. Otherwise it keeps the shell's own first-run screens, as on systems without `worksuite-setup`.
   - Bridge: `electron/setup.ts` calls the service through `busctl`; `lib/setupApi.ts` adds an in-memory preview at `?setup=1`, `?setup=recovery` and `?setup=install`.
   - Strings are in en/si/ta (`i18n/setupWizard.ts`).
4. **Done:** the application catalog and installation engine (`services/setup/src/apps/`).
   - `catalog.ts`: WorkSuite Desktop (required), Office, POS, Desk and FrameFlow, plus Firefox, VLC, GIMP and Thunderbird. Trusted sources only: bundled `.deb` files checked against the image's `SHA256SUMS`, signed APT, and Flathub when it is configured system-wide.
   - `plan.ts`: the person's selection, plus the organization's mandatory apps (`setup_mandatory_apps`), minus restricted ones (`setup_restricted_apps`) and third-party apps outside Software Management's allowlist, with dependencies installed first.
   - `engine.ts`: each app is its own transaction, with a dependency check (`apt-get -s`), retries with backoff, and no retry when packages can't be resolved. An optional app that fails never fails setup. Apps that need the network while offline are queued and installed by `worksuite-setup-queue.timer`.
   - Progress for each app is exposed through `GetApps`, and the wizard shows it during "Installing apps".
   - End-to-end test: `tests/setup-apps/`, report in `docs/testing/setup-apps-e2e-2026-11-11.md`.
5. Next: animated install graphics bound to real job states (reduced motion respected), and enterprise deployment sync.
