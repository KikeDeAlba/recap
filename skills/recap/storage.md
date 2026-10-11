# Liberar espacio

Solo si el usuario lo pide. Todos aceptan `<id>` o `--bita-entry <id>` y `--json`.

```sh
recap compress-video <id> --preset light|medium|max   # recomprime el video en HEVC (solo remotas)
recap strip-video <id>                                 # quita el video y deja recording.m4a con ambas pistas de audio
recap prune <id> --intermediates                       # borra mic.wav, system.wav, transcript-mic/system.json y live/chunks
recap delete <id>                                      # borra la carpeta completa de la reunión
```

`compress-video` y `strip-video` aceptan `--prune-intermediates`. Fallan con
`NOT_REMOTE` en reuniones presenciales, `NO_VIDEO` si ya no hay video,
`MEETING_ACTIVE` mientras se graba y `NOT_SMALLER` si la compresión no ahorra
espacio (el original se conserva). `recap list --json` trae `storage` y
`hasVideo` de cada reunión.
