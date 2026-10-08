---
description: Responde la última pregunta de la reunión en curso con las páginas y repos del proyecto
argument-hint: [pregunta, opcional]
allowed-tools: Bash(recap ask:*)
---

Responde en vivo una pregunta de la reunión que se está grabando.

- **Con `$ARGUMENTS`**, es la pregunta:

  ```
  recap ask --active --question "$ARGUMENTS" --json
  ```

- **Sin `$ARGUMENTS`**, recap toma la última pregunta de la transcripción en
  vivo:

  ```
  recap ask --active --json
  ```

Muestra `data.answer` tal cual y, debajo, las fuentes de `data.sources` (su
`label`). Si `data.found` es false, dilo en una línea: no está documentado.
Si falla con `NOT_RECORDING`, no hay grabación activa; con `NO_QUESTION`, la
transcripción en vivo todavía está vacía y hace falta escribir la pregunta.
