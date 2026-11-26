# Tareas 032 · Enviar a SUNAT y seguir el ticket

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A. Flujo 04 §1.3. Rama `spec/032-envio-sire-ticket` desde `main` **después** de 041 hecha y de la spec de formatos oficiales (P-1). Requiere P-1 a P-10 resueltas. Todo contra mock y servidores falsos; el único contacto real con SUNAT es T22 (piloto con el usuario).

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Pruebas del puerto `SireEscritura`, mock, TUS y adaptador http con servidor TUS falso (rojo) | tester | sonnet | 041 ∥ T2–T4 | ✓ | — | [ ] |
| T2 | Pruebas de BD: `envio_sire`, único no final, confirmación de un solo uso, bandera, estado `enviado`, RLS, grants (rojo) | tester | sonnet | — ∥ T1, T3, T4 | ✓ | — | [ ] |
| T3 | Pruebas de contratos: permiso, acciones de auditoría, esquemas `shared`, catálogo de la cola (rojo) | tester | sonnet | — ∥ T1, T2, T4 | ✓ | — | [ ] |
| T4 | Pruebas del worker: enviar (R-3 incierto), consultar diferido, aceptar, preliminar, interruptor (rojo) | tester | sonnet | T3 ∥ T5 | ✓ | — | [ ] |
| T5 | Pruebas HTTP del backend: preparar/confirmar, 409/422/403/404, doble clic, R-7, verificar (rojo) | tester | sonnet | T3 ∥ T4 | ✓ | — | [ ] |
| T6 | Pruebas de componentes: botón, modal de doble confirmación, estado por SSE, errores (rojo) | tester | sonnet | T3 ∥ T4, T5 | ✓ | — | [ ] |
| T7 | `SireEscritura`, mock, `tus.ts`, `sire-escritura.http.ts` | backend | opus | T1 ∥ T8, T9 | ✓ | — | [ ] |
| T8 | Migración, esquema drizzle y `packages/db/src/envios/` | backend | opus | T2 ∥ T7, T9 | ✓ | — | [ ] |
| T9 | `shared`, permiso, auditoría y catálogo de la cola | backend | sonnet | T3 ∥ T7, T8 | ✓ | — | [ ] |
| T10 | Worker: procesadores y `SIRE_ESCRITURA` | backend | opus | T4, T7, T8, T9 ∥ T11, T12 | ✓ | — | [ ] |
| T11 | Backend: módulo `envios`, R-7 en archivos/compras/ventas, bandera en `plataforma` | backend | sonnet | T5, T8, T9 ∥ T10, T12 | ✓ | — | [ ] |
| T12 | Frontend: envío dentro de la pantalla del archivo | frontend | sonnet | T6, T9 ∥ T10, T11 | ✓ | — | [ ] |
| T13 | Ronda adversarial 1: doble envío, confirmación reusada o ajena, aislamiento, permisos, interruptor a mitad, secretos | adversario | opus | T10, T11 | — | ✓ | [ ] |
| T14 | Pruebas de las correcciones de la ronda 1 (rojo) | tester | sonnet | T13 | ✓ | — | [ ] |
| T15 | Corregir hallazgos de la ronda 1 | backend | opus | T14 | — | — | [ ] |
| T16 | Ronda adversarial 2: TUS (Location hostil, cortes, respuestas raras), reporte de errores (ZIP, texto hostil), estados desconocidos, concurrencia del seguimiento | adversario | opus | T15 | — | ✓ | [ ] |
| T17 | Pruebas de las correcciones de la ronda 2 (rojo) | tester | sonnet | T16 | ✓ | — | [ ] |
| T18 | Corregir hallazgos de la ronda 2 | backend | opus | T17 | — | — | [ ] |
| T19 | E2E con mock (CA-14) | tester | sonnet | T10–T12 ∥ T13–T18 | — | — | [ ] |
| T20 | Prueba manual con el sistema levantado y `SIRE_ESCRITURA=mock` | tester | sonnet | T18, T19 | — | — | [ ] |
| T21 | Verificar CA-1 a CA-14 con evidencia y suites afectadas | tester | sonnet | T20 | — | — | [ ] |
| T22 | **Piloto real** supervisado con el usuario (P-4): un envío, su ticket y, si aplica, registrar preliminar; anotar P-2/P-8 | tester | sonnet | T21 + aprobación explícita del usuario | — | — | [ ] |
| T23 | Revisión final contra la spec | arquitecto | opus | T22 | — | — | [ ] |
| T24 | Cierre: `tasks.md`, `spec.md`, commit (el orquestador actualiza `ESTADO.md`) | devops | haiku | T23 | — | — | [ ] |

Paralelismo: oleada 1 = T1 ∥ T2 ∥ T3; oleada 2 = T4 ∥ T5 ∥ T6 y T7 ∥ T8 ∥ T9; oleada 3 = T10 ∥ T11 ∥ T12. Rondas y correcciones en serie; T19 ∥ rondas. Si una ronda no deja fallos, sus dos tareas siguientes se marcan `[x]` «sin hallazgos».

Escalamientos: T7, T8 y T10 nacen en `opus` (escritura ante SUNAT, RLS y funciones acotadas, como-máximo-una-vez). T9, T11 o T12 pasan a `opus` si fallan 2 veces. T24 pasa a `sonnet` si `haiku` falla una vez.

Reglas comunes:
- **Ninguna tarea salvo T22 habla con SUNAT.** `SIRE_ESCRITURA` queda `off` en `.env.example`, CI y E2E usan `mock`. Ningún subagente enciende el interruptor real ni corre T22 sin que el usuario lo pida en ese momento.
- Canarios en clave SOL, `client_secret` y token; se buscan en errores, logs, `resultado`, eventos, auditoría y `envio_sire`.
- Migraciones: siguiente número libre al implementar (027/028 en paralelo); nunca editar una aplicada. Funciones `SECURITY DEFINER` con el patrón de 026 y registradas en `tests/aislamiento/escalada.adv.spec.ts`.
- Un commit por tarea (`test(032)`, `feat(032)`, `fix(032)`, `chore(032)`), trailer del modelo, sin push del subagente, `git add` con rutas explícitas.
- El tester no toca producción; backend y frontend no editan `*.spec.ts` ajenos; solo T13 y T16 crean `*.adv.spec.ts`. Checks: solo fallos u «OK» + conteo. Ambigüedad que cambie la spec: `requiere usuario`.

## T1 · Puerto, mock, TUS y http, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (R-1, R-3, R-6, R-8; CA-4 a CA-7, CA-9, CA-11), `plan.md` (Contratos, Decisiones TUS), `packages/sunat/src/http/pruebas/servidor-sire-falso.ts` (041, modelo), `packages/sunat/src/errores.ts`.
- **Hacer**: `servidor-tus-falso.ts` y `packages/sunat/src/{mock/sire-escritura.mock,http/tus,http/sire-escritura.http}.spec.ts`: cabeceras y metadatos exactos (base64, orden, valores de P-2), cuerpo idéntico al ZIP, corte tras la creación → `ErrorEnvioIncierto`, `Location` de otro host, 422 con lista de errores, estados de ticket, «no domiciliados».
- **Hecho cuando**: fallan por módulo ausente; `sunat` existente verde. Commit `test(032): puerto de escritura SIRE en rojo`.

## T2 · BD, rojo (tester · sonnet)
- **Contexto**: `spec.md` (R-2, R-5, R-7; CA-2, CA-8, CA-12), `plan.md` (Tabla), `packages/db/migrations/0040_archivo_generado.sql`, `tests/aislamiento/escalada.adv.spec.ts`, una prueba de BD de 026 como modelo (`packages/db/src/prorrata/*.int.spec.ts`).
- **Hacer**: pruebas de `packages/db/src/envios/*.int.spec.ts` y `tests/aislamiento/envios-032.int.spec.ts`.
- **Hecho cuando**: fallan por tabla o función ausente. Commit `test(032): BD de envíos en rojo`.

## T3 · Contratos, rojo (tester · sonnet)
- **Contexto**: `plan.md` (Contratos, HTTP), `packages/shared/src/acceso/{permisos,roles}.ts`, `packages/shared/src/auditoria/acciones.ts`, `packages/queue/src/catalogo.ts`.
- **Hacer**: `packages/shared/src/envios/{esquemas,vistas}-032.spec.ts`, `acceso/permisos-032.spec.ts`, `auditoria/acciones-032.spec.ts`, `packages/queue/src/catalogo-032.spec.ts`; ajustar listas cerradas existentes.
- **Hecho cuando**: fallan por export ausente. Commit `test(032): contratos de envío en rojo`.

## T4 · Worker, rojo (tester · sonnet)
- **Contexto**: `spec.md` (R-1, R-3, R-4, R-6; CA-1, CA-3, CA-5, CA-6, CA-9 a CA-11, CA-13), `plan.md` (Decisiones), `apps/worker/src/trabajos/procesadores/generar-archivo.ts` (cómo se guarda el ZIP en `storage`), `apps/worker/src/trabajos/ejecutor.ts` (líneas 1–30), `apps/worker/src/adaptadores/adaptadores.module.ts`.
- **Hacer**: `apps/worker/src/trabajos/procesadores/{enviar-reemplazo,consultar-ticket,aceptar-propuesta,registrar-preliminar}.int.spec.ts`, `adaptadores-032.spec.ts`.
- **Hecho cuando**: fallan por procesador ausente. Commit `test(032): worker de envíos en rojo`.

## T5 · Backend, rojo (tester · sonnet)
- **Contexto**: `spec.md` (R-1, R-2, R-4, R-5, R-7; CA-1 a CA-3, CA-8, CA-10, CA-12), `plan.md` (HTTP), `apps/backend/src/modules/archivos/archivos.controller.ts` y una de sus `*.int.spec.ts`.
- **Hacer**: `apps/backend/src/modules/envios/*.int.spec.ts` y casos R-7 en `archivos`, `compras`, `ventas`.
- **Hecho cuando**: fallan por módulo ausente. Commit `test(032): API de envíos en rojo`.

## T6 · Componentes, rojo (tester · sonnet)
- **Contexto**: `spec.md` (R-5, CA-1, CA-6), `plan.md` (HTTP), `apps/frontend/components/archivos/panel-generar.tsx` y su prueba.
- **Hacer**: pruebas de `components/envios/*` (botón oculto sin permiso o con interruptor apagado, modal que exige escribir el periodo, estados y errores).
- **Hecho cuando**: fallan por componente ausente. Commit `test(032): pantalla de envío en rojo`.

## T7–T12 · Implementación
- **Contexto**: `plan.md` y las pruebas rojas de su par (T7←T1, T8←T2, T9←T3, T10←T4, T11←T5, T12←T6), más los archivos que esas pruebas importan.
- **Hecho cuando**: sus pruebas verdes; `typecheck` y `lint` del paquete; las suites existentes del paquete siguen verdes. Commits `feat(032): …`.

## T13 / T16 · Rondas adversariales (adversario · opus)
- **Contexto**: T13 caja negra (spec, plan, interfaz pública); T16 caja blanca (más la implementación). Catálogo 04 §2.3: Aislamiento, Permisos, Cola, Formatos ZIP, Cifrado (secretos).
- **Hacer**: ≤ 15 pruebas cada una en `*.adv.spec.ts` / `*.adv.int.spec.ts` de los paquetes atacados.
- **Hecho cuando**: hallazgos `H-032-n-m` en el resultado. Commits `test(032): ronda adversarial n`.

## T14–T15 · T17–T18 · Correcciones
- Pruebas del tester (rojo) y corrección hasta verde, como en 026.

## T19 · E2E (tester · sonnet)
- **Contexto**: `spec.md` CA-14, `tests/e2e/` (un flujo de 012b como modelo).
- **Hecho cuando**: `tests/e2e/envio-sire.spec.ts` verde en local y en CI con `SIRE_ESCRITURA=mock`.

## T20 · Prueba manual con mock · T21 · Verificación (tester · sonnet)
- **Hecho cuando**: cada CA con evidencia (prueba o comando) o listado como faltante; suites de `sunat`, `db`, `shared`, `queue`, `worker`, `backend`, `frontend`.

## T22 · Piloto real (tester · sonnet, con el usuario)
- **Contexto**: `spec.md` P-2, P-4, P-8; guía de encendido del interruptor.
- **Hacer**: solo con orden explícita del usuario en ese momento: encender el interruptor de su estudio, enviar un archivo de su RUC y periodo elegidos, seguir el ticket, registrar preliminar si lo pide, apagar el interruptor. Anotar solo formas (estados, tiempos, nombre del reporte, códigos), nunca datos.
- **Hecho cuando**: el ticket llega a estado final y P-2/P-8 quedan confirmadas o corregidas con el usuario.

## T23 · Revisión final (arquitecto · opus) · T24 · Cierre (devops · haiku)
- Revisión contra la spec con evidencia; cierre `docs(032): cierre`.
