---
description: Empieza a grabar una reunión (remota o presencial)
argument-hint: [remota|presencial] [título]
allowed-tools: Bash(recap start:*), Bash(recap status:*), Bash(bita hooks:*), Bash(bita start:*)
---

Estado actual:

!`recap status`

Empieza a grabar una reunión con `$ARGUMENTS`.

1. **Si arriba dice que ya se está grabando**, no arranques otra: dilo en una
   línea y termina.
2. **Modo.** Sácalo de `$ARGUMENTS` o del contexto de la conversación:
   - remota: Meet, Zoom, Teams, llamada, videollamada, en línea.
   - presencial: en sala, en oficina, en persona.

   Si no se puede saber, pregunta solo "¿remota o presencial?" y espera.
3. **Título.** Lo que quede de `$ARGUMENTS` sin la palabra del modo, literal. Si
   no hay, uno corto sacado del contexto; si tampoco hay contexto, arranca sin
   título.
4. **Por dónde arrancar.** Corre `bita hooks`. Si muestra una línea con
   `recap bita-hook`, arranca por bita, para que el tiempo también quede medido
   y la minuta llegue al documento de la entrada:

   ```
   bita start "<título>" --kind remote-meeting
   bita start "<título>" --kind in-person-meeting
   ```

   Si bita no está, o no tiene el hook, arranca recap directamente:

   ```
   recap start --remote "<título>"
   recap start --in-person "<título>"
   ```

Si falla por permisos (`SCREEN_DENIED`, `MICROPHONE_DENIED`), di exactamente qué
activar en Configuración > Privacidad y seguridad. Si es `RECORDER_TIMEOUT` o
falta una dependencia, sugiere `recap setup`. Si arrancaste por bita, confirma
con `recap status` que la grabación empezó.

Responde en una línea: modo, título, que ya está grabando y el id de bita si
arrancó por ahí. Nada más.
