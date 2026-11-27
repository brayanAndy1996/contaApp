# Plan 030 · Roles personalizados

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/db/migrations/0082_roles_propios.sql` (0083 solo para correcciones de la ronda) | tablas, columnas, funciones, nuevas versiones |
| crear/modificar | `packages/db/src/acceso/roles.ts`, `miembros.ts`, `invitaciones.ts`, `schema/acceso.ts` | repositorio y esquema drizzle |
| modificar | `tests/aislamiento/{escalada.adv,catalogo}.spec.ts`, `acceso-soporte.ts`, `auth-soporte.ts`, `apps/backend/test/soporte-acceso.ts`, `tests/e2e/soporte/siembra.ts` | catálogos y borrado en réplica (los hace la tarea de la migración) |
| crear | `packages/shared/src/acceso/{efectivos,combinacion,roles-propios}.ts` | resolvedor, U3, zod |
| modificar | `shared/acceso/{roles,esquemas}.ts`, `shared/auth/factor-exigido.casos.ts`, `shared/auditoria/acciones.ts` | `puedeGestionar` por conjuntos, unión de rol, casos, acciones |
| modificar | `apps/backend/src/modules/acceso/guards/{permiso,cliente-scope}.guard.ts`, `auth/totp/exigencia.ts`, `usuarios.service.ts`, `invitaciones.service.ts`, `yo.controller.ts` | núcleo: permisos efectivos, alcance, escalada, TOTP |
| crear | `apps/backend/src/modules/acceso/roles/{roles.controller,roles.service}.ts`; registro en `acceso.module.ts` | rutas `/roles` |
| crear/modificar | `apps/frontend/app/(app)/usuarios/roles/` (lista, formulario, avisos), `usuarios/page.tsx` | pantallas |
| crear | `tests/e2e/flujos/roles.e2e.ts` | flujo completo con login e invitación |
| modificar | `apps/backend/vitest.cobertura.config.mts` | globs nuevos |

## Contratos
**Shared**
- `RolAsignado = Rol | { rolId: uuid }` (`rolAsignadoSchema`); `invitarSchema` y `cambiarRolSchema` lo usan (compatible con 005).
- `Efectivo = { rolSistema: Rol | null; permisos: ReadonlySet<Permiso>; alcance: 'global' | 'asignado' }`.
- `permisosEfectivos(rol, propio?: {permisos, alcance}) → Efectivo`; `alcanceEfectivo(e)`; `puedeSerResponsable(e)`.
- `validarCombinacion(permisos, alcance) → {ok} | {error: 'permiso_invalido' | 'combinacion_invalida', permiso}` (U3, sin `plan.gestionar`).
- `puedeGestionar(actor: Efectivo, actual: Efectivo | null, nuevo: Efectivo | null)` por contención de permisos y alcance; `puedeGestionarRol(actor, antes, despues, esPropioDelActor)` (U2, U4).
- `CASOS_EFECTIVOS` (tabla común TS/SQL) y `CASOS_FACTOR_EXIGIDO` con filas de roles propios; `rolSistema: null` para propios.
- `crearRolSchema {nombre 1..40 sin controles, alcance, permisos[], baseRolId?}`, `editarRolSchema` (parcial). Acciones de auditoría `rol.creado`, `rol.editado`, `rol.eliminado`.

**HTTP** (CSRF y Origen de 004; errores con código fijo):
| Ruta | Permiso | Respuesta |
|---|---|---|
| `GET /roles` | `roles.gestionar` | sistema (solo lectura) + propios `{id, nombre, alcance, permisos, miembros, invitaciones}` |
| `GET /roles/asignables` | `usuarios.gestionar` | roles que el actor puede asignar (`puedeGestionar`) |
| `POST /roles` | `roles.gestionar` | 201 · 422 `permiso_invalido`/`combinacion_invalida` · 409 `nombre_duplicado`/`limite_roles` · 403 `escalada` |
| `POST /roles/:id/impacto` (cuerpo de edición) | `roles.gestionar` | `{miembros, clientesSinResponsable, miembrosSinTotpExigidos}`, sin cambios (U6, U8) |
| `PATCH /roles/:id` | `roles.gestionar` | 200 · 404 ajeno o de sistema · 403 `escalada`/`rol_propio` · 422 · 409 |
| `DELETE /roles/:id` | `roles.gestionar` | 204 · 409 `rol_en_uso {miembros, invitaciones}` |
| `POST /invitaciones`, `PATCH /usuarios/:id/rol` | como 005 | aceptan `{rolId}`; rol ajeno o inexistente: 404 |
| `GET /yo` | como 005 | + `rolPropio: {id, nombre} \| null`, `permisos`, `alcance` efectivos |

**BD** (patrón de 0012/0078; tablas con RLS `ENABLE` + `FORCE`, solo `SELECT` a `contapp_backend`):
- `rol(tenant_id FK, id, nombre, nombre_clave GENERATED (minúsculas, sin tildes) , alcance CHECK, creado_en, actualizado_en)`, `UNIQUE (tenant_id, nombre_clave)`, `UNIQUE (tenant_id, id)`, `CHECK nombre_clave` fuera de los 5 nombres de sistema.
- `rol_permiso(tenant_id, rol_id, permiso CHECK (catálogo sin plan.gestionar))`, PK `(rol_id, permiso)`, FK `(tenant_id, rol_id)` `ON DELETE CASCADE`.
- `membresia.rol_id`, `invitacion.rol_id`: FK `(tenant_id, rol_id)` `ON DELETE RESTRICT`; `CHECK ((rol = 'propio') = (rol_id IS NOT NULL))`; los `CHECK` de rol admiten `'propio'`.
- Funciones `SECURITY DEFINER` (actor y estudio de `app.user_id`/`app.tenant_id`): `acceso.permisos_membresia(tenant, usuario) → (rol_sistema, permisos text[], alcance)`; `acceso.rol_guardar(id?, nombre, alcance, permisos[])` y `acceso.rol_eliminar(id)` (U1–U5, U9, auditoría, bloqueos D4); `acceso.rol_impacto(...)`. Disparador en `membresia`/`invitacion`: asignar un rol propio exige contención al actor de contexto.
- Nuevas versiones: `auth.totp_desactivar` (usa `permisos_membresia`), `auth.invitacion_vigente`, `auth.invitacion_aceptar_nueva`/`_existente` (copian `rol_id`, mismo advisory de D4). Explícitas por U10, sin cambio de lógica pero probadas con `'propio'`: `interno.destinatarios_cliente`, `interno.notificar`, `interno.uso_plan`, `notificacion_credencial_invalida`, `correo_preferencia*`, `auth.correo_baja_aplicar`. `membresia_ultimo_dueno` igual (U7). Inventario cerrado de funciones con `rol` en `catalogo.spec.ts`.
- Auditoría: `CHECK` de `auditoria.accion` + 3 acciones; `datos` con permisos y alcance antes/después.

## Decisiones
- Escrituras de `rol`/`rol_permiso` solo por funciones: la regla de U2–U4 y U9 vive en BD (CA-5 en BD) y el backend la repite para dar 403/422 claros.
- El guard obtiene rol, `rol_id`, permisos y alcance en la misma consulta de `miembroActual` (join + `array_agg`): sin consulta extra ni caché (CA-4, CA-11).
- Alcance: `alcanceDe(rol)` se reemplaza por `alcanceEfectivo`; `filtroAlcance` no cambia (recibe el `Alcance`).
- Quitar `sire.clasificar` (U6): `rol_guardar` borra las asignaciones `responsable` de los miembros del rol en la misma transacción.
- Límite U9 contado bajo el advisory `acceso.roles:<tenant>` (sin carrera).
- Solo T6 (0082) y T13 (0083) escriben migraciones; quien necesite SQL en otra tarea para y lo reporta.

## Riesgos
- Romper 005/029 al tocar `CHECK`, guard y funciones de invitación: suites `acceso*`, `permisos.int`, `totp.exigencia.int`, `equipo.e2e` en T8 y T16.
- Divergencia TS/SQL del resolvedor: `CASOS_EFECTIVOS` común (T1, T2).
- Interbloqueos: orden fijo de D4 en todo camino; pruebas de carrera con 20 concurrentes (T1).
- Función nueva con `rol` olvidada: lista cerrada en `catalogo.spec.ts` sobre `pg_proc.prosrc`.
- Soportes: en réplica, borrar `rol_permiso` y `rol` antes del estudio; lanzar si queda algo.
- PG 16 local: sin `MERGE … RETURNING`; las fallas ajenas conocidas de 029 no cuentan.
