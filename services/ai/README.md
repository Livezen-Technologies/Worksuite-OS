# worksuite-ai — the on-device AI assistant

The assistant in the shell (Super+A, the panel's AI button, "Ask AI" in search, Settings › AI) answers with a model
that runs on this computer. Nothing a person asks leaves it. This is WorkSuite Desktop's Local AI
(Livezen-Technologies/worksuite-desktop, `electron/services/local-ai`) ported to the OS: the same runtime
(llama.cpp through node-llama-cpp, prebuilt binaries only), the same model catalog (Qwen3.5 0.8B / 2B / 4B / 9B,
Q4_K_M), the same hardware tiers, readiness check, crash limit and idle unload.

## Processes

| Unit (systemd --user) | Does | Network |
| --- | --- | --- |
| `worksuite-ai.service` | catalog, downloads, SHA-256 checks, policy, settings; serves `$XDG_RUNTIME_DIR/worksuite/ai.sock` (0600) | HTTPS to the catalog's hosts only (`src/fetch.ts`) |
| `worksuite-ai-engine.service` | llama.cpp; started on the first question, stopped after 10 idle minutes | none (`RestrictAddressFamilies=AF_UNIX`, `PrivateNetwork=yes`, AppArmor `deny network inet`) |

The engine has memory limits (`MemoryHigh=75%`, `MemoryMax=85%`, no swap) and a CPU quota; a model too large for the
computer is stopped and reported as "out of memory" rather than freezing the desktop. More than 3 crashes in 10
minutes stop the assistant until Settings › AI › Restart. CPU threads: "auto" is `autoThreads()` in
`src/hardware.ts`; the GPU (Vulkan) is used when the switch is on and llama.cpp finds one.

## Socket protocol

One JSON object per line, as `sync.sock` and `credentials.sock`. Requests `{ id, method, params }`, replies
`{ id, result }` or `{ id, error: <code> }`. Methods: `Status`, `Models`, `Refresh`, `Install {id}`,
`Cancel {id, discard?}` (pause / discard a download), `Remove {id}`, `SetDefault {id}`, `Check {id}`, `Test {id}`,
`Restart`, `SetSettings {enabled?, threads?, gpu?}`, `Ask {id, messages, maxTokens?, temperature?}` (the answer
streams on the same connection as `{ stream: { id, type: chunk|done|error } }`), `CancelAsk {id}`, `Watch`
(`{ changed: true }` lines). Limits (`src/server.ts` `LIMITS`): 256 KiB per line, 64 messages, 32 000 characters per
message and 96 000 in all, 4096 tokens per answer; unknown keys, roles or methods are refused. Errors are codes; the
shell words them in English, Sinhala and Tamil. Prompts and answers are never logged.

## Models

Never in the image. The catalog is `/usr/share/worksuite/ai/catalog.json` (this package; `catalog/catalog.json`), or
an administrator's `/etc/worksuite/ai-catalog.json` in its place. Each model is pinned by URL (https, on a host the
catalog lists), size and SHA-256; a model whose checksum is not published yet (`"sha256": ""`) is listed but cannot
be downloaded. Release: `node tools/catalog.mjs fill catalog/catalog.json <dir-with-<id>.gguf>` pins them.

Downloads go to `$XDG_DATA_HOME/worksuite/ai/models/<id>/<version>/model.gguf.part`, resume with HTTP Range, can be
paused or discarded, and are renamed into place only when size and SHA-256 match. The file is hashed again before
llama.cpp loads it (once per change of the file). An administrator can install a model for everyone:
`sudo worksuite-ai system-install <model-id> <file.gguf>` (checked against the catalog, copied to
`/var/lib/worksuite/ai/models`).

## Policy

The organization sets `ai_assistant` (on/off) and `ai_models` (allowed catalog ids) in the WorkSuite admin console
(`services/server`). The device agent writes `/etc/worksuite/ai-policy.json` (`{"enabled":…,"models":[…]}`); the
service applies a change at once. A policy file that cannot be read turns the assistant off.

## Tests

`npm test`: protocol, validation, cancel, crashes and out of memory, policy, download, resume and hash checks (with a
fake engine and fake downloads). Real llama.cpp, end to end:

    python3 tools/make-tiny-gguf.py /tmp/tiny.gguf      # pip install gguf numpy; a 0.5 MB random-weight model
    WORKSUITE_AI_SMOKE_MODEL=/tmp/tiny.gguf npm test
