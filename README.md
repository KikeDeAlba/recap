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
recap discard <meeting>
```

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

The `recap` skill lets Claude answer questions such as "¿qué acordamos en la reunión de ayer?" from the stored minutes and transcripts. The commands call `recap`, so it must be on the `PATH` of the shell Claude Code runs.

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
| `stop` | stops, processes in the background and adds a `## Reunión` section with the minutes to the entry document (`bita note save`) |
| `cancel` | discards the recording |
| `amend --kind <meeting kind>` on a running entry | starts recording |
| `amend --kind none` while recording | stops without processing; the recording is kept |

The hook output goes to `hooks.log` beside the bita database. Minutes regenerated with `/recap-summarize` or `recap save-summary` are sent to bita again.

## Pipeline

| Stage | Remote | In-person | Output |
|---|---|---|---|
| `audio` | mic and system tracks | mic track | `mic.wav`, `system.wav` (16 kHz mono) |
| `transcribe` | per channel, then merged | mic | `transcript.json`, `transcript.md` |
| `frames` | scene changes, at least 20 s apart, at most 40 | skipped | `frames/hh-mm-ss.jpg`, `frames.json` |
| `summarize` | `claude -p` with transcript and frames | `claude -p` with transcript | `summary.md` |
| `bita` | only when linked to a bita entry | same | `## Reunión` section in the entry document |

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
├── recording.m4a     in-person: mic track
├── mic.wav, system.wav
├── transcript.md     merged transcript with timestamps
├── frames/           remote only
├── summary.md        minutes
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
  "tools": {
    "claude": "/Users/me/.nvm/versions/node/v24.19.0/bin/claude",
    "ffmpeg": "/opt/homebrew/bin/ffmpeg"
  }
}
```

- `vocabulary` is passed to whisper as a glossary and fixes most misheard product names.
- `tools` holds absolute paths to the external commands. `recap setup` fills it in, so the pipeline also works when it is started with a minimal `PATH` (for example from a menu bar app).
- `recap setup` downloads the whisper and VAD models to `~/.local/share/recap/models`.

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
