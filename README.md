# recap

Record meetings on macOS and turn them into a transcript, a summary, agreements and action items, all stored as local Markdown.

- **Remote meetings** (Meet, Zoom, Teams): screen, system audio and microphone, with key frames extracted from the screen.
- **In-person meetings**: microphone only.
- Local transcription with whisper.cpp; summary written by Claude Code (`claude -p`).
- CLI (`recap start|stop|status|list|process`), Claude Code plugin with slash commands and a skill, and an optional integration with [bita](https://github.com/KikeDeAlba/bita-cli) timers.

Work in progress.
