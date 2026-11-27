# 030 · Roles personalizados · resultados de T16

Corrida del 2026-11-26 sobre la rama `spec/030-roles-personalizados`, BD limpia propia `contapp_029t16` (recreada, migrada dos veces y sembrada), PG 16, Redis y Mailpit locales. Logs en el scratchpad de la sesión (`t16-*.log`).

## Antes de verificar
- Falla conocida corregida: `apps/backend/src/aislamiento/hu40-api.int.spec.ts` («toda ruta registrada tiene un caso») no tenía casos para las 6 rutas de `/roles`. Se agregó `casosRoles()` (GET /roles, GET /roles/asignables, POST /roles, PATCH, DELETE y POST /roles/:rolId/impacto), un rol propio sembrado por estudio (id y nombre como marcas de fuga) y `rol`/`rol_permiso` en la instantánea. Solo pruebas; commit `test(030): casos de aislamiento HU-40 para las 6 rutas de /roles (T16)`. Resultado: 693/693 verdes.
  - Nota: la ruta registrada es `POST /roles/:rolId/impacto` (no `:id`).

## Suites completas
| Suite | Archivos | Pruebas | Resultado |
|---|---|---|---|
| `@contapp/shared` | 75 | 4383 | OK |
| `@contapp/correo` | 12 | 118 | OK |
| `@contapp/db` | 113 | 2513 | OK |
| backend unitarias | 129 | 1652 | OK |
| backend `--mode int` | 186 | 4762 | 1 falla intermitente (ver abajo) |
| `tests/aislamiento` | 148 | 4142 | 9 fallas, todas conocidas del entorno (ver abajo) |
| frontend | 184 | 1859 | OK |
| E2E completa (`pnpm e2e`, Mailpit, `E2E_BD=contapp_029t16`, `E2E_CONSERVAR_BD=1`) | — | 113 | 113 passed (2.1 min); incluye `flujos/roles.e2e.ts` (2 casos) |
| cobertura backend (`vitest.cobertura.config.mts`) | 434 | 11988 | OK, umbral 90 % por archivo cumplido |
| cobertura db | 264 | 2513+ | umbrales cumplidos; fallan solo las 9 conocidas |
| cobertura correo | 12 | 118 | OK (100/96.92) |

### Fallas conocidas del entorno (contadas aparte, no son de 030)
`contapp_pruebas` es superusuario y PG 16 no soporta `MERGE … RETURNING`. Se repiten idénticas en la suite y en la cobertura db (9):
- `correo-funciones.spec.ts` · `interno.notificar` EXECUTE (1)
- `escalada.adv.spec.ts` · inventario SECURITY DEFINER y funciones 025, 026, 027, 028 (5)
- `reglas-lote.spec.ts` · EXECUTE de `aplicar_reglas_historial` y `auditoria_insertar_lote` (2)
- `credencial-r1a.adv.spec.ts` · `MERGE ... RETURNING` (42601 en vez de 42501) (1)
Las pruebas de 030 de `escalada.adv.spec.ts` (funciones de roles propios) y `catalogo.spec.ts` pasan.

### Falla no listada como conocida: intermitente, no de 030
- `apps/backend/src/modules/auth/totp-r1a.adv.int.spec.ts` · «revocar por id a la vez que esa sesión cambia de estudio: su continuación rotada también muere» (029, R1a): `expected ['vuelta 3: la rotada (estado 200)'] to deeply equal []`. Carrera de tiempos bajo la carga de la suite completa; en una BD aparte el archivo pasó 3/3 (15/15 pruebas) y la cobertura backend (corrida completa posterior) la pasó. No se tocó.
- Perf (`roles.rendimiento` db, backend int y aislamiento; `auth-sesiones.rendimiento`): sin fallas en esta corrida.

## Evidencia por criterio
| CA | Evidencia (todas verdes en esta corrida) | Estado |
|---|---|---|
| CA-1 | `roles.crud.int.spec.ts` «CA-1 · crear un rol propio» (201, nombre único sin mayúsculas ni tildes, distinto de los de sistema, otro estudio puede repetirlo); `roles.asignacion.int.spec.ts` (asignable al invitar y al cambiar de rol); `tests/aislamiento/roles-funciones.spec.ts` «rol_guardar · crear (CA-1…)», `roles-r2.adv.spec.ts` (e) nombre_clave; E2E `roles.e2e.ts:177` y `:472` | cumplido |
| CA-2 | `roles.crud.int.spec.ts` «CA-2 · permisos fuera del catálogo y combinaciones inválidas (U3)» (`plan.gestionar` y fuera de catálogo: 422; los 23 con sus requisitos se aceptan); `roles-r1a.adv.int.spec.ts` «cuerpos de /roles: catálogo cerrado»; `tests/aislamiento/roles-tablas.spec.ts` «CHECK del catalogo…» (CHECK en BD); `packages/shared` `combinacion.spec.ts` (23 reglas U3); UI sin `plan.gestionar` en `usuarios/roles/formulario.spec.tsx` | cumplido |
| CA-3 | `permisos.int.spec.ts` «CA-1 · tabla 5 roles x endpoints de 005 (D2)»; `roles.crud.int.spec.ts` «GET /roles · lista» (5 de sistema, solo lectura); ninguna ruta de `/roles` acepta un rol de sistema (404 en PATCH/DELETE/impacto, `roles.uso.int.spec.ts`) | cumplido |
| CA-4 | `roles.permisos.int.spec.ts` «CA-4 · tabla por permiso» (rol que solo lo tiene 2xx vs sin él 403), «alcance asignado: 404 en cliente no asignado», «editar el rol aplica en la siguiente petición»; `packages/shared` `efectivos.spec.ts` «tabla por permiso»; `tests/aislamiento/roles-efectivos.spec.ts` (espejo SQL de `CASOS_EFECTIVOS`) | cumplido |
| CA-5 | `roles.escalada.int.spec.ts` (U2, U4, rol propio del actor); `roles-r1a.adv.int.spec.ts` «escalada por baseRolId y por la vista previa», «escalada al re-emitir invitaciones»; en BD `roles-funciones.spec.ts` «U2 y U4», `roles-r1b.adv.spec.ts` «escalada en rol_guardar / rol_eliminar», `roles-r2.adv.spec.ts` (a), (g) | cumplido |
| CA-6 | `roles.uso.int.spec.ts` «U5 · eliminar un rol en uso» (409 con conteos) y «CA-6: … nunca queda una referencia a un rol inexistente», U6 impacto; `roles-funciones.spec.ts` «rol_eliminar (CA-6…)»; FK compuestas en `roles-tablas.spec.ts` | cumplido |
| CA-7 | `roles.totp.int.spec.ts` «CA-7 · ganar o perder un permiso sensible…» y «`/auth/totp/desactivar` aplica la misma regla»; `factor-exigido.casos.ts` con filas de propios (shared); `roles-efectivos.spec.ts` «auth.totp_desactivar con roles propios (CA-7, U8)» | cumplido |
| CA-8 | `tests/aislamiento/roles-concurrencia.spec.ts` «CA-8 / U7: nunca 0 Dueños activos con roles propios, tampoco en concurrencia» (20 Dueños: 19 pasan y 1 recibe P0001; degradaciones mutuas sin interbloqueo) | cumplido |
| CA-9 | `roles-tablas.spec.ts` «RLS FORCE y privilegios (CA-9)»; `catalogo.spec.ts` (`rol`, `rol_permiso` con RLS ENABLE/FORCE y una política); `escalada.adv.spec.ts` (funciones 030); `roles-r1b.adv.spec.ts` «rol_id entre estudios»; `roles-r1a.adv.int.spec.ts` «ids ajenos (CA-9)»; `hu40-api.int.spec.ts` casos `/roles` (T16) en 4 combinaciones; E2E `roles.e2e.ts:472` (404 de un rol de otro estudio) | cumplido |
| CA-10 | `tests/aislamiento/roles-concurrencia.spec.ts` «CA-10…» (eliminar/editar vs invitar, aceptar, cambiar de rol, desactivar) y «U9» (25 altas: exactamente 20); `roles.concurrencia.int.spec.ts`; `roles-r2.adv.spec.ts` (c) orden de bloqueo sin 40P01 | cumplido |
| CA-11 | `roles.rendimiento.int.spec.ts` (guard y listado con 2.000 roles ajenos), `tests/aislamiento/roles.rendimiento.spec.ts` (40.000 ajenos ≤ 3x, mínimo de varias corridas, `medirEscala`) y `packages/db` `roles.rendimiento.spec.ts`: sin fallas | cumplido |
| CA-12 | Ronda 1: `roles-r1a.adv.int.spec.ts` y `roles-r1b.adv.spec.ts`; ronda 2: `roles-r2.adv.int.spec.ts` y `roles-r2.adv.spec.ts` (≤ 2 rondas): escalada, carreras, ids ajenos, `plan.gestionar` lateral, evadir TOTP, último Dueño, avisos (U10) y canarios sin secretos; todas verdes | cumplido |

## Cobertura (T14, medida en esta corrida)
Backend (`vitest.cobertura.config.mts`, un solo proyecto con umbral 90 % por archivo): total 98.92 % sentencias, 97.16 % ramas, 99.82 % funciones, 99.7 % líneas; **0 archivos bajo 90 %**.

| Archivo (nuevo o tocado por 030) | Líneas | Ramas |
|---|---|---|
| backend `acceso/roles/roles.service.ts`, `roles.controller.ts`, `acceso/efectivo.ts`, `acceso/errores.ts`, `acceso.module.ts`, `guards/decoradores.ts`, `auth/totp/exigencia.ts`, `comun/filtro-errores.ts`, `compras/resumen.service.ts` | 100 | 100 |
| backend `acceso/guards/permiso.guard.ts` | 100 | 94.91 |
| backend `acceso/invitaciones.service.ts` | 100 | 94.11 |
| backend `acceso/usuarios.service.ts` | 100 | 95.38 |
| backend `acceso/yo.controller.ts` | 100 | 90.9 |
| backend `clientes/asignaciones.service.ts` | 100 | 90 |
| backend `clientes/clientes.service.ts` | 100 | 97.1 |
| backend `importacion/importacion.service.ts`, `validar-filas.ts` | 100 | 98.5 / 97.61 |
| backend `trabajos/trabajos.service.ts` | 97.05 | 90 |
| db `acceso/roles.ts`, `miembros.ts`, `invitaciones.ts`, `schema/acceso.ts` | 100 | 100 |
| shared `acceso/combinacion.ts`, `efectivos.ts`, `roles-propios.ts`, `roles.ts`, `esquemas.ts` | 100 | 100 |

(Mínimos backend de lo tocado: líneas 97.05, ramas 90. db `roles.ts` medido hoy en 100/100; el 95.8/100 anterior de T14 quedó superado por sus pruebas de cobertura.) db total 96.55 L / 94.26 B; correo 100 / 96.92.

Frontend (medición ad hoc con `vitest --coverage` v8; no hay script):

| Archivo | Líneas | Sentencias | Ramas |
|---|---|---|---|
| `app/(app)/usuarios/roles/page.tsx` | 100 | 100 | 92.45 |
| `app/(app)/usuarios/roles/formulario-rol.tsx` | 100 | 98.86 | 92 |
| `app/(app)/usuarios/page.tsx` | 100 | 100 | 93.13 |
| `app/(app)/clientes/nuevo/page.tsx` | 94.2 | 94.52 | 90.62 |
| `components/marco/menu-principal.tsx` | 100 | 97.95 | 97.87 |
| `lib/acceso.ts` | 100 | 100 | 100 |
| `lib/roles.ts` | 100 | 100 | 92.59 |
| `lib/auditoria.ts` | 100 | 99.07 | 97.22 |
| `app/(publico)/invitacion/page.tsx` (con `errores.spec.tsx`) | 100 | 97.67 | 95.78 |

## Faltante
- Ninguno. `invitacion/page.tsx` (tocado por T15a) pasó de 80 % de ramas y 88.37 % de sentencias a 95.78 % y 97.67 % con `invitacion/errores.spec.tsx` (15 pruebas: carga, consulta 500 y red caída, desmontaje en vuelo, aceptar/login/aceptar-con-sesion/cambio de estudio en 401, 429 y 5xx). Quedan sin cubrir solo cuatro guardas inalcanzables desde la UI (`!token`, `!info`, `!estudioUnido`, `previa` nula). Frontend completo: 185 archivos, 1874 pruebas verdes.

## Revisión final T17 (arquitecto · opus, modelo efectivo `claude-opus-5-5`)
Contrastado spec (U1–U10, CA-1..CA-12, D1–D6) y plan con 0082–0086, `packages/shared/src/acceso/*`, guards, servicios de acceso, `/roles`, auth y la evidencia de T16. Escalada (U2/U4 en TS y BD, RL001, revocación y re-chequeo al aceptar), `plan.gestionar` vetado (CHECK + zod + UI), espejo SQL/TS (`permisos_membresia`, `factorExigido`/`totp_desactivar`), orden D4 (advisory `acceso.roles` primero en todo camino, incluido el disparador por sentencia de `invitacion` y `cupo_usuarios_aceptar`), RLS FORCE y FK compuestas, U7/U9/U10 y secretos: conformes.

**Veredicto: no aprobada (1 bloqueante).**
- **T17-1 · BLOQUEANTE (D3, CA-4).** El despachador del worker revalida al encolador por clave de rol de sistema: `packages/db/src/trabajos/registro.ts:552-553` (`m.rol = any($3)` con `rolesPermitidos` de `packages/queue/src/catalogo.ts:82-86`, solo los 5 de sistema, y `m.rol in ('dueno','admin')` para el alcance global). Todo trabajo con cliente y permiso (SIRE, credenciales, buzón, reglas, prorrata) encolado por un miembro con rol propio termina `cancelado/acceso_retirado`. Falla cerrado (sin fuga), pero el permiso efectivo no funciona de punta a punta; escapó porque el inventario de `roles-funciones-rol.spec.ts` solo mira `pg_proc.prosrc`, no SQL en repositorios TS. Corrección propuesta (T17a, opus, TDD): (1) tester: casos rojos en `packages/queue/src/revalidacion.int.spec.ts` — propio con el permiso y alcance global sin asignación → ok; asignado con asignación → ok; asignado sin asignación, sin el permiso, o permiso quitado tras encolar → `acceso_retirado`; (2) migración 0087: `GRANT USAGE ON SCHEMA acceso` y `EXECUTE ON acceso.permisos_membresia(uuid, uuid)` a `contapp_worker` (actualizar `escalada.adv`/`catalogo`); (3) `SQL_REVALIDAR` con `acceso.permisos_membresia(c.tenant_id, $2)`: `($3::text is null or $3 = any(e.permisos)) and (e.alcance = 'global' or exists asignacion)`; `Revalidable.rolesPermitidos` → `permiso: string | null` (despachador y `bd-falsa.ts`); (4) agregar al inventario una búsqueda de `m.rol in (` / `rol = any` en `packages/db/src/**` fuera de la lista U10 (`correo/envios.ts`, `correo/resumen.ts`, `correo/preferencias.ts`).
- Aceptables documentadas (no bloquean; registrar en `cierre.md`): U6 (responsable → colaborador), disparador SECURITY INVOKER, confusables (`it.fails`), ZWJ rechazado; 0084: eliminar un rol borra sus invitaciones no vigentes y pasa a `lectura` a sus miembros desactivados (decisión en la cabecera de 0084, sin aval explícito del usuario); el backend no repite U2 antes de la BD en `POST/PATCH /roles` (traduce 42501 → 403 `escalada`, mismo código); migraciones 0082–0086 en vez de 0082–0083 (siguiente libre: 0087, o 0088 tras T17a); T11–T13 siguen `[ ]` en la tabla de `tasks.md` aunque están hechas.

## Re-revisión T17 tras T17a (arquitecto · opus, modelo efectivo `claude-opus-5-5`; commits d80780f, 8921980; BD `contapp_029t17`)
**T17-1: resuelto en código.** `SQL_REVALIDAR` (`packages/db/src/trabajos/registro.ts`) decide con `acceso.permisos_membresia(c.tenant_id, $2)`: permiso efectivo (`$3 = any(e.permisos)`, null = sin permiso) y alcance (`global` o asignación); membresía desactivada, rol propio inexistente o usuario ajeno → cero filas → `acceso_retirado`; `permiso` ausente (contrato viejo) → `acceso_retirado` (falla cerrado). Sin `FOR UPDATE` ni advisory: el resolvedor solo lee (orden D4 intacto). 0087: USAGE en `acceso` y EXECUTE solo sobre `permisos_membresia` para `contapp_worker` (REVOKE previo, sin CREATE); verificado por `roles-funciones-rol`, `roles-r1b.adv`, `roles-efectivos` y `escalada.adv` (030) en verde. Las 4 suites adaptadas conservan cada aserción con permisos equivalentes según `PERMISOS_POR_ROL` (`plan.gestionar`=dueno, `usuarios.gestionar`=dueno/admin, `credenciales.editar`=dueno/admin/contador, `clientes.ver`=los cinco; `["contador"]` para el Dueño → `permiso.inexistente`), y `revalidacion.spec.ts` además fija `args.permiso` y la ausencia de `rolesPermitidos`. `rolesPermitidos()` queda sin consumidores de producción (el despachador ya no lo importa; solo specs de catálogo): sin camino de decisión por rol. El inventario TS nuevo barre `packages/db/src` y su control positivo pasa. Corridas T17a: queue 790/790, queue int 123/123, db 2513/2513.

**Veredicto: no aprobada (1 bloqueante nuevo, solo de pruebas).**
- **T17-2 · BLOQUEANTE (regresión de suite, introducida por T17a).** `limpiarRolesPropios()` de `packages/queue/src/revalidacion.int.spec.ts:70-86` borra `rol` con `session_replication_role = replica` sin borrar antes `rol_permiso` (el `ON DELETE CASCADE` no corre en réplica): deja 6 filas huérfanas en `rol_permiso` (`sire.descargar`, `clientes.ver`) de estudios ya borrados. Con ellas, `tests/aislamiento/roles-r1b.adv.spec.ts` «0082, 0083 y 0084 se reaplican…» falla con 23503 (`rol_permiso_rol_fk` al recrear la FK); pasaba en T16 y falla en `t17a/ais.log` y aislado. Comprobado: borrando los huérfanos dentro de una transacción, 0082–0084 y 0087 se reaplican sin error. Corrección (T17b, tester · sonnet): en `limpiarRolesPropios` borrar `rol_permiso where tenant_id = any($1)` antes de `rol` (como `tests/aislamiento/acceso-soporte.ts:215`) y verificar después que no quedan `rol`/`rol_permiso` de los estudios (como `acceso-soporte.ts:243`), sin tragarse el error; recrear `contapp_029t17`, correr queue `--mode int` y luego `tests/aislamiento` (`roles-`, `escalada`): solo las 5 conocidas de `escalada.adv` (025–028 e inventario) pueden fallar.
- Observación (no bloquea): el worker puede pedir `permisos_membresia` de cualquier estudio (SECURITY DEFINER con `p_tenant` arbitrario); `SQL_REVALIDAR` solo le pasa `c.tenant_id` de un cliente visible por RLS. Registrar en `cierre.md`.

## Cierre T17 tras T17b (arquitecto · opus, modelo efectivo `claude-opus-5-5`; commit 598db0e; BD `contapp_029t17c`)
**T17-2: resuelto.** `limpiarRolesPropios()` (`packages/queue/src/revalidacion.int.spec.ts`) borra, en réplica, `membresia` con `rol_id` → `invitacion` con `rol_id` → `rol_permiso` → `rol` (todo lo que referencia a `rol` antes que `rol`); quitó el `catch {}` de mejor esfuerzo (un error ahora falla el `afterAll`); destruye la conexión (`release(true)`) para no devolverla con `replica`; y luego exige 0 filas de `rol`/`rol_permiso` de los estudios y 0 huérfanos globales en `rol_permiso`, con error explícito. El diff solo toca la limpieza: ninguna aserción de los casos cambió. Corridas propias: queue `--mode int` 15 archivos, 123/123; huérfanos en `rol_permiso` = 0 antes y después de `tests/aislamiento` completo (4134 verdes, 2 `expected fail`, 9 fallas = las mismas 9 de T16: 5 de `escalada.adv` 025–028/inventario, `correo-funciones`, `credencial-r1a` `MERGE … RETURNING`, 2 de `reglas-lote`, todas del entorno). `roles-r1b.adv` «0082, 0083 y 0084 se reaplican…» vuelve a verde.

**Veredicto: aprobada.**

Aceptables para `cierre.md` (no bloquean):
- El worker puede consultar `acceso.permisos_membresia` de cualquier estudio (SECURITY DEFINER con `p_tenant` arbitrario, EXECUTE por 0087); `SQL_REVALIDAR` solo le pasa `c.tenant_id` de un cliente visible por RLS. Solo devuelve permisos/alcance, no datos de negocio.
- Disparador por sentencia de `invitacion` SECURITY INVOKER (orden D4 intacto).
- U6 (responsable → colaborador).
- Confusables Unicode en nombres de rol no se detectan (documentado con `it.fails`); ZWJ se rechaza.
- 0084: eliminar un rol borra sus invitaciones no vigentes y pasa a `lectura` a sus miembros desactivados (decisión en la cabecera de 0084, pendiente de aval explícito del usuario).
- El backend no repite U2 antes de la BD en `POST/PATCH /roles` (traduce 42501 → 403 `escalada`).
- Migraciones 0082–0087 (no 0082–0083); siguiente libre: 0088.
- Fallas del entorno de `contapp_pruebas` (superusuario; PG 16 sin `MERGE … RETURNING`): las 9 listadas arriba, idénticas desde T16.
- T11–T13 siguen `[ ]` en la tabla de `tasks.md` aunque están hechas (T18 las marca).

## Corrección de CI (PR #6, corrida 45919968522, head 8fa6240)
Cuatro jobs en rojo, dos causas (ambas de 030, ninguna de 028/029, ninguna flaky: determinísticas por entorno).

- **«Instalar, lint, typecheck y build» (`@contapp/backend#lint`)**: `--max-warnings=0` y una advertencia: `apps/backend/src/modules/acceso/invitaciones.rolpropio.int.spec.ts` (T15a) llevaba `/* eslint-disable @typescript-eslint/no-explicit-any */` sin ningún `any` en el archivo (directiva sin uso). Arreglo: se quita la línea. `pnpm --filter @contapp/backend lint` y `typecheck` en verde.
- **«Aislamiento entre estudios (PostgreSQL 17)», «Cobertura de packages/*» y «Cobertura del backend»**: un único fallo en los tres, `roles-r1b.adv.spec.ts > T12 · privilegios, RLS FORCE y EXECUTE de lo nuevo de 030 > rol y rol_permiso…` (263/264 y 433/434 archivos en verde; en `cobertura-paquetes` fallaba en la etapa `cobertura:db`, así que `cobertura:crypto` no llegó a correr). Causa: la consulta de privilegios usaba `order by 1` sobre `r || ':' || t || ':' || p` y la prueba comparaba contra `[rol:SELECT, rol_permiso:SELECT]`. Con la collation `en_US` del contenedor PG 17 `_` y `:` se ignoran en la primera pasada y `rol_permiso` queda antes que `rol`; con la collation `C` de `contapp_pruebas` el orden era el esperado, por eso no se vio en local. Comprobado con `collate "en-US-x-icu"` (rol_permiso | rol) frente a `"C"` (rol | rol_permiso). No es defecto de producción (los GRANT son correctos). Arreglo mínimo en la prueba, sin tocar la aserción: `order by (r || ':' || t || ':' || p) collate "C"` (orden bytewise, independiente del servidor). Es el único cambio en un `*.adv.spec.ts`: no se relaja nada, solo se fija el orden de la consulta. Verificado: `roles-r1b.adv.spec.ts` 15/15 en `contapp_029t18`; suite de aislamiento completa 6675 verdes + las 9 fallas conocidas del entorno (superusuario / PG 16), sin el fallo de roles.
- **Umbrales de cobertura**: no se tocaron. En CI, vitest no evalúa los umbrales cuando hay una prueba fallida, así que no hay evidencia de que alguno incumpla; si tras este arreglo alguno falla, saldrá en la siguiente corrida (en local `cobertura:db` no se puede cerrar por las 9 fallas del entorno).
