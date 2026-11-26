# Resultados 043 · Modelo y CI completo garantizados

## T1–T3 · Hook y validador (2026-11-26)
- `pnpm hooks:test` → 19 pruebas, 0 fallos (`node:test`, sin dependencias).
  - Cubren CA-1 a CA-4: alias `claude-opus-*`, celda `opus (sonnet)`, ruta con `..`, tarea inexistente, `fork` sin modelo, variable `CLAUDE_CODE_SUBAGENT_MODEL` y prompt fuera del registro.
  - Cubren CA-5: área crítica con ADV en sonnet, revisión final, celda ambigua, falta de la línea «Áreas críticas» y lectura de `ESTADO.md`.
- `pnpm specs:validar` sobre esta rama → `1 spec(s) abierta(s) con tasks.md, sin errores`.
- Por línea de comandos, con el JSON de entrada del hook:
  - `backend` sin `model` en T2 (sonnet): salida 0, `permitido`.
  - `devops` con `haiku` en T2: salida 2, `043: T2 de 043-modelo-y-ci-garantizados exige sonnet; pediste haiku. Relanza con model: "sonnet".`

## CA-7 (parte del hook) · sesión real
- En la sesión que implementó la 043 se lanzó `Agent(subagent_type: devops, model: haiku, prompt: "Tarea: …043…/tasks.md#T2 …")`.
- Claude Code lo rechazó con `PreToolUse:Agent hook error: … exige sonnet; pediste haiku`, y `agentes.log` registró `T2 devops haiku - bloqueado`.
- El hook se activó sin reiniciar la sesión.

## Pendiente
- T4: CI con el nivel 1 (`hooks:test`, `specs:validar`) y builds `--filter "<paquete>..."`. Espera a que la 029 esté en `main`.
- T6: PR en borrador con el CI completo en verde y verificación de un orquestador en una sesión nueva.
- Al fusionar las specs 041 y 032 (rama de otra conversación), su `spec.md` debe agregar la línea «Áreas críticas». Si no, `specs:validar` falla en el CI.
