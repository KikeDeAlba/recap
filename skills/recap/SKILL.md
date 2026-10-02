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

Errores típicos y qué hacer:

| Código | Causa | Acción |
|---|---|---|
| `SCREEN_DENIED` | Recap.app sin permiso de grabación de pantalla | Pide activarlo en Configuración > Privacidad y seguridad > Grabación de pantalla y audio del sistema |
| `MICROPHONE_DENIED` | Sin permiso de micrófono | Igual, en Micrófono |
| `RECORDER_TIMEOUT` | Un diálogo de permisos quedó esperando | `recap setup` |
| `DEPENDENCY_MISSING`, `MODEL_MISSING` | Falta ffmpeg, whisper-cli, claude o el modelo | `recap setup` |

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
- No sube nada a la nube salvo la transcripción que lee Claude al resumir.
