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

El cerebro solo se consulta si la reunión tiene proyecto (nunca en `global`) y
gaze está registrado en el registro del kit con las capacidades `memory.search` y
`memory.write`.
Claude no ejecuta gaze: recap hace `gaze search --project=<P>` con la pregunta (o,
sin ella, con los últimos 300 caracteres de los últimos 30 s de la transcripción en vivo). Por diseño de gaze,
eso devuelve también notas de `global` y de los proyectos del mismo grupo de gaze:
Claude ve notas del proyecto, de su grupo y de `global`, nunca de otros proyectos.
recap lee el cuerpo completo de las 3 primeras notas y las pone, recortadas a 1200 caracteres y
escapadas como datos (no pueden salirse del bloque de notas), en el prompt. Si
esas notas responden, la fuente es de tipo `note`. Tras responder, recap guarda la
respuesta en gaze como nota `fact` (título = la pregunta, recortado a 200 caracteres (más `…`))
solo si `found` es true, cita al menos una fuente, ninguna es una nota del
cerebro y recap verifica todas (la página está en el árbol del proyecto, el
archivo existe en la raíz de docs o en un repo del proyecto, con la línea citada,
y el commit existe en un repo del proyecto). No se guarda si el prompt ya incluyó
notas del cerebro (solo se guarda lo hallado sin el cerebro), porque gaze fusiona o
reemplaza notas casi idénticas y podría pisar una nota escrita por una persona.
En el cuerpo, las páginas se citan con su título del árbol del proyecto y los
commits solo con sha y repo (sin etiquetas escritas por el modelo). Tampoco se
guarda una respuesta de más de 8000 caracteres, ni si la nota completa (título y
cuerpo, con el título de la reunión) trae secretos o datos personales: tarjetas
(también con CVV, vencimiento u otros separadores), llaves de acceso, llaves
privadas, correos, JWT, bearer tokens, tokens `sk_live_`/`github_pat_`/`npm_`,
credenciales en URLs, Basic auth, llaves de GitLab/Slack/`sk-` y credenciales como
`password`, `secret`, `token`, `api_key` (también `clave`/`contraseña`) seguidas de
`=`, `:` o `is`/`was`/`es`/`era`. Antes de escanear se normaliza el texto: los dígitos
no ASCII pasan a ASCII y se quitan los caracteres invisibles. La nota termina
con «Generada por recap a partir de la reunión «…» (fecha); sin revisión humana.».
Las consultas a gaze (y la comprobación de commits con `git cat-file`) vencen a los 10 s y el guardado a los 60 s; si gaze falta,
falla o vence, recap sigue sin el cerebro. `RECAP_NO_GAZE=1` lo apaga.

Con `live.autoAsk` (encendido por omisión), el live-worker detecta solo las
preguntas técnicas de la reunión y las responde sin que nadie las pida: esas
respuestas llevan `auto: true` en `live/answers.jsonl`. Mientras se responde
algo, `live/asking.json` dice qué pregunta va (`{question, startedAt, auto}`);
una respuesta manual detiene a la automática.

Se configura con `recap config get|set`: `live.enabled`, `live.openWindow`,
`live.proposals`, `live.maxChunkSeconds`, `live.assistModel`, `live.autoAsk`,
`live.autoAskModel`, `live.autoAskMinSeconds` y `live.autoAskConcurrency`.
