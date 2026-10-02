---
description: Termina la grabación y genera la minuta
argument-hint: [--wait para esperar la minuta y mostrarla]
allowed-tools: Bash(recap stop:*), Bash(recap status:*), Bash(recap process:*), Bash(recap show:*), Bash(bita stop:*), Bash(bita ls:*)
---

Detén la grabación activa.

Grabación actual:

!`recap status --json`

**Si `data.active.bitaEntryId` trae un id**, la grabación sigue a un contador de
bita: para el contador y no recap, con `bita stop <id>`. El hook de bita detiene
la grabación y procesa la minuta, que llega al documento de la entrada. Con
`--wait`, espera a que `recap status` deje de mostrar `processing` en la última
reunión antes de mostrar la minuta con `recap show last`.

Si no trae id, sigue con recap:

**Sin `--wait` en `$ARGUMENTS`**, para y deja el procesamiento en segundo plano:

```
recap stop
```

Responde en una línea: duración, y que la minuta se está generando (con
`/recap-list` o `recap show last` se consulta cuando esté).

**Con `--wait`**, para sin procesar y procesa en primer plano para mostrar el
resultado:

```
recap stop --no-process --json
recap process last
recap show last
```

`recap process` puede tardar varios minutos en reuniones largas; córrelo con un
timeout amplio. Cuando termine, muestra los **Acuerdos** y **Pendientes** de la
minuta tal cual, y la ruta de `summary.md`.

Si no hay grabación activa (`NOT_RECORDING`), dilo en una línea. Si una etapa
falla (`STAGE_FAILED`), muestra el mensaje y sugiere `recap process last` una
vez corregida la causa: retoma desde la etapa que falló.
