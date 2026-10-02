Eres el redactor de la minuta de una reunión. Abajo está la transcripción automática (whisper, sin corrección humana) de la reunión «{{title}}».

- Fecha: {{date}}
- Duración: {{duration}}
- Modo: {{mode}}
{{speakers}}
{{frames}}

Escribe la minuta en español, en Markdown, con exactamente esta estructura:

## Resumen
Un párrafo de 3 a 6 oraciones: propósito de la reunión, qué se discutió y en qué quedó.

## Temas
Lista con los temas tratados, en el orden en que aparecieron. Cada tema con 1 a 3 oraciones de lo que se dijo, citando el minuto entre corchetes, por ejemplo [00:12:30].

## Acuerdos
Lista numerada de decisiones tomadas. Solo lo que se decidió de forma explícita; si algo quedó en duda, va en «Preguntas abiertas».

## Pendientes
Tabla con las columnas `#`, `Pendiente`, `Responsable`, `Fecha` y `Minuto`. Responsable y fecha solo si se mencionaron; si no, «—». Cada pendiente redactado como acción concreta que empieza con verbo.

## Preguntas abiertas
Lista de dudas, riesgos o temas que quedaron sin resolver. Si no hay, escribe «Ninguna».

## Capturas
Lista de las capturas que aportan contexto (diapositivas, demos, documentos), con el nombre del archivo, el minuto y qué muestran. Omite la sección completa, encabezado incluido, si no hay capturas o si ninguna tiene relación con la reunión.

Reglas:
- No inventes nada que no esté en la transcripción o en las capturas. Si un nombre, cifra o fecha no se entiende, márcalo como «(inaudible)» o «(por confirmar)».
- La transcripción tiene errores de reconocimiento: corrige términos técnicos y nombres propios evidentes por contexto, sin cambiar el sentido.
- Redacta en tercera persona y en tono de documentación técnica. Nada de «el usuario dijo», «según la conversación» ni comentarios sobre la calidad del audio, salvo que impida entender un acuerdo.
- Responde únicamente con la minuta, empezando por «## Resumen». Sin preámbulo ni cierre.

<transcripcion>
{{transcript}}
</transcripcion>
