---
description: Muestra si se está grabando y en qué va la última reunión
allowed-tools: Bash(recap status:*)
---

!`recap status --json`

Resume en una o dos líneas:

- Si `data.recording` es true: modo, título y tiempo transcurrido.
- Si no: que no se está grabando, y el estado de la última reunión
  (`data.latest.status`). Si está en `processing`, di qué etapas ya están en
  `done` dentro de `data.latest.stages`. Si alguna está en `failed`, muestra
  su error.
