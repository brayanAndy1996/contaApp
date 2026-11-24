# Tareas 042 · Acelerar el desarrollo

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Spec, plan y tareas | arquitecto | opus | — | — | — | [x] |
| T2 | Método y plantillas (B2, B3, B4) | devops | sonnet | T1 | — | — | [x] |
| T3 | Línea base para CA-2: lista de pruebas y cobertura actuales | devops | haiku | 028 en `main` | — | — | [ ] bloqueada |
| T4 | Config única de cobertura en backend y worker (A1) | devops | sonnet | T3 | — | — | [ ] bloqueada |
| T5 | `ci.yml`: jobs paralelos, paths-ignore, concurrency, dos niveles (A2–A5) | devops | sonnet | T4 | — | — | [ ] bloqueada |
| T6 | Reporter compacto (B5) y regla A6 en el método | devops | haiku | T4 | — | — | [ ] bloqueada |
| T7 | Migrar `ESTADO.md` (B1, B6) | devops | sonnet | 028 en `main` ∥ | — | — | [ ] bloqueada |
| T8 | Verificar CA-1 a CA-6 y cerrar | devops | sonnet | T5–T7 | — | — | [ ] bloqueada |

## T2 · Método y plantillas
- **Contexto**: `docs/04-metodologia.md` (§1.3, §2.3, §5, §7), `docs/specs/_plantilla/`, `spec.md#alcance` (B2–B4).
- **Hecho cuando**: el método y las plantillas reflejan B2, B3 y B4 (CA-6 parcial).

## T3 a T8
- Se detallan al desbloquearse, con `plan.md` como contrato. Resultados en `resultados.md`.
