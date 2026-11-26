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
| **`app/(publico)/invitacion/page.tsx`** | 92.62 | **88.37** | **80** |

## Faltante
- `apps/frontend/app/(publico)/invitacion/page.tsx` (tocado por T15a, nombre del rol propio) queda en 80 % de ramas y 88.37 % de sentencias, bajo el 90 % que pide T14 para «cada archivo nuevo o tocado». Requiere pruebas nuevas de la pantalla (p. ej. ampliar `rol-propio.spec.tsx`); no se editó producción ni pruebas de otros roles.
- Por eso `T16` no se marca `[x]` en `tasks.md`.
