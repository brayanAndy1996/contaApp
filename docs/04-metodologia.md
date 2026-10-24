# ContApp — Metodología de desarrollo (v0.1)

Fecha: 2026-10-24 · Aplica a todo el código del monorepo descrito en [03-arquitectura.md](03-arquitectura.md).

**Resumen**
- Un **orquestador** (conversación principal) coordina **roles** que corren como subagentes: arquitecto, backend, frontend, tester, adversario, devops (§3). Prompt de arranque: [prompt-orquestador.md](prompt-orquestador.md).
- **SDD** (Spec-Driven Development) **siempre**: nada se programa sin una spec.
- **TDD** y **pruebas adversariales** **solo donde hay impacto**, según un nivel de riesgo (A/B/C/D).
- Cada tarea va al **modelo más barato que la resuelve bien**: Opus 5.5 high, Sonnet 5.5 high o Haiku 5.5 max.
- Reglas explícitas de **eficiencia de tokens** (§7).

---

## 1. SDD — Spec-Driven Development

### 1.1 Artefactos
Cada funcionalidad vive en `docs/specs/NNN-nombre/`:

| Archivo | Qué responde | Límite | Plantilla |
|---|---|---|---|
| `spec.md` | **Qué** y **por qué**: alcance, RF/HU que cubre, criterios de aceptación, nivel de riesgo, fuera de alcance | ~1 página | [_plantilla/spec.md](specs/_plantilla/spec.md) |
| `plan.md` | **Cómo**: archivos a crear o tocar, contratos (tipos, endpoints, tablas), decisiones | ~1 página | [_plantilla/plan.md](specs/_plantilla/plan.md) |
| `tasks.md` | **Pasos**: tareas atómicas con modelo, TDD/ADV, contexto exacto y criterio de hecho | 1 línea + detalle corto por tarea | [_plantilla/tasks.md](specs/_plantilla/tasks.md) |

- La spec **referencia** requerimientos por ID (RF-082, HU-24); no los copia.
- Specs de nivel **D** pueden omitir `plan.md` (el plan cabe en `tasks.md`).

### 1.2 Estados de una spec
`borrador` → `aprobada` (el usuario la aprueba) → `en curso` → `verificada` → `hecha`

**Puerta humana**: el usuario aprueba toda spec de nivel **A o B** antes de implementar. Las de nivel C/D se aprueban en bloque.

### 1.3 Flujo por spec (por roles)

Toda spec se desarrolla con los **roles** de §3. El **orquestador** (conversación principal) no programa: lanza a cada rol como subagente, en orden, y lleva el tablero `docs/specs/ESTADO.md`.

| Paso | Qué se hace | Rol · modelo | A | B | C | D |
|---|---|---|---|---|---|---|
| 1. Especificar | `spec.md` desde RF/HU, nivel de riesgo | arquitecto · opus (A) / sonnet (B, C) · devops · haiku (D) | ✓ | ✓ | ✓ | ✓ |
| 2. Aprobar | Revisa y aprueba la spec | **Usuario** | ✓ | ✓ | en bloque | en bloque |
| 3. Planificar | `plan.md` + `tasks.md` con rol, modelo, TDD, ADV y contexto por tarea | igual que paso 1 | ✓ | ✓ | ✓ (sin plan) | ✓ (sin plan) |
| 4. Pruebas primero | Pruebas desde los criterios; confirmar rojo | tester · sonnet | ✓ | ✓ | — | — |
| 5. Implementar | Verde + refactor | backend / frontend / devops · según tarea | ✓ | ✓ | ✓ (+ pruebas mínimas) | ✓ |
| 6. Atacar | Ronda(s) adversarial(es) | adversario · opus | ✓ | solo si la spec lo pide | — | — |
| 7. Corregir | Hacer pasar los `*.adv.spec.ts` | backend / frontend · mismo modelo del paso 5 | ✓ | si hubo 6 | — | — |
| 8. Verificar | Suite del paquete + criterios con evidencia | tester · sonnet (A/B) · devops · haiku (C/D) | ✓ | ✓ | ✓ | ✓ |
| 9. Revisión final | Contra la spec | arquitecto · opus | ✓ | — | — | — |
| 10. Cerrar | Commit, `tasks.md` y `ESTADO.md` | devops · haiku | ✓ | ✓ | ✓ | ✓ |

- Las pruebas de los pasos 4 y 8 las hace un rol **distinto** al que implementa: el tester valida contra la spec, no contra el código.
- Las tareas independientes dentro de un paso (por ejemplo, backend y frontend contra un contrato ya definido) pueden ir **en paralelo**.

---

## 2. Nivel de riesgo: cuándo TDD y cuándo adversarial

### 2.1 Cómo se asigna el nivel
Para cada spec (y si hace falta, para cada tarea) responder:

1. ¿Un error aquí produce un **monto, clasificación o archivo tributario incorrecto**?
2. ¿Un error aquí puede **exponer datos o credenciales** de otro estudio, cliente o usuario?
3. ¿El error sería **difícil de notar a simple vista** por el contador?
4. ¿Tiene **muchas combinaciones de entrada** o concurrencia?

| Respuestas "sí" | Nivel | Pruebas |
|---|---|---|
| (1) o (2) **y** al menos otra | **A · Crítico** | **TDD + Adversarial** |
| Cualquier otra combinación con 2+ | **B · Alto** | **TDD** (adversarial solo si la spec lo pide en un punto concreto) |
| 1 | **C · Normal** | Pruebas después: 1 caso feliz + 1 de error por comportamiento público |
| 0 | **D · Bajo** | Sin pruebas dedicadas; lo cubren typecheck, lint y los E2E de historias |

### 2.2 TDD (niveles A y B)
- Las pruebas se escriben **desde los criterios de aceptación** de la spec, antes del código, y se confirma que fallan.
- Los **casos reales** documentados son pruebas obligatorias en su módulo:
  - San Juan con ISC 770 en DG.
  - Mixta con base 21.48 e IGV 1.61, que se separa en 8.97 + 12.51 según el XML (sin XML: estimado 8.94, rango 8.92–8.97).
  - Redondeo en una factura en USD.
  - Boleta 291 faltante.
  - Glosa "zapatilla".
- Ciclo corto: rojo → verde → refactor. No se escribe código que ninguna prueba exija.
- Se prueba el comportamiento público, no detalles internos (para no reescribir pruebas en cada refactor).

### 2.3 Pruebas adversariales (nivel A)
**Objetivo:** que un agente **distinto** al que implementó intente romper el código con entradas y escenarios que el implementador no consideró.

**Reglas**
- Lo ejecuta el rol `adversario` (Opus 5.5 high). Nunca el mismo agente o sesión que implementó.
- Primero **caja negra** (solo spec + interfaz pública) y luego **caja blanca** (lee la implementación).
- **Solo escribe pruebas**, en `*.adv.spec.ts`. No modifica código de producción.
- Cada prueba que falla es un hallazgo. El implementador lo corrige o la spec se ajusta con aprobación del usuario.
- **Presupuesto:** máximo 2 rondas y unas 15 pruebas por ronda. Se termina antes si una ronda no produce fallos nuevos.
- Las pruebas adversariales que pasan **se quedan** en el repo como regresión.

**Catálogo de ataques por tipo de módulo**
| Módulo | Ataques |
|---|---|
| Dinero / reglas / prevalidación | 0, negativos, 0.005, 0.015, montos enormes, USD con tipo de cambio de 3 o más decimales, IGV al 10 % vs 18 %, base 0 con IGV > 0, filas con todos los tributos, notas de crédito (montos negativos), redondeos que se acumulan |
| Formatos TXT/ZIP | Caracteres especiales en razón social (ñ, tildes, `|`, saltos de línea), campos vacíos, longitudes máximas, periodo de otro año |
| Aislamiento (RLS) | Cambiar `tenantId`/`clienteId` en la URL y el cuerpo, transacción sin `set_config`, `set_config` de otro tenant, consultas en lote mezclando IDs |
| Permisos y alcance | Rol asistente llamando endpoints de aprobación, usuario desactivado con sesión viva, cliente desasignado durante la sesión |
| Cifrado | AAD cruzada (copiar el cifrado a otra fila), nonce repetido, llave equivocada, búsqueda del secreto en logs y errores |
| Límites del plan | Dos importaciones simultáneas que juntas superan el límite, reactivar un cliente archivado en el límite |
| Cola / despachador | Un tenant con 1,000 trabajos vs otro con 1, mismo RUC en paralelo, worker que muere a mitad del trabajo |
| Parsers (XML, Excel) | XXE y entidades externas, XML gigante, XML de otro comprobante, fórmulas en celdas (`=HYPERLINK…`), CSV injection en exportaciones |

---

## 3. Roles y modelos

### 3.1 Roles (subagentes en `.claude/agents/`)

| Rol | Modelo por defecto | Responsabilidad | No hace |
|---|---|---|---|
| **orquestador** | conversación principal (Sonnet 5.5 high recomendado) | Elige la próxima spec, lanza roles en orden, pasa la puerta de aprobación al usuario, escala, lleva `ESTADO.md` | Programar o escribir specs |
| **arquitecto** | Opus · high | `spec.md`, `plan.md`, `tasks.md`; decisiones de diseño; revisión final de nivel A | Código de producción |
| **backend** | Sonnet · high | `apps/backend`, `apps/worker`, `packages/*` | Tocar `apps/frontend`; editar pruebas del tester o del adversario |
| **frontend** | Sonnet · high | `apps/frontend` | Lógica de negocio; inventar endpoints |
| **tester** | Sonnet · high | Pruebas primero (TDD), integración, E2E, verificación de criterios | Código de producción |
| **adversario** | Opus · high | Pruebas adversariales `*.adv.spec.ts` (nivel A) | Código de producción |
| **devops** | Haiku · max | Scaffolding, configuración, CI, docker, fixtures, seeds, git, correr checks, specs de nivel D | Decisiones de diseño |

**Modelo por tarea**: el rol define el modelo **por defecto**, pero el modelo efectivo es el que indica `tasks.md`. Así, `backend` usa Opus en el núcleo crítico (dinero, reglas, cifrado, RLS, despachador) y Sonnet en el resto; `frontend` usa Haiku en pantallas mecánicas. El orquestador lanza el subagente con `subagent_type = rol`, y `model` y `effort` según la tarea (Opus → high, Sonnet → high, Haiku → max).

### 3.2 Criterios de modelo

| Modelo | Esfuerzo | Cuándo |
|---|---|---|
| **Opus 5.5** | high | Diseño y decisiones con ambigüedad · specs y planes de nivel A · implementación del núcleo crítico (dinero, reglas, prevalidación, formatos SUNAT, cifrado, RLS, despachador) · **todas** las pruebas adversariales · bugs que Sonnet no resolvió en 2 intentos · revisión final de specs A |
| **Sonnet 5.5** | high | Implementar siguiendo un plan existente · módulos NestJS con guards y repositorios · pantallas Next.js (grilla, modal, formularios) · procesadores del worker con adaptadores mock · pruebas de integración · specs y planes de nivel B/C · revisión contra spec |
| **Haiku 5.5** | max | Scaffolding (CLI de Nest, Next, shadcn) · configuración (tsconfig, eslint, turbo, docker-compose) · renombres y cambios mecánicos · fixtures y seeds · plantilla Excel · textos de UI · correr lint, tipos y pruebas y **resumir solo los fallos** · actualizar estados en `tasks.md` · specs de nivel D |

### 3.3 Reglas de escalamiento
- **Haiku** falla 1 vez en la misma tarea → el orquestador relanza el **mismo rol** con **Sonnet**.
- **Sonnet** falla 2 veces o la tarea resulta ambigua → mismo rol con **Opus**; si es un problema de diseño, pasa al **arquitecto**.
- **Opus** decide y planifica; si el resultado es mecánico, el arquitecto lo marca en `tasks.md` para un rol con Sonnet o Haiku.
- No se escala "por si acaso": el modelo de `tasks.md` es el punto de partida. Cada escalamiento se anota en la tarea.

---

## 4. Plan inicial de specs del MVP (R1)

| Spec | Contenido | RF / HU | Nivel | Spec y plan | Implementación | Pruebas |
|---|---|---|---|---|---|---|
| 001-fundaciones | Monorepo, tooling, docker-compose, CI base, git | RNF-080, 081, 084 | D | devops·haiku | devops·haiku | devops·haiku (checks) |
| 002-db-rls | Esquema base, roles PG, `withTenant`, políticas RLS, prueba de aislamiento | RNF-001, 082 · HU-40 | **A** | arquitecto·opus | backend·opus | tester·sonnet + adversario·opus |
| 003-cifrado | Cifrado híbrido, KeyProvider local, auditoría de descifrado | RNF-002–004 · RF-033 | **A** | arquitecto·opus | backend·opus | tester·sonnet + adversario·opus |
| 004-auth | Login, sesión por cookie, bloqueo, recuperación, multi-estudio | RF-010–015 · HU-04 | **A** | arquitecto·opus | backend·sonnet + frontend·sonnet | tester·sonnet + adversario·opus |
| 005-acceso | Roles, permisos, asignación, guards de alcance | RF-020–028 · HU-03, 07, 08 | **A** | arquitecto·opus | backend·sonnet + frontend·sonnet | tester·sonnet + adversario·opus |
| 006-planes | Planes y límites de RUCs/usuarios transaccionales | RF-001–004 · HU-01, 02 | B | arquitecto·sonnet | backend·sonnet + frontend·haiku | tester·sonnet |
| 007-clientes | CRUD, perfil fiscal, importación Excel, credenciales (UI) | RF-030–039 · HU-06, 09, 10 | B | arquitecto·sonnet | backend·sonnet + frontend·sonnet | tester·sonnet |
| 008-cola | Colas BullMQ, despachador round-robin, locks por RUC, SSE | RF-040–045 | **A** | arquitecto·opus | backend·opus | tester·sonnet + adversario·opus |
| 009-adaptadores-mock | Mock SIRE, SOL, `MockXmlProvider`, fixtures | RF-097a/b | C | arquitecto·sonnet | backend·sonnet + devops·haiku (fixtures) | backend (mínimas) |
| 010-dominio-dinero | Money, redondeo SUNAT, movimiento entre columnas, cuadre | RNF-050, 051 | **A** | arquitecto·opus | backend·opus | tester·sonnet + adversario·opus |
| 011-motor-reglas | R-ISC, R-MIX, R-RED, R-NEW, hallazgos y sugerencias | RF-080–085 · HU-23, 24 | **A** | arquitecto·opus | backend·opus | tester·sonnet + adversario·opus |
| 012-prevalidacion-archivos | Prevalidación SUNAT, formatos TXT versionados, ZIP | RF-088, 100–103 · HU-25, 26 | **A** | arquitecto·opus | backend·opus | tester·sonnet + adversario·opus |
| 013-ventas | Descarga/importación RVIE, grilla, correlatividad | RF-050–056 · HU-11, 12 | B | arquitecto·sonnet | backend·sonnet + frontend·sonnet | tester·sonnet |
| 014-compras-backend | Propuesta inmutable, versiones de fila, clasificación, exclusión, agregar | RF-060–071 | B | arquitecto·sonnet | backend·sonnet | tester·sonnet |
| 015-compras-frontend | Grilla editable tipo Excel, resumen, acciones masivas | HU-14–19 | C | arquitecto·sonnet | frontend·sonnet | frontend (mínimas) |
| 016-lupa-xml | Parser UBL, endpoint de detalle, modal, subida manual | RF-090–099 · HU-20–22 | B (+ADV en el parser) | arquitecto·sonnet | backend·sonnet + frontend·sonnet | tester·sonnet + adversario·opus (parser) |
| 017-auditoria-notif | Auditoría solo-inserción, notificaciones en la app | RF-150, 152, 160 | B | arquitecto·sonnet | backend·sonnet + frontend·haiku | tester·sonnet |
| 018-e2e-r1 | E2E de las historias R1 con adaptadores mock | — | C | arquitecto·sonnet | — | tester·sonnet |

**Orden:** 001 → 002 → 003 → (004, 010 en paralelo) → 005 → (006, 008, 011) → 007 → 009 → 012 → 013, 014 → 015, 016 → 017 → 018

---

## 5. Definición de hecho (DoD)

| Nivel | Requisitos |
|---|---|
| **A** | Pruebas TDD verdes · casos reales cubiertos · ronda(s) adversarial(es) cerradas sin fallos abiertos · cobertura del módulo ≥ 90 % · revisión de Opus contra la spec · usuario informado de los hallazgos |
| **B** | Pruebas TDD verdes · casos reales cubiertos si aplica · revisión de Sonnet contra la spec |
| **C** | 1 caso feliz + 1 de error por comportamiento público · typecheck y lint limpios |
| **D** | typecheck y lint limpios · la app levanta |
| **Todos** | Criterios de aceptación con evidencia · `tasks.md` actualizado · sin secretos en el código ni en logs |

---

## 6. Convenciones de trabajo

- **Ramas**: `spec/NNN-nombre`. Un commit por tarea (`feat(011): R-MIX separa gravado y no gravado`). Conventional Commits.
- **Pruebas**: `*.spec.ts` (unitarias/integración), `*.adv.spec.ts` (adversariales), `tests/e2e/*.e2e.ts`.
- **Nombres**: dominio en español (`comprobante`, `hallazgo`, `periodo`), infraestructura técnica en inglés cuando es el término estándar (`controller`, `repository`, `provider`).
- **Montos**: siempre `Money`/`decimal.js`. Un `number` para dinero se considera bug.
- El repositorio aún no está inicializado con git; se hace en la spec 001.

---

## 7. Eficiencia de tokens

| # | Regla |
|---|---|
| 1 | **`CLAUDE.md` corto** (convenciones + punteros). Los docs se leen **por sección**, no completos. |
| 2 | Cada tarea de `tasks.md` lista su **Contexto**: los archivos exactos a leer. El agente no explora fuera de esa lista salvo que esté bloqueado. |
| 3 | Specs y planes de **~1 página**; se referencian RF/HU por ID en lugar de copiarlos. |
| 4 | TDD solo en niveles A/B; adversarial solo en A. Los niveles C/D no pagan ese costo. |
| 5 | Pruebas **filtradas** al paquete o archivo afectado mientras se trabaja; suite completa solo al cerrar la spec. |
| 6 | La salida de pruebas y lint la resume **Haiku**: solo fallos, con archivo y línea. |
| 7 | El código repetitivo se genera con **CLI** (`nest g`, `shadcn add`, `drizzle-kit generate`), no escrito por el modelo. |
| 8 | Las tareas mecánicas similares se **agrupan** en una sola sesión de Haiku. |
| 9 | Un subagente recibe **ruta de spec + ID de tarea**, no el contexto repetido. Solo se lanza si la tarea es independiente. |
| 10 | No releer archivos ya leídos en la sesión; ediciones puntuales en vez de reescribir archivos. |
| 11 | Al terminar una spec se abre una **sesión nueva** para la siguiente, en vez de arrastrar un historial largo. |
| 12 | El adversarial tiene **presupuesto fijo** (2 rondas / ~15 pruebas). |
