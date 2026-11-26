# Cierre 030 · Roles personalizados

Estado: hecha (2026-11-26). Rama `spec/030-roles-personalizados` sin mergear, sobre la rama de 029 (también sin mergear). Commits de `cf0d7a3` (spec) a `0af8e9a` (T17 aprobada), más este cierre. Decisiones del usuario: U1–U10 con la opción recomendada; confusables aceptados; 0084 aprobado.

## Qué se entregó
- Roles propios por estudio: `/roles` (crear, editar, eliminar, impacto, asignables, auditoría) y asignación a membresías e invitaciones con la regla de contención (U2: nadie da un rol con permisos o alcance que no tiene).
- Backend: guards de permiso y alcance, escalada al asignar, TOTP (`auth/totp/exigencia.ts`) y `/yo`.
- Frontend: «Equipo → Roles», selector de rol y nombre del rol propio en la invitación (T15a).
- Revalidación de los trabajos del worker con permisos efectivos y alcance (T17a).
- Cobertura ≥ 90 % por archivo (T14, `57a14c1`), E2E con Mailpit (T15, `8af3988`) y CA-1 a CA-12 verificados con evidencia (T16, `resultados.md`).

## Migraciones
0082 roles propios (tablas, funciones y disparadores; T6) · 0083 auditoría de cambios de rol en membresías · 0084 eliminar un rol (riesgo 5) · 0085 corrección de la ronda 1 (T13) · 0086 corrección de la ronda 2 (T13b) · 0087 revalidación del worker (T17a). Siguiente libre: 0088.

## Rondas adversariales
- Ronda 1 (T11 caja negra, T12 caja blanca): 9 hallazgos (2 altos, 3 medios, 4 bajos). Corregidos en T13: HTTP en `ec25bae`; SQL en `3ca88db` (0085).
- Ronda 2 (T13a): 1 alto, 1 medio, 1 bajo. Corregidos en `e9b4320` (0086, T13b). Cierre de la ronda en `82cd744`.
- Detalle y resolución: `docs/specs/HALLAZGOS.md`, filas de 030.

## T17, T17a y T17b
- Revisión final T17 (`7389e49`): no aprobada por T17-1 (bloqueante). El despachador del worker revalidaba al encolador solo por rol de sistema. Corregido en T17a (`d80780f`, `8921980`): 0087, `SQL_REVALIDAR` con `acceso.permisos_membresia` y `Revalidable.permiso`.
- Re-revisión (`b6427ea`): no aprobada por T17-2 (bloqueante de pruebas). La limpieza de `revalidacion.int.spec.ts` dejaba huérfanos en `rol_permiso`. Corregido en T17b (`598db0e`).
- Cierre T17 (`0af8e9a`): aprobada.

## Riesgos aceptados
1. Confusables u homoglifos en nombres de rol (p. ej., «Dueño» con cirílica): no se detectan. `it.fails` lo documenta. Aceptado por el usuario.
2. ZWJ se rechaza en nombres de rol: los emoji compuestos no se aceptan.
3. Disparadores SECURITY INVOKER: el de asignación (`rol_propio_asignar`) y el por sentencia de `invitacion`. Deben ver quién escribe (decisión de T6). El orden D4 se mantiene.
4. Desviación de U6: la fila de responsable pasa a colaborador; no se borra.
5. 0084: al eliminar un rol, se borran sus invitaciones no vigentes y sus miembros desactivados pasan a `lectura`. El usuario lo aprobó explícitamente el 2026-11-26; `resultados.md` lo registraba como pendiente de aval al cierre de T17.
6. El worker puede consultar `acceso.permisos_membresia` de cualquier estudio (SECURITY DEFINER con `p_tenant` libre). `SQL_REVALIDAR` solo le pasa estudios visibles por RLS. La función devuelve permisos y alcance, nunca datos de negocio.
7. El backend no repite U2 antes de la BD en `POST/PATCH /roles`: la BD responde 42501 y el backend lo traduce a 403 `escalada`.
8. Fallos de entorno, no de 030: 9 fallas idénticas desde T16 (`escalada.adv` 025–028 e inventario: 5; `correo-funciones`: 1; `reglas-lote`: 2; `credencial-r1a`: 1 por `MERGE … RETURNING`). Causa: `contapp_pruebas` es superusuario y PG 16 no tiene `MERGE … RETURNING`.

## Verificación
- `queue --mode int`: 123/123. `tests/aislamiento`: 4134 verdes, 2 `expected fail`, 9 fallas de entorno (punto 8).
- `packages/db`: 2513/2513. `packages/queue`: 790/790 (T17a).

## Modelos efectivos
`opus` = `claude-opus-5-5` (así lo registra la revisión T17). El resto, según la columna Modelo de `tasks.md`.
