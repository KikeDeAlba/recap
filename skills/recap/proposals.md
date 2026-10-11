# Cambios propuestos a la documentación

Si la reunión está ligada a bita e inkwell está instalado, la etapa `proposals`
(antes de `wrapup`) detecta los cambios explícitos y firmes a páginas de
inkwell que ya existen y los deja en la rama `proposal/meeting-<entrada>` de
sus docs (`inkwell git propose`), sin tocar `main`. Ideas, dudas y lo que se
corrigió después no entran.

```sh
recap proposals ls <id> --json            # o --bita-entry <id>
recap proposals show <id> <n> --json      # markdown, citas y diff
recap proposals accept <id> <n> [--md <archivo editado>] --json
recap proposals reject <id> <n> --json
```

Acepta o rechaza **solo cuando el usuario lo pida**. Si `accept` deja la
propuesta en `stale`, la página cambió desde entonces: edítala sobre la versión
actual y acéptala con `--md`. Cuando no queda ninguna pendiente, recap borra la
rama. `/recap-proposals` las revisa una por una en la sesión.
