---
name: recap
description: Graba reuniones con la CLI `recap` y las convierte en minuta (resumen, acuerdos, pendientes y preguntas abiertas). Úsala cuando el usuario quiera empezar o terminar de grabar una reunión, saber si se está grabando, regenerar la minuta, o consultar qué se habló, qué se acordó o qué quedó pendiente en reuniones pasadas. Frases que la disparan: "graba la reunión", "empieza a grabar la junta", "ya terminó la reunión", "para la grabación", "¿se está grabando?", "¿qué acordamos en la reunión de ayer?", "pendientes de la junta con X", "rehaz la minuta".
---

# recap

`recap` graba reuniones (en macOS, con Recap.app) y las procesa localmente en
macOS, Windows y Linux. Cada reunión es una carpeta bajo `~/Recap` (o la raíz
configurada) con `meeting.json`, la grabación, `transcript.md`, `frames/` y
`summary.md`.

Quién hace qué: bita mide el tiempo, recap graba y escribe la minuta, inkwell
guarda la documentación, tally vuelca el tiempo a Jira y atl habla con Jira y
Confluence. Este es el único lugar donde se describe el flujo de una reunión;
las demás herramientas enlazan aquí.

Todos los comandos aceptan `--json` y devuelven un sobre
`{schemaVersion, ok, command, data, error}`. Usa `--json` siempre que vayas a
leer el resultado; el texto plano es para mostrarlo tal cual.

Fuera de macOS no se puede grabar (`start` falla con `CAPTURE_UNAVAILABLE`):
la reunión se graba con otra app y se procesa con
`recap import <archivo> [--title "…"] [--in-person|--remote] --json`.

## Modo

Hay que elegirlo siempre; no tiene valor por defecto.

| Modo | Flag | Cuándo |
|---|---|---|
| Remota | `--remote` | Meet, Zoom, Teams, Slack huddle, llamada, videollamada, "en línea" |
| Presencial | `--in-person` | En sala, en oficina, en persona, junta física, comida, "aquí con" |

En remota se graba pantalla, audio del sistema y micrófono; en presencial solo
el micrófono. Si el contexto no deja claro cuál es, pregunta con una sola línea
("¿remota o presencial?") antes de arrancar.

## Flujo de una reunión

1. **Ver el estado**: `recap status --json`. Si ya se está grabando
   (`ALREADY_RECORDING` al arrancar), no arranques otra: avísalo.
2. **Arrancar.** Si `data.bitaLinked` es true, recap sigue a los cronómetros
   de bita: arranca por bita para que el tiempo también quede medido.

   ```sh
   bita start "<título>" --kind remote-meeting      # o --kind in-person-meeting
   recap start --remote "<título>"                  # solo si bitaLinked es false
   ```

3. **Durante la reunión**: `recap ask --active --json` responde la última
   pregunta con las páginas de inkwell y los repos del proyecto. Detalle en
   [live.md](live.md).
4. **Parar.** Con cronómetro, para el cronómetro y espera; sin él, para recap:

   ```sh
   bita stop <id> --json && recap wait --bita-entry <id> --json
   recap stop --json && recap wait --json
   ```

   `stop` lanza el procesamiento en segundo plano (transcripción, capturas,
   minuta y cierre). Tarda de uno a cinco minutos por hora de reunión: corre
   `recap wait` con un timeout amplio. El monitor del plugin de Claude Code
   avisa en la sesión cuando termina, así que no hace falta sondear.
5. **Cierre automático** (con bita e inkwell): recap le pone título y proyecto
   al cronómetro, crea o completa la página en inkwell, pasa pendientes y
   hallazgos al backlog y deja la minuta en la nota de la entrada. El
   resultado viene en `data.wrapup` de `recap wait`; si
   `wrapup.projectResolved` es false, pregunta el proyecto. Detalle y
   correcciones en [wrapup.md](wrapup.md).
6. **Después**: los cambios que la reunión propuso a la documentación se
   revisan con `/recap-proposals` ([proposals.md](proposals.md)), y el tiempo
   de la reunión llega a Jira con tally, no desde recap.

Cambiar el título o el proyecto del cronómetro mientras se graba
(`bita amend`) no corta la grabación; solo un cambio de `--kind` que cruce la
línea de reunión la arranca o la detiene. `recap discard` borra la grabación
activa: solo si el usuario lo pide.

## Consultar reuniones

```sh
recap list --json
recap show <id|parte del id|last> --json
recap show <id> --path
```

Para responder qué se habló o qué se acordó, lee `summary.md` de las reuniones
que apliquen. Si hace falta precisión (una cifra, quién dijo qué), ve a
`transcript.md`, que lleva el minuto de cada párrafo. Cita la reunión y el
minuto. En remotas, **Sala** es el micrófono local y **Remotos** el audio de la
llamada; no hay separación por persona.

## Regenerar la minuta

- Sin intervención: `recap process <id> --from summarize`.
- Dentro de la sesión, cuando el usuario quiere dirigir el enfoque: `/recap-summarize`.
- Si una etapa falló, `recap process <id>` retoma desde ahí.

## Errores típicos

| Código | Causa | Acción |
|---|---|---|
| `SCREEN_DENIED` | Recap.app sin permiso de grabación de pantalla | Configuración > Privacidad y seguridad > Grabación de pantalla y audio del sistema |
| `MICROPHONE_DENIED` | Sin permiso de micrófono | Igual, en Micrófono |
| `RECORDER_TIMEOUT` | Un diálogo de permisos quedó esperando | `recap setup` |
| `DEPENDENCY_MISSING`, `MODEL_MISSING` | Falta ffmpeg, whisper-cli, claude o el modelo | `recap setup --install-deps` |
| `CAPTURE_UNAVAILABLE` | No hay grabador en este equipo | Graba con otra app y usa `recap import <archivo>`; en mac, `recap setup` |

## Más detalle, bajo demanda

- [wrapup.md](wrapup.md): qué hace el cierre con bita e inkwell, sin inkwell, y cómo corregir el proyecto.
- [live.md](live.md): transcripción en vivo, `recap ask` y su configuración.
- [proposals.md](proposals.md): cambios propuestos a la documentación.
- [storage.md](storage.md): liberar espacio (comprimir, quitar video, borrar).

## Lo que no hace

- No separa hablantes por persona: los nombres salen del contexto.
- No sube nada a la nube salvo la transcripción que lee Claude al resumir, al
  responder con `recap ask` y al buscar cambios propuestos.
- No toca Jira.
