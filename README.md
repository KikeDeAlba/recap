# recap

Record meetings on macOS and turn them into a transcript, a summary, agreements and action items, all stored as local Markdown.

| Mode | Flag | Captures | Permissions |
|---|---|---|---|
| Remote (Meet, Zoom, Teams) | `--remote` | Screen (1280 px, 2 fps), system audio and microphone, as separate tracks | Screen & System Audio Recording, Microphone |
| In-person | `--in-person` | Microphone only | Microphone |

## Instalación con npm (núcleo en TypeScript)

Desde la 0.9 la CLI `recap` es un paquete de npm, `@kikedealba/recap`, que corre
en macOS, Windows y Linux. Lo único que sigue siendo exclusivo de macOS es la
grabación, que hace `Recap.app` (el grabador nativo `recap-capture`).

```sh
npm install -g @kikedealba/recap      # o: pnpm add -g @kikedealba/recap
recap setup --install-deps
```

Requisitos: Node 24 o superior, ffmpeg, whisper.cpp (`whisper-cli`) y
[Claude Code](https://claude.com/claude-code) para las minutas.

`recap setup` hace todo lo demás:

- con `--install-deps` instala ffmpeg y whisper-cpp con Homebrew en macOS y
  ffmpeg con winget en Windows; en Linux muestra el comando (`sudo apt install
  ffmpeg`) y cómo conseguir whisper.cpp;
- descarga los modelos de whisper a `~/.local/share/recap/models`
  (`--skip-models` lo omite);
- en macOS baja `Recap.app` del último release de GitHub a `~/Applications` si
  no está (`--skip-app` lo omite; `RECAP_APP` apunta a otra copia) y pide los
  permisos de micrófono y pantalla (`--skip-permissions` solo los reporta);
- registra recap en el registro de herramientas de
  [kit](https://github.com/KikeDeAlba/kit) (`~/.config/kikedealba/tools.d`) con
  sus capacidades y, si bita está instalado, la suscripción a sus eventos
  `start`, `stop`, `cancel` y `amend` de las entradas `remote-meeting` e
  `in-person-meeting`. Reemplaza al viejo `bita hooks add` y quita ese hook si
  lo encuentra, para que no se dispare dos veces;
- en Claude Code agrega o actualiza el marketplace `KikeDeAlba/recap` e instala
  o actualiza el plugin `recap@recap` (`claude plugin marketplace add|update` y
  `claude plugin install|update --scope user`), así el plugin queda en la misma
  versión que la CLI; también quita los archivos sueltos que versiones viejas
  dejaron en `~/.claude`;
- en opencode, Codex y Gemini CLI instala la skill y las skills de usuario en el
  formato de cada uno (`--agents codex,gemini`, `--agents all` o
  `--agents none`).

En Windows y Linux `recap start` falla con `CAPTURE_UNAVAILABLE`: graba con la
app que quieras y procesa el archivo con

```sh
recap import grabacion.m4a --title "Revisión semanal"     # presencial por omisión
recap import llamada.mov --remote                         # video con dos pistas de audio
```

Los archivos en disco, los comandos, las opciones y el sobre `--json` son los
mismos que los del `recap` en Swift, así que las dos versiones leen las mismas
reuniones. bita solo lleva el tiempo: las páginas, las propuestas, el backlog
y la nota de cada entrada viven en [inkwell](https://github.com/KikeDeAlba/inkwell),
y el volcado del tiempo a Jira lo hace [tally](https://github.com/KikeDeAlba/tally).
Sin inkwell la reunión se procesa igual: las etapas `proposals` y `wrapup` se
saltan con un aviso y la minuta se queda en la carpeta de la reunión.

Para trabajar en el paquete: `pnpm install`, `pnpm test`, `pnpm typecheck` y
`node src/bin/recap.ts <comando>`.

## Requirements

- macOS 15 or later (ScreenCaptureKit microphone capture), Apple Silicon recommended
- Xcode command line tools (Swift 6)
- `brew install ffmpeg whisper-cpp`
- [Claude Code](https://claude.com/claude-code) for summaries

## Install with bita

If you use [bita](https://github.com/KikeDeAlba/bita-cli), its setup installs everything:

```sh
bita setup
```

It downloads the latest `Recap.app` release to `~/Applications`, links `recap` into a directory on your `PATH`, installs the Claude Code plugin, and runs `recap setup --install-deps`, which installs ffmpeg and whisper-cpp with Homebrew, downloads the models, registers the bita hook and asks for the permissions. `bita setup --no-recap` skips all of it.

## Install from source


```sh
make install
```

This builds `Recap.app`, signs it with your first `Apple Development` identity (or ad-hoc when there is none, set `RECAP_SIGN_IDENTITY` to pick another one), copies it to `~/Applications` and links `~/.local/bin/recap`. Make sure `~/.local/bin` is on your `PATH`, or install the link elsewhere with `make install PREFIX_BIN=/opt/homebrew/bin`.

Then check the dependencies and grant the permissions:

```sh
recap setup                 # add --install-deps to brew install a missing ffmpeg or whisper-cpp
```

### Why an app bundle

The recorder always runs as `Recap.app`, launched with `open`, so macOS grants the microphone and screen permissions to Recap itself no matter who starts the recording: a terminal, Claude Code, bita or the bita menu bar app. With a stable signing identity the permissions survive rebuilds; with ad-hoc signing macOS may ask again after every `make install`.

## Usage

```sh
recap start --remote "Sprint planning"
recap status
recap stop

recap start --in-person "1:1 with Ana"
recap stop

recap list
recap show last
recap show --bita-entry 812 --json    # the meeting behind a bita entry, with paths to every file
recap discard <meeting>
```

Free space once a meeting is processed:

```sh
recap compress-video <meeting> --preset medium   # HEVC re-encode: light (1280 px, 2 fps), medium (960 px, 1 fps), max (720 px, 0.5 fps)
recap strip-video <meeting>                      # drop the video, keep mic and system audio in recording.m4a
recap prune <meeting> --intermediates            # delete mic.wav, system.wav, the per-channel transcripts and live/chunks
recap delete <meeting>                           # delete the whole meeting folder
```

`compress-video` and `strip-video` work on remote meetings only, accept `--bita-entry` and `--prune-intermediates`, check the new file (duration and audio tracks) with AVFoundation before replacing the original, and refuse while the meeting is being recorded or processed. `compress-video` keeps the original when the result is not smaller (`NOT_SMALLER`). After `strip-video` the `frames` stage is skipped and the existing frames are kept. `recap list --json` reports `hasVideo`, `storage` (`recordingBytes`, `intermediateBytes`, `framesBytes`, `otherBytes`, `totalBytes`), `video` and `videoRemovedAt` for each meeting; `--limit 0` lists them all.

`recap stop` processes the meeting in the background (`--no-process` to skip). Re-run the pipeline at any time:

```sh
recap process last                     # resume from the first stage that is not done
recap process <meeting> --from summarize   # regenerate the summary only
recap process <meeting> --only frames
recap prompt <meeting>                 # print the summary prompt with transcript and frames
recap save-summary <meeting> file.md   # store minutes written elsewhere
```

## Plugin de Claude Code

El repositorio también es un marketplace de plugins de Claude Code. `recap setup`
lo instala y lo mantiene al día; a mano sería:

```
claude plugin marketplace add KikeDeAlba/recap
claude plugin install recap@recap --scope user
claude plugin marketplace update recap && claude plugin update recap@recap   # al actualizar la CLI
```

Trae tres cosas:

- **La skill `recap`**, que Claude carga sola cuando la conversación trata de
  reuniones ("¿qué acordamos en la reunión de ayer?"). Es la única fuente del
  flujo de una reunión; bita y tally enlazan a ella. Lo largo (cierre con bita e
  inkwell, en vivo, propuestas, espacio) vive en archivos aparte que se leen
  solo cuando hacen falta.
- **Skills de usuario** con `disable-model-invocation: true`: no ocupan contexto
  y solo corren cuando las escribes.

  | Skill | Qué hace |
  |---|---|
  | `/recap:recap-start [remota\|presencial] [título]` | Empieza a grabar; saca el modo de los argumentos o de la conversación y pregunta si no puede |
  | `/recap:recap-stop [--no-wait]` | Para la grabación (por bita si la sigue un cronómetro), espera el procesamiento y muestra el resultado |
  | `/recap:recap-status` | Dice si se está grabando y en qué va el procesamiento |
  | `/recap:recap-list [reunión]` | Lista las reuniones o muestra la minuta de una |
  | `/recap:recap-summarize [reunión] [indicaciones]` | Rehace la minuta dentro de la sesión y la guarda con `recap save-summary` |
  | `/recap:recap-ask [pregunta]` | Responde la última pregunta de la reunión en curso, o la que le pases, con las páginas de inkwell y los repos del proyecto |
  | `/recap:recap-proposals [reunión]` | Revisa los cambios a la documentación que propuso una reunión |

- **Un monitor** (`monitors/monitors.json`) que corre `recap watch` en segundo
  plano en cada sesión interactiva. Revisa las carpetas de reuniones cada 5 s,
  sin llamar al modelo, y escribe una sola línea cuando una reunión termina de
  procesarse o falla; esa línea le llega a Claude como notificación. No corre
  con `claude -p`. Si `recap` no está en el `PATH`, no hace nada. Para apagarlo,
  define `RECAP_MONITOR=off` en el entorno de Claude Code (por ejemplo en
  `"env"` de `~/.claude/settings.json`).

Las skills llaman a `recap`, así que tiene que estar en el `PATH` del shell que
usa Claude Code.

## Live assistant

While a meeting is being recorded, recap also transcribes it live:

- The recorder taps the microphone and system audio, converts each to 16 kHz mono, and cuts it on silence into 3–10 s chunks (`live.maxChunkSeconds`) under `live/chunks/`. The tap runs on its own queue and never blocks the file writer.
- A detached `recap live-worker` transcribes each chunk with `whisper-cli` (same model and VAD as the pipeline, 4 threads, the previous text as prompt), drops hallucinations and microphone echo, and appends `{startMs, endMs, channel, text}` lines to `live/transcript.jsonl`, with offsets from the start of the recording. It exits once the recording stops and the queue is empty.
- The transcript after `stop` is still the source of truth; the live one is for answering during the meeting.

`recap ask` answers a question with Claude Code (headless, streaming), reading only the inkwell pages of the project (`inkwell page ls --project`) and the repositories registered for it in bita (`bita project repo ls`). Without inkwell it answers from the repositories alone:

```sh
recap ask --active                                      # the last question in the live transcript
recap ask --active --question "¿cómo se despliega bita-desktop?"
recap ask --meeting <meeting> --window 300 --json-stream
recap ask --sources --project CoDi --json               # the docs root and repositories it would read
```

- The context is the last `--window` seconds (default 180) of the live transcript, the entry title and project, the project page tree and its repositories. Claude may use Read, Grep, Glob and, in each repository, only `git -C <repo> log|show|diff` (one exact `--allowedTools` prefix per repository and subcommand, since headless Claude Code rejects `cd <repo> && git …` and does not match wildcards in the middle of a pattern), and nothing else (`Resources/ask-prompt.md`).
- Answers are short, give the exact command when there is one, cite the page, `file:line` or commit, and say "No está documentado." instead of guessing.
- `--json-stream` prints one JSON object per line: `question`, `progress` (the file being read), `delta` (answer text), `source`, then `done` with the whole answer, or `error`.
- Every answer is appended to `live/answers.jsonl` as `{id, askId, askedAt, question, answer, found, sources}`, plus `"auto": true` when the live worker detected the question (manual answers leave `auto` out). `askId` is the id of the ask's file under `live/asking/`, so a pending ask maps to its answer exactly. A failed ask appends nothing.
- Several answers can run at once. Each queued or running ask is described by `live/asking/<askId>.json`: `{"id": "…", "auto": true | false, "question": "…" | null, "questionMs": …, "channel": "mic" | "system", "startedAt": "…", "state": "queued" | "running", "pid": …}` (`questionMs` and `channel` only when known; `pid` is the process that owns the entry, and entries of dead processes are ignored and pruned). The file is removed when the ask ends, whether it answered or failed. Manual asks never stop other asks; they simply run alongside them.
- For older readers, `live/asking.json` mirrors the running ask that started last (same shape) and is removed when no ask is running. Writes to `live/asking/` and `live/asking.json` are serialized with `flock` on `live/asking/.lock`.

bita-desktop drives this from its floating window: it opens while recording (`live.openWindow`), runs `recap ask --active --json-stream` from a global shortcut and shows the answers.

#### Detected questions

With `live.autoAsk` on (the default), the live worker also looks for questions on its own queue, so transcription never waits for it:

- It keeps a cursor in `live/detector-state.json` (`{"detectedThroughMs": …, "examinedSegments": …}`): the transcript lines already examined and the end of the last one. While there are lines past the cursor, and at most once every `live.autoAskMinSeconds` (default 5, 3–120), it sends the new lines, plus up to 60 s before the cursor marked as already reviewed, with the project and its page titles to `claude -p --model <live.autoAskModel>` (default `haiku`) with no tools and the same isolation flags as the pipeline (`Resources/detect-prompt.md`). The answer is strict JSON with every distinct question in the new part: `{"questions": [{"question": "…", "at": "HH:MM:SS"}]}` or `{"questions": []}` (the older `{"question": …}` form is still accepted). A follow-up that only refines the previous question is merged into it.
- The cursor moves only after a successful call, so lines are never lost to a failed call or to answers in progress; it is retried on the next interval even if the transcript does not grow.
- Only technical questions that the docs or the code can answer count: how to run, deploy or configure something, what changed, how something was done, where something is. Greetings, logistics, opinions and rhetorical questions are ignored. In remote meetings questions from Remotos weigh more; in-person meetings only have Sala, so the content decides. The question comes back rephrased so it stands on its own.
- Each question gets its origin (`questionMs`, `channel`) from its `at`. A question too similar to one already answered in `live/answers.jsonl`, queued or running in `live/asking/`, or already detected in this meeting (Jaccard ≥ 0.5 on accent-folded words without stopwords), is skipped.
- Otherwise it is queued, and the worker runs up to `live.autoAskConcurrency` (default 3, 1–6) of them at a time, in order, each as `recap ask --question <q> --auto --ask-id <id>` in a child process. Nothing is dropped: a question waits in the queue (`"state": "queued"`) until a slot frees up. Manual asks do not count against that limit.
- Detector and answer failures go to `live/worker.log` and never stop the transcription; queued and running detected answers stop with the worker.

### Proposed documentation changes

For meetings linked to a bita entry, when inkwell is installed, the `proposals` stage (before `wrapup`) asks Claude Code (`Resources/proposals-prompt.md`) for the explicit, firm changes said about existing pages: the project pages and the pages linked to the entry in inkwell (`inkwell page ls --entry`), never the meeting's own page. Ideas, doubts and statements corrected later are left out, and the text follows the documentation writing rule: nothing that reveals the conversation.

Each change becomes a commit on the docs branch `proposal/meeting-<entry>` through `inkwell git propose`, and is listed in `proposals.json` (its markdown in `proposals/<n>.md`). Nothing reaches `main`, or Confluence, until it is accepted:

```sh
recap proposals ls <meeting> --json          # or --bita-entry <id>
recap proposals show <meeting> <n> --json    # markdown, quotes and the branch diff
recap proposals accept <meeting> <n> [--md edited.md]
recap proposals reject <meeting> <n>
```

`accept` runs `inkwell branch apply` (and needs inkwell); with `--md` it first proposes the edited text again. If the page changed since the proposal, the merge conflicts and the proposal turns `stale` (the command still succeeds). When no proposal is pending, the branch is dropped. A failure in this stage is recorded in `stages.proposals` and never stops the wrap-up; without inkwell the stage is `skipped` with the reason in `stages.proposals.reason`. Turn it off with `recap config set live.proposals false`.

## bita integration

With [bita](https://github.com/KikeDeAlba/bita-cli), a meeting timer records the meeting while it runs:

```sh
bita start "Planeación sprint 42" --kind remote-meeting     # recap starts recording the screen, system audio and mic
bita start "1:1 con Ana" --kind in-person-meeting           # recap records the mic only
bita stop                                                   # recap stops, processes, and writes the minutes into the entry note in inkwell
```

`recap setup` subscribes `recap bita-hook` to bita's `start`, `stop`, `cancel` and `amend` events through the kit registry. It works the same whether the timer is started from the terminal, from Claude Code or from bita-desktop.

| bita event | recap |
|---|---|
| `start` of a meeting kind | starts recording in the matching mode, linked to the entry |
| `stop` | stops, processes in the background and wraps the meeting up (see below) |
| `cancel` | discards the recording |
| `amend --kind <meeting kind>` on a running entry | starts recording |
| `amend --kind none` while recording | stops without processing; the recording is kept |
| `amend` of the title or project only | updates the meeting's title and entry data; the recording is not touched |

### Wrap-up

After the summary, the `wrapup` stage asks Claude Code (headless, `Resources/wrapup-prompt.md`) for a title, a project, a documentation page and backlog items, and applies them: title and project through `bita amend`, everything else through inkwell (found in the kit registry by its capabilities):

- the timer gets the meeting's real topic as its title when the current one is generic ("Reunión presencial", "Junta", …);
- if the timer has no project, it gets one only when the conversation makes it clear and the name exists in `bita projects`; otherwise `wrapup.projectResolved` is false and `/recap-stop` asks;
- a page is created with `inkwell page new --from-entry` in that project and written as formal documentation (no pending sections); if the entry already has a page in inkwell (`inkwell page ls --entry`), a `## Reunión <date>` section is added to it instead;
- action items and findings become `inkwell backlog add` items on that page;
- the minutes land in the `Reunión` section of the entry note (`inkwell note save <entry> --section Reunión --md …`, capability `docs.entry-notes`).

Without inkwell the stage is `skipped` (reason and hint `npm i -g @kikedealba/inkwell && inkwell setup` in `stages.wrapup`) and the meeting is still `processed`; the minutes stay in `summary.md`. With an inkwell lacking `docs.entry-notes` the page and backlog are written and `process.log` notes that the minutes were not saved. Run `recap process <id> --from proposals` after installing it. Time goes to Jira later through tally, never from recap.

`recap wait --bita-entry <id>` blocks until all of that is done and prints the result (`data.wrapup` with `--json`).

The hook output goes to `hooks.log` beside the bita database. Minutes regenerated with `/recap-summarize` or `recap save-summary` are saved in the entry note again when inkwell is installed.

## Pipeline

| Stage | Remote | In-person | Output |
|---|---|---|---|
| `audio` | mic and system tracks | mic track | `mic.wav`, `system.wav` (16 kHz mono) |
| `transcribe` | per channel, then merged | mic | `transcript.json`, `transcript.md` |
| `frames` | scene changes, at least 20 s apart, at most 40 | skipped | `frames/hh-mm-ss.jpg`, `frames.json` |
| `summarize` | `claude -p` with transcript and frames | `claude -p` with transcript | `summary.md` |
| `proposals` | only when linked to a bita entry and `live.proposals` is on; skipped without inkwell | same | `proposals.json`, `proposals/<n>.md` and the docs branch `proposal/meeting-<entry>` |
| `wrapup` | only when linked to a bita entry; skipped without inkwell | same | entry title and project (bita), an inkwell page, backlog items and the `Reunión` section of the entry note |

- Transcription runs locally with `whisper-cli`, `large-v3-turbo` and Silero VAD. Known whisper hallucinations on silence are dropped.
- In remote meetings the microphone is labelled **Sala** and the call audio **Remotos**. When the microphone picks up the speakers, segments that repeat the call audio within a few seconds are removed as echo; headphones avoid the problem entirely.
- The summary is written by Claude Code in headless mode, without user hooks, MCP servers or slash commands, and may open the key frames with the Read tool. It contains: Resumen, Temas, Acuerdos, Pendientes (owner, date, minute), Preguntas abiertas and Capturas. Customize it by copying `Resources/summary-prompt.md` to `~/.config/recap/summary-prompt.md`.

Every command accepts `--json` and prints an envelope:

```json
{ "schemaVersion": 1, "ok": true, "command": "stop", "generatedAt": "…", "data": { … } }
```

Errors set `ok: false` and `error: { code, message }`, and exit with status 1.

## Storage

Each meeting gets a folder under `~/Recap` (configurable):

```
~/Recap/2026-10-02-1530-sprint-planning/
├── meeting.json      metadata, status and pipeline stages
├── recording.mov     remote: video + mic track + system track
├── recording.m4a     in-person: mic track; remote after strip-video: mic + system tracks
├── mic.wav, system.wav
├── transcript.md     merged transcript with timestamps
├── frames/           remote only
├── summary.md        minutes
├── live/             transcript.jsonl, answers.jsonl, asking/, asking.json, detector-state.json and chunks/ (live assistant)
├── proposals.json    proposed documentation changes, with proposals/<n>.md
├── recorder.log
└── process.log
```

Recordings are written as fragmented QuickTime (remote) or M4A (in-person), so a crash or a forced quit keeps everything up to the last few seconds.

## Configuration

`~/.config/recap/config.json` (override with `RECAP_CONFIG_PATH`):

```json
{
  "root": "~/Recap",
  "language": "es",
  "vocabulary": ["CoDi", "webhook", "PostgreSQL"],
  "summaryModel": "sonnet",
  "whisperModel": "~/.local/share/recap/models/ggml-large-v3-turbo.bin",
  "live": {
    "enabled": true,
    "openWindow": true,
    "proposals": true,
    "maxChunkSeconds": 10,
    "assistModel": "sonnet",
    "autoAsk": true,
    "autoAskModel": "haiku",
    "autoAskMinSeconds": 5,
    "autoAskConcurrency": 3
  },
  "tools": {
    "claude": "/Users/me/.nvm/versions/node/v24.19.0/bin/claude",
    "ffmpeg": "/opt/homebrew/bin/ffmpeg"
  }
}
```

- `vocabulary` is passed to whisper as a glossary and fixes most misheard product names.
- `tools` holds absolute paths to the external commands. `recap setup` fills it in, so the pipeline also works when it is started with a minimal `PATH` (for example from a menu bar app).
- `recap setup` downloads the whisper and VAD models to `~/.local/share/recap/models`.
- `live` controls the live assistant; every key is optional. `enabled` turns the live transcription on, `openWindow` lets bita-desktop open its floating window while recording, `proposals` turns the `proposals` stage on, `maxChunkSeconds` (5–60) is the longest live chunk, `assistModel` is the model for `recap ask` (Claude Code's default when unset), `autoAsk` turns question detection on, `autoAskModel` is the model that detects them (`haiku` by default), `autoAskMinSeconds` (3–120) is the shortest time between two detections, and `autoAskConcurrency` (1–6) is how many detected questions are answered at once.
- `recap config get [<key>] --json` and `recap config set <key> <value> --json` read and change the `live.*` keys.

Environment overrides: `RECAP_ROOT`, `RECAP_STATE_DIR`, `RECAP_DATA_DIR`.

## recap-capture

`recap-capture` is the capture half of recap as a standalone executable, for tools that want to record a meeting without the rest of recap. It ships inside `Recap.app` next to `recap` (`Recap.app/Contents/MacOS/recap-capture`), `make install` links it into `~/.local/bin`, and its code lives in the `RecapCapture` library target that `recap` itself uses, so both record exactly the same way.

```sh
recap-capture record <meetingDir> [--live-worker <command>]   # record until SIGINT or SIGTERM
recap-capture permissions [--request] [--json]                # {microphone, screen}: granted, denied, not-determined, restricted
recap-capture capabilities --json                             # kit envelope: name, version, capabilities, emits
recap-capture --version
```

`--json` prints one line with the same envelope as `recap` (`schemaVersion`, `ok`, `command`, `generatedAt`, `data` or `error {code, message}`). Capabilities: `capture.remote`, `capture.in-person` and `capture.live-chunks`. A usage error with `--json` prints an error envelope with code `USAGE` and exits with 64.

### Launching it

macOS grants the microphone and screen permissions to the app that is running, so record through the bundle:

```sh
open -g -n -a Recap.app --stdout <meetingDir>/recorder.log --stderr <meetingDir>/recorder.log \
  --args capture record <meetingDir>
```

`recap capture <command>` runs the same commands as `recap-capture <command>`, with the same envelopes; that is how the `open` call above, which always starts the bundle's main executable, reaches them. `permissions --request` only shows the system prompts this way; running `recap-capture` directly from a terminal attributes the permissions to the terminal. macOS applies a newly granted screen permission on the next launch, so the report that follows the request still says `denied` for it.

### On-disk contract

The caller creates `<meetingDir>/meeting.json` and `recap-capture record` updates it in place (pretty-printed, sorted keys, ISO 8601 dates):

| Key | Who writes it | Meaning |
|---|---|---|
| `schemaVersion`, `id`, `title`, `createdAt`, `stages` | caller | required to read the file; `stages` can be `{}` |
| `mode` | caller | `remote` or `in-person` |
| `status` | caller (`starting`), recorder | `recording` once capture starts, `recorded` after a clean stop, `failed` when it cannot start |
| `display` | caller, optional | display ID to record in remote mode; the main display otherwise |
| `recorderPid` | recorder | the recorder's PID while it runs, removed when it stops |
| `startedAt`, `endedAt` | recorder | when the capture started and stopped |
| `error` | recorder | why it failed or stopped early |

Every other key, including ones recap does not know, is kept. The recording goes to `recording.mov` (remote: H.264 video at 1280 px and 2 fps, then the microphone and the system audio as separate AAC tracks) or `recording.m4a` (in-person: microphone only). Send SIGINT or SIGTERM to `recorderPid` to stop; the recorder closes the file, sets `status` to `recorded` and exits with 0, or with 1 after an error.

When `live.enabled` is on (the default, see Configuration), it also cuts the audio into 16 kHz mono 16-bit WAV chunks under `live/chunks/`, named `<channel>-<seq, 5 digits>.wav` with `channel` `mic` or `system`, and appends one line per chunk to `live/chunks/index.jsonl`:

```json
{"channel":"mic","endMs":9870,"file":"mic-00001.wav","seq":1,"startMs":0}
{"channel":"system","endMs":12000,"seq":2,"startMs":9870}
```

Offsets are milliseconds from the start of the recording; chunks without speech have no `file` and no WAV. Then it spawns the live worker, detached, with its output in `live/worker.log`. `--live-worker` (or `RECAP_LIVE_WORKER` when the option is absent) picks it: an executable runs as `<executable> live-worker <meetingDir>`, a JSON array such as `["node", "/path/recap.js", "live-worker"]` is the whole command with `<meetingDir>` appended, and `none` turns it off. Use absolute paths: an app started by `open` gets the minimal launchd `PATH`, and bare names are only searched there and in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`. `open` does not pass the caller's environment either; `recap start` forwards `RECAP_LIVE_WORKER` with `open --env`, and other callers should do the same or use `--live-worker`. By default `recap-capture` spawns the `recap` next to it and `recap` spawns itself, which is the behavior of `recap start`.

## Development

```sh
make build
make test
```

## Releases

```sh
make release                      # dist/Recap-<version>-macos-arm64.zip and its .sha256
./scripts/release.sh --publish    # from main: create or update the v<version> GitHub release
```

The version comes from `CaptureTool.version` in `Sources/RecapCapture/Commands/CaptureCommands.swift`, which `recap` and `recap-capture` share. Releases are built and signed locally with an Apple Development identity, so macOS keeps the permissions across updates; they are not notarized. `bita setup` downloads the `*-macos-arm64.zip` asset of the latest release.

## License

MIT
