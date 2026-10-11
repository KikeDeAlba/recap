---
name: recap-list
description: Lista las reuniones grabadas, o muestra la minuta de una
argument-hint: [id, parte del título o "last"]
allowed-tools: Bash(recap list:*), Bash(recap show:*)
disable-model-invocation: true
---

**Sin `$ARGUMENTS`**, lista las reuniones recientes:

!`recap list`

y muéstralas en una tabla corta (fecha, modo, estado, duración, título).

**Con `$ARGUMENTS`**, muestra esa reunión:

```
recap show "$ARGUMENTS"
```

Si tiene minuta, muéstrala tal cual. Si no, di en qué estado está y si alguna
etapa falló. Si el texto coincide con varias reuniones (`MEETING_AMBIGUOUS`),
lista las candidatas y pregunta cuál.
