# Cierre de una reunión con bita e inkwell

Si `recap status --json` trae `data.bitaLinked: true` (recap está suscrito a
los eventos de bita desde `recap setup`), las reuniones se arrancan y se paran
desde bita. recap solo le pide a bita `projects`, `project repo ls`,
`entries get` y `amend` (título y proyecto).

Al parar el cronómetro, recap hace todo lo demás sin que nadie lo pida:

- transcribe y escribe la minuta;
- le pone al cronómetro un título real, si el que tenía era genérico (`bita amend`);
- le asigna el proyecto si no tenía y la conversación lo deja claro (`bita amend`);
- crea la página en inkwell, ligada a la entrada (`inkwell page new --from-entry`),
  o agrega una sección a la que ya tenía (`inkwell page ls --entry`), y la escribe;
- pasa pendientes y hallazgos al backlog de inkwell (`inkwell backlog add`);
- deja la minuta en la sección «Reunión» de la nota de la entrada
  (`inkwell note save <entrada> --section Reunión --md …`).

El resultado está en `data.wrapup` de `recap wait`: `title`, `project`,
`projectResolved`, `pageId`, `pageCreated` y `backlogKeys`.

## Corregir el proyecto

Si `wrapup.projectResolved` es false, pregunta solo «¿De qué proyecto fue?» y,
con la respuesta:

```sh
bita amend <entryId> --project <X>
inkwell page move <pageId> --project <X>
inkwell backlog edit <CLAVE> --project <X>   # una por cada valor de wrapup.backlogKeys
```

## Sin inkwell, o con un inkwell viejo

La reunión igual queda procesada: las etapas `proposals` y `wrapup` quedan en
`skipped` con el motivo en `stages.<etapa>.reason` y la pista
`npm i -g @kikedealba/inkwell && inkwell setup`; la minuta se queda en
`summary.md` de la carpeta de la reunión. Si inkwell no tiene la capacidad
`docs.entry-notes`, se escriben la página y el backlog, pero la minuta no pasa
a la nota (queda anotado en `process.log`). Después de instalar o actualizar
inkwell, `recap process <id> --from proposals` lo completa.

## Qué responder al usuario

- Título y duración.
- Con bita e inkwell: el proyecto, la página (`wrapup.pageId`) y cuántos
  pendientes y hallazgos quedaron en el backlog.
- Sin bita o sin inkwell: los **Acuerdos** y **Pendientes** de la minuta, tal cual.
- Si una etapa falló, su error y la sugerencia `recap process <id>`.
