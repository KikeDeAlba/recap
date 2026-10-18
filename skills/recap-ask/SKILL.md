---
name: recap-ask
description: Responde la última pregunta de la reunión en curso
argument-hint: [pregunta, opcional]
allowed-tools: Bash(recap ask:*)
disable-model-invocation: true
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
`label`; las de tipo `note` vienen del cerebro de gaze). Si `data.found` es false, dilo en una línea: no está documentado.
Si falla con `NOT_RECORDING`, no hay grabación activa; con `NO_QUESTION`, la
transcripción en vivo todavía está vacía y hace falta escribir la pregunta.
Puede haber otras respuestas en curso al mismo tiempo; no se estorban. Las
respuestas que el live-worker encontró solo llevan `auto: true` en
`live/answers.jsonl`.
Si el proyecto tiene gaze, recap lo consulta él mismo antes de lanzar a Claude (Claude
no ejecuta gaze) con `gaze search --project=<P>`, que por diseño trae también notas
de `global` y del grupo de gaze del proyecto (nunca de otros proyectos); el texto de
las notas llega a Claude escapado, como datos. recap guarda como nota `fact` solo las
respuestas cuyas fuentes verifica, sin secretos ni datos personales en la nota
completa (JWT, tokens, credenciales en URLs, Basic auth, frases en español como `contraseña es …`,
tarjetas, llaves, correos; la lista no es exhaustiva), de 8000 caracteres como máximo
(la respuesta) y solo si el prompt no llevó notas del cerebro (para no pisar notas
humanas). Las consultas (y la verificación de commits) vencen a los 10 s y el guardado a los 60 s; si fallan, sigue
sin el cerebro. Sin proyecto no busca ni guarda. `RECAP_NO_GAZE=1`
lo desactiva; `recap ask --sources --question "<pregunta>"` muestra gaze y las notas halladas.
