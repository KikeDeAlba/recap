# En vivo

Mientras se graba, recap transcribe por tramos de 5 a 20 s en
`live/transcript.jsonl` (una línea `{startMs, endMs, channel, text}`; `mic` es
Sala y `system` Remotos). Es aproximada: la transcripción de después del stop
(`transcript.md`) sigue siendo la fuente de verdad.

Para responder una pregunta que hicieron en la reunión, recap busca en este
orden: el cerebro de gaze, las páginas de inkwell, Grep en la raíz de docs y los
repos del proyecto (`bita project repo ls`). Sin inkwell se salta las páginas;
sin gaze, el cerebro; sin ninguno responde solo con los repos:

```sh
recap ask --active --json                              # la última pregunta de la transcripción
recap ask --active --question "¿cómo se despliega X?" --json
recap ask --meeting <id> --question "..." --json-stream   # eventos question/progress/delta/source/done
recap ask --sources --project <p> --json               # qué consultaría (incluye gaze y sus notas), sin llamar a claude
```

La respuesta lleva `found` y `sources` (página, `archivo:línea` o commit) y se
guarda en `live/answers.jsonl`. Con `found: false` no está documentado: no lo
completes por tu cuenta.

El cerebro solo se consulta si la reunión tiene proyecto (nunca en `global`). Si
sus notas responden, la fuente es de tipo `note`. Tras responder, recap guarda la
respuesta en gaze como nota `fact` solo si `found` es true, cita al menos una
fuente verificable (página, archivo o commit) y ninguna fuente es una nota del
cerebro; gaze fusiona los casi duplicados. Si gaze falta o falla, todo sigue como
antes; `RECAP_NO_GAZE=1` lo apaga.

Con `live.autoAsk` (encendido por omisión), el live-worker detecta solo las
preguntas técnicas de la reunión y las responde sin que nadie las pida: esas
respuestas llevan `auto: true` en `live/answers.jsonl`. Mientras se responde
algo, `live/asking.json` dice qué pregunta va (`{question, startedAt, auto}`);
una respuesta manual detiene a la automática.

Se configura con `recap config get|set`: `live.enabled`, `live.openWindow`,
`live.proposals`, `live.maxChunkSeconds`, `live.assistModel`, `live.autoAsk`,
`live.autoAskModel`, `live.autoAskMinSeconds` y `live.autoAskConcurrency`.
