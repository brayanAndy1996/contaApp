# Spec 005 · Roles, permisos, asignación y alcance

Estado: aprobada (2026-10-26: el usuario aprueba D1–D14 y las recomendaciones de P1–P7, ahora D15–D21)
Nivel de riesgo: A — sí a (2): un fallo de permiso o de alcance muestra clientes de otro usuario o de otro estudio, o deja a un asistente aprobar o tocar credenciales; sí a (3): un cliente visible de más o una escalada de rol no se notan a simple vista; sí a (4): 5 roles × permisos × endpoints, más carreras (último Dueño, responsable único, invitación aceptada dos veces). (1) solo de forma indirecta.
Cubre: RF-020, RF-021, RF-023, RF-024, RF-025, RF-026 (mecanismo y endpoints de 005), RF-027, RF-028 · HU-03 (salvo el límite del plan, que va en 006), HU-07, HU-08 · HU-40 "por API" (heredado de 002, D2) · RNF-007

## Objetivo
Que el Dueño o el Administrador invite a su equipo con un rol, asigne clientes (responsable y colaboradores) y que cada usuario vea y haga solo lo que su rol y sus asignaciones permiten. La regla se aplica en el backend en cada petición y se niega por defecto. Entrega los guards `PermisoGuard` y `ClienteScopeGuard` que usarán todas las specs siguientes.

## Alcance
- Catálogo de permisos y roles de sistema (01 §4) en `packages/shared`; rol por membresía (D1, D2).
- `PermisoGuard` y `ClienteScopeGuard` después de los guards de 004, con denegación por defecto (D4) y un filtro de alcance único para listados (D5).
- Invitaciones: crear, reenviar, revocar, listar pendientes y aceptar (pantalla pública y función `auth.*`, D7).
- Miembros: listar, cambiar rol, desactivar y reactivar (RF-027), con el invariante del último Dueño en BD (RF-028, D10).
- Asignación individual y masiva de clientes (tabla `asignacion`, D6) y lectura mínima de clientes filtrada por alcance (D12, D20).
- Frontend: Usuarios, aceptación de invitación y asignación de clientes; los menús se ocultan según `GET /acceso/yo`.
- Suite HU-40 "por API" con dos estudios sobre los endpoints de 004 y 005 (D14).

## Fuera de alcance
- Límite de usuarios del plan (RF-004, HU-03 criterio 2) → 006. 005 deja el puerto `CupoUsuarios` con un adaptador sin límite (D11).
- Crear, editar, importar y archivar clientes, y credenciales (HU-06, HU-09) → 007. 005 usa la tabla `cliente` de 002 y el seed.
- Roles personalizados (RF-022, HU-05) → R2. TOTP obligatorio para Dueño y Administrador (RF-012) → R2. Registro de estudio (HU-01) → 006.
- Filtro de alcance en búsquedas, exportaciones, notificaciones y buzón de cada módulo: lo aplica cada spec con el filtro de D5 (RF-026). Auditoría de cambios de rol y de asignación → 017. Trabajos en cola de un cliente desasignado → 008.
- Transferir el estudio o eliminarlo, y que un usuario abandone un estudio por su cuenta: no en R1.

## Criterios de aceptación
- [ ] CA-1 (roles, RF-021/023): una prueba de tabla recorre los 5 roles × todos los endpoints de 005 y verifica 2xx o 403 según la matriz de D2. No existe endpoint que modifique los permisos de un rol de sistema. Dueño y Administrador ven todos los clientes y los demás roles, solo los asignados.
- [ ] CA-2 (invitar, RF-020/HU-03): con `usuarios.gestionar`, invitar con correo y rol responde igual exista o no una cuenta con ese correo en la plataforma. En BD solo queda el SHA-256 del token, que vence a las 72 h. El correo sale por el puerto `Correo` de 004 fuera de la petición. Invitar a quien ya es miembro activo da 409; reenviar invalida el token anterior y revocar lo anula.
- [ ] CA-3 (aceptar): con un token válido y una cuenta nueva se crean el usuario, su contraseña (política de 004 CA-4, con `fijarContrasena`) y la membresía con el rol invitado, todo en una transacción. Si dos aceptan a la vez, uno funciona y el otro falla. Un token reusado, vencido, revocado, alterado o de otro estudio da siempre la misma respuesta. Si el correo ya tiene cuenta, se aplica D15 y nunca se cambia su contraseña.
- [ ] CA-4 (escalada, D8): un Administrador no puede invitar, ascender, degradar ni desactivar a un Dueño (403). Nadie puede otorgar un permiso que no tiene, cambiar su propio rol ni desactivarse. Los campos de rol o `tenantId` en el cuerpo de una petición se ignoran, salvo el rol en las rutas que lo reciben.
- [ ] CA-5 (alcance, HU-08): si un asistente tiene 15 de 120 clientes asignados, `GET /clientes` devuelve esos 15. Un cliente no asignado, uno inexistente y uno de otro estudio dan el mismo 404 (código, cuerpo y cabeceras salvo `Date`). Una ruta con `:clienteId` exige permiso (403) antes de mirar el cliente, así que el 403 no revela si existe.
- [ ] CA-6 (efecto inmediato): con una sesión viva, después de desasignar un cliente, cambiar el rol o desactivar al usuario, la siguiente petición ya refleja el cambio (404, 403 o sin estudio activo) sin volver a iniciar sesión (D3).
- [ ] CA-7 (asignación, RF-024/HU-07): cada cliente tiene como máximo un responsable (índice único). Al elegir uno nuevo, el anterior pasa a colaborador o se retira, según lo que pida el usuario. Dos asignaciones de responsable simultáneas al mismo cliente dejan exactamente uno. Solo se asigna a miembros activos que cumplan D18; un usuario o cliente de otro estudio da 404.
- [ ] CA-8 (masiva, RF-025): se asignan hasta 500 clientes a un usuario o hasta 500 usuarios a un cliente en una petición, todo o nada. Si el lote trae un ID ajeno o inexistente, no se aplica nada y la respuesta no dice cuál falló. El usuario ve los clientes en su siguiente petición.
- [ ] CA-9 (desactivar, RF-027): desactivar marca la membresía, sin borrar al usuario ni su historial. Las sesiones de ese usuario con ese estudio activo quedan sin estudio en la siguiente petición; sus sesiones en otros estudios siguen. Sus clientes como responsable quedan "sin responsable" y sus colaboraciones siguen D19. Reactivar devuelve el acceso con su rol.
- [ ] CA-10 (último Dueño, RF-028): degradar o desactivar al único Dueño activo da 409. Si dos Dueños se degradan a la vez, al menos uno queda. El invariante también vale en BD: un `UPDATE` directo con `contapp_backend` que deja 0 Dueños falla.
- [ ] CA-11 (denegación por defecto, D4): una prueba recorre las rutas registradas en Nest y falla si alguna no declara permiso, `@SoloSesion` o `@Publica`, o si tiene parámetro `clienteId` sin `ClienteScopeGuard`. Agregar una ruta sin declarar rompe la prueba.
- [ ] CA-12 (HU-40 por API, heredado de 002 D2): con los estudios A y B, un usuario de A llama a todos los endpoints de 004 y 005 con IDs de B (cliente, usuario, membresía, invitación, asignación) en URL, cuerpo y lotes, y siempre recibe 404 o listas sin datos de B. La prueba es simétrica y corre en el CI de aislamiento.
- [ ] CA-13 (BD): `asignacion` e `invitacion` tienen RLS `ENABLE` + `FORCE` (la prueba de catálogo de 002 CA-3 las cubre) y FK compuestas con `tenant_id` hacia `cliente` y `membresia`. `contapp_backend` sigue sin escribir `auth.*`, salvo por las funciones de D7. Pasan el lint de SQL crudo y el lint que impide al backend importar `@contapp/crypto/descifrado`.
- [ ] CA-14 (sin fugas, RNF-004): un token de invitación y una contraseña canario no aparecen en logs, errores ni respuestas. Ni crear ni listar invitaciones devuelve el token ni su hash; la única excepción es el adaptador `consola` en desarrollo, como en 004.
- [ ] CA-15 (frontend): la pantalla Usuarios lista miembros con rol y estado, e invitar, reenviar, revocar, cambiar rol, desactivar y reactivar. La invitación lee el token del fragmento y la página envía `Referrer-Policy: no-referrer`. La asignación de clientes es individual y masiva. Las acciones sin permiso se ocultan, pero el backend sigue siendo la barrera (RNF-007).
- [ ] CA-16 (adversario): hasta 2 rondas (04 §2.3), al menos con los ataques de abajo. Todo hallazgo queda corregido o aceptado por el usuario, y los `*.adv.spec.ts` quedan como regresión.
- [ ] Casos reales aplicables: ninguno.

**Cobertura (DoD A):** lo que 005 agrega en `apps/backend` (guards y módulos de acceso), `packages/db` y `packages/shared`, sin pruebas; ≥ 90 % por archivo con `pnpm cobertura:acceso`. El plan fija la lista exacta.

**Ataques mínimos del adversario:** asistente o lectura llamando a endpoints de gestión, asignación y aprobación; usuario desactivado con sesión viva; cliente desasignado durante la sesión; rol cambiado durante la sesión; IDOR con IDs de otro estudio o no asignados en URL, cuerpo y lotes mezclados; asignación masiva de campos (`rol`, `tenantId`, `usuarioId`); escalada de Administrador a Dueño, autoascenso y autodesactivación; carrera por el último Dueño y por el responsable único; token de invitación reusado, concurrente, vencido, revocado, de otro estudio, aceptado con otra sesión u otro correo; enumeración de cuentas al invitar; oráculos 403/404 por tiempo o cabeceras; ruta nueva sin declarar permiso.

## Dependencias
- Specs: 002 (RLS, `withTenant`, tabla `cliente`, prueba de catálogo), 003 (no fugas, veto a `descifrado`), 004 (sesión, `SesionGuard`, estudio activo, `Correo`, `fijarContrasena`, esquema `auth`). Todas hechas. Rama `spec/005-acceso` desde `spec/004-auth`.
- 006 y 007 dependen de 005, no al revés (D11, D12). Externas: ninguna.

## Decisiones
- D1 Roles en código: catálogo de permisos y 5 roles de sistema en `packages/shared`. `membresia.rol` pasa a un `CHECK` con `dueno|admin|contador|asistente|lectura`. La migración convierte el seed: el primer `admin` de cada estudio pasa a `dueno`. Las tablas `rol` y `rol_permiso` se crean en R2 con HU-05 (D21).
- D2 Matriz (01 §4; celdas confirmadas en D17). Dueño: todos los permisos. Administrador: todos menos `plan.gestionar`. Contador: `clientes.ver`, `credenciales.editar`, `sire.*`, `ajustes.*`, `buzon.*`, `reglas.*` y `prorrata.ver`. Asistente: `clientes.ver`, `sire.descargar`, `sire.clasificar`, `buzon.*`, `reglas.ver` y `prorrata.ver`. Lectura: `clientes.ver`, `buzon.ver`, `reglas.ver` y `prorrata.ver`. Alcance global para Dueño y Administrador; asignado para el resto (D16).
- D3 En cada petición se leen el rol y el estado de la membresía y las asignaciones desde la BD, dentro de `withTenant`. No se guardan en la sesión ni en caché.
- D4 Orden de guards: Sesión → Estudio (004) → Permiso (403) → Alcance del cliente (404). Toda ruta declara `@Permiso(...)`, `@SoloSesion()` o `@Publica()`; si no declara nada, se rechaza (CA-11).
- D5 La visibilidad dentro del estudio la aplica el backend (ADR-05; RLS sigue separando solo estudios). Hay un único filtro de alcance en `packages/db` que reciben todos los listados de esta spec y de las siguientes.
- D6 Tabla `asignacion(tenant_id, cliente_id, usuario_id, tipo)` con `UNIQUE (tenant_id, cliente_id, usuario_id)`, índice único parcial de responsable por cliente y FK compuestas hacia `cliente(tenant_id, id)` y `membresia(tenant_id, usuario_id)`. "Sin responsable" se deriva de la falta de fila.
- D7 Tabla `invitacion` con estudio, correo normalizado (ASCII, D13 de 004), rol, quién invita, SHA-256 del token, vencimiento a 72 h y fechas de aceptación y revocación. El token es de 32 B y va en el fragmento (`/invitacion#t=…`). El consumo es atómico. La aceptación pasa por funciones `SECURITY DEFINER` del esquema `auth` (como D10 de 004): el backend calcula el hash con `fijarContrasena` y la función guarda el usuario, la contraseña y la membresía.
- D8 Contra la escalada: solo un Dueño invita, asciende, degrada o desactiva a un Dueño. Nadie otorga permisos que no tiene. Nadie cambia su propio rol ni se desactiva.
- D9 La desactivación es de la membresía (`desactivada_en`), no de la cuenta, que puede estar en otros estudios. Las funciones de `auth` de 004 pasan a exigir una membresía activa, así que se reutiliza el camino de 004 CA-9.
- D10 El invariante del último Dueño vive en BD: un trigger con bloqueo por estudio rechaza el cambio que deja 0 Dueños activos.
- D11 Para 006: el puerto `CupoUsuarios` se llama en la misma transacción al invitar y al aceptar. 005 trae el adaptador `sin-limite` y 006 lo reemplaza.
- D12 Para 007: 005 solo lee `cliente` (id, RUC, razón social) para listar y asignar. Las FK de 005 apuntan a la tabla que ya existe.
- D13 Lo que no es visible responde 404, igual que lo inexistente. La falta de permiso responde un 403 genérico. El estudio sale solo de la sesión, nunca de la URL ni del cuerpo.
- D14 HU-40 por API: la suite vive en `tests/aislamiento/` y se agrega al job de CI de 002.

## Decisiones del usuario (antes P1–P7)
Aprobación textual del 2026-10-26: "Apruebo la spec 005 con todo lo recomendado: P1 a, P2 a, P3 confirmar tal cual, P4 a, P5 a, P6 a, P7 a."
- D15 (P1 a) Invitación a un correo que ya tiene cuenta: para aceptarla hay que iniciar sesión como ese usuario. El token solo no autentica una cuenta existente.
- D16 (P2 a) Alcance fijo por rol en R1: global para Dueño y Administrador; asignado para el resto. El alcance por miembro llega con los roles personalizados (R2).
- D17 (P3) Celdas de D2 confirmadas tal cual: Contador con `credenciales.editar` y `prorrata.ver`; Asistente con `buzon.marcar_leido`, `reglas.ver` y `prorrata.ver`; Lectura con `reglas.ver` y `prorrata.ver`; `usuarios.ver` y `auditoria.ver` solo para Dueño y Administrador.
- D18 (P4 a) Responsable: un miembro activo con `sire.clasificar`. Si lo pierde al cambiar de rol, el cliente queda sin responsable.
- D19 (P5 a) Al desactivar, las colaboraciones se retiran y no vuelven al reactivar.
- D20 (P6 a) 005 trae lectura mínima de clientes (`GET /clientes`, `GET /clientes/:clienteId`) y una pantalla mínima con asignación, que 007 amplía. HU-07 y HU-08 se cierran aquí.
- D21 (P7 a) Roles en código más `CHECK` en `membresia.rol`; las tablas `rol` y `rol_permiso` llegan en R2.

Sin preguntas pendientes.
