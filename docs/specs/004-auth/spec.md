# Spec 004 · Autenticación, sesión y multi-estudio

Estado: aprobada (por el usuario: D1–D12 y P1–P10 según la recomendación del arquitecto; P11–P13 respondidas por el usuario, antes Q1–Q3)
Nivel de riesgo: A — sí a (2): un fallo de sesión o de cambio de estudio expone datos de otro estudio o usuario; sí a (3): una fijación de sesión, un oráculo de enumeración o un token reusable no se notan a simple vista; sí a (4): intentos concurrentes, carreras al consumir tokens, varias pestañas y estudios. (1) no aplica.
Cubre: RF-010, RF-011, RF-013, RF-015, RF-014 en parte (logout y "cerrar todas mis sesiones", P2) · HU-04 · RNF-004, RNF-005, RNF-006, RNF-007 (parte de sesión), RNF-009 (login y recuperación)

## Objetivo
Que un usuario entre con correo y contraseña, recupere su contraseña por correo y, si pertenece a varios estudios, elija y cambie de estudio sin volver a autenticarse, con sesión por cookie revocable (ADR-11) y sin abrir oráculos ni caminos entre estudios. Entrega el módulo `auth` del backend, el `SesionGuard`, las tablas y funciones de BD de autenticación, el puerto de correo con adaptador de consola y las pantallas públicas y el selector de estudio.

## Alcance
- Backend `auth/`: login, logout, estado de sesión, recuperación (solicitar y restablecer), cambio de contraseña con sesión iniciada (P11), listar estudios del usuario (`withUsuario`) y cambiar de estudio. `SesionGuard` resuelve `{userId, tenantId}` **fuera** de `withTenant` y lo pasa al contexto de 03 §4.1.
- BD (`packages/db`): credencial de contraseña, sesión, token de recuperación e intentos de login, accesibles solo por funciones (D10). Email único sin distinguir mayúsculas.
- Puerto `Correo` con adaptador `consola` por defecto (`CORREO_PROVIDER=consola`), prohibido con `NODE_ENV=production`.
- Frontend: `login`, `recuperar`, `recuperar/nueva` (token en el fragmento), selector de estudio, cambio desde el menú y formulario mínimo de cambio de contraseña (P11). Esquemas zod en `packages/shared`.
- Semilla de desarrollo con usuarios de prueba (contraseña en el seed, nunca en el código).

## Fuera de alcance
- Registro de estudio (HU-01/02) → 006. Invitaciones y aceptación con contraseña inicial (HU-03) → 005; 004 deja la función de dominio para fijar contraseña.
- Permisos por rol y alcance de clientes (`PermisoGuard`, `ClienteScopeGuard`) → 005. Auditoría general de accesos → 017.
- TOTP (RF-012, P1) y lista de sesiones por dispositivo (resto de RF-014, P2) → R2. "Recordarme" (P6) y límite de sesiones simultáneas (P10): no en R1.

## Criterios de aceptación
- [x] CA-1 (login): con credenciales válidas responde 200, crea una sesión nueva y emite la cookie de D5. En BD solo queda el hash del token. Sin estudio activo hasta elegirlo, salvo que el usuario tenga un solo estudio: entonces queda activo en el login (P7).
- [x] CA-2 (respuesta única): correo inexistente, contraseña errónea y cuenta bloqueada dan el mismo código, cuerpo y cabeceras (salvo `Date`), sin `Set-Cookie`. Con correo inexistente se ejecuta igual una verificación Argon2id contra un hash ficticio (D9); la prueba verifica que se llama una vez en cada rama y que la diferencia de medianas en 200 intentos queda bajo el umbral que fije el plan.
- [x] CA-3 (bloqueo, RF-015): el 5.º fallo en 15 min bloquea la cuenta 15 min; durante el bloqueo, la contraseña correcta también se rechaza (CA-2). Un éxito reinicia el contador. Con 20 intentos fallidos concurrentes no hay más de 5 verificaciones antes del bloqueo (contador atómico). Los correos inexistentes también acumulan intentos. El límite por IP de D7 devuelve 429. Al bloquearse una cuenta existente se envía un aviso al titular, fuera de la petición, como máximo uno por cuenta cada 24 h (P3, P13). El bloqueo solo se levanta esperando o restableciendo la contraseña; no hay desbloqueo por el administrador (P4).
- [x] CA-4 (hash, RNF-005): las contraseñas se guardan en formato PHC Argon2id con parámetros ≥ el piso de D1 y sal única. Una configuración bajo el piso impide arrancar. Un hash con parámetros viejos se re-calcula en el siguiente login válido. Una contraseña mayor que el máximo de P5 se rechaza antes de calcular el hash. Una contraseña nueva debe tener de 12 a 128 caracteres (puntos de código), sin reglas de composición, y no estar en la lista local de contraseñas comunes (P5).
- [x] CA-5 (fijación y ciclo de vida): una cookie fijada antes del login nunca se promueve: el login siempre emite un token nuevo. El token rota al cambiar de estudio y al cambiar la contraseña, y el anterior deja de valer en el acto. Las caducidades de D3 se aplican en el servidor (alargar `Max-Age` en el navegador no sirve). Después del logout, reusar la cookie da 401. "Cerrar todas mis sesiones" revoca todas las sesiones del usuario (P2). No hay "recordarme" ni límite de sesiones simultáneas (P6, P10).
- [x] CA-6 (robo): un volcado de la tabla de sesiones no permite autenticarse (solo hay hashes SHA-256). Restablecer la contraseña revoca todas las sesiones del usuario.
- [x] CA-7 (CSRF, RNF-006): toda petición que cambia estado sin token CSRF válido de la sesión, o con `Origin`/`Sec-Fetch-Site` ajeno, recibe 403. Login, logout y recuperación también validan `Origin` (CSRF de login). Ningún `GET` cambia estado.
- [x] CA-8 (recuperación, RF-011): solicitar recuperación responde igual exista o no el correo, y el envío no altera el tiempo de respuesta. El token es de un solo uso, caduca a los 30 min, se guarda como hash y pedir otro invalida el anterior. Dos consumos concurrentes del mismo token: uno funciona y el otro falla. Token reusado, vencido, alterado o ajeno dan la misma respuesta. Al restablecer se avisa por correo al titular (P9).
- [x] CA-9 (multi-estudio, RF-013/HU-04): la lista de estudios sale de `withUsuario` y solo trae membresías propias. Al elegir uno, la API solo devuelve datos de ese estudio. Se cambia de estudio sin contraseña. Un estudio sin membresía o inexistente da la misma respuesta 403. Un estudio activo por sesión (P8). Si se revoca la membresía, la siguiente petición con ese estudio activo se rechaza y obliga a elegir de nuevo. Una petición cuyo encabezado `X-Estudio` no coincide con el estudio activo de la sesión recibe 409 (pestañas desfasadas, D12).
- [x] CA-10 (sin fugas, RNF-004): con contraseña y tokens canario, ninguno aparece en logs, errores (`message`, `stack`, `cause`), respuestas ni errores de `pg`. Ninguna respuesta incluye el hash. La única excepción es el adaptador `consola` en desarrollo, que imprime el enlace de recuperación por stdout, fuera del logger.
- [x] CA-11 (BD): `contapp_backend` no puede leer ni escribir directamente las tablas de D10 (`permission denied`); solo ejecuta las funciones. `contapp_worker` y `contapp_platform` no tienen `EXECUTE`. RLS sigue activo en `usuario`, `tenant` y `membresia`. El lint de SQL crudo pasa. El guard no anida `withTenant` ni lanza tareas que lo hagan (nota [004/008]).
- [x] CA-12 (frontend): las pantallas muestran mensajes genéricos (CA-2, CA-8). El formulario de nueva contraseña lee el token del fragmento y la página envía `Referrer-Policy: no-referrer`. El selector aparece con 2 o más estudios (el último usado resaltado); con uno se entra directo y sin estudios se muestra "No perteneces a ningún estudio activo" (P7). El cambio desde el menú recarga los datos del estudio nuevo. El mensaje de bloqueo es el mismo que el de credenciales inválidas (P3).
- [x] CA-13 (adversario): hasta 2 rondas (04 §2.3), al menos con los ataques de abajo. Todo hallazgo queda corregido o aceptado por el usuario, y los `*.adv.spec.ts` quedan como regresión.
- [ ] Casos reales aplicables: ninguno.

**Cobertura (DoD A):** `apps/backend/src/modules/auth/**`, el guard y lo que 004 agrega en `packages/db` y `packages/shared` (los lista el plan), sin pruebas. Medida con `pnpm cobertura:auth` (v8), ≥ 90 % en líneas, sentencias, funciones y ramas por archivo; el comando falla por debajo.

**Ataques mínimos del adversario:** fijación de sesión; robo y reuso de cookie (tras logout, tras restablecer, tras cambio de estudio); fuerza bruta, carrera contra el contador y bloqueo; enumeración de usuarios por mensaje, código, cabeceras, cookies o tiempo (login y recuperación), incluidas variantes de mayúsculas y espacios del correo; token de recuperación reusado, vencido, concurrente, truncado o de otro usuario; cambio de estudio sin membresía, con membresía revocada o con id de otro estudio; CSRF (incluido el de login) y `Origin` falsificado; comparaciones de token que no son de tiempo constante; flags de cookie (`HttpOnly`, `Secure`, `SameSite`, prefijo `__Host-`, sin `Domain`); parámetros de Argon2id bajo el piso y contraseñas gigantes (DoS); lectura directa de hashes o sesiones con el rol del backend.

## Dependencias
- Specs: 002 (hecha): `withTenant`/`withUsuario`, roles, RLS de `usuario`/`membresia`, lint de SQL crudo. 003 (hecha): reglas de no fuga y patrón `mock` prohibido en producción. 010 (se implementa antes en el mismo árbol de trabajo): la rama `spec/004-auth` se crea desde el último commit de `spec/010-dominio-dinero` cuando 010 esté cerrada.
- Externas: ninguna (sin Docker; correos a consola).

## Decisiones técnicas (aprobadas por el usuario)
- D1 Hash: Argon2id con m = 19 MiB, t = 2, p = 1, sal de 16 B y salida de 32 B (piso OWASP), configurable solo hacia arriba. Librería `@node-rs/argon2` (binarios para Windows) o `node:crypto` si la versión de Node lo trae estable; lo fija el plan.
- D2 Sesión: token opaco de 32 B (CSPRNG) en la cookie. En PostgreSQL se guarda solo SHA-256 del token, con usuario, estudio activo, token CSRF, creación, último uso y revocación. No usa JWT (ADR-11) ni Redis.
- D3 Caducidades: inactividad de 2 h (el último uso se actualiza como máximo cada 5 min) y absoluta de 12 h. Recuperación: 30 min. Las aplica el servidor.
- D4 Rotación del token al hacer login, cambiar de estudio y cambiar la contraseña; el anterior se revoca en la misma transacción.
- D5 Cookie `__Host-contapp_sid`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sin `Domain` y `Max-Age` igual a la caducidad absoluta restante. `localhost` es contexto seguro, así que no hay excepción en local.
- D6 CSRF: `SameSite=Lax`, más validación de `Origin`/`Sec-Fetch-Site` contra `APP_ORIGIN`, más token sincronizador por sesión en `X-CSRF-Token` (se obtiene con `GET /auth/sesion`) y comparación en tiempo constante.
- D7 Límites: 5 fallos por cuenta en 15 min bloquean 15 min (los correos inexistentes se cuentan por hash del correo normalizado). Por IP: 20 intentos de login en 10 min. Recuperación: 3 por correo por hora y 10 por IP por hora. Todo en PostgreSQL, así que vale con varias instancias.
- D8 Recuperación: token de 32 B que viaja en el fragmento (`/recuperar/nueva#t=…`) y se envía por POST. Se guarda su SHA-256. El consumo es atómico (`UPDATE … WHERE usado_en IS NULL AND expira_en > now()`). Al restablecer se revocan las sesiones y se reinicia el contador de bloqueo. El correo se envía fuera de la petición y de `withTenant`.
- D9 Antitiempos: hash ficticio precalculado con los mismos parámetros, `timingSafeEqual` en toda comparación de tokens y la misma ruta de código para fallo, bloqueo e inexistente.
- D10 Acceso a BD: tablas `usuario_contrasena`, `sesion`, `token_recuperacion` e `intento_login` sin `GRANT` a los roles de la app. El acceso pasa por funciones `SECURITY DEFINER` en un esquema `auth` (`search_path` fijo), con `EXECUTE` solo para `contapp_backend`, y cada función devuelve lo mínimo (el hash solo para el correo exacto pedido). Índice único sobre `lower(email)` y correo normalizado con trim, minúsculas y NFC.
- D11 Correo: puerto `Correo` con los adaptadores `consola` (por defecto) y `smtp` (despliegue). Un `CORREO_PROVIDER` desconocido o `consola` con `NODE_ENV=production` (sin distinguir mayúsculas ni espacios) impide arrancar.
- D12 Estudio activo: uno por sesión. El frontend envía `X-Estudio` y el backend responde 409 si no coincide, para que una pestaña vieja no escriba en el estudio equivocado. El cambio de estudio verifica la membresía con `withUsuario` antes de tocar la sesión.
- D13 Correos solo ASCII (decisión del usuario tras la ronda adversarial 1b, hallazgo B4): los correos son solo ASCII; los dominios internacionales se escriben en forma punycode (`xn--`). La BD y `normalizarCorreo` rechazan los correos no ASCII.

## Decisiones de producto y alcance (aprobadas; antes P1–P10 y Q1–Q3)
- P1 TOTP (RF-012): fuera de 004; va en una spec de R2.
- P2 RF-014: en 004, logout de la sesión actual y "cerrar todas mis sesiones"; la lista por dispositivo queda para R2.
- P3 Bloqueo: mensaje genérico en pantalla (igual al de credenciales inválidas) y aviso por correo al titular cuando se bloquea.
- P4 Desbloqueo: esperando los 15 min o restableciendo la contraseña; el administrador del estudio no desbloquea (la cuenta es global a varios estudios).
- P5 Política de contraseña: de 12 a 128 caracteres, sin reglas de composición, con una lista local de contraseñas comunes (sin servicios externos).
- P6 Sin "recordarme" en R1 (D3 fijo).
- P7 Con un solo estudio se entra directo; con varios, selector con el último usado resaltado; sin estudios, mensaje "No perteneces a ningún estudio activo".
- P8 Un estudio activo por sesión; no hay pestañas con estudios distintos a la vez (D12).
- P9 Aviso por correo al cambiar la contraseña.
- P10 Sin límite de sesiones simultáneas en R1.
- P11 Cambio de contraseña con sesión iniciada (antes Q1): entra en 004 con `POST /auth/contrasena` `{actual, nueva}`, un formulario mínimo en el frontend y `auth.contrasena_cambiar`, que rota la sesión actual y revoca las demás (D4). Aplican la política de CA-4 y el aviso de P9.
- P12 Lista de contraseñas comunes (antes Q2): local y armada a mano, de unos cientos de entradas comunes; no se descarga nada de internet ni de SecLists (en lugar de la descarga propuesta en Q2). Se amplía después editando `comunes.txt`.
- P13 Aviso de bloqueo (antes Q3): como máximo un aviso por cuenta cada 24 h (P3), para que el bloqueo cada 15 min no llene el buzón del titular.
