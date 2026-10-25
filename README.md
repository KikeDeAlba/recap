# recap

Record meetings on macOS and turn them into a transcript, a summary, agreements and action items, all stored as local Markdown.

| Mode | Flag | Captures | Permissions |
|---|---|---|---|
| Meeting (default) | none | Microphone only, to `recording.m4a` | Microphone |
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
un agente de código para las minutas: [Claude Code](https://claude.com/claude-code)
por omisión, o Codex, Gemini CLI, Antigravity CLI (`agy`) u opencode con `agent` en la
configuración.

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
  `start`, `stop`, `cancel` y `amend` de las entradas `meeting`,
  `remote-meeting` e `in-person-meeting`. Reemplaza al viejo `bita hooks add` y quita ese hook si
  lo encuentra, para que no se dispare dos veces;
- en Claude Code agrega o actualiza el marketplace `KikeDeAlba/recap` e instala
  o actualiza el plugin `recap@recap` (`claude plugin marketplace add|update` y
  `claude plugin install|update --scope user`), así el plugin queda en la misma
  versión que la CLI; también quita los archivos sueltos que versiones viejas
  dejaron en `~/.claude`;
- en opencode, Codex y Gemini CLI instala la skill y las skills de usuario en el
  formato de cada uno (`--agents codex,gemini`, `--agents all` o
  `--agents none`).

### Al actualizar

Tras actualizar recap (npm, bita o desde el código), vuelve a correr:

```sh
recap setup
```

La suscripción a bita se guarda en el registro de kit al correr `recap setup` y
no se reescribe sola: hasta que lo corras, las entradas `--kind meeting` de bita
no arrancan la grabación. `recap capabilities --json` muestra en `subscribes`
lo que quedó registrado. `recap setup` también baja el `Recap.app` actual; con
uno anterior, que no anuncia `capture.meeting`, `recap start` sin
`--remote`/`--in-person` graba solo el micrófono como reunión presencial y lo
marca con `"fallback": "in-person"` en `meeting.json` y en el `--json`.

En Windows y Linux `recap start` falla con `CAPTURE_UNAVAILABLE`: graba con la
app que quieras y procesa el archivo con

```sh
recap import grabacion.m4a --title "Revisión semanal"     # presencial por omisión
recap import llamada.mov --remote                         # video con dos pistas de audio
```

Los archivos en disco, los comandos, las opciones y el sobre `--json` son los
mismos que los del `recap` en Swift, así que las dos versiones leen las mismas
reuniones.

### El `recap` en Swift es legado

`Recap.app` queda solo para grabar: el pipeline (transcripción, minuta,
propuestas, wrap-up, `recap ask` y el live worker) vive en la CLI de
TypeScript, que corre con cualquier agente headless. Los subcomandos de
pipeline del binario Swift `Recap.app/Contents/MacOS/recap` (`process`,
`prompt`, `save-summary`, `ask`, `proposals`, `live-worker`, `bita-hook`,
`wait`, `setup`) y sus fuentes (`Sources/recap/Pipeline`, `Sources/recap/Bita`,
`Sources/recap/Live`) son legado, están atados a Claude Code y se quitarán.
`make install` ya no enlaza ese binario como `recap`: solo enlaza
`recap-capture`, así que el `recap` del `PATH` es el de npm. La CLI pasa
siempre `RECAP_LIVE_WORKER` con su propio worker al lanzar `Recap.app`, y si
la app instalada no trae `recap-capture` avisa de actualizarla con
`recap setup`. bita solo lleva el tiempo: las páginas, las propuestas, el backlog
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
- [Claude Code](https://claude.com/claude-code) for summaries (or another coding agent, see `agent` below)

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

This builds `Recap.app`, signs it with the hardened runtime and only the microphone entitlement (`scripts/recap.entitlements`) using your first `Apple Development` identity (or ad-hoc when there is none, set `RECAP_SIGN_IDENTITY` to pick another one), copies it to `~/Applications` and links `~/.local/bin/recap-capture` (it does not link the legacy Swift `recap`, so the `recap` on your `PATH` stays the npm CLI). Make sure `~/.local/bin` is on your `PATH`, or install the link elsewhere with `make install PREFIX_BIN=/opt/homebrew/bin`.

Then check the dependencies and grant the permissions:

```sh
recap setup                 # add --install-deps to brew install a missing ffmpeg or whisper-cpp
```

### Why an app bundle

The recorder always runs as `Recap.app`, launched with `open`, so macOS grants the microphone and screen permissions to Recap itself no matter who starts the recording: a terminal, Claude Code, bita or the bita menu bar app. With a stable signing identity the permissions survive rebuilds; with ad-hoc signing macOS may ask again after every `make install`.

## Usage

```sh
recap start "Weekly sync"            # meeting mode: microphone only
recap stop

recap start --remote "Sprint planning"
recap status
recap stop

recap start --in-person "1:1 with Ana"
recap stop

recap list
recap show last
recap show --bita-entry 812 --json    # the meeting behind a bita entry, with paths to every file
recap transcript last --json          # the transcript as segments and paragraphs
recap summary --bita-entry 812 --json # the minutes with their agreements and action items
recap discard <meeting>
```

Without `--remote` or `--in-person`, `recap start` records in `meeting` mode: the microphone only, like an in-person meeting, with `"mode": "meeting"` in `meeting.json`. `list`, `show`, `process`, `compress-video`, `strip-video`, `prune`, the storage report and the bita integration treat it like the other modes. A `meeting` without `recording.mov` skips the `frames` stage. Minutes, headers and prompts call it «reunión», with no modality (no «presencial» or «remota»), like inkwell and tally do; its default title is `Meeting`, which the wrap-up treats as generic.

recap asks the installed recorder (`recap-capture capabilities --json`) whether it announces `capture.meeting`. An older Recap.app that does not (or has no `recap-capture` at all) still records: `recap start` falls back to an in-person meeting (microphone only, the same result), stores `"mode": "in-person"` and `"fallback": "in-person"` in `meeting.json`, returns `fallback` in the `--json` output and says so in the text output. The same happens to a bita entry with `--kind meeting`. Run `recap setup` to get the current Recap.app.

`recap transcript <meeting> --json` reads `transcript.json` (or, for older meetings, `transcript.md`) and returns times in seconds from the start of the recording; `speaker` is `Sala` or `Remotos` in remote meetings and `null` otherwise. It fails with `NO_TRANSCRIPT` until the `transcribe` stage has run. Without `--json` it prints `transcript.md`.

```json
{"segments": [{"start": 2.5, "end": 6.25, "channel": "mic", "text": "La versión 0.14 sale el viernes."}],
 "paragraphs": [{"start": 0, "channel": "mic", "speaker": null, "text": "Buenos días, empezamos la planeación. La versión 0.14 sale el viernes."}],
 "channels": ["mic"]}
```

`recap summary <meeting> --json` returns `summary.md` as `markdown`, the items under `## Acuerdos` as `agreements`, and the action items: the `pending` items of the wrap-up (`wrapup.json`) with the inkwell backlog key they got, or, without a wrap-up, the `Pendiente` column under `## Pendientes`. Sections not written yet come back empty (`[]`). Without `--json` it prints `summary.md`. With or without `--json`, a meeting with no `summary.md` yet fails with `NO_SUMMARY`, like `transcript` fails with `NO_TRANSCRIPT`.

```json
{"markdown": "# Planeación del sprint\n…", "agreements": ["Liberar la versión 0.14 el viernes."],
 "actionItems": [{"text": "Preparar las notas de la versión 0.14", "backlogKey": "PEND-12"}]}
```

`recap capabilities --json` lists `meeting.record` and `meeting.mode.meeting` when this machine can record, `meeting.capture.sources` and `meeting.capture.switch` when the installed Recap.app announces `capture.sources` and `capture.switch`, plus `meeting.transcript.json` and `meeting.summary.json`.

### Adding a screen or a window while a meeting records (macOS)

A `meeting` always starts with the microphone only. While it records, add the whole screen or one window, switch between them, or drop them; the microphone keeps recording until `recap stop`:

```sh
recap capture sources --thumbnails --json   # displays and windows, with 320 px JPEG thumbnails as data: URLs
recap capture set --window 4242 --json      # record that window and the audio of its app
recap capture set --display 1 --json        # switch to the whole display and the audio of the whole system
recap capture clear --json                  # back to the microphone only
recap capture state --json
```

```json
{"displays": [{"id": 1, "name": "Built-in Retina Display", "width": 1512, "height": 982, "main": true, "thumbnail": "data:image/jpeg;base64,…"}],
 "windows": [{"id": 4242, "app": "zoom.us", "bundleId": "us.zoom.xos", "title": "Zoom Meeting", "pid": 777, "width": 1280, "height": 800, "thumbnail": "data:image/jpeg;base64,…"}]}
```

```json
{"meetingId": "2026-10-25-1200-sync", "mic": true, "systemAudio": true,
 "video": {"kind": "window", "id": 4242, "title": "Zoom Meeting", "app": "zoom.us", "since": "2026-10-25T12:03:10Z"}}
```

`thumbnail` only appears with `--thumbnails`: a JPEG of at most 320x240 px and 128 KiB, for up to 48 sources; recap drops any thumbnail that is not a `data:image/jpeg;base64,` URL. `sources` leaves out the windows of Den and Recap, menus and other non-standard windows, and windows without a title, and `set --window` refuses the windows of Den and Recap and non-standard windows with `CAPTURE_UNSUPPORTED`. A display capture leaves out Den and Recap, also when Den opens after the display was set. The text output strips control characters from titles and names. `set`, `clear` and `state` return the state; `video` is `null` and `systemAudio` is `false` when only the microphone records, and `app` is `null` for a display. ScreenCaptureKit gives the audio of the whole system with a display and the audio of the window's app with a window. `set` and `clear` wait up to 15 s for the recorder (`--timeout s`); `sources` up to 30 s.

| Code | When |
|---|---|
| `NOT_RECORDING` | no recording is running, it is still starting, or it stopped while waiting |
| `CAPTURE_UNSUPPORTED` | not macOS, a `--remote` or `--in-person` recording, a fallback meeting, a window of Den or Recap, or a Recap.app that cannot switch (update it with `recap setup`) |
| `WINDOW_GONE` | the window was closed or is no longer on screen; `DISPLAY_GONE` for a display that was unplugged |
| `SCREEN_PERMISSION_DENIED` | Recap.app has no Screen & System Audio Recording permission; macOS shows the prompt the first time |
| `CAPTURE_TIMEOUT` | the recorder did not answer in time; the message says what the meeting records now, since the recorder may still apply the change. See `recorder.log` |

When the window being recorded closes, the recorder goes back to the microphone only and `capture.json` keeps the reason in `error`.

Den never writes to the meeting folder: it only runs `recap capture …` and reads its JSON.

#### Residual risk of the control channel

`recap capture` reaches the running Recap.app through files in `<meeting>/control/`. Any process that runs as the same macOS user can write there too, so it can ask Recap.app, which holds the Screen & System Audio Recording permission, to record a display or a window, or to list the open windows with thumbnails. This is accepted: such a process can already read the meeting folder and everything else of that user. The mitigations:

- `control/` is a `0700` folder of the user; a link or a folder of another user is replaced, and Recap.app empties it when it starts. Once no live recorder can use it, recap removes it: when the recording stops, when it recovers a recording whose recorder died, before `assemble`, and before the summary, the `proposals` stage or the wrap-up hand the meeting folder to an agent.
- Recap.app opens each request with `O_NOFOLLOW` and only reads a regular file of the same user of at most 4 KiB. It writes each answer to a temporary file with a random name opened with `O_EXCL`, then renames it into place.
- A request carries `issuedAt` and expires 30 s later (also when it is more than 30 s in the future). Answers nobody waits for are swept after 60 s by both sides.
- `recap capture` withdraws its request on SIGINT or SIGTERM and after a timeout.
- Recap.app never records the windows of Den or Recap, the capture only lasts while the meeting records, and the recording is the meeting's `recording.mov`, which the user sees and can delete.

Free space once a meeting is processed:

```sh
recap compress-video <meeting> --preset medium   # HEVC re-encode: light (1280 px, 2 fps), medium (960 px, 1 fps), max (720 px, 0.5 fps)
recap strip-video <meeting>                      # drop the video, keep mic and system audio in recording.m4a
recap prune <meeting> --intermediates            # delete mic.wav, system.wav, the per-channel transcripts and live/chunks
recap delete <meeting>                           # delete the whole meeting folder
```

`compress-video` and `strip-video` work on meetings with a `recording.mov` (remote, or `meeting` with video), never on in-person ones, accept `--bita-entry` and `--prune-intermediates`, check the new file (duration and audio tracks) with AVFoundation before replacing the original, and refuse while the meeting is being recorded or processed. `compress-video` keeps the original when the result is not smaller (`NOT_SMALLER`). After `strip-video` the `frames` stage is skipped and the existing frames are kept. `recap list --json` reports `hasVideo`, `storage` (`recordingBytes`, `intermediateBytes`, `framesBytes`, `otherBytes`, `totalBytes`), `video` and `videoRemovedAt` for each meeting; `--limit 0` lists them all.

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
  | `/recap:recap-start [remota\|presencial] [título]` | Empieza a grabar; saca el modo de los argumentos o de la conversación y, si no se dice, graba en modo reunión (solo micrófono) |
  | `/recap:recap-stop [--no-wait]` | Para la grabación (por bita si la sigue un cronómetro), espera el procesamiento y muestra el resultado |
  | `/recap:recap-status` | Dice si se está grabando y en qué va el procesamiento |
  | `/recap:recap-list [reunión]` | Lista las reuniones o muestra la minuta de una |
  | `/recap:recap-summarize [reunión] [indicaciones]` | Rehace la minuta dentro de la sesión y la guarda con `recap save-summary` |
  | `/recap:recap-ask [pregunta]` | Responde la última pregunta de la reunión en curso, o la que le pases, con el cerebro de gaze, las páginas de inkwell y los repos del proyecto |
  | `/recap:recap-proposals [reunión]` | Revisa los cambios a la documentación que propuso una reunión |

- **Sin monitor.** El plugin no arranca nada en segundo plano. `recap watch`
  sigue disponible a mano: escribe una línea cuando una reunión termina de
  procesarse o falla (`RECAP_MONITOR=off` lo apaga).

Las skills llaman a `recap`, así que tiene que estar en el `PATH` del shell que
usa Claude Code.

## Live assistant

While a meeting is being recorded, recap also transcribes it live:

- The recorder taps the microphone and system audio, converts each to 16 kHz mono, and cuts it on silence into 3–10 s chunks (`live.maxChunkSeconds`) under `live/chunks/`. The tap runs on its own queue and never blocks the file writer.
- A detached `recap live-worker` transcribes each chunk with `whisper-cli` (same model and VAD as the pipeline, 4 threads, the previous text as prompt), drops hallucinations and microphone echo, and appends `{startMs, endMs, channel, text}` lines to `live/transcript.jsonl`, with offsets from the start of the recording. It exits once the recording stops and the queue is empty.
- The transcript after `stop` is still the source of truth; the live one is for answering during the meeting.

`recap ask` answers a question with Claude Code (headless, streaming), reading only the project brain in gaze (notes of the project, its gaze group and `global`), the inkwell pages of the project (`inkwell page ls --project`) and the repositories registered for it in bita (`bita project repo ls`). Without inkwell it skips the pages, and without gaze the brain; with neither it answers from the repositories alone:

```sh
recap ask --active                                      # the last question in the live transcript
recap ask --active --question "¿cómo se despliega bita-desktop?"
recap ask --meeting <meeting> --window 300 --json-stream
recap ask --sources --project CoDi --json               # gaze availability, the notes found (pass `--question` to see notes), the docs root and repositories it would read
```

- The context is the last `--window` seconds (default 180) of the live transcript, the entry title and project, the project page tree and its repositories. Claude may use Read, Grep, Glob and, per project repository, only `<recap> repo-git <repo> log|show|diff …` (one allowlist prefix per repository and subcommand), and nothing else (`Resources/ask-prompt.md`). `recap repo-git` is a hidden subcommand that checks every option against an allowlist (counts, date/author/grep filters, formats, stats, patches, renames…), rejects absolute paths and `..` segments, requires the directory to be a git work tree, and runs git without a shell or pager, with ext-diff, textconv, fsmonitor and signature programs disabled, an environment reduced to PATH, HOME, USER, LOGNAME, TMPDIR, DEVELOPER_DIR and the locale (no `GIT_*` overrides), a 10 s work-tree check and a 30 s timeout (exit 124). Options such as `--output`, `--no-index`, `--ext-diff`, `--textconv` or `-O` are refused (exit 2). If the recap path or a repository path contains characters outside `[A-Za-z0-9_./+@-]`, that repository gets no git rule and the prompt tells Claude it has no git history (Read, Grep and Glob only).
- Search order: brain (gaze) → inkwell pages → Grep in the docs root → bita repositories. Claude never runs gaze (no gaze command in its allowlist): before launching it, recap runs `gaze search --project=<P>` itself, with the question or, without one, the last 300 characters of the last 30 s of the live transcript. By gaze's design that search also returns notes from `global` and from projects in the same gaze group, so Claude sees notes from the project, its gaze group and `global`, never from other projects outside that. recap reads the full body of the top 3 notes and puts them, cut to 1200 characters, in the prompt as escaped data, so a note cannot break out of the notes block. It only happens when gaze is installed and registered in the kit registry with the `memory.search` and `memory.write` capabilities, and the meeting has a project (never in `global`). If the notes answer the question, the answer cites a source `{"kind":"note","label":"…","noteId":"…"}`. gaze lookups (and the `git cat-file` commit existence check) time out after 10 s and saving after 60 s; if gaze is missing, fails or times out, `recap ask` continues without the brain.
- After answering, the answer is saved in gaze as a `fact` note (title = the question, cut to 200 characters (plus `…`); body = the answer and a `Fuentes:` list, ending with «Generada por recap a partir de la reunión «…» (fecha); sin revisión humana.») only when `found` is true, it cites at least one source, no source is a brain note, and recap verifies every source: the page is in the project tree, the file exists inside the docs root or a project repo (and the cited line exists), and the commit exists in a project repo. In `Fuentes:`, page sources use the page title from the project tree and commit sources only the sha and repo; recap writes no model-written labels. Nothing is saved when the prompt already included brain notes (only knowledge found without the brain is saved), because gaze merges or replaces near-identical notes and could overwrite a human-written note. Answers longer than 8000 characters are not saved. The sensitive-data check covers the whole note (title and body, including the meeting title) and blocks the save on card numbers (also with CVV/expiry or other separators), access keys, private keys, emails, JWTs, bearer tokens, `sk_live_`, `github_pat_` and `npm_` tokens, Basic auth, GitLab/Slack/`sk-` keys, credentials in URLs, and credentials such as `password`, `secret`, `token`, `api_key` (also `clave`/`contraseña`) followed by `=`, `:` or `is`/`was`/`es`/`era`. The text is normalized first: non-ASCII digits become ASCII and invisible characters are removed before scanning. Unverified answers are never saved, since they could be unfounded. Without a project nothing is searched or saved.
- `RECAP_NO_GAZE=1` turns off both the search and the saving. `recap ask --sources --question "<q>"` shows whether gaze is available and the notes it finds for that question.
- Answers are short, give the exact command when there is one, cite the page, `file:line` or commit, and say "No está documentado." instead of guessing.
- `--json-stream` prints one JSON object per line: `question`, `progress` (the file being read), `delta` (answer text), `source`, then `done` with the whole answer, or `error`.
- Every answer is appended to `live/answers.jsonl` as `{id, askId, askedAt, question, answer, found, sources}`, plus `"auto": true` when the live worker detected the question (manual answers leave `auto` out). `askId` is the id of the ask's file under `live/asking/`, so a pending ask maps to its answer exactly. A failed ask appends nothing.
- Several answers can run at once. Each queued or running ask is described by `live/asking/<askId>.json`: `{"id": "…", "auto": true | false, "question": "…" | null, "questionMs": …, "channel": "mic" | "system", "startedAt": "…", "state": "queued" | "running", "pid": …}` (`questionMs` and `channel` only when known; `pid` is the process that owns the entry, and entries of dead processes are ignored and pruned). The file is removed when the ask ends, whether it answered or failed. Manual asks never stop other asks; they simply run alongside them.
- For older readers, `live/asking.json` mirrors the running ask that started last (same shape) and is removed when no ask is running. Writes to `live/asking/` and `live/asking.json` are serialized with `flock` on `live/asking/.lock`.

bita-desktop drives this from its floating window: it opens while recording (`live.openWindow`), runs `recap ask --active --json-stream` from a global shortcut and shows the answers.

#### Detected questions

With `live.autoAsk` on (the default), the live worker also looks for questions on its own queue, so transcription never waits for it. The worker rereads `live.autoAsk` whenever the config file changes, so turning it off mid-meeting (from Den or `recap config set live.autoAsk false`) stops the detection at once and cancels the queued and running auto answers; turning it back on only looks at what is said from then on:

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
bita start "Revisión semanal" --kind meeting                # recap records the mic only, in meeting mode
bita stop                                                   # recap stops, processes, and writes the minutes into the entry note in inkwell
```

`recap setup` subscribes `recap bita-hook` to bita's `start`, `stop`, `cancel` and `amend` events of `meeting`, `remote-meeting` and `in-person-meeting` entries through the kit registry. After updating recap, run `recap setup` again: the subscription is only rewritten then, and until you do, `--kind meeting` entries do not start a recording. It works the same whether the timer is started from the terminal, from Claude Code or from bita-desktop.

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
| `assemble` | — | — | `meeting` only: `recording.mov` from `mic.m4a` and `screen-<n>.mov`, or `recording.m4a` when there was never a screen or window; also runs on `recap stop` |
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
├── capture.json      meeting: the screen and window segments (kept after assembly)
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

While a `meeting` records, the folder holds `mic.m4a`, one `screen-<n>.mov` per stretch with a screen or window, `capture.json` and `control/`. The `assemble` stage turns them into one recording: `recording.mov` with H.264 video at the size of the first segment and 2 fps (black frames where there was no target), the microphone as the first audio track and the audio of the targets as the second one (silence in between), or `recording.m4a` with the microphone only when no target was ever added. It aligns the audio of each segment with its own start time in the file and holds the last frame until the segment's planned end. ffprobe and ffmpeg run with a timeout and write to a temporary file with a unique name. Before deleting anything it checks with ffprobe that `recording.mov` has one video track, two audio tracks and the length of the microphone; then it deletes `mic.m4a` and only the segments it used. A segment it leaves out stays in the folder and the stage prints a warning that says why: it is empty, it starts after the microphone ends or is too short, or it could not be read. A temporary `.recording.assemble-<uuid>.mov` older than 10 minutes, left by an assembly that did not finish, is removed on the next run. Only `mic.m4a` and `screen-<n>.mov` are ever deleted, whatever `capture.json` says; `meeting.json` gets `"channels": ["mic", "system"]` (or `["mic"]`), which the transcription, the `Sala` and `Remotos` labels and `transcript --json` follow. If assembling fails on `recap stop`, the meeting stays `recorded` with the error in `stages.assemble` and `recap process` tries again.

## Configuration

`~/.config/recap/config.json` (override with `RECAP_CONFIG_PATH`):

```json
{
  "root": "~/Recap",
  "language": "es",
  "vocabulary": ["CoDi", "webhook", "PostgreSQL"],
  "summaryModel": "sonnet",
  "whisperModel": "~/.local/share/recap/models/ggml-large-v3-turbo.bin",
  "agent": "claude",
  "live": {
    "agent": "claude",
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

- `agent` is the coding agent that writes the summary, the proposals and the wrapup: `claude` (default), `codex`, `gemini`, `antigravity` or `opencode`, run headless and read-only through kit's `runHeadless`; recap writes every output file itself. `live.agent` overrides it for `recap ask` and question detection. Only Claude Code streams the live answer (`stream-json`). With any other agent `recap ask` loses, compared to Claude Code: the streamed deltas and the progress lines (the answer arrives at once), `--add-dir` (the docs root and the repositories are listed in the prompt as folders to read instead), the per-repository `recap repo-git` allowlist (the agent only has its own read-only mode, so git history may be unavailable) and `live.assistModel`. Question detection runs Claude Code with no tools (`--disallowedTools Read,Grep,Glob` on top of kit's read mode) and a 60 s timeout; summary, proposals and wrapup get 30 minutes; `recap ask` keeps no timeout of its own with Claude Code and kit's 10 minutes with the others. If the chosen agent is not installed, recap uses the first one it finds (Claude Code first) and prints `<agent> is not installed; using <other> instead` once per process. A prompt too long for the command line (agy on Windows) fails with `PROMPT_TOO_LONG`. `summaryModel`, `assistModel` and `autoAskModel` only apply to Claude Code; the other agents use their own default model. Failures come back as `AGENT_FAILED` (or `AGENT_OUTPUT` when the output has no answer).
- `vocabulary` is passed to whisper as a glossary and fixes most misheard product names.
- `tools` holds absolute paths to the external commands. `recap setup` fills it in, so the pipeline also works when it is started with a minimal `PATH` (for example from a menu bar app).
- `recap setup` downloads the whisper and VAD models to `~/.local/share/recap/models`.
- `live` controls the live assistant; every key is optional. `enabled` turns the live transcription on, `openWindow` lets bita-desktop open its floating window while recording, `proposals` turns the `proposals` stage on, `maxChunkSeconds` (5–60) is the longest live chunk, `assistModel` is the model for `recap ask` (Claude Code's default when unset), `autoAsk` turns question detection on, `autoAskModel` is the model that detects them (`haiku` by default), `autoAskMinSeconds` (3–120) is the shortest time between two detections, and `autoAskConcurrency` (1–6) is how many detected questions are answered at once.
- `recap config get [<key>] --json` and `recap config set <key> <value> --json` read and change the `live.*` keys, `live.agent` included (`default` clears it).

Environment overrides: `RECAP_ROOT`, `RECAP_STATE_DIR`, `RECAP_DATA_DIR`, `RECAP_NO_GAZE` (`1` turns off the gaze brain (search and saving) in `recap ask`, the live worker and the app).

## recap-capture

`recap-capture` is the capture half of recap as a standalone executable, for tools that want to record a meeting without the rest of recap. It ships inside `Recap.app` next to `recap` (`Recap.app/Contents/MacOS/recap-capture`), `make install` links it into `~/.local/bin`, and its code lives in the `RecapCapture` library target that `recap` itself uses, so both record exactly the same way.

```sh
recap-capture record <meetingDir> [--live-worker <command>]   # record until SIGINT or SIGTERM
recap-capture permissions [--request] [--json]                # {microphone, screen}: granted, denied, not-determined, restricted
recap-capture capabilities --json                             # kit envelope: name, version, capabilities, emits
recap-capture sources [--thumbnails] --json                   # {displays, windows}, the same JSON as recap capture sources
recap-capture --version
```

`--json` prints one line with the same envelope as `recap` (`schemaVersion`, `ok`, `command`, `generatedAt`, `data` or `error {code, message}`). Capabilities: `capture.remote`, `capture.in-person`, `capture.meeting`, `capture.live-chunks`, `capture.sources` and `capture.switch`. A usage error with `--json` prints an error envelope with code `USAGE` and exits with 64.

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
| `mode` | caller | `remote`, `in-person` or `meeting` (microphone only, like `in-person`) |
| `status` | caller (`starting`), recorder | `recording` once capture starts, `recorded` after a clean stop, `failed` when it cannot start |
| `display` | caller, optional | display ID to record in remote mode; the main display otherwise |
| `recorderPid` | recorder | the recorder's PID while it runs, removed when it stops |
| `startedAt`, `endedAt` | recorder | when the capture started and stopped |
| `error` | recorder | why it failed or stopped early |

Every other key, including ones recap does not know, is kept. The recording goes to `recording.mov` (remote: H.264 video at 1280 px and 2 fps, then the microphone and the system audio as separate AAC tracks) or `recording.m4a` (in-person: microphone only). Send SIGINT or SIGTERM to `recorderPid` to stop; the recorder closes the file, sets `status` to `recorded` and exits with 0, or with 1 after an error.

A `meeting` records differently, so that a screen or a window can come and go without touching the microphone:

- The microphone goes through AVCaptureSession to `mic.m4a` (AAC mono, 64 kb/s) from start to stop. The file is fragmented every 5 s, so if the recorder is killed (even with SIGKILL) `mic.m4a` still plays up to its last fragment and loses at most the last 5 s; `recap stop` or `recap process` assembles it as usual.
- A display or a window goes through one SCStream to `screen-<n>.mov` (H.264 at 1280 px wide with the main display's aspect, 2 fps, and the target audio as stereo AAC at 96 kb/s) only while it is set. Changing the target calls `updateContentFilter` on the running stream, so the segment goes on; if that fails, the segment is closed and a new one starts. Clearing the target closes the segment. Target changes run one at a time and stopping waits for the one in progress. The windows of Den and Recap are left out of a display capture; the recorder checks every 2 s whether they changed (for example, Den was opened) and updates the filter.
- `capture.json` (rewritten atomically after each change) holds `mic`, `startedAt`, `endedAt`, the current `video` and the `segments`, each with `file`, `startMs`, `endMs` (milliseconds from the first microphone sample) and the `targets` it went through, plus the last capture `error`.
- `control/` takes requests: write `<id>.request.json` (atomically: a dot-file renamed into place; `id` is up to 64 letters, digits or dashes) with `{"id", "issuedAt": <epoch ms>, "action": "set", "target": {"kind": "display"|"window", "id": n}}`, `{"id", "issuedAt", "action": "clear"}` or `{"id", "issuedAt", "action": "sources", "thumbnails": true}`. A request without `issuedAt` or older than 30 s gets `CONTROL_EXPIRED`. The recorder checks every 100 ms, handles `set` and `clear` one at a time in name order and `sources` alongside them, so thumbnails never delay a switch; it deletes each request and writes `<id>.response.json` with `{"id", "ok": true, "data": …}` (the state without `meetingId`, or the sources) or `{"id", "ok": false, "error": {"code", "message"}}`. Requests still waiting when the recording stops get `NOT_RECORDING`. This is an internal protocol: tools use `recap capture`.

When `live.enabled` is on (the default, see Configuration), it also cuts the audio into 16 kHz mono 16-bit WAV chunks under `live/chunks/`, named `<channel>-<seq, 5 digits>.wav` with `channel` `mic` or `system`, and appends one line per chunk to `live/chunks/index.jsonl`:

```json
{"channel":"mic","endMs":9870,"file":"mic-00001.wav","seq":1,"startMs":0}
{"channel":"system","endMs":12000,"seq":2,"startMs":9870}
```

Offsets are milliseconds from the start of the recording; chunks without speech have no `file` and no WAV. Then it spawns the live worker, detached, with its output in `live/worker.log`. `--live-worker` (or `RECAP_LIVE_WORKER` when the option is absent) picks it: an executable runs as `<executable> live-worker <meetingDir>`, a JSON array such as `["node", "/path/recap.js", "live-worker"]` is the whole command with `<meetingDir>` appended, and `none` turns it off. Use absolute paths: an app started by `open` gets the minimal launchd `PATH`, and bare names are only searched there and in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`. `open` does not pass the caller's environment either; `recap start` forwards `RECAP_LIVE_WORKER` with `open --env`, and other callers should do the same or use `--live-worker`. There is no default worker: without `--live-worker` or `RECAP_LIVE_WORKER` the recording goes on, no worker starts and `recorder.log` says `live worker not started: No live worker configured…`.

### Checking live capture on a Mac

The tests cover the control protocol with a fake recorder, the JSON of `sources` and `state`, the errors and `assemble` with ffmpeg on synthetic files. What needs the screen permission (real thumbnails, ScreenCaptureKit audio and `updateContentFilter`) is checked by hand, with an installed Recap.app built from this branch (`make install`) and a scratch root so no real meeting is touched:

1. `export RECAP_ROOT=$(mktemp -d)` and `recap capture sources --thumbnails --json > /tmp/sources.json`. Expect `ok: true`, every display and window with a `thumbnail`, and no window of Den or Recap. Paste one `thumbnail` value in a browser address bar: it shows a ~320 px picture of that window. If macOS asks for Screen & System Audio Recording, allow Recap and run it again (a first run fails with `SCREEN_PERMISSION_DENIED`).
2. Play a video with sound in Safari or Chrome. `recap start "Capture check" --json`, then `recap capture state --json`: `mic: true`, `video: null`.
3. Say "one" and `recap capture set --window <id of the browser window> --json`: `systemAudio: true`, `video.kind: "window"`. Wait 10 s.
4. Say "two" and `recap capture set --display <main display id> --json`: `video.kind: "display"`. Wait 10 s. `jq '.segments' "$RECAP_ROOT"/*/capture.json` still shows one segment with two `targets` (the switch kept the stream). If it shows two segments, `updateContentFilter` failed and the fallback opened a new one; note it in the issue.
5. Say "three", `recap capture clear --json` (`video: null`), wait 5 s, close the browser window after `recap capture set --window <id>` and check that `recap capture state --json` goes back to `video: null` and `capture.json` has `error` starting with `WINDOW_GONE`.
6. `recap stop --no-process --json`: `stages.assemble.status` is `done` and the folder has `recording.mov`, `capture.json` and `meeting.json` but no `mic.m4a` or `screen-*.mov`.
7. `ffprobe -v error -show_entries stream=index,codec_type,width,height -of csv "$RECAP_ROOT"/*/recording.mov` lists one video and two audio streams. Play it in QuickTime and switch tracks (View > Languages / Subtitles, or `ffplay -ast 1`): track 1 has your voice saying "one", "two" and "three" all along; track 2 has the browser audio during step 3 (only that app) and all the system audio during step 4, and silence elsewhere; the picture shows the window, then the display, then black.
8. `recap process last --only audio` writes `mic.wav` and `system.wav`; `recap process last` labels the transcript `Sala` and `Remotos`.

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
