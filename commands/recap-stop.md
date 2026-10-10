---
description: Termina la grabación y deja la reunión documentada
argument-hint: [--no-wait para no esperar el resultado]
allowed-tools: Bash(recap stop:*), Bash(recap status:*), Bash(recap wait:*), Bash(recap show:*), Bash(bita stop:*), Bash(bita ls:*), Bash(bita amend:*), Bash(bita docs page move:*), Bash(bita backlog edit:*), Bash(inkwell page move:*), Bash(inkwell backlog edit:*)
---

Detén la grabación activa y deja la reunión documentada.

Grabación actual:

!`recap status --json`

Si no hay grabación activa (`NOT_RECORDING`), dilo en una línea y termina.

## Si la grabación sigue a un contador de bita

Cuando `data.active.bitaEntryId` trae un id, para **el contador**, no recap. Sin
`--did` y sin escribir la página:

```
bita stop <id> --json
recap wait --bita-entry <id> --json
```

El hook de bita detiene la grabación y recap hace lo demás:

- transcribe y escribe la minuta;
- le pone al contador un título real y, si no tenía, su proyecto;
- crea o completa la página;
- pasa los pendientes al backlog;
- deja la minuta en la sección «Reunión» de la entrada.

`recap wait` tarda de uno a cinco minutos en una reunión de una hora: córrelo con
un timeout amplio (15 min). Si después de un minuto `recap status` sigue
grabando, el evento no llegó: párala con `recap stop`.

## Si es una grabación suelta

```
recap stop --json
recap wait --json
```

## Qué responder

Con el resultado de `recap wait` responde:

- título y duración;
- con bita: el proyecto, la página (`wrapup.pageId`) y cuántos pendientes y
  hallazgos quedaron en el backlog;
- sin bita: los **Acuerdos** y **Pendientes** de la minuta, tal cual.

Si una etapa falló, muestra su error y sugiere `recap process <id>`: retoma
desde la etapa que falló.

**Si `wrapup.projectResolved` es false**, pregunta solo «¿De qué proyecto fue?»
y, con la respuesta:

```
bita amend <entryId> --project <X>
bita docs page move <pageId> --project <X>
bita backlog edit <CLAVE> --project <X>      # una por cada valor de wrapup.backlogKeys
```

Si inkwell está instalado, usa `inkwell page move <pageId> --project <X>` e
`inkwell backlog edit <CLAVE> --project <X>` en lugar de los dos últimos.

Con `--no-wait` en `$ARGUMENTS`, solo para y responde en una línea que el
procesamiento sigue en segundo plano.
