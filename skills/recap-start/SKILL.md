---
name: recap-start
description: Empieza a grabar una reunión (sin modalidad, remota o presencial)
argument-hint: [remota|presencial] [título]
allowed-tools: Bash(recap start:*), Bash(recap status:*), Bash(recap import:*), Bash(bita start:*)
disable-model-invocation: true
---

Estado actual:

!`recap status --json`

Empieza a grabar una reunión con `$ARGUMENTS`.

1. **Si arriba dice que ya se está grabando**, no arranques otra: dilo en una
   línea y termina.
2. **Modo.** Sácalo de `$ARGUMENTS` o del contexto de la conversación:
   - remota: Meet, Zoom, Teams, llamada, videollamada, en línea.
   - presencial: en sala, en oficina, en persona.
   - reunión (por omisión): si no se dice ninguna de las dos. Graba solo el
     micrófono; no preguntes la modalidad.
3. **Título.** Lo que quede de `$ARGUMENTS` sin la palabra del modo, literal. Si
   no hay, uno corto sacado del contexto; si tampoco hay contexto, arranca sin
   título.
4. **Por dónde arrancar.** Si arriba `data.bitaLinked` es true, recap escucha
   los eventos de bita: arranca por bita, para que el tiempo también quede
   medido y la minuta llegue al documento de la entrada:

   ```
   bita start "<título>" --kind meeting
   bita start "<título>" --kind remote-meeting
   bita start "<título>" --kind in-person-meeting
   ```

   Si `data.bitaLinked` es false, arranca recap directamente:

   ```
   recap start "<título>"
   recap start --remote "<título>"
   recap start --in-person "<título>"
   ```

   Si la respuesta trae `"fallback": "in-person"`, el Recap.app instalado es
   anterior al modo reunión: grabó igual, solo el micrófono; sugiere
   `recap setup` para actualizarlo.

Si falla por permisos (`SCREEN_DENIED`, `MICROPHONE_DENIED`), di exactamente qué
activar en Configuración > Privacidad y seguridad. Si es `RECORDER_TIMEOUT` o
falta una dependencia, sugiere `recap setup`. Si es `CAPTURE_UNAVAILABLE`
(Windows o Linux), explica que ahí no se graba: que grabe con otra app y la
procese con `recap import <archivo>`. Si arrancaste por bita, confirma
con `recap status` que la grabación empezó.

Responde en una línea: modo (en reunión, sin modalidad), título, que ya está grabando y el id de bita si
arrancó por ahí. Nada más.
