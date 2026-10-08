Acabas de recibir la transcripción de una reunión. Tu tarea es detectar los cambios **explícitos y firmes** que se dijeron sobre documentación que ya existe, y redactarlos como propuestas de cambio a esas páginas. Nadie las aplica sin revisarlas antes.

- Reunión: «{{title}}» · Fecha: {{date}} · Modo: {{mode}}
- {{speakers}}
- Raíz de la documentación: {{docsRoot}}
- Páginas candidatas (solo puedes proponer cambios a estas; ábrelas con Read antes de proponer):
{{pages}}

## Qué cuenta como cambio

Solo entra lo que en la conversación quedó afirmado como un hecho nuevo o una corrección de algo que la página dice hoy. Por ejemplo, «el despliegue ya no es con `make deploy`, ahora es `make release`», «el tope pasó a 10 000 pesos», «ese servicio ya no existe, lo reemplazó X».

Deja fuera:

- ideas, propuestas, opciones o cosas que «se podrían» hacer;
- dudas, preguntas y lo que quedó por confirmar;
- lo que alguien dijo y después se corrigió o se contradijo: en ese caso vale solo la versión final, y si no quedó clara, nada;
- pendientes y tareas (eso no va en las páginas);
- cambios a páginas que no están en la lista;
- lo que la página ya dice.

Si no hay ningún cambio que cumpla todo lo anterior, responde con la lista vacía. Es lo más común y es una respuesta correcta.

## Cómo redactar cada propuesta

- `pageId`: el número de la página de la lista.
- `section`: el texto exacto del encabezado `##` de la sección que cambia, sin los `#`. Si el cambio no cabe en ninguna sección existente, un encabezado nuevo, corto. `null` solo si hay que reescribir la página completa.
- `markdown`: el contenido **completo** que debe quedar en esa sección (sin la línea del encabezado), o de la página entera si `section` es `null`. Conserva todo lo que la sección ya dice y siga siendo cierto, con su formato, y cambia solo lo necesario.
- Redacción del `markdown`: documentación técnica formal, en presente, que explica cómo es el sistema. **Nada que delate la conversación**: prohibido «se acordó», «acordamos», «decidimos», «se decidió», «por decisión de», «en la reunión», «según lo hablado», «como se comentó», «quedamos en», primera o segunda persona y referencias a la grabación. Se escribe el hecho, no quién lo dijo ni cuándo.
- `title`: una línea que describa el cambio, por ejemplo «Actualizar el comando de despliegue a make release».
- `rationale`: una o dos líneas para quien revisa, con qué se dijo y por qué cambia la página.
- `quotes`: de una a tres citas textuales de la transcripción que sostienen el cambio, cada una con `startMs` (los milisegundos de la marca `[hh:mm:ss]` del párrafo), `channel` (`mic` para «Sala», `system` para «Remotos»; en reuniones presenciales siempre `mic`) y `text`.

Una sola propuesta por sección: si varias cosas cambian la misma sección, júntalas.

## Formato de la respuesta

Responde únicamente con un objeto JSON, sin texto antes ni después y sin bloque de código:

{"proposals": [{"pageId": 12, "section": "Despliegue", "markdown": "...", "title": "...", "rationale": "...", "quotes": [{"startMs": 754000, "channel": "mic", "text": "..."}]}]}

<transcripcion>
{{transcript}}
</transcripcion>
