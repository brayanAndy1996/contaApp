# Plan 020 · Deuda técnica de R1

Nivel C. Una migración (0046), sin rutas nuevas ni cambios de contrato HTTP. DT-n, CA-n y P-n son los de `spec.md`. La cola (`packages/queue/src/despachador.ts`, `reconciliador.ts`) y `auditoria` no se tocan.

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `apps/backend/test/tiempos.ts` · `apps/worker/test/tiempos.ts` | `medirMediana(fn, n)` y `BAJO_COBERTURA` (`CONTAPP_COBERTURA === "1"`), uno por app (DT-1, D-1) |
| modificar | `apps/backend/src/modules/compras/lectura.int.spec.ts` (CA-15) · `apps/backend/src/modules/auth/auth.r1b.adv.int.spec.ts` (CA-8) · `apps/backend/vitest.cobertura*.config.mts` (`test.env.CONTAPP_COBERTURA = "1"`) | DT-1, CA-2, CA-3 |
| modificar | `apps/worker/src/trabajos/procesadores/generar-archivo.int.spec.ts` (CA-13: fuera `FACTOR_COBERTURA`) · `apps/worker/src/trabajos/ejecutor.int.spec.ts` (`:523`) | DT-1 |
| modificar | `apps/worker/test/trabajos.ts` · `packages/queue/src/soporte-pruebas/int.ts` (`restaurarConfig`) | DT-2 |
| crear | `packages/db/migrations/0046_notificacion_ms_validada.sql` · `meta/_journal.json` (idx 46) · `meta/0046_snapshot.json` · `tests/aislamiento/notificacion-ms-0046.spec.ts` | DT-8, CA-10 |
| modificar | `apps/frontend/components/credenciales-cliente.tsx` · `lib/credenciales.ts` y su prueba | DT-3 (refresco, «Inválida») |
| modificar | `apps/frontend/lib/trabajos.ts` · `app/(app)/trabajos/page.tsx` y sus pruebas | DT-7 y «Cancelar» de DT-3 |
| modificar | `apps/frontend/components/archivos/panel-generar.tsx` · `app/(app)/clientes/[clienteId]/compras/page.tsx` (contenedor) | DT-4 |
| modificar | `apps/frontend/lib/{fechas,acceso,lupa-compras,archivos}.ts` · `components/compras/historial-compra.tsx` (y quien use `fechaLegibleUtc`) · `components/archivos/{versiones-archivo,previo-archivo}.tsx` · `packages/shared/src/archivos/errores.ts` | DT-5, DT-6 |
| modificar | `tests/e2e/flujos/{clientes,archivo}.e2e.ts` · `tests/e2e/soporte/selectores/{clientes,archivo}.ts` | CA-5 (E-03) y CA-6 |

## Decisiones técnicas
- **D-1 Tiempos (DT-1, P-4).** La aserción de tiempo se evalúa solo con `!BAJO_COBERTURA`; la parte funcional (filas, estados, 202) corre siempre. Bajo cobertura se registra la medida con `console.info` y no se compara (sin factor). CA-15 y CA-13 toman la mediana de 3 muestras (CA-13: un calentamiento y 3 muestras). El helper se duplica por app (8 líneas) para no crear dependencia entre `apps/backend` y `apps/worker`.
- **D-2 Inyección de CA-8.** La prueba nueva usa el mismo arnés de `auth.r1b.adv.int.spec.ts`, con un doble que añade 20 ms solo cuando la cuenta existe (el puerto de correo o el repositorio que solo se llama con cuenta existente), y comprueba que la misma comparación de medianas falla. La comparación se extrae a una función local de la prueba (`fugaPorTiempo(existe, noExiste)`) para usarla en las dos. No se toca código de producción; si el único punto de inyección está en producción, la tarea se escala.
- **D-3 `restaurarConfig` (DT-2).** Repone las cuatro filas de `config_sistema` (`sire`, `sol`, `xml`, `archivos`) con los valores de sus migraciones (0017 y 0040); si se agrega una cola, se agrega aquí.
- **D-4 Migración 0046 (DT-8).** Un único bloque `DO` (atómico aunque el migrador no abra transacción): si existe alguna fila con µs, `ALTER TABLE notificacion DISABLE TRIGGER notificacion_solo_leida` (solo ese trigger, por nombre; nunca `ALL` ni `USER`), `UPDATE … SET creada_en = date_trunc('milliseconds', creada_en) WHERE creada_en <> date_trunc(…)`, `ENABLE TRIGGER`; luego `VALIDATE CONSTRAINT notificacion_creada_en_ms`. Idempotente. RLS no se desactiva: `notificacion` tiene `FORCE ROW LEVEL SECURITY` (0043), así que la migración sigue el patrón de las migraciones de datos previas sobre tablas con FORCE RLS (corre con el rol de `MIGRATIONS_DATABASE_URL`); si no hay patrón, se escala antes de escribirla. `auditoria_ocurrida_en_ms` sigue `NOT VALID`, como explica 0044.
- **D-5 Refresco de la ficha (DT-3).** Mientras alguna credencial esté en «Verificando», la ficha vuelve a leer `listarCredenciales` con espera creciente (`ESPERA_INICIAL_MS` 1 s hasta `ESPERA_MAXIMA_MS` 10 s, importadas de `lib/trabajos.ts` sin modificarlo) y para al llegar a un estado final o al desmontar. No abre otro SSE: el límite es de 3 streams por sesión. «Inválida» traduce el motivo con un mapa en `lib/credenciales.ts`; un motivo desconocido muestra un texto genérico en español, nunca el código.
- **D-6 «Cancelar» (DT-3, 008 D9).** Se muestra si el trabajo está `en_cola` y el usuario es quien lo encoló (`creadoPor.usuarioId`) o tiene rol Dueño o Administrador. El servidor sigue decidiendo: un 403/409 se muestra como hoy.
- **D-7 Stream tardío (DT-7).** En `seguirTrabajos`, si el tope `TOPE_ESPERA_STREAM_MS` venció y se listó sin stream, al abrirse el stream se vuelve a llamar al listado una sola vez por conexión. Con el stream a tiempo no cambia nada.
- **D-8 Fechas (DT-5).** Todo instante con hora usa `fechaHoraLima`. `fechaLegibleUtc` (lupa) y el formateador de `historial-compra.tsx` desaparecen. `fechaCorta` (`lib/acceso.ts`) distingue: una fecha pura `AAAA-MM-DD` se formatea desde el texto, sin `Date` (no cambia de día); un instante muestra el día de Lima. Así ningún archivo de `components/` ni `lib/` necesita `timeZone: "UTC"`.
- **D-9 Versiones (DT-6).** Cada versión muestra «Versión N · <fechaHoraLima> · por <Autor>», el SHA-256 del ZIP (`sha256Zip`, completo, en monoespaciada y con `break-all`) y descarga como `<nombreZip sin .zip>_vN.zip`. El nombre lo arma el frontend; el contenido del ZIP y el nombre del servidor no cambian. `resumen_fuera_de_rango` se agrega a `CODIGOS_ERROR_ARCHIVO` (`packages/shared`) y a `MENSAJES_ARCHIVO`; `CUADRE`, `USD_SIN_TC` y `SALTO_CORRELATIVIDAD` reciben texto donde hoy se muestran crudos (previo de ventas).
- **D-10 Panel «Generar archivo» (DT-4).** El panel deja de superponerse a la grilla: ocupa su propia columna y la grilla se encoge con su desplazamiento horizontal propio; si a 1366 px no queda espacio útil para la grilla, el panel va debajo. Sin cambios en `grilla-compras.tsx` salvo el contenedor.

## Riesgos
- **Pruebas de tiempo que siguen fallando sin instrumentar.** Si la mediana sin cobertura pasa del límite en CI, es un defecto de rendimiento real: se escala, no se sube el límite (CA-2).
- **Pruebas de integración en paralelo en local (T1, T2, T3).** Comparten la BD de pruebas y `config_sistema`; justo por eso DT-2 importa. Si una se cruza con otra, se corre en serie y se anota.
- **Trigger deshabilitado a medias.** El bloque `DO` hace que 0046 sea todo o nada; la prueba de CA-10 comprueba que, tras migrar, el trigger está habilitado (`pg_trigger.tgenabled = 'O'`) y sigue rechazando cambiar `creada_en` (42501).
- **Nombre del ZIP con `_vN`.** Si el formato oficial de SUNAT valida el nombre al subirlo, el contador tendría que quitar el sufijo; se revisa con el formato oficial (nota [oficial]).
- **Polling de la ficha.** Acotado a la vista abierta y a credenciales en «Verificando»; para al desmontar (prueba con temporizadores falsos).
