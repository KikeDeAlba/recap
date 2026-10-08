---
name: recap
description: Graba reuniones con la CLI `recap` y las convierte en minuta (resumen, acuerdos, pendientes y preguntas abiertas). Úsala cuando el usuario quiera empezar o terminar de grabar una reunión, saber si se está grabando, regenerar la minuta, o consultar qué se habló, qué se acordó o qué quedó pendiente en reuniones pasadas. Frases que la disparan: "graba la reunión", "empieza a grabar la junta", "ya terminó la reunión", "para la grabación", "¿se está grabando?", "¿qué acordamos en la reunión de ayer?", "pendientes de la junta con X", "rehaz la minuta".
---

# recap

`recap` graba reuniones en macOS y las procesa localmente. Todo vive en una
carpeta por reunión bajo `~/Recap` (o la raíz configurada):
`meeting.json`, la grabación, `transcript.md`, `frames/` y `summary.md`.

Todos los comandos aceptan `--json` y devuelven un sobre
`{schemaVersion, ok, command, data, error}`. Usa `--json` siempre que vayas a
leer el resultado; el texto plano es para mostrarlo tal cual.

## Modos

Hay que elegir el modo siempre; no tiene valor por defecto.

| Modo | Flag | Cuándo |
|---|---|---|
| Remota | `--remote` | Meet, Zoom, Teams, Slack huddle, llamada, videollamada, "en línea" |
| Presencial | `--in-person` | En sala, en oficina, en persona, junta física, comida, "aquí con" |

En remota se graba pantalla, audio del sistema y micrófono; en presencial solo
el micrófono, sin pantalla ni capturas. Si el contexto no deja claro cuál es,
pregunta con una sola línea ("¿remota o presencial?") antes de arrancar.

## Ciclo

```sh
recap start --remote "Planeación sprint 42"
recap status
recap stop
```

- `start` falla con `ALREADY_RECORDING` si ya hay una grabación activa: no
  arranques otra, avísalo.
- `stop` cierra el archivo y lanza el procesamiento en segundo plano
  (transcripción, capturas y minuta). Tarda de segundos a unos minutos según la
  duración. `recap status` y `recap show <id>` dicen en qué etapa va.
- `recap discard` descarta la grabación activa y borra su carpeta. Solo si el
  usuario lo pide explícitamente.

## Liberar espacio

Solo si el usuario lo pide; todos aceptan `<id>` o `--bita-entry <id>` y `--json`.

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

Errores típicos y qué hacer:

| Código | Causa | Acción |
|---|---|---|
| `SCREEN_DENIED` | Recap.app sin permiso de grabación de pantalla | Pide activarlo en Configuración > Privacidad y seguridad > Grabación de pantalla y audio del sistema |
| `MICROPHONE_DENIED` | Sin permiso de micrófono | Igual, en Micrófono |
| `RECORDER_TIMEOUT` | Un diálogo de permisos quedó esperando | `recap setup` |
| `DEPENDENCY_MISSING`, `MODEL_MISSING` | Falta ffmpeg, whisper-cli, claude o el modelo | `recap setup` |

## Con bita

Si bita está instalado con el hook de recap (`bita hooks` lo lista), **arranca
y para las reuniones desde bita**, no desde recap: así el tiempo queda medido y
la grabación sigue al contador.

```sh
bita start "<título>" --kind remote-meeting
bita start "<título>" --kind in-person-meeting
bita stop <id> --json                 # sin --did y sin escribir la página
recap wait --bita-entry <id> --json   # espera a que todo quede listo
```

Al parar, recap hace todo lo demás sin que nadie lo pida:

- transcribe y escribe la minuta;
- le pone al contador un título real, si el que tenía era genérico;
- le asigna el proyecto si no tenía y la conversación lo deja claro;
- crea la página en ese proyecto, o agrega una sección a la que ya tenía, y la escribe;
- pasa pendientes y preguntas abiertas al backlog;
- deja la minuta en la sección «Reunión» de la entrada.

El resultado está en `data.wrapup` de `recap wait`. Si `wrapup.projectResolved`
es false, pregunta el proyecto y aplícalo con `bita amend`,
`bita docs page move --project` y `bita backlog edit --project`.

## En vivo

Mientras se graba, recap transcribe por tramos de 5 a 20 s en
`live/transcript.jsonl` (una línea `{startMs, endMs, channel, text}`; `mic` es
Sala y `system` Remotos). Es aproximada: la transcripción de después del stop
(`transcript.md`) sigue siendo la fuente de verdad.

Para responder una pregunta que hicieron en la reunión, con las páginas de bita
y los repos del proyecto (`bita project repo ls`):

```sh
recap ask --active --json                              # la última pregunta de la transcripción
recap ask --active --question "¿cómo se despliega X?" --json
recap ask --meeting <id> --question "..." --json-stream   # eventos question/progress/delta/source/done
recap ask --sources --project <p> --json               # qué consultaría, sin llamar a claude
```

La respuesta lleva `found` y `sources` (página, `archivo:línea` o commit) y se
guarda en `live/answers.jsonl`. Con `found: false` no está documentado: no lo
completes por tu cuenta. Se configura con `recap config get|set`
(`live.enabled`, `live.openWindow`, `live.proposals`, `live.maxChunkSeconds`,
`live.assistModel`).

## Cambios propuestos a la documentación

Si la reunión está ligada a bita, la etapa `proposals` (antes de `wrapup`)
detecta los cambios explícitos y firmes a páginas que ya existen y los deja en
la rama `proposal/meeting-<entrada>` de los docs, sin tocar `main`. Ideas,
dudas y lo que se corrigió después no entran.

```sh
recap proposals ls <id> --json            # o --bita-entry <id>
recap proposals show <id> <n> --json      # markdown, citas y diff
recap proposals accept <id> <n> [--md <archivo editado>] --json
recap proposals reject <id> <n> --json
```

Acepta o rechaza **solo cuando el usuario lo pida**. Si `accept` deja la
propuesta en `stale`, la página cambió desde entonces: edítala sobre la versión
actual y acéptala con `--md`. Cuando no queda ninguna pendiente, recap borra la
rama. Usa `/recap-proposals` para revisarlas en la sesión.

## Consultar reuniones

```sh
recap list --json
recap show <id|parte del id|last> --json
recap show <id> --path
```

Para responder qué se habló o qué se acordó, lee `summary.md` de las reuniones
que apliquen. Si hace falta precisión (una cifra, quién dijo qué), ve a
`transcript.md`, que lleva el minuto de cada párrafo. Cita la reunión y el
minuto en la respuesta. En reuniones remotas, **Sala** es el micrófono local y
**Remotos** el audio de la llamada; no hay separación por persona.

## Regenerar la minuta

- Sin intervención: `recap process <id> --from summarize`.
- Dentro de la sesión, cuando el usuario quiere dirigir el enfoque o corregir
  algo: usa `/recap-summarize`.

## Lo que no hace

- No separa hablantes por persona: los nombres salen del contexto.
- No sube nada a la nube salvo la transcripción que lee Claude al resumir, al
  responder con `recap ask` y al buscar cambios propuestos.
