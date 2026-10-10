Vas a cerrar el registro de una reunión ya transcrita y resumida. Con la minuta y la transcripción de abajo, decide cómo queda documentada.

- Título actual del contador: «{{currentTitle}}»
- Proyecto actual del contador: {{currentProject}}
- Fecha: {{date}} · Duración: {{duration}} · Modo: {{mode}}
- Proyectos que existen en bita (elige solo de esta lista, con el nombre exacto):
{{projects}}
{{existingPage}}

Responde únicamente con un objeto JSON, sin texto antes ni después y sin bloque de código, con esta forma:

{"title": "...", "project": "..." | null, "pageTitle": "...", "pageMarkdown": "...", "backlog": [{"kind": "pending" | "finding", "title": "...", "body": "..."}]}

Reglas por campo:

- **title**: el tema real de la reunión, corto (máximo 80 caracteres), reconocible en Jira. Por ejemplo, «Reunión presencial: iniciativa de recompra con cupón post-entrega». Sin fecha.
- **project**: el nombre exacto de uno de los proyectos de la lista, solo si la conversación deja claro a cuál pertenece (se menciona el cliente, el producto o el sistema). Si hay duda, o si ninguno aplica, `null`. Nunca inventes un nombre.
- **pageTitle**: el título de la página de documentación, el tema sin la palabra «reunión». Por ejemplo, «Iniciativa de recompra con cupón post-entrega».
- **pageMarkdown**: el cuerpo de la página, en Markdown, sin título H1. Debe ser un documento técnico formal que explica **cómo es** lo que se trató, en presente:
  - Secciones `##` por tema: contexto y objetivo, cómo funciona o cómo se propone, decisiones tomadas y, si aplica, arquitectura, datos, costos o plan de pruebas, con las cifras y nombres que se dijeron.
  - Si hay un flujo o una arquitectura, puedes incluir un diagrama en un bloque `mermaid`. Solo con componentes que se mencionaron: si algo no se nombró, no lo supongas.
  - **Prohibido**: secciones de «Pendientes», «Próximos pasos», «Hallazgos», «Preguntas abiertas» o «Lo que falta»; eso va en `backlog`. Tampoco «se acordó con el usuario», «según lo solicitado», «decidimos», «creo que», primera ni segunda persona, ni comentarios sobre la grabación o la transcripción.
  - Entre 3 y 7 secciones. Nada que no esté en la minuta o en la transcripción.
- **backlog**: un ítem por cada pendiente (`kind: "pending"`, redactado como acción que empieza con verbo; en `body` el responsable, la fecha y el contexto si se mencionaron) y por cada pregunta abierta o riesgo (`kind: "finding"`). Títulos de una línea, sin numeración. Lista vacía si no hay ninguno.

<minuta>
{{summary}}
</minuta>

<transcripcion>
{{transcript}}
</transcripcion>
