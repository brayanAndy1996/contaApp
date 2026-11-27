# Spec 030 · Roles personalizados

Estado: hecha (2026-11-26; U1–U10 con la opción recomendada)
Nivel de riesgo: A — (2) un permiso mal resuelto expone clientes o credenciales; (3) un permiso de más no se nota; (4) 2^23 combinaciones y concurrencia.
Cubre: RF-022, RF-023 (roles propios) · HU-05 · mantiene RF-021, RF-026, RF-028, U2 de 029

## Objetivo
Que el estudio cree roles propios (p. ej. «Practicante») con permisos de 01 §4 y los asigne, sin escalada ni romper el alcance de 005.

## Alcance
- «Equipo → Roles»: listar, crear, editar y eliminar roles propios (nombre, alcance, permisos por módulo), partiendo opcionalmente de un rol existente.
- Asignarlo al invitar (HU-03) y al cambiar rol (005).
- Resolución única de permisos efectivos para guards, alcance, `puedeGestionar`, `puedeSerResponsable`, TOTP y funciones SQL que hoy deciden por `rol IN (...)`.
- Auditoría de altas, ediciones y bajas (permisos antes y después).

## Fuera de alcance
- Editar roles de sistema, permisos nuevos o por cliente, roles de plataforma, avisos a roles propios (U10).

## Criterios de aceptación
- [ ] CA-1 (HU-05): al guardar el rol queda asignable al invitar y al cambiar rol. Nombre único por estudio (sin mayúsculas ni tildes) y distinto de los de sistema.
- [ ] CA-2: `plan.gestionar` o un permiso fuera del catálogo: 422 en API y `CHECK` en BD; la UI no lo ofrece. Combinación inválida (U3): 422 que nombra el permiso faltante.
- [ ] CA-3 (RF-021): ninguna ruta modifica un rol de sistema; la tabla 5 roles × endpoints de 005 sigue verde.
- [ ] CA-4 (permiso efectivo): prueba de tabla por permiso, con un rol propio que solo lo tiene (más sus requisitos de U3) y otro sin él, sobre un endpoint representativo: 2xx o 403. Con alcance asignado, cliente no asignado da 404 (HU-08). Editar el rol aplica en la siguiente petición (005 D3).
- [ ] CA-5 (escalada, U1–U2): se cumple U2, probada por API y en BD.
- [ ] CA-6 (rol en uso, U5–U6): nunca queda una membresía o invitación con un rol inexistente o de otro estudio.
- [ ] CA-7 (TOTP, U8): misma regla en TS y SQL (`factor-exigido.casos.ts` ampliada), también en `totp_desactivar`; un rol que gana un permiso sensible exige factor en la siguiente petición.
- [ ] CA-8 (U7): ninguna operación con roles propios deja 0 Dueños activos (005 D10), también en concurrencia.
- [ ] CA-9 (aislamiento): rol de otro estudio: 404. Tablas nuevas con RLS `FORCE` y FK compuestas, en `escalada.adv.spec.ts` y `catalogo.spec.ts`; los soportes las borran en modo réplica.
- [ ] CA-10 (concurrencia): editar o eliminar un rol mientras se invita, acepta, cambia de rol o desactiva da un resultado consistente (D4); crear en paralelo no supera el límite de U9.
- [ ] CA-11 (escala): guard y listado no crecen con roles de otros estudios (`medirEscala`).
- [ ] CA-12 (adversario, ≤ 2 rondas): escalada, carreras, ids ajenos, `plan.gestionar` lateral, evadir TOTP, último Dueño, avisos indebidos.
- [ ] Casos reales aplicables: ninguno.

**Cobertura (DoD A):** lo nuevo ≥ 90 % por archivo.

## Dependencias
- Specs: 005, 029, 017 (auditoría). Externas: ninguna.

## Decisiones técnicas
- D1 Tablas `rol(tenant_id, id, nombre, nombre_clave, alcance, …)` y `rol_permiso(tenant_id, rol_id, permiso)` con `CHECK` de catálogo y sin `plan.gestionar`. Los de sistema siguen en código (005 D21).
- D2 `membresia` e `invitacion` agregan `rol_id` nulo con FK compuesta (`tenant_id`, `rol_id`) `ON DELETE RESTRICT`; `rol` admite `'propio'` y un `CHECK` exige `rol_id` si y solo si `rol = 'propio'`.
- D3 Resolvedor puro en `packages/shared` (`permisosEfectivos`, `alcanceEfectivo`, `validarCombinacion`) y espejo SQL `acceso.permisos_membresia`, con la misma tabla de casos. Las funciones SQL que conceden acceso lo usan; las de avisos quedan explícitas con Dueño y Administrador (U10).
- D4 Lectura por petición en `withTenant`, sin caché. Orden de bloqueo fijo: advisory `acceso.roles:<tenant>` → `bloquearMiembros` → fila de `rol` → asignaciones → invitaciones (→ advisory `acceso.duenos` del disparador de 005).
- D5 Rutas `/roles` con `@Permiso('roles.gestionar')`; el rol asignado viaja como unión `sistema | propio` (zod en shared).
- D6 Migraciones desde la 0082.

## Decisiones del usuario
- U1 Gestiona roles quien tenga `roles.gestionar`, limitado por U2.
- U2 Escalada: los permisos y el alcance del rol tocado (antes y después) están contenidos en los del actor (amplía 005 D8; global ⊇ asignado). Nadie crea, edita ni elimina el rol que tiene asignado.
- U3 Combinaciones: toda acción exige el `.ver` de su módulo (`usuarios.gestionar` y `roles.gestionar` → `usuarios.ver`; `buzon.*` → `buzon.ver`; `reglas.gestionar` → `reglas.ver`; `prorrata.gestionar` → `prorrata.ver`) y todo permiso de cliente (`clientes.*`, credenciales, SIRE, ajustes, buzón, reglas, prorrata) exige `clientes.ver`. Si falta, se rechaza; no se completa solo.
- U4 Alcance global o asignado por rol; uno global solo lo crea o edita quien tiene alcance global.
- U5 Eliminar un rol con miembros activos o invitaciones vigentes: 409 `rol_en_uso` con ambos conteos.
- U6 Editar un rol en uso aplica a sus miembros en la siguiente petición; si pierde `sire.clasificar`, sus miembros dejan de ser responsables y esos clientes quedan sin responsable (005 D18). La UI avisa antes con los conteos.
- U7 Un rol propio nunca cuenta como Dueño; 005 D10 no cambia.
- U8 U2 de 029 tal cual: si el rol gana un permiso sensible, sus miembros sin TOTP quedan exigidos; la UI lo advierte.
- U9 Máximo 20 roles propios por estudio en todos los planes: 409 `limite_roles`.
- U10 Los avisos que hoy van a Dueño y Administrador (buzón crítico, límite de plan, credencial inválida) siguen solo para ellos.
