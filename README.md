# recap

Record meetings on macOS and turn them into a transcript, a summary, agreements and action items, all stored as local Markdown.

| Mode | Flag | Captures | Permissions |
|---|---|---|---|
| Remote (Meet, Zoom, Teams) | `--remote` | Screen (1280 px, 2 fps), system audio and microphone, as separate tracks | Screen & System Audio Recording, Microphone |
| In-person | `--in-person` | Microphone only | Microphone |

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

## Claude Code plugin

The repository is also a Claude Code plugin marketplace:

```
/plugin marketplace add KikeDeAlba/recap
/plugin install recap@recap
```

| Command | What it does |
|---|---|
| `/recap-start [remota\|presencial] [título]` | Starts a recording; infers the mode from the arguments or the conversation and asks when it cannot |
| `/recap-stop [--wait]` | Stops the recording; with `--wait` it processes in the foreground and shows agreements and action items |
| `/recap-status` | Shows whether a recording is running and how far processing got |
| `/recap-list [meeting]` | Lists meetings or shows one meeting's minutes |
| `/recap-summarize [meeting] [instructions]` | Rewrites the minutes inside the session, following extra instructions, and stores them with `recap save-summary` |
| `/recap-ask [question]` | Answers the last question of the meeting being recorded, or the one given, from the bita pages and the project repositories |
| `/recap-proposals [meeting]` | Reviews the documentation changes proposed by a meeting and accepts, edits or rejects them |

The `recap` skill lets Claude answer questions such as "¿qué acordamos en la reunión de ayer?" from the stored minutes and transcripts. The commands call `recap`, so it must be on the `PATH` of the shell Claude Code runs.

## Live assistant

While a meeting is being recorded, recap also transcribes it live:

- The recorder taps the microphone and system audio, converts each to 16 kHz mono, and cuts it on silence into 5–20 s chunks (`live.maxChunkSeconds`) under `live/chunks/`. The tap runs on its own queue and never blocks the file writer.
- A detached `recap live-worker` transcribes each chunk with `whisper-cli` (same model and VAD as the pipeline, 4 threads, the previous text as prompt), drops hallucinations and microphone echo, and appends `{startMs, endMs, channel, text}` lines to `live/transcript.jsonl`, with offsets from the start of the recording. It exits once the recording stops and the queue is empty.
- The transcript after `stop` is still the source of truth; the live one is for answering during the meeting.

`recap ask` answers a question with Claude Code (headless, streaming), reading only the bita pages and the repositories registered for the entry's project (`bita project repo ls`, bita 0.16 or later):

```sh
recap ask --active                                      # the last question in the live transcript
recap ask --active --question "¿cómo se despliega bita-desktop?"
recap ask --meeting <meeting> --window 300 --json-stream
recap ask --sources --project CoDi --json               # the docs root and repositories it would read
```

- The context is the last `--window` seconds (default 180) of the live transcript, the entry title and project, the project page tree and its repositories. Claude may use Read, Grep, Glob and, in each repository, only `git -C <repo> log|show|diff` (one exact `--allowedTools` prefix per repository and subcommand, since headless Claude Code rejects `cd <repo> && git …` and does not match wildcards in the middle of a pattern), and nothing else (`Resources/ask-prompt.md`).
- Answers are short, give the exact command when there is one, cite the page, `file:line` or commit, and say "No está documentado." instead of guessing.
- `--json-stream` prints one JSON object per line: `question`, `progress` (the file being read), `delta` (answer text), `source`, then `done` with the whole answer, or `error`.
- Every answer is appended to `live/answers.jsonl` as `{id, askedAt, question, answer, found, sources}`, plus `"auto": true` when the live worker detected the question (manual answers leave `auto` out).
- Only one answer runs at a time per meeting. The running one holds `live/ask.lock` (`{pid, auto, startedAt}`) and describes itself in `live/asking.json` as `{"question": "…" | null, "startedAt": "…", "auto": true | false}`; both are removed when it finishes. A manual `recap ask` always wins: it stops the running answer (and its `claude` process) and takes over; a stale lock from a dead process is ignored.

bita-desktop drives this from its floating window: it opens while recording (`live.openWindow`), runs `recap ask --active --json-stream` from a global shortcut and shows the answers.

#### Detected questions

With `live.autoAsk` on (the default), the live worker also looks for questions on its own queue, so transcription never waits for it:

- Whenever new lines reach `live/transcript.jsonl`, and at most once every `live.autoAskMinSeconds` (default 20, 10–120), it sends the last 90 s of transcript, the project and its page titles to `claude -p --model <live.autoAskModel>` (default `haiku`) with no tools and the same isolation flags as the pipeline (`Resources/detect-prompt.md`). The answer is strict JSON: `{"question": "…"}` or `{"question": null}`.
- Only technical questions that the docs or the code can answer count: how to run, deploy or configure something, what changed, how something was done, where something is. Greetings, logistics, opinions and rhetorical questions are ignored. In remote meetings questions from Remotos weigh more; in-person meetings only have Sala, so the content decides. The question comes back rephrased so it stands on its own.
- A question too similar to one already answered in `live/answers.jsonl`, or already detected in this meeting (Jaccard ≥ 0.5 on accent-folded words without stopwords), is skipped.
- Otherwise the worker runs the same path as `recap ask --question <q>` in a child process, with `auto: true` in `asking.json` and in the answer. It skips the question when another answer holds the lock, and a manual ask stops it.
- Detector failures go to `live/worker.log` and never stop the transcription; a running detected answer stops with the worker.

### Proposed documentation changes

For meetings linked to a bita entry, the `proposals` stage (before `wrapup`) asks Claude Code (`Resources/proposals-prompt.md`) for the explicit, firm changes said about existing pages: the project pages and the pages linked to the entry, never the meeting's own page. Ideas, doubts and statements corrected later are left out, and the text follows bita's writing rule: nothing that reveals the conversation.

Each change becomes a commit on the docs branch `proposal/meeting-<entry>` through `bita docs propose`, and is listed in `proposals.json` (its markdown in `proposals/<n>.md`). Nothing reaches `main`, or Confluence, until it is accepted:

```sh
recap proposals ls <meeting> --json          # or --bita-entry <id>
recap proposals show <meeting> <n> --json    # markdown, quotes and the branch diff
recap proposals accept <meeting> <n> [--md edited.md]
recap proposals reject <meeting> <n>
```

`accept` runs `bita docs branch apply`; with `--md` it first proposes the edited text again. If the page changed since the proposal, the merge conflicts and the proposal turns `stale` (the command still succeeds). When no proposal is pending, the branch is dropped. A failure in this stage is recorded in `stages.proposals` and never stops the wrap-up. Turn it off with `recap config set live.proposals false`.

## bita integration

With [bita](https://github.com/KikeDeAlba/bita-cli) 0.12 or later, a meeting timer records the meeting while it runs:

```sh
bita start "Planeación sprint 42" --kind remote-meeting     # recap starts recording the screen, system audio and mic
bita start "1:1 con Ana" --kind in-person-meeting           # recap records the mic only
bita stop                                                   # recap stops, processes, and writes the minutes into the entry
```

`recap setup` registers the hook in bita (`bita hooks add --on start,stop,cancel,amend --kind in-person-meeting,remote-meeting -- …/recap bita-hook`). It works the same whether the timer is started from the terminal, from Claude Code or from bita-desktop.

| bita event | recap |
|---|---|
| `start` of a meeting kind | starts recording in the matching mode, linked to the entry |
| `stop` | stops, processes in the background and wraps the meeting up in bita (see below) |
| `cancel` | discards the recording |
| `amend --kind <meeting kind>` on a running entry | starts recording |
| `amend --kind none` while recording | stops without processing; the recording is kept |

### Wrap-up

After the summary, the `wrapup` stage asks Claude Code (headless, `Resources/wrapup-prompt.md`) for a title, a project, a documentation page and backlog items, and applies them through the bita CLI:

- the timer gets the meeting's real topic as its title when the current one is generic ("Reunión presencial", "Junta", …);
- if the timer has no project, it gets one only when the conversation makes it clear and the name exists in `bita projects`; otherwise `wrapup.projectResolved` is false and `/bita-stop` asks;
- a page is created with `bita docs page new --from-entry` in that project and written as formal documentation (no pending sections); if the timer already had a page, a `## Reunión <date>` section is added to it instead;
- action items and open questions become `bita backlog` items on that page;
- the minutes still land in the `## Reunión` section of the entry document.

`recap wait --bita-entry <id>` blocks until all of that is done and prints the result (`data.wrapup` with `--json`).

The hook output goes to `hooks.log` beside the bita database. Minutes regenerated with `/recap-summarize` or `recap save-summary` are sent to bita again.

## Pipeline

| Stage | Remote | In-person | Output |
|---|---|---|---|
| `audio` | mic and system tracks | mic track | `mic.wav`, `system.wav` (16 kHz mono) |
| `transcribe` | per channel, then merged | mic | `transcript.json`, `transcript.md` |
| `frames` | scene changes, at least 20 s apart, at most 40 | skipped | `frames/hh-mm-ss.jpg`, `frames.json` |
| `summarize` | `claude -p` with transcript and frames | `claude -p` with transcript | `summary.md` |
| `proposals` | only when linked to a bita entry and `live.proposals` is on | same | `proposals.json`, `proposals/<n>.md` and the docs branch `proposal/meeting-<entry>` |
| `wrapup` | only when linked to a bita entry | same | entry title and project, a bita page, backlog items and the `## Reunión` section of the entry document |

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
├── live/             transcript.jsonl, answers.jsonl, asking.json, ask.lock and chunks/ (live assistant)
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
    "maxChunkSeconds": 20,
    "assistModel": "sonnet",
    "autoAsk": true,
    "autoAskModel": "haiku",
    "autoAskMinSeconds": 20
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
- `live` controls the live assistant; every key is optional. `enabled` turns the live transcription on, `openWindow` lets bita-desktop open its floating window while recording, `proposals` turns the `proposals` stage on, `maxChunkSeconds` (5–60) is the longest live chunk, `assistModel` is the model for `recap ask` (Claude Code's default when unset), `autoAsk` turns question detection on, `autoAskModel` is the model that detects them (`haiku` by default), and `autoAskMinSeconds` (10–120) is the shortest time between two detections.
- `recap config get [<key>] --json` and `recap config set <key> <value> --json` read and change the `live.*` keys.

Environment overrides: `RECAP_ROOT`, `RECAP_STATE_DIR`, `RECAP_DATA_DIR`.

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

The version comes from `Recap.version` in `Sources/recap/Recap.swift`. Releases are built and signed locally with an Apple Development identity, so macOS keeps the permissions across updates; they are not notarized. `bita setup` downloads the `*-macos-arm64.zip` asset of the latest release.

## License

MIT
