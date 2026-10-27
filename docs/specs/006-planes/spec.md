# Spec 006 · Planes, registro de estudio y límites

Estado: borrador
Nivel de riesgo: B — sí a (3): un límite que no se aplica (o se aplica de menos) no lo nota el contador y se traduce en cobro perdido; sí a (4): carreras entre invitaciones, importaciones y reactivaciones simultáneas contra un cupo compartido. No a (1): no calcula montos tributarios. No a (2) directo: el registro público y el panel de plataforma son superficies nuevas, pero no leen datos de otro estudio (el adversario se pide solo en un punto, P6).
Cubre: RF-001, RF-002, RF-003, RF-004 · HU-01, HU-02 · HU-03 criterio 2 (límite de usuarios, que 005 dejó aquí)

## Objetivo
Que los límites comerciales vivan en la base de datos y se apliquen en el backend: el super-admin define planes, un visitante registra su estudio y arranca una prueba de 14 días, y ninguna acción (invitar, aceptar, reactivar, crear/importar/reactivar clientes) supera el máximo de usuarios o de RUCs del plan, ni siquiera con peticiones simultáneas.

## Alcance
- Tablas de plataforma `plan` y `suscripcion` (campos de 01 §3; uno por estudio, con `rucs_extra_contratados`), con los 5 planes de 01 §3 sembrados y los estudios existentes migrados a un plan (D1, D2). Sin límite = `NULL` (D1).
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
- [ ] CA-5 (límite de RUCs, RF-003/HU-02): `CupoRucs` rechaza con 409 `cupo_rucs` crear, importar o reactivar si `activos + n` supera `max_rucs + rucs_extra_contratados`; con N cupos libres informa cuántos entran. Archivar libera el cupo en la misma consulta siguiente. Con dos importaciones simultáneas que juntas superan el límite, entra solo la que cabe (el bloqueo es el de D4).
- [ ] CA-6 (límite de usuarios, RF-004/HU-03): `alInvitar` y `alReactivar` rechazan con 409 `cupo_usuarios` si `usuarios + n` supera `max_usuarios`; `alAceptar` también, en la transacción de la aceptación. Con dos invitaciones simultáneas con un solo cupo libre, solo una se crea. El conteo se define en D7.
- [ ] CA-7 (bajar de plan): si un plan se edita o un estudio pasa a otro menor y ya excede el límite, no se borra ni desactiva nada; solo se bloquea agregar hasta regularizar (01 §3).
- [ ] CA-8 (aislamiento): `plan`/`suscripcion` no filtran datos de otro estudio: el estudio solo lee su suscripción y los planes que necesita ver; las respuestas de límite no incluyen precios internos ni datos de otros estudios. La suite HU-40 de 005 sigue verde con los endpoints nuevos.
- [ ] CA-9 (regresión): las suites de 004 y 005 siguen verdes con el adaptador real (el seed asigna un plan sin límite práctico a los estudios de prueba de 005).
- [ ] CA-10 (frontend): el registro y la confirmación funcionan; un banner o indicador muestra "usados de límite" de RUCs y usuarios y avisa al llegar al máximo con acción "archivar o subir de plan"; el super-admin gestiona planes en una pantalla. El backend sigue siendo la barrera (RNF-007).
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 002 (RLS, `withTenant`, `tenant`, rol `contapp_platform`), 004 (sesión, `Correo`, `fijarContrasena`, esquema `auth`, límite por IP), 005 (puerto `CupoUsuarios`, orden global de bloqueo, `invitacion`, `membresia`). Todas hechas. 007 depende de 006 (puerto `CupoRucs`).
- Externas: ninguna (correo con adaptador `consola`/memoria en desarrollo).

## Decisiones propuestas
- D1 Planes: `plan` (campos de 01 §3) y `suscripcion` (tenant, plan, estado `prueba`|`activa`, `prueba_vence_en`, `rucs_extra_contratados`, uno vigente por estudio). `max_usuarios` y `max_rucs_extra` pueden ser `NULL` = ilimitado; Corporativo se siembra con 600 RUCs y usuarios `NULL`. Los 5 planes de 01 §3 son seed, sus precios son hipótesis y se editan en BD. Estudio sin suscripción: los cupos fallan cerrado (409), nunca "sin límite".
- D2 Los estudios existentes (seed de 002) se migran a una suscripción; `tenant` no cambia salvo `ruc_estudio` opcional (informativo, sin unicidad).
- D3 Registro en dos pasos con correo (ver P2): `POST` público registra la intención y envía el enlace; la confirmación crea todo con una función `SECURITY DEFINER` de `contapp_auth`, como la aceptación de invitaciones de 005. Si el correo ya tiene cuenta, el enlace pide iniciar sesión y crea el estudio para esa cuenta sin tocar su contraseña (como D15 de 005).
- D4 `CupoRucs` es un puerto con dos operaciones: `libres` (para la vista previa de 007) y `reservar(n)` (lanza 409 `cupo_rucs`). Ambas corren en la transacción del llamador, toman `FOR UPDATE` sobre la fila de `suscripcion` del estudio y cuentan después, lo que serializa invitar/importar simultáneos. El plan fija el lugar del bloqueo de `suscripcion` en el orden global de 005 (tras `bloquearMiembros`) y una prueba de carrera lo vigila contra interbloqueos. Hoy `cliente` no tiene estado: 006 cuenta todas las filas y 007, al agregar archivado, cambia el conteo a activos y llama al puerto en crear, importar y reactivar (nota en ESTADO para 007).
- D5 Super-admin: ver P1.
- D6 Límite efectivo de RUCs = `max_rucs + rucs_extra_contratados`, con `rucs_extra_contratados <= max_rucs_extra` del plan (el super-admin lo fija; el Dueño no puede en R1).
- D7 Usuarios que cuentan: membresías activas (el Dueño cuenta) más invitaciones pendientes vigentes. `alAceptar` solo exige `activos + 1 <= max` (la invitación ya estaba contada). Ver P3.

## Preguntas abiertas
- P1 Super-admin y gestión de planes (RF-001). Hoy no existe sesión de super-admin y el rol `contapp_platform` queda fuera del login de la app (002 D8). Opciones: (A) planes solo por seed/CLI con `MIGRATIONS_DATABASE_URL`, sin API ni pantalla; (B) tabla `admin_plataforma` (alta solo por seed/CLI, sin ruta de auto-alta) + endpoints `@SoloPlataforma()` con la misma sesión de 004, escritura por funciones `SECURITY DEFINER` limitadas a `plan` y `suscripcion`, y una pantalla simple; (C) panel con conexión separada `PLATFORM_DATABASE_URL` (proceso/credencial propios). Recomiendo B: cumple RF-001 completo; el riesgo (super-admin sin TOTP hasta R2, RF-012) se acepta y queda anotado. A es lo más seguro pero no cumple "super-admin puede".
- P2 Flujo de registro (HU-01 pide "confirmé mi correo"). Opciones: (A) el estudio se crea al confirmar el enlace del correo (D3); (B) se crea todo al enviar el formulario y el login queda bloqueado hasta confirmar. Recomiendo A: no deja estudios sin dueño verificado, no filtra qué correos existen y reutiliza el patrón de invitación de 005.
- P3 Conteo de usuarios (D7). Opciones: (A) activos + invitaciones pendientes; (B) solo activos (una invitación pendiente podría fallar al aceptar). Recomiendo A, para que el aviso salga al invitar y no al aceptar.
- P4 Plan Prueba con 1 usuario (01 §3): durante la prueba el Dueño no puede invitar a nadie. Opciones: mantener 1 (dato del plan, editable sin código) o sembrar 2. Recomiendo mantener 1 como dice 01 y confirmarlo en la revisión de precios.
- P5 Adicionales y edición de plan. (a) ¿Incluir `rucs_extra_contratados` en 006 (RF-003 los menciona) aunque la contratación por el Dueño sea R3? Recomiendo sí, fijado por el super-admin. (b) Editar un plan cambia a todos sus estudios al instante (límites en `plan`) en vez de versionarlo. Recomiendo edición directa; los estudios que exceden se bloquean sin borrar (CA-7).
- P6 Adversario puntual (04 §2.1 permite pedirlo en un punto de un nivel B): ¿sobre el registro público y su enlace (enumeración, reuso, carrera, abuso de tenants basura)? Recomiendo sí, 1 ronda y solo ahí; las carreras de cupo las cubre TDD.
