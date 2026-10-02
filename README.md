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

## Install

```sh
make install
```

This builds `Recap.app`, signs it with your first `Apple Development` identity (or ad-hoc when there is none, set `RECAP_SIGN_IDENTITY` to pick another one), copies it to `~/Applications` and links `~/.local/bin/recap`. Make sure `~/.local/bin` is on your `PATH`, or install the link elsewhere with `make install PREFIX_BIN=/opt/homebrew/bin`.

Then check the dependencies and grant the permissions:

```sh
recap setup
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
├── recording.mp4     remote: video + mic track + system track
├── recording.m4a     in-person: mic track
└── recorder.log
```

Recordings are written as fragmented MP4, so a crash or a forced quit keeps everything up to the last few seconds.

## Configuration

`~/.config/recap/config.json` (override with `RECAP_CONFIG_PATH`):

```json
{
  "root": "~/Recap",
  "language": "es",
  "whisperModel": "~/.local/share/recap/models/ggml-large-v3-turbo.bin",
  "bitaPath": "/Users/me/Library/pnpm/bin/bita"
}
```

Environment overrides: `RECAP_ROOT`, `RECAP_STATE_DIR`, `RECAP_DATA_DIR`.

## Development

```sh
make build
make test
```

## License

MIT
