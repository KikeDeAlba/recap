---
description: Rehace la minuta de una reunión dentro de la sesión, con indicaciones
argument-hint: [id o "last"] [indicaciones, p. ej. "enfócate en los riesgos"]
allowed-tools: Bash(recap prompt:*), Bash(recap save-summary:*), Bash(recap show:*), Read, Write
---

Rehaz la minuta de una reunión aquí mismo, en lugar del `claude -p` sin
supervisión del pipeline.

1. El primer token de `$ARGUMENTS` es la reunión (id, parte del id o `last`);
   si no parece un id, usa `last`. El resto son indicaciones del usuario.
2. Obtén las instrucciones completas, con la transcripción y la lista de
   capturas:

   ```
   recap prompt <reunión>
   ```

3. Síguelas al pie de la letra. Las rutas de las capturas son relativas al
   directorio que aparece en la primera línea; ábrelas con Read cuando el tema
   lo amerite. Aplica las indicaciones del usuario encima de esas
   instrucciones, sin romper la estructura de secciones.
4. Escribe la minuta, empezando por `## Resumen`, en un archivo del directorio
   temporal de la sesión, y guárdala:

   ```
   recap save-summary <reunión> <archivo>
   ```

Responde con los **Acuerdos** y **Pendientes** de la nueva minuta y la ruta de
`summary.md`.
