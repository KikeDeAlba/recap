# En vivo

Mientras se graba, recap transcribe por tramos de 5 a 20 s en
`live/transcript.jsonl` (una línea `{startMs, endMs, channel, text}`; `mic` es
Sala y `system` Remotos). Es aproximada: la transcripción de después del stop
(`transcript.md`) sigue siendo la fuente de verdad.

Para responder una pregunta que hicieron en la reunión, con las páginas de
inkwell y los repos del proyecto (`bita project repo ls`); sin inkwell responde
solo con los repos:

```sh
recap ask --active --json                              # la última pregunta de la transcripción
recap ask --active --question "¿cómo se despliega X?" --json
recap ask --meeting <id> --question "..." --json-stream   # eventos question/progress/delta/source/done
recap ask --sources --project <p> --json               # qué consultaría, sin llamar a claude
```

La respuesta lleva `found` y `sources` (página, `archivo:línea` o commit) y se
guarda en `live/answers.jsonl`. Con `found: false` no está documentado: no lo
completes por tu cuenta.

Con `live.autoAsk` (encendido por omisión), el live-worker detecta solo las
preguntas técnicas de la reunión y las responde sin que nadie las pida: esas
respuestas llevan `auto: true` en `live/answers.jsonl`. Mientras se responde
algo, `live/asking.json` dice qué pregunta va (`{question, startedAt, auto}`);
una respuesta manual detiene a la automática.

Se configura con `recap config get|set`: `live.enabled`, `live.openWindow`,
`live.proposals`, `live.maxChunkSeconds`, `live.assistModel`, `live.autoAsk`,
`live.autoAskModel`, `live.autoAskMinSeconds` y `live.autoAskConcurrency`.
