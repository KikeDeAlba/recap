---
name: recap-stop
description: Termina la grabación y deja la reunión documentada
argument-hint: [--no-wait para no esperar el resultado]
allowed-tools: Bash(recap stop:*), Bash(recap status:*), Bash(recap wait:*), Bash(recap show:*), Bash(bita stop:*), Bash(bita ls:*), Bash(bita amend:*), Bash(inkwell page move:*), Bash(inkwell backlog edit:*)
disable-model-invocation: true
---

Detén la grabación activa y deja la reunión documentada.

Grabación actual:

!`recap status --json`

Si no hay grabación activa (`NOT_RECORDING`), dilo en una línea y termina.

## Si la grabación sigue a un cronómetro de bita

Cuando `data.active.bitaEntryId` trae un id, para **el cronómetro**, no recap,
sin escribir la página:

```
bita stop <id> --json
recap wait --bita-entry <id> --json
```

El evento de bita detiene la grabación y recap hace lo demás: transcribe,
escribe la minuta, le pone título y proyecto al cronómetro (`bita amend`),
crea o completa la página en inkwell, pasa pendientes y hallazgos al backlog
de inkwell y deja la minuta en la nota de la entrada.

Sin inkwell, las etapas `proposals` y `wrapup` quedan en `skipped` con su
motivo (`stages.wrapup.reason`) y la minuta se queda en la carpeta de la
reunión; sugiere `npm i -g @kikedealba/inkwell && inkwell setup` y después
`recap process <id> --from proposals`.

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
- con bita e inkwell: el proyecto, la página (`wrapup.pageId`) y cuántos
  pendientes y hallazgos quedaron en el backlog;
- sin bita o sin inkwell: los **Acuerdos** y **Pendientes** de la minuta, tal cual.

Si una etapa falló, muestra su error y sugiere `recap process <id>`: retoma
desde la etapa que falló.

**Si `wrapup.projectResolved` es false**, pregunta solo «¿De qué proyecto fue?»
y, con la respuesta:

```
bita amend <entryId> --project <X>
inkwell page move <pageId> --project <X>
inkwell backlog edit <CLAVE> --project <X>   # una por cada valor de wrapup.backlogKeys
```

El tiempo de la reunión se vuelca a Jira después con tally, no desde aquí.

Con `--no-wait` en `$ARGUMENTS`, solo para y responde en una línea que el
procesamiento sigue en segundo plano y que `recap status` dice cuándo termina.
