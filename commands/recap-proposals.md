---
description: Revisa los cambios a la documentación que propuso una reunión
argument-hint: [id de la reunión o "last"]
allowed-tools: Bash(recap proposals:*), Bash(recap show:*), Read, Write
---

Al cerrar una reunión ligada a bita, recap deja los cambios explícitos a
páginas existentes como propuestas en la rama `proposal/meeting-<entrada>` de
los docs. Nada llega a `main` sin aceptarse.

1. La reunión es `$ARGUMENTS`, o `last` si viene vacío. Lista sus propuestas:

   ```
   recap proposals ls <reunión> --json
   ```

2. Por cada una en `pending` o `stale`, muestra el detalle con
   `recap proposals show <reunión> <n> --json`: título, página y sección,
   justificación, citas (con su minuto) y el diff.
3. Pregunta qué hacer con cada una y aplícalo:

   ```
   recap proposals accept <reunión> <n> --json
   recap proposals accept <reunión> <n> --md <archivo-editado> --json
   recap proposals reject <reunión> <n> --json
   ```

   Para editar antes de aceptar, copia `proposal.file`, haz el cambio que pida
   el usuario y pásalo con `--md`.

Si `accept` deja la propuesta en `stale`, la página cambió desde la propuesta:
muéstralo, y ofrece editarla sobre la versión actual y aceptarla con `--md`.
