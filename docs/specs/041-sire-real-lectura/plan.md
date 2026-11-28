# Plan 041 · SIRE real de solo lectura

Las decisiones marcadas «según P-n» siguen la recomendación de la spec; si el usuario elige otra opción, el arquitecto ajusta este plan antes de T1.

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/sunat/src/http/endpoints.ts` | URLs y parámetros fijos (tabla de abajo); hosts permitidos |
| crear | `packages/sunat/src/http/transporte.ts` | `fetch` con timeout, sin redirecciones, tope de bytes al leer, mapeo HTTP → errores |
| crear | `packages/sunat/src/http/sire-auth.http.ts` | `HttpSireAuth` |
| crear | `packages/sunat/src/http/sire-api-client.http.ts` | `HttpSireApiClient`: exportar → ticket → descargar → leer → mapear |
| crear | `packages/sunat/src/http/ticket.ts` | Esquema zod de 5.31/5.16 y espera con presupuesto (P-4) |
| crear | `packages/sunat/src/http/zip-seguro.ts` | Descompresión por streaming (`fflate` `Unzip`) con los topes de CA-10 |
| crear | `packages/sunat/src/http/txt/{leer-txt,encabezados,mapeo-compras,mapeo-ventas}.ts` | TXT → registros por nombre de columna → filas del puerto |
| crear | `packages/sunat/src/http/almacen-tickets.ts` | Puerto `AlmacenTicketsSire` + `AlmacenTicketsMemoria` (pruebas) |
| crear | `packages/sunat/src/http/pruebas/servidor-sire-falso.ts` | Servidor `node:http` en 127.0.0.1 con guion de respuestas (solo pruebas) |
| crear | `packages/sunat/src/http/sire.contrato.spec.ts` | Prueba de contrato manual (CA-15) |
| modificar | `packages/sunat/src/errores.ts` | `TokenRechazadoError` (se mueve desde el worker) y subclases con `detalle` literal |
| modificar | `packages/sunat/src/puertos.ts` | `claveReanudacion?` en las dos solicitudes (el mock la ignora) |
| modificar | `packages/sunat/{src/index.ts,package.json,vitest.config.mts}` | exports, `zod` (misma versión que `shared`), script `test:contrato`, exclusión de `*.contrato.spec.ts` |
| crear | `fixtures/sire/http/{compras,ventas}-*.txt` (registro: `-pen`, `-usd`, `-mixto`, `-solo-encabezado`) + `fixtures/LEEME.md` | TXT sintéticos con el encabezado real copiado; RUC de `rucs-prueba.json`; los ZIP se arman en la prueba |
| modificar | `packages/queue/src/claves.ts` | `ticketSire(tenantId, clienteId, libro, periodo, operacion)` |
| crear | `apps/worker/src/trabajos/token-sire/almacen-tickets-redis.ts` | `AlmacenTicketsSire` sobre Redis (`SET PX`, `GET`, `DEL`) |
| modificar | `apps/worker/src/adaptadores/adaptadores.module.ts` | `SIRE_CLIENT=http`; `crearAdaptadores(env, logger, { redis, prefijo })` |
| modificar | `apps/worker/src/trabajos/token-sire/cache-token.ts` | Importa `TokenRechazadoError` de `@contapp/sunat` y lo reexporta |
| modificar | `apps/worker/src/trabajos/procesadores/{descargar-propuesta,importar-historial}.ts` | Pasan `claveReanudacion = "{tenantId}:{clienteId}"` |
| modificar | `docs/03-arquitectura.md` §4, `.env.example` | Adaptador real disponible; `SIRE_CLIENT=mock\|http` |
| modificar | `tools/sire-postman/` | Peticiones 5.51 y 5.40 (solo lectura) para resolver P-3 |

## Contratos
```ts
// @contapp/sunat
export class TokenRechazadoError extends Error {}           // 401 de la API con token: 008 renueva una vez
export class ErrorDatosSire extends ErrorDatos { readonly detalle: "respuesta_ajena" | "fila_invalida" | "columna_no_soportada" | "ticket_con_errores" | "sin_datos" }
export class ErrorPortalSire extends ErrorPortal { readonly detalle: "encabezado" | "zip_invalido" | "codificacion" | "respuesta_inesperada" | "estado_desconocido" | "nombre_archivo" | "solicitud_rechazada"; readonly codigosSunat: readonly string[] }  // códigos solo en solicitud_rechazada (P-3)
export class ErrorTransitorioSire extends ErrorTransitorio { readonly detalle: "ticket_pendiente" | "red" | "timeout" | "servidor" }
export interface AlmacenTicketsSire { leer(clave: string): Promise<string | null>; guardar(clave: string, numTicket: string, ttlMs: number): Promise<void>; borrar(clave: string): Promise<void> }
export interface OpcionesHttpSire {
  fetch?: typeof fetch; ahora?: () => Date; dormir?: (ms: number) => Promise<void>;
  almacenTickets?: AlmacenTicketsSire;      // sin él, P-4 cae en (a)
  urlsDePrueba?: { seguridad: string; sire: string };  // solo constructor; nunca desde el entorno
}
export class HttpSireAuth implements SireAuth { constructor(o?: OpcionesHttpSire) }
export class HttpSireApiClient implements SireApiClient { constructor(o?: OpcionesHttpSire) }
// puertos.ts: SolicitudPropuesta y SolicitudRegistroPresentado ganan `claveReanudacion?: string` (opaca; nunca llega a SUNAT)
```
Endpoints (base `https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros`; Postman probado):
| Paso | Método y ruta | Parámetros |
|---|---|---|
| Token | POST `https://api-seguridad.sunat.gob.pe/v1/clientessol/{client_id}/oauth2/token/` | form: `grant_type=password`, `scope=https://api-sire.sunat.gob.pe`, `client_id`, `client_secret`, `username={ruc}{usuarioSol}`, `password` |
| Exportar RCE | GET `/rce/propuesta/web/propuesta/{per}/exportacioncomprobantepropuesta` | `codTipoArchivo=0&codOrigenEnvio=2` → `{numTicket}` |
| Exportar RVIE | GET `/rvie/propuesta/web/propuesta/{per}/exportapropuesta` | `codTipoArchivo=0` → `{numTicket}` |
| Ticket | GET `/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets` | `perIni=perFin={per}&page=1&perPage=20&numTicket` |
| Archivo | GET `/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte` | `nomArchivoReporte`, `codTipoArchivoReporte`, `perTributario`, `codProceso`, `numTicket`, `codLibro=080000\|140000` |
| Registro (5.51) | GET `/rce/ajustesposteriores/web/ajustesposteriores/{per}/solicitardescarga` | ver «P-3 · Registro presentado» → `{numTicket}`; luego Ticket y Archivo con `codLibro=080000` |

Mapeo (encabezado normalizado → campo). Compras: `Tipo CP/Doc.`→`tipo`, `Serie del CDP`→`serie`, `Nro CP o Doc. Nro Inicial (Rango)`→`numero`, `Tipo Doc Identidad`→`tipoDocContraparte`, `Nro Doc Identidad`→`rucContraparte`, `Apellidos Nombres/ Razón Social`→`razonSocialContraparte`, `Fecha de emisión`, `Moneda`, `Tipo de Cambio` (solo USD), `BI Gravado DG/DGNG/DNG`, `IGV / IPM DG/DGNG/DNG`, `Valor Adq. NG`→`noGravado`, `ISC`, `ICBPER`, `Otros Trib/ Cargos`→`otros`, `Total CP`; control: `RUC`, `Periodo`; sin equivalente (P-2): `IMB`, `Nro Final (Rango)`. Ventas: `BI Gravada`→`baseGravada`, `IGV / IPM`→`igv`, `Mto Exonerado`, `Mto Inafecto`, `ISC`, `ICBPER`, `Otros Tributos`→`otros`, `Total CP`, `Nro Doc Identidad`→`docContraparte`; control `Ruc`, `Periodo`; sin equivalente (P-2): `Valor Facturado Exportación`, `Dscto BI`, `Dscto IGV / IPM`, `BI Grav IVAP`, `IVAP`, `Valor FOB Embarcado`, `Valor OP Gratuitas`, `Nro Final (Rango)`; ignoradas: CAR, vencimiento, doc. modificado, tipo de operación, `Est. Comp.`, `CLU*`. Regla P-2 (CA-7): toda columna monetaria o de rango sin equivalente es requerida en el encabezado; vacío, `0` o `0.00` pasa; otro valor con formato de monto válido → `columna_no_soportada`, con formato inválido → `fila_invalida`. Solo se ignoran columnas no monetarias.

## Decisiones
- `fetch` de Node 24 con `AbortSignal.timeout` y `redirect: "manual"` (3xx → `ErrorPortalSire`); sin dependencias HTTP nuevas — menos superficie.
- Hosts fijos en `endpoints.ts`; `urlsDePrueba` solo por constructor — una variable de entorno mal puesta mandaría el token a otro host.
- `client_id` con gramática `[A-Za-z0-9-]{1,64}` antes de ir a la ruta; `nomArchivoReporte` con gramática de nombre plano; todo parámetro con `URLSearchParams`.
- Respuestas JSON con tope de 1 MiB y esquema zod; el ZIP con tope al leer el cuerpo (no se confía en `Content-Length`).
- Sin logger en el adaptador; errores con mensaje fijo y `detalle` literal (patrón `ErrorPropuesta` de 013).
- Ticket (P-4 c): sondeo 0,5 / 1 / 2 / 4 s hasta 20 s; si no termina, `guardar(clave, ticket, 1 h)` y `ErrorTransitorioSire("ticket_pendiente")`; al terminar (bien o mal) `borrar`. Clave = `ticketSire(tenant, cliente, libro, periodo, operacion)`; el valor es solo el número de ticket.
- Encabezado: quitar BOM, NFC, recortar, colapsar espacios, minúsculas; columnas requeridas por libro; duplicadas o ausentes → `ErrorPortalSire("encabezado")` (P-1). Filas con un campo de más vacío al final (el `|` final) se aceptan; otro número de campos → `fila_invalida`.
- Montos: `^-?\d{1,12}(\.\d{1,2})?$` y luego `Money.desde(v, moneda).toString()`; jamás `Number`. Tipo de cambio `^\d{1,4}\.\d{1,3}$`. Fecha `dd/mm/aaaa` con validación de calendario.
- Se valida TODO el archivo antes de devolver filas: un error no deja filas a medias (igual que 013).
- `TokenRechazadoError` pasa a `@contapp/sunat` porque el adaptador lo lanza y no puede importar del worker; `cache-token.ts` lo reexporta (sin cambio de comportamiento).
- La prueba de contrato lee `SIRE_CONTRATO_{CLIENT_ID,CLIENT_SECRET,RUC,USUARIO,CLAVE,PERIODO}` en tiempo de ejecución, solo hace POST de token y GET, y solo imprime formas; `vitest.config.mts` la excluye salvo `--mode contrato` y una prueba normal verifica esa exclusión.

## Decisiones de la ronda 2 (T13 → T15)
- **Ticket (H-1, H-2, H-3)**: `guardar(clave, ticket, 1 h)` una sola vez, justo tras exportar. `borrar` solo al validar todas las partes, o ante un error permanente (estado 03 → `ticket_con_errores`, estado desconocido, cualquier `ErrorPortalSire`/`ErrorDatosSire` de las partes). Lo conservan `ErrorTransitorioSire` (`ticket_pendiente`, `red`, `timeout`, `servidor`) y `TokenRechazadoError`, en la consulta o en la descarga. Si SUNAT no lista un ticket guardado: `borrar`, exportar una vez más en ese mismo intento y seguir el flujo normal con el ticket nuevo. Ese ticket ya no se re-exporta en el intento: si tampoco aparece, rige la regla del ticket recién exportado (`respuesta_ajena`).
- **Clave (H-4)**: el cliente arma `{claveReanudacion}:{libro}:{periodo}:{operacion}`, con `operacion` = `propuesta` | `registro-pen` | `registro-usd` (ronda 3: un ticket de registro por moneda), que da 5 partes. `claveReanudacion` sigue siendo `{tenant}:{cliente}`, así que T4 no cambia. `AlmacenTicketsRedis` deja de aceptar 4 partes (sin el valor por defecto `propuesta`) y rechaza la antigua `registro`.
- **Presupuesto (H-5)**: cada petición usa `min(timeout del paso, restante de los 90 s)`. Con `restante ≤ 0`, el adaptador lanza `ErrorTransitorioSire("timeout")` sin pedir nada. El `dormir` del sondeo también se recorta a lo que quede. Los 90 s son de la llamada al adaptador: en el registro, PEN y USD los comparten.
- **Partes (H-6)**: se procesan en orden y de una en una. Cada parte se baja, se valida (ZIP, UTF-8, encabezado igual al de la 1.ª, filas) y se suelta antes de pedir la siguiente. Al primer error se corta y no se piden más partes. En memoria solo quedan las filas ya validadas; no se devuelven filas mientras falte alguna parte.
- **Token (H-8)**: `conToken` borra la caché solo si el token guardado es el que fue rechazado (comparar y borrar de forma atómica). Si ya hay uno más nuevo, lo usa sin pedir otro.
- **CA-10 «en total» (H-7)**: Decidido por el usuario (2026-11-27): 64 MiB por parte + 256 MiB acumulado entre partes; superado el acumulado → zip_invalido. En el registro el acumulado es de la operación (partes PEN + USD).

## P-3 · Registro presentado (manual RCE v28, 2026-11-28)
**Servicio**: 5.51 «Descargar RCE por periodo» (pp. 115-117). En el diagrama de la p. 40 cuelga de «¿Se generó el registro? Sí», o sea, del registro ya generado. 5.40 «Exportar preliminar de registro de compras» (pp. 99-100: GET `/rce/preliminar/web/registroslibros/{per}/exportareportepreliminar?codTipoArchivo=0&codOrigenEnvio=2`) baja el **preliminar** y cuelga de «Registrar preliminar»; se descarta. 5.50 (p. 114) es el consolidado (`codProceso` 69 del ejemplo) y comparte URL con 5.51.
**Contrato 5.51** (corregido con la prueba de contrato real del usuario, 12 variantes, 2026-11-28): GET `{BASE_LIBROS}/rce/ajustesposteriores/web/ajustesposteriores/{perTributario}/solicitardescarga`. Query: `codTipoArchivo=0` (txt), `codProceso=70` (el **único** aceptado: 00/01/02 → 422 cod 1026 «Código Proceso no permitido o no valido», con o sin moneda), `codOrigen=2` (no `codOrigenEnvio`), `lisPeriodos={per}` y `codMoneda` **obligatorio** (sin él → 422 cod 1061 «El campo 'codMoneda' es nulo o vacio»). Con 70+PEN y 70+USD: HTTP 200 `{"numTicket":…}`. Va con `Authorization: Bearer`. Luego el mismo flujo de ticket que la propuesta: 5.31 (01/02/05 pendiente, 04/06 listo, 03 con errores) y 5.32 con `codLibro=080000` y el `codProceso`/`perTributario` **que devuelva el ticket**. El cuerpo de error trae `errors[].cod`/`msg`. Columnas del TXT: se asume el layout de la propuesta (CA-13); lo confirma T16.
**Decisiones** (ronda 3; el usuario delegó lo técnico ante la evidencia; reemplazan 01→02 y «sin codMoneda»):
- `endpoints.ts`: `COD_PROCESO_REGISTRO = "70"`, `MONEDAS_REGISTRO = ["PEN", "USD"] as const` (en ese orden), `COD_SIN_DATOS_REGISTRO = ["1070"]` y `parametrosRegistro(per, moneda)` → `{codTipoArchivo:"0", codProceso:"70", codOrigen:"2", lisPeriodos:per, codMoneda:moneda}` (moneda obligatoria en el tipo). Un ticket por periodo y moneda.
- Flujo de `descargarRegistroPresentado`: (1) por moneda, en orden PEN→USD, retomar su ticket guardado o solicitar y `guardar` (así SUNAT procesa los dos a la vez); (2) por moneda, en el mismo orden, esperar el ticket (plan de sondeo de 20 s **por ticket**, con la regla «no listado → solicitar una vez más») y `leerPartes`. Todo dentro de **un** presupuesto de 90 s (H-5): un `timeout` deja los dos tickets guardados y el reintento los retoma. Sin reintento de `codProceso`.
- Clave por moneda: `…:compras:{per}:registro-pen` y `…:registro-usd` (5 partes; ver H-4). `claves.ts`: `OperacionTicketSire = "propuesta" | "registro-pen" | "registro-usd"`; `ticketSire` no cambia de forma. `AlmacenTicketsRedis.OPERACIONES` = esas tres. No colisiona con la propuesta porque la 5.ª parte es un literal distinto y ninguno contiene `:`; una clave vieja `…:registro` se rechaza y la de Redis vence sola (TTL 1 h).
- Guardar y borrar: cada ticket se guarda una vez tras su solicitud. Los **dos** se borran solo al terminar la operación (éxito, `sin_datos` o error permanente de cualquiera de las monedas); `ErrorTransitorioSire`/`TokenRechazadoError` en cualquier paso conservan los dos. Una moneda ya leída no se devuelve sola: no hay filas a medias.
- «Sin datos» **por moneda**: 422 al solicitar con algún `cod` ∈ `COD_SIN_DATOS_REGISTRO`, o TXT válido con solo encabezado. Una moneda sin datos no falla si la otra trae filas. Las dos sin datos → `ErrorDatosSire("sin_datos")` (025 lo cuenta y sigue).
- Rechazo de contrato: en la solicitud 5.51, un 400 o 422 sin código de «sin datos» (1061, 1026, cualquier otro o cuerpo ilegible) → `ErrorPortalSire("solicitud_rechazada")`, permanente, sin reintento (excepción a «422 → ErrorDatos» de CA-11, que sigue igual para la propuesta). `ErrorPortalSire` gana `codigosSunat: readonly string[]` (solo `^\d{1,6}$`, tope 5; nunca `msg`, que puede repetir valores). `transporte` lee ese cuerpo de error solo en este contexto, con `MAX_BYTES_JSON`.
- Unión: filas PEN y luego USD, cada una en el orden de sus partes. El encabezado de toda parte (de las dos monedas) debe ser igual al de la 1.ª parte leída → si no, `encabezado`. Cada fila debe traer en `Moneda` la moneda pedida → si no, `respuesta_ajena` (si `codMoneda` resultara ser la moneda de expresión y no un filtro, falla cerrado y T16 lo muestra). Un comprobante (`tipo|serie|numero|tipoDocContraparte|rucContraparte`) en las dos monedas → `ErrorPortalSire("respuesta_inesperada")` sin filas; no se deduplica (montos distintos quedarían ocultos).
- Fixtures: `compras-registro-202610.txt` pasa a `compras-registro-202610-pen.txt` (sus 8 filas PEN); nuevo `-usd.txt` (filas USD con tipo de cambio, sin comprobantes comunes, con la fila USD de hoy); `-solo-encabezado.txt` se queda; nuevo `-mixto.txt` (PEN con una fila USD) para `respuesta_ajena`.
- T16: Postman paso 5 con `codProceso=70` y `codMoneda=PEN`/`USD`. Contrato (`contrato-sire.ts`, `sire.contrato.spec.ts`): el caso normal usa el cliente real (70, PEN y USD, flujo del ticket hasta el archivo). `InformeRegistro` pasa a `{ periodo, ms, porMoneda: { PEN, USD }, filas, error }`; por moneda: solicitud (HTTP, `codigosSunat`, `devolvioTicket`), `sinDatos`, ticket (estados, tiempos), archivos (ZIP legible, columnas, `encabezadoIgualPropuesta`, conteo por valor de `Moneda`) y `FormaFilas` de su TXT aunque el cliente falle. La observación se separa por `codMoneda` (solicitud) y por `numTicket` (ticket y archivo). Usa `COD_SIN_DATOS_REGISTRO` de `endpoints.ts`. Expectativas: sin error, o solo `sin_datos` con las dos monedas sin datos; por moneda con ticket: estados del anexo III, termina en 04/06, ≥1 archivo legible, encabezado igual al de la propuesta, toda fila con la moneda pedida. El modo diagnóstico (12 variantes) no cambia.
**Pruebas (tester)**. `registro-presentado.http.spec.ts` (cabecera y `CLAVE_ALMACEN` → `CLAVE_PEN`/`CLAVE_USD`; ayudas: `solicitar` guiona por `codMoneda`, `parteRegistro(moneda)`):
1. `registro: solicita 5.51 por GET dos veces (codMoneda PEN y luego USD) con codTipoArchivo=0, codProceso=70, codOrigen=2, lisPeriodos=per, perTributario=per; solo Bearer al host SIRE` (reemplaza la 1)
2. `registro: cada ticket 06 → 5.32 con codLibro=080000 y codProceso/perTributario de su ticket → filas PEN y luego USD con el mapeo de la propuesta` (reemplaza la 2)
3. `registro: varias partes en orden; encabezado distinto entre partes o entre monedas → ErrorPortalSire encabezado` (amplía la 3)
4. `registro: una moneda sin datos (422 1070 o TXT solo con encabezado) y la otra con filas → devuelve las de la otra` (nueva, en lugar de la 4 y de «01 sin datos → pide 02 una vez»)
5. `registro: PEN y USD sin datos (cualquier combinación) → ErrorDatosSire sin_datos y borra los dos tickets` (en lugar de la 4)
6. `registro: 422 1061, 1026 u otro código, 400 o cuerpo ilegible al solicitar → ErrorPortalSire solicitud_rechazada con codigosSunat, sin secretos ni msg, sin otra solicitud` (en lugar de «un error que no es sin datos no pide 02»)
7. `registro: nunca pide un codProceso distinto de 70 ni más de una solicitud por moneda` (en lugar de «no envía codMoneda»)
8. `registro: ticket 03 / estado desconocido / listo sin archivos en cualquiera de las monedas → mismo error, sin filas, borra los dos tickets` (amplía la 5)
9. `registro: ticket pendiente → guarda …:registro-pen y …:registro-usd y lanza ticket_pendiente; el reintento retoma los dos sin volver a solicitar` (reemplaza la 6)
10. `registro (PEN y USD) y propuesta del mismo periodo y cliente no comparten ticket guardado` (amplía la 7)
11. `registro: fila con RUC, Periodo o Moneda ajenos → respuesta_ajena sin filas` (amplía la 8; usa `-mixto.txt`)
12. `registro: comprobante repetido entre PEN y USD → ErrorPortalSire respuesta_inesperada sin filas` (en lugar del `it.todo`)
13. `registro: PEN y USD comparten los 90 s; agotados tras PEN → timeout y conserva los dos tickets` y `registro: el acumulado de 256 MiB suma partes PEN y USD → zip_invalido` (nuevas)
14. La 9 (gramática) se queda; el `describe` 401/5xx/timeout pasa a «conserva los dos tickets» y sus casos cubren ticket y archivo de PEN y de USD (los índices del `it.each` de timeout se recalculan: solicitudes 1-2, luego ticket/archivo).
Otras: `transporte*.spec.ts` `solicitud 5.51: 400/422 → códigos de errors[].cod y cod con tope y gramática; propuesta: 422 sigue siendo ErrorDatos`; `errores*.spec.ts` `ErrorPortalSire solicitud_rechazada: mensaje fijo y codigosSunat filtrados`; `claves-041.spec.ts` (los casos con `"registro"` → `registro-pen`/`registro-usd`); `almacen-tickets-redis.int.spec.ts`: «libro y operación se reflejan en la clave de Redis (compras/registro-usd)» y en H-041-2-4 añadir a las malas `…:registro` y `…:registro-eur`; `ronda2.adv.spec.ts`: nueva `la clave del registro nombra la moneda: dos claves de 5 partes que terminan en :registro-pen y :registro-usd`; `importar-historial-041.int.spec.ts`: «lee el registro presentado de dos periodos (uno sin datos en PEN y USD)… 5.51 dos veces por periodo; claves registro-pen/usd borradas» y «registro pendiente: guarda los tickets registro-pen y registro-usd en Redis y el reintento los retoma (5.51 una vez por moneda)»; `sire.contrato.spec.ts`: `compras: registro presentado (5.51) con el cliente real, codProceso 70 con PEN y con USD y unión de filas` y su prueba normal del informe por moneda con el servidor falso.
Decidido por el usuario (2026-11-28): codProceso 01→02 y codMoneda omitido; **superado por la evidencia** de T16 (1061/1026). Con la delegación técnica del usuario rige lo de arriba.
Decidido (2026-11-28, evidencia de la corrida real de contrato): codProceso 70 fijo; codMoneda obligatorio; PEN y USD; sustituye el 01→02.

## Decisiones de la ronda 3 · ZIP del registro (T15e)
Evidencia (corrida de contrato, 5.51 → 5.32): `PK\x07\x08` al inicio, EOCD al final, sin ZIP64, cifrado ni descriptor, 3 entradas: `LE#/LE#.txt` con datos (deflate), otra `LE#/LE#.txt` vacía y la carpeta `LE#/`. Regla de `extraerTxtDeZip` (decisión técnica delegada):
- Directorio central con 1..8 entradas (`MAX_ENTRADAS_ZIP`), que lo ocupan exactamente; `enDisco = total`.
- Se ignoran las de directorio (nombre en `/`, método 0, tamaños 0, CRC 0) y las de archivo vacías (método 0, tamaños 0, CRC 0). Cualquier otra cuenta como «con datos»: debe haber exactamente UNA y terminar en `.txt` (0 o ≥ 2 → `zip_invalido`; un duplicado con datos es un 2.º archivo).
- El NOMBRE de TODAS se valida: 1..255 bytes, UTF-8 válido, sin NUL ni controles (C0, DEL, C1), sin `\`, `:` ni `..`, sin `/` inicial ni segmentos vacíos o que empiecen con `.`, a lo sumo una carpeta. Toda entrada vive en la carpeta del archivo con datos (la de directorio es su prefijo exacto). Si el archivo con datos está en una carpeta y no hay entrada de directorio, la carpeta debe llamarse como el archivo sin `.txt` (`LE#/LE#.txt`); así `dir/x.txt` suelto sigue rechazado (CA-10, rondas 1 y 2).
- Cada entrada (también las ignoradas) tiene cabecera local coherente (firma, mismo nombre y método, sin cifrar, antes del directorio central). Sin campo extra ZIP64.
- Siguen: 64 MiB por parte / 256 MiB acumulados, 200:1, inflado por trozos de 4 KiB cortando en lo declarado, tamaño y CRC verificados, solo métodos 0 y 8. Los nombres solo se validan: nunca se usan como ruta ni se escribe a disco; el error es fijo.

## Riesgos
- SUNAT cambia el layout o los nombres de columna → `ErrorPortalSire("encabezado")` + alerta (RNF-044); la prueba de contrato lo detecta antes.
- Formas no vistas (NC, USD, boletas, anulados) → P-5; la spec no se cierra sin una corrida de contrato que las incluya o sin decisión del usuario.
- Tickets lentos con volumen → P-4; medir en la prueba de contrato con el periodo más grande disponible.
- 401 del OAuth por un error nuestro (no de la clave) marcaría la credencial inválida → solo 400/401 del endpoint de token; el cuerpo de error se descarta.
- Dos estudios con el mismo cliente RUC → la clave del ticket incluye estudio y cliente (prueba adversarial).
