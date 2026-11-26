# Spec 043 · Modelo y CI completo garantizados

Estado: aprobada (usuario 2026-11-26: P-1 a P-3 con la opción (a) recomendada).
Nivel de riesgo: D. No toca código de producción ni datos. El riesgo indirecto es un hook que bloquee trabajo legítimo o que deje pasar un modelo equivocado. Se cubre con las pruebas de CA-1 a CA-4.
Áreas críticas: ninguna.
Cubre: `docs/04-metodologia.md` §2.3, §3.1, §5 y §7 · `docs/prompt-orquestador.md` · `.claude/` · `.github/workflows/ci.yml` · `docs/specs/_plantilla/`.

## Objetivo
La spec 029 se hizo en 4,6 h con el método de la 042, pero dejó dos huecos. Primero, no se puede comprobar que su ronda adversarial y sus tareas críticas usaran Opus: los commits muestran el modelo del orquestador (Sonnet), no el de cada subagente. Segundo, su CI completo falló recién en el pull request: el CI liviano de la rama no compila `db` como lo hacen los jobs con base de datos, y `@contapp/correo` faltaba. Esta spec hace que el modelo de cada tarea se **verifique y quede registrado**, y que ninguna spec se cierre sin el **CI completo en verde**.

## Alcance

**Parte A · Modelo por tarea**
- A1. **Hook de lanzamiento**: antes de cada uso de la herramienta `Agent`, `.claude/settings.json` ejecuta `.claude/hooks/modelo-tarea.mjs`. Si el prompt nombra una tarea (`Tarea: docs/specs/NNN-*/tasks.md#Tn`), el hook calcula el modelo efectivo: el `model` pedido o, si falta, el del frontmatter del rol. Lo compara con la columna «Modelo» de esa fila. Si el modelo pedido es menor (haiku < sonnet < opus), **bloquea** y explica el motivo. Uno mayor se permite, porque es un escalamiento (§3).
- A2. **Roles que exigen tarea**: el hook bloquea un lanzamiento de `adversario` o `arquitecto` que no nombre tarea, porque sin tarea no puede saber qué modelo corresponde.
- A3. **Registro**: cada lanzamiento con tarea agrega una línea a `docs/specs/NNN-*/agentes.log` con fecha, tarea, rol, modelo efectivo, effort y resultado (permitido o bloqueado). Se commitea con la spec. Así se puede auditar después qué modelo hizo cada tarea.
- A4. **Validador de `tasks.md`** (`pnpm specs:validar`): la celda «Modelo» empieza con `opus`, `sonnet` o `haiku` (el rol secundario va entre paréntesis). Si la línea «Áreas críticas» de `spec.md` no dice «ninguna», toda tarea con `ADV` ✓ y toda revisión final del arquitecto debe ser `opus`. Corre en el nivel 1 del CI.

**Parte B · CI completo antes de cerrar**
- B1. **Builds con dependencias**: los jobs de nivel 2 compilan con `pnpm --filter "<paquete>..." build` en vez de paquete por paquete, para que una dependencia nueva entre sola (el defecto de la 029).
- B2. **Regla de cierre**: la tarea de verificación final abre el pull request de la spec como **borrador**, lo que dispara el CI completo. La spec solo se cierra con esa corrida en verde. La regla de «una corrida en verde» (042 B4) pasa a decir «una corrida del **CI completo** en verde».
- B3. **Documentación**: `04-metodologia.md` (§3.1, §5, §7), `_plantilla/spec.md` (línea «Áreas críticas»), `_plantilla/tasks.md` (referencia de tarea, modelo de una sola palabra, PR en borrador en la verificación) y `prompt-orquestador.md` (formato `Tarea: …#Tn` y `model` explícito).

## Fuera de alcance
- Cambiar el modelo del orquestador, que sigue en Sonnet (042).
- Revisar o rehacer la 029. Su arreglo de CI va en su propia rama, y quien la desarrolla registra en su `resultados.md` qué modelo hizo cada tarea.
- Medir tokens directamente.

## Decisiones
- D1 **Bloquear, no avisar** (P-2): un aviso se puede ignorar sin que nadie lo note, y eso es justo lo que pasó en la 029.
- D2 **Subir de modelo siempre se permite**: el escalamiento de §3 sigue igual, y queda anotado en el registro.
- D3 **Sin dependencias nuevas**: el hook y el validador son Node puro (`node:test`) y no dependen del monorepo, para que funcionen antes de `pnpm install`.
- D4 Si el hook no puede leer `tasks.md` o la fila de la tarea, **bloquea** con un mensaje claro. Esto solo aplica cuando el prompt nombra una tarea.

## Criterios de aceptación
- [ ] CA-1: Un lanzamiento de `adversario` con `model: sonnet` para una tarea marcada `opus` se bloquea con un mensaje que nombra la tarea y el modelo exigido. Con `opus` u omitiendo `model` (el frontmatter dice opus) se permite.
- [ ] CA-2: Un lanzamiento de `backend` sin `model` para una tarea marcada `opus` se bloquea, porque el frontmatter es sonnet. Con `model: opus` se permite. Un `tester` con `opus` en una tarea `sonnet` se permite y queda registrado como escalamiento.
- [ ] CA-3: `adversario` o `arquitecto` sin referencia de tarea se bloquea. Cualquier otro rol sin tarea pasa sin registro. Una tarea inexistente se bloquea.
- [ ] CA-4: Cada lanzamiento con tarea deja exactamente una línea en el `agentes.log` de su spec, sin el texto del prompt.
- [ ] CA-5: `pnpm specs:validar` falla con una spec de prueba que declara un área crítica y tiene una tarea ADV en `sonnet`, y pasa sobre todas las specs abiertas de `main`.
- [ ] CA-6: Los jobs de nivel 2 compilan con `--filter "<paquete>..."`. Una corrida completa en `main` sale en verde y con el mismo conjunto de pruebas de antes.
- [ ] CA-7: La metodología, las plantillas y el prompt del orquestador reflejan A1 a A4 y B2. Una sesión de prueba del orquestador lanza una tarea con el formato nuevo y el hook la registra.
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 042 (hecha). Se aplica después de fusionar la 029, para no chocar en `ci.yml` con su arreglo de build.
- Externas: el hook `PreToolUse` de Claude Code, que recibe `tool_input` con `subagent_type`, `model` y `prompt`, y bloquea con salida 2.

## Preguntas abiertas
Ninguna. Decisiones del usuario (2026-11-26), todas la opción (a): **P-1** CI completo con el pull request en borrador · **P-2** el hook bloquea · **P-3** `agentes.log` commiteado en la carpeta de la spec.
