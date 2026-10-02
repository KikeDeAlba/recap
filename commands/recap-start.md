---
description: Empieza a grabar una reunión (remota o presencial)
argument-hint: [remota|presencial] [título]
allowed-tools: Bash(recap start:*), Bash(recap status:*)
---

Estado actual:

!`recap status`

Empieza a grabar una reunión con `$ARGUMENTS`.

1. **Si arriba dice que ya se está grabando**, no arranques otra: dilo en una
   línea y termina.
2. **Modo.** Sácalo de `$ARGUMENTS` o del contexto de la conversación:
   - `--remote`: remota, Meet, Zoom, Teams, llamada, videollamada, en línea.
   - `--in-person`: presencial, en sala, en oficina, en persona.

   Si no se puede saber, pregunta solo "¿remota o presencial?" y espera.
3. **Título.** Lo que quede de `$ARGUMENTS` sin la palabra del modo, literal. Si
   no hay, uno corto sacado del contexto; si tampoco hay contexto, arranca sin
   título.

```
recap start --remote "<título>"
recap start --in-person "<título>"
```

Si falla por permisos (`SCREEN_DENIED`, `MICROPHONE_DENIED`), di exactamente qué
activar en Configuración > Privacidad y seguridad. Si es `RECORDER_TIMEOUT` o
falta una dependencia, sugiere `recap setup`.

Responde en una línea: modo, título y que ya está grabando. Nada más.
