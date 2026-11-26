# Resultados 029 · Cuenta segura (T17, verificación)

Rama `spec/029-cuenta-segura` en `cd98f90` (tras T14 y T16: migraciones 0080 y 0081). BD limpia `contapp_029t9` (`db:migrate` ×2 sin cambios, `db:seed`), Redis y Mailpit locales. La verificación se hizo contra la spec, no contra el código.

## Suites del entorno

| Suite | Resultado |
|---|---|
| `packages/shared` | 72 archivos, 4 061 pruebas: OK |
| `packages/correo` | 12 archivos, 118 pruebas: OK |
| `packages/db` completo (incluye `*.int.spec.ts` del CLI) | 110 archivos, 2 370 pruebas: OK |
| backend unitario | 124 archivos, 1 620 pruebas: OK |
| backend `test:int` | 174 archivos, 4 494 pruebas: OK |
| `tests/aislamiento` completo | 135 de 139 archivos OK; 3 871 OK, 9 fallos ajenos (ver abajo), 1 `expected fail` |
| frontend | 176 archivos, 1 734 pruebas: OK |
| lint y tipos (shared, correo, db, backend, frontend, tests-e2e) | OK, 0 avisos. `tests/aislamiento` no tiene script `lint` ni `typecheck` |
| `next build` del frontend | OK (`/cuenta/seguridad` generada) |
| E2E completa (`pnpm e2e`, Mailpit, BD `contapp_029t11`) | 108 de 109 OK; **1 ✘: `flujos/equipo.e2e.ts:382` (T17a)** |

**Fallos ajenos al entorno (9, 4 archivos).** Todo el diff de las 8 aserciones de catálogo es una sola cosa: el superusuario `contapp_pruebas` aparece de más en las listas de `EXECUTE`. Afecta a `escalada.adv.spec.ts:449,481,508,536,586`, `correo-funciones.spec.ts:110` y `reglas-lote.spec.ts:224,246`, todos de catálogos de 025, 026, 027, 028 y 0052. La novena, `credencial-r1a.adv.spec.ts:150`, recibe `42601` en vez de `42501` por `MERGE … RETURNING` de PG16. Ninguno nombra `totp`, `sesion` ni `cuenta_evento`. Salen igual en la corrida de cobertura de `packages/db`. No se corrió `main` aparte: los fallos son de ese tipo, y la aserción de `escalada.adv` sobre `FUNCIONES_AUTH` (la lista cerrada de 029) corre antes de la que falla y pasa.

**Las 4 ✘ de `flujos/soporte.e2e.ts:147-187` son esperadas.** Son `test.fail()` de la suite «la vigilancia hace fallar la prueba»: centinela de credencial en el DOM y en una respuesta `/api`, `window.__pwn` y un error de consola no declarado. Playwright las cuenta como pasadas porque la prueba falla justo como se declaró; con el reporter `list` salen marcadas ✘.

## Criterios de aceptación

| CA | Estado | Evidencia (suite → resultado) |
|---|---|---|
| CA-1 enrolar | cumplido | `totp.enrolar.int.spec` («CA-1 · enrolar / confirmar / re-enrolar con el TOTP activo exige el código vigente»: pendiente vencido, reemplazado, ±1 paso, sin contraseña, concurrencia); `auth-totp-enrolar.spec` (aislamiento); `totp-r2.adv.int.spec` («confirmar desde dos sesiones a la vez»): OK |
| CA-2 login | cumplido | `totp.login.int.spec` («CA-2 · sesión pendiente solo sirve para verificar o salir», `csrf` del login, ±1 paso, replay, verificación concurrente, restablecer contraseña no salta el TOTP); `sesion.pendiente.spec`; `rfc6238.spec` (vectores RFC 6238, tiempo constante); `auth-totp-verificar.spec`; `totp-r1a.adv.int.spec` («replay y reloj»): OK |
| CA-3 fuerza bruta | cumplido | `totp.login.int.spec` («CA-3»: 5.º erróneo bloquea 15 min y revoca la pendiente, contador compartido con la contraseña, 20 concurrentes ≤ 5 evaluaciones); `auth-totp-verificar.spec` (`totp_intento_reservar`); `totp-r1a.adv.int.spec`, `totp-r2.adv.int.spec` y `auth-totp-r2.adv.spec` (contador frente al cambio de contraseña): OK |
| CA-4 exigencia | cumplido | `totp.exigencia.int.spec` (403 `segundo_factor_requerido` en estudio y plataforma, tras cambiar de estudio o rol, lista cerrada, desactivar `totp_exigido`); `auth-totp-cuenta.spec` (`totp_desactivar` con `CASOS_FACTOR_EXIGIDO`); `totp-r2.adv.int.spec` («lista cerrada `@PermitirSinFactor`»); `auth-totp-r1b.adv.spec` («sesiones vivas»): OK. E2E `cuenta-segura.e2e` («el Dueño queda bloqueado… no puede desactivarlo») OK. Ver nota de T17a |
| CA-5 sesiones | cumplido | `totp.sesiones.int.spec` (propias, sin hashes ni tokens, id ajeno, inexistente o revocado = misma salida, 401 siguiente); `auth-sesiones.spec`; `sesiones.spec` (repositorio); `shared/seguridad.spec` («sesionCuentaSchema»): OK |
| CA-6 secretos | cumplido | `totp.fugas.int.spec` («CA-6 · ningún canario sale por logs, respuestas, correos ni tablas legibles»); `totp-restablecer.int.spec` (CLI); `totp.spec` y `sesiones.spec` del repositorio («errores de pg → solo el SQLSTATE»); `auth-totp-r1b.adv.spec` («lectura y volcado de secretos»); `cifrado.spec`, `recuperacion.spec`; `docs/` sin secretos (grep de URI `otpauth`, claves, PEM, tokens, URL con contraseña: 0 coincidencias): OK |
| CA-7 BD | cumplido | `auth-totp-tablas.spec` (sin `GRANT` a roles de la app, dueño, RLS, catálogo de 11 funciones + `totp_restablecer` solo `contapp_migrator`); `catalogo.spec` («029 · tablas de la cuenta segura»); `escalada.adv.spec` (lista cerrada `FUNCIONES_AUTH` ampliada en `auth-soporte.ts`; la aserción pasa, los 5 fallos de ese archivo son ajenos); `auth-totp-cuenta.spec` («CA-7: contapp_backend ejecuta…»). Migraciones 0078 a 0081; `db:migrate` ×2 sin cambios: OK |
| CA-8 escala | cumplido | `auth-sesiones.rendimiento.spec` (corrida aislada: OK, 1,3 s). Variante async `minimoDe` de `medirEscala`, 6 corridas intercaladas, razón ≤ 3× entre 2 000 y 40 000 sesiones ajenas, sin tope de reloj, fuera de cobertura |
| CA-9 recuperación y operador | cumplido | `totp.login.int.spec` («CA-9 · código de recuperación: un uso», concurrentes); `totp.exigencia.int.spec` («regenerar»); `auth-totp-verificar.spec` (`totp_recuperacion_usar`); `auth-totp-cuenta.spec` (regenerar, `totp_restablecer`); `totp-restablecer.int.spec` (borra, revoca, un aviso, evento, idempotente, correo inexistente indistinguible); E2E `cuenta-segura.e2e` (operador): OK |
| CA-10 avisos | cumplido | `totp.fugas.int.spec` («CA-10 · un aviso por evento de U8»); `correo/seguridad.spec` (sin código, secreto ni enlace; texto escapado); E2E con Mailpit `cuenta-segura.e2e` (4 pruebas) OK |
| CA-11 adversario | cumplido | 2 rondas (T12 y T13, luego T15) con correcciones T14 y T16: `totp-r1a.adv.int.spec`, `totp-r2.adv.int.spec`, `auth-totp-r1b.adv.spec`, `auth-totp-r2.adv.spec`, `auth-r2a.adv.spec`, todas en verde tras las migraciones 0080 y 0081; cubren replay, carreras, reloj, fuerza bruta, pendiente, saltar enrolamiento, ajenas, enumeración, CSRF y lectura del secreto |
| Casos reales | n/a | la spec declara «ninguno» |

## Decisiones U1 a U9

| U | Estado | Evidencia |
|---|---|---|
| U1 obligatorio super-admin, Dueño y Administrador | cumplido | `totp.exigencia.int.spec` (U1 y plataforma); `shared/factor-exigido.casos` + `auth-totp-cuenta.spec` |
| U2 roles propios con `usuarios.gestionar`, `roles.gestionar`, `plan.gestionar`, `credenciales.editar` | cumplido | `shared/seguridad.spec` y `factor-exigido.casos` (tabla común TS y SQL) |
| U3 sin plazo, sesiones previas `sin_factor` | cumplido | `totp.exigencia.int.spec` («coherente con la BD»), `auth-totp-r1b.adv.spec` (sesiones vivas), `auth-totp-verificar.spec` |
| U4 10 códigos de recuperación de un uso, regenerables | cumplido | `totp.enrolar.int.spec` (10 únicos), `recuperacion.spec`, `totp.exigencia.int.spec` (regenerar) |
| U5 `db:totp-restablecer` | cumplido | `totp-restablecer.int.spec` y `.spec`, `auth-totp-cuenta.spec`, E2E |
| U6 dispositivo resumido, IP /24 y /48 | cumplido | `dispositivo.spec`, `totp.sesiones.int.spec` («U6») |
| U7 sin «recordar este equipo» (fuera de alcance) | cumplido | sin código ni pantalla (grep) |
| U8 avisos de activar, desactivar, usar código y restablecer | cumplido | `totp.fugas.int.spec` (CA-10), `correo/seguridad.spec`, `totp-restablecer.int.spec`, E2E |
| U9 cambio de correo y política de contraseña fuera de 029 | cumplido | el diff de la rama no toca esos módulos |

## Cobertura por archivo (≥ 90 % en las cuatro métricas)

| Paquete | Resultado |
|---|---|
| backend (`test:cobertura`, 407 archivos, 11 013 pruebas) | exit 0; mínimo de 029: `totp.service.ts` 97,05 / 94,64 / 96,87 / 98,09; `permiso.guard.ts` 95,52 / 94,73 / 100 / 100; `cifrado.ts`, `dispositivo.ts`, `auth.service.ts`, `entorno.ts`, `db/auth/repositorio.ts` entre 96 y 100; `rfc6238`, `recuperacion`, `exigencia`, `sesiones.service`, `totp.controller`, `sesion.guard`, `decoradores`, `db/auth/totp.ts`, `db/auth/sesiones.ts`, `shared/auth/seguridad.ts` al 100 % |
| `packages/db` (`--coverage.reportOnFailure`) | `auth/totp.ts` 100, `auth/sesiones.ts` 100, `cli/totp-restablecer.ts` 98,03 / 97,14 / 100 / 97,77. El exit 1 es solo por los 9 fallos ajenos |
| `packages/correo` | `seguridad.ts` 100 / 91,66 / 100 / 100 (línea 53 de ramas): OK |

Ningún archivo de 029 baja de 90 %.

## Defecto abierto

**T17a (tester · sonnet).** `tests/e2e/flujos/equipo.e2e.ts:406` falla de forma determinista (también en solitario): «quien ya tiene cuenta acepta la invitación a otro estudio y cambia a él». La persona invitada es `a.dueno`, Dueño de otro estudio sin TOTP. Al iniciar sesión desde la página de invitación, 029 la lleva a `/cuenta/seguridad` («Tu cuenta exige la verificación en dos pasos», U1 y U3) y el aviso «Te uniste a Estudio Destino E2E.» no llega a verse. El comportamiento coincide con la spec; falla la prueba, que no se ajustó en T11. Corrección: sembrar al invitado con factor verificado, o aceptar por la ruta de enrolamiento forzado. No hay cambio en producción. Hasta cerrarla, T17 queda sin marcar. La spec lo da por cumplido, pero la regla de cierre pide E2E completa en verde.

## Prueba manual

No se hizo una sesión manual en navegador: la E2E con la pila real (backend, worker y frontend compilado, adaptadores `mock`, Mailpit) hace ese recorrido (login en dos pasos, enrolamiento forzado, sesiones, operador y avisos) y pasa, salvo T17a.
