# Spec 006 · Planes, registro de estudio y límites

Estado: aprobada (2026-10-27: el usuario aprueba la spec con todo lo recomendado en P1–P6, ahora D5, D3, D7, D10, D11 y D12)
Nivel de riesgo: B — sí a (3): un límite que no se aplica (o se aplica de menos) no lo nota el contador y se traduce en cobro perdido; sí a (4): carreras entre invitaciones, importaciones y reactivaciones simultáneas contra un cupo compartido. No a (1): no calcula montos tributarios. No a (2) directo: el registro público y el panel de plataforma son superficies nuevas, pero no leen datos de otro estudio (el adversario se pide solo en ese punto, D12).
Cubre: RF-001, RF-002, RF-003, RF-004 · HU-01, HU-02 · HU-03 criterio 2 (límite de usuarios, que 005 dejó aquí)

## Objetivo
Que los límites comerciales vivan en la base de datos y se apliquen en el backend: el super-admin define planes, un visitante registra su estudio y arranca una prueba de 14 días, y ninguna acción (invitar, aceptar, reactivar, crear/importar/reactivar clientes) supera el máximo de usuarios o de RUCs del plan, ni siquiera con peticiones simultáneas.

## Alcance
- Tablas de plataforma `plan` y `suscripcion` (campos de 01 §3; uno por estudio, con `rucs_extra_contratados`), con los 5 planes de 01 §3 sembrados y los estudios existentes migrados a un plan (D1, D2). Sin límite = `NULL` en `max_usuarios` (D1).
- Gestión de planes por el super-admin: crear, editar y desactivar (RF-001), y asignar plan y RUCs adicionales a un estudio (D5, D6).
- Registro público de estudio con prueba de 14 días y plan Prueba: el visitante queda como Dueño (RF-002, HU-01) (D3).
- Adaptador real del puerto `CupoUsuarios` de 005 (D8), que reemplaza `CupoSinLimite` por defecto en `crearApp`, y puerto nuevo `CupoRucs` que 007 consumirá (D4).
- `GET` de plan y uso del estudio (usados / límite / libres) para que el frontend avise al llegar al límite (HU-02). Frontend mínimo: registro, indicador de uso y pantalla de planes del super-admin.

## Fuera de alcance
- Crear, importar y archivar clientes (RF-030–039, HU-06) y la vista previa de importación → 007. 006 entrega el puerto y la regla; 007 lo llama (D4).
- Cambio de plan por el Dueño, vencimiento y solo lectura al expirar la prueba o la suscripción (RF-005, RF-006), cobro en línea y comprobante (RF-007), listado de estudios del super-admin (RF-008) → R2/R3. 006 solo guarda la fecha de fin de prueba.
- TOTP del super-admin (RF-012), acceso de soporte a datos de un tenant (RNF-022) → R2.
- Uso por feature (`features`, frecuencia de buzón): se guardan en el plan, pero los aplica quien los consume (008 para el buzón).

## Criterios de aceptación
- [ ] CA-1 (planes, RF-001): el super-admin crea, edita y desactiva planes con precio mensual y anual, `max_rucs`, `max_usuarios`, `precio_ruc_extra`, `max_rucs_extra`, `frecuencia_buzon_min` y `features`. Valores inválidos (negativos, límites en 0, tope extra sobre el 20 % de `max_rucs`) se rechazan. Un plan desactivado no se puede asignar a estudios nuevos, y quienes ya lo tienen lo conservan. Ningún usuario de estudio, ni siquiera el Dueño, puede escribir en `plan` ni en el plan de su suscripción.
- [ ] CA-2 (límite de plan en BD): los límites salen siempre de `plan` + `suscripcion`; no hay un número de límite en el código (prueba que cambia el plan en BD y el comportamiento cambia sin reiniciar). `NULL` en `max_usuarios` significa sin límite.
- [ ] CA-3 (registro, RF-002/HU-01): con nombre del estudio, RUC del estudio opcional (11 dígitos), nombre y correo del dueño, el visitante recibe un correo con un enlace de un solo uso (D3). Al confirmarlo y fijar su contraseña (política de 004 CA-4) se crean, en una transacción, el estudio, el usuario, la membresía de Dueño y la suscripción al plan Prueba con vencimiento a 14 días y 5 RUCs. El enlace usado, vencido o alterado da siempre la misma respuesta; dos confirmaciones simultáneas crean un solo estudio.
- [ ] CA-4 (registro sin oráculo): pedir el registro responde igual exista o no una cuenta con ese correo, sin variación de código, cuerpo ni tiempo apreciable (como 004 CA-2/CA-8). El token se guarda solo como hash y no aparece en logs, errores ni respuestas. Hay límite por IP y por correo (429).
- [ ] CA-5 (límite de RUCs, RF-003/HU-02): `CupoRucs` rechaza con 409 `cupo_rucs` crear, importar o reactivar si `activos + n` supera el límite efectivo de D6; con N cupos libres informa cuántos entran. Archivar libera el cupo en la misma consulta siguiente. Con dos importaciones simultáneas que juntas superan el límite, entra solo la que cabe (el bloqueo es el de D4).
- [ ] CA-6 (límite de usuarios, RF-004/HU-03): `alInvitar` y `alReactivar` rechazan con 409 `cupo_usuarios` si `usuarios + n` supera `max_usuarios`; `alAceptar` también, en la transacción de la aceptación. Con dos invitaciones simultáneas con un solo cupo libre, solo una se crea. El conteo se define en D7.
- [ ] CA-7 (bajar de plan): si un plan se edita o un estudio pasa a otro menor y ya excede el límite, no se borra ni desactiva nada; solo se bloquea agregar hasta regularizar (01 §3).
- [ ] CA-8 (aislamiento): `plan`/`suscripcion` no filtran datos de otro estudio: el estudio solo lee su suscripción y los planes que necesita ver; las respuestas de límite no incluyen precios internos ni datos de otros estudios. La suite HU-40 de 005 sigue verde con los endpoints nuevos.
- [ ] CA-9 (regresión): las suites de 004 y 005 siguen verdes con el adaptador real (el seed asigna un plan sin límite práctico a los estudios de prueba de 005).
- [ ] CA-10 (frontend): el registro y la confirmación funcionan; un banner o indicador muestra "usados de límite" de RUCs y usuarios y avisa al llegar al máximo con acción "archivar o subir de plan"; el super-admin gestiona planes en una pantalla. El backend sigue siendo la barrera (RNF-007).
- [ ] CA-11 (adversario, D12): una ronda sobre el registro público y su enlace (enumeración por respuesta o tiempo, reuso, carrera de confirmación, abuso para crear estudios basura, token en logs); todo hallazgo queda corregido o aceptado por el usuario y los `*.adv.spec.ts` quedan como regresión.
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 002 (RLS, `withTenant`, `tenant`, rol `contapp_platform`), 004 (sesión, `Correo`, `fijarContrasena`, esquema `auth`, límite por IP), 005 (puerto `CupoUsuarios`, orden global de bloqueo, `invitacion`, `membresia`). Todas hechas. 007 depende de 006 (puerto `CupoRucs`).
- Orden de implementación 011 → 008 → 006 sobre una sola BD de pruebas local: 006 no usa nada de 008. Solo (a) sus migraciones toman los números siguientes a los de 008 al implementarse y (b) las pruebas de catálogo y `FUNCIONES_AUTH` se ajustan sobre el conteo vigente en ese momento, no sobre uno fijo. 008 no purga lo de 006: `registro_pendiente` se limpia solo (D3).
- Externas: ninguna (correo con adaptador `consola`/memoria en desarrollo).

## Decisiones
- D1 Planes: `plan` (campos de 01 §3) y `suscripcion` (tenant, plan, estado `prueba`|`activa`, `prueba_vence_en`, `rucs_extra_contratados`, uno vigente por estudio). `max_usuarios` puede ser `NULL` = ilimitado; Corporativo se siembra con 600 RUCs y usuarios `NULL`. `max_rucs_extra` es un entero con tope 20 % de `max_rucs`. Los 5 planes de 01 §3 son seed, sus precios son hipótesis y se editan en BD. Estudio sin suscripción: los cupos fallan cerrado (409), nunca "sin límite".
- D2 Los estudios existentes (seed de 002) se migran a una suscripción; `tenant` no cambia salvo `ruc_estudio` opcional (informativo, sin unicidad).
- D3 Registro en dos pasos con correo (P2 aprobada, opción A): `POST` público registra la intención y envía el enlace; la confirmación crea todo con una función `SECURITY DEFINER` de `contapp_auth`, como la aceptación de invitaciones de 005. Si el correo ya tiene cuenta, el enlace pide iniciar sesión y crea el estudio para esa cuenta sin tocar su contraseña (como D15 de 005). El enlace vence a las 24 h y la tabla de pendientes se limpia sola al registrar otro (los vencidos hace más de 7 días), sin depender de la purga de 008.
- D4 `CupoRucs` es un puerto con dos operaciones: `libres` (para la vista previa de 007) y `reservar(n)` (lanza 409 `cupo_rucs`). Ambas corren en la transacción del llamador, toman `FOR UPDATE` sobre la fila de `suscripcion` del estudio y cuentan después, lo que serializa invitar/importar simultáneos. El plan fija el lugar del bloqueo de `suscripcion` en el orden global de 005 (tras `bloquearMiembros`) y una prueba de carrera lo vigila contra interbloqueos. Hoy `cliente` no tiene estado: 006 cuenta todas las filas y 007, al agregar archivado, cambia el conteo a activos y llama al puerto en crear, importar y reactivar (nota en ESTADO para 007).
- D5 Super-admin (P1 aprobada, opción B): tabla `admin_plataforma` con alta solo por seed/CLI, sin ruta de auto-alta; endpoints `@SoloPlataforma()` con la misma sesión de 004 (no exigen estudio); toda escritura de planes y suscripciones pasa por funciones `SECURITY DEFINER` que revalidan la sesión y el alta del admin, y solo tocan `plan` y `suscripcion`. Riesgo aceptado: sin TOTP del super-admin hasta R2 (RF-012).
- D6 Límite efectivo de RUCs = `max_rucs + min(rucs_extra_contratados, max_rucs_extra)` (D10); el Dueño no puede contratar adicionales en R1.
- D7 Usuarios que cuentan (P3 aprobada, opción A): membresías activas (el Dueño cuenta) más invitaciones pendientes vigentes. `alAceptar` solo exige `activos + 1 <= max` (la invitación ya estaba contada); `alInvitar` y `alReactivar` exigen `activos + pendientes + 1 <= max`.
- D8 `GET /plan/uso` (cualquier miembro, `@SoloEstudio`) devuelve nombre del plan, límites y uso, sin precios. Como el Dueño aún no puede cambiar de plan (RF-005 es R3), el aviso de límite dice que contacte a ContApp para subir de plan.
- D9 Prueba con 1 usuario (P4 aprobada): se mantiene el dato de 01 §3; el super-admin lo cambia en BD sin tocar código.
- D10 Adicionales (P5a aprobada): `rucs_extra_contratados` lo fija el super-admin en la suscripción; el límite efectivo usa `min(contratados, max_rucs_extra)`, así que bajar el tope del plan nunca da más cupo del permitido.
- D11 Edición de plan (P5b aprobada): se edita en sitio y vale para todos sus estudios al instante; quien excede queda bloqueado sin borrar (CA-7).
- D12 Adversario puntual (P6 aprobada): una ronda, en dos piezas (caja negra y caja blanca), solo sobre el registro público y su enlace (CA-11). Las carreras de cupo las cubre TDD.
- D13 El super-admin necesita ubicar estudios para asignarles plan: `GET /plataforma/estudios` mínimo (id, nombre, plan, estado). El listado completo con RUCs y uso de RF-008 sigue en R2.

## Preguntas abiertas
- Ninguna. Aprobada por el usuario (2026-10-27), textual: "Apruebo las specs 006, 008 y 011 con todo lo recomendado por el arquitecto en cada P. Continúa con plan y tareas."
