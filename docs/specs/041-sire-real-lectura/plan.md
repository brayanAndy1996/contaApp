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
| crear | `fixtures/sire/http/{compras,ventas}-*.txt` (registro: `-mixto`, `-solo-encabezado`) + `fixtures/LEEME.md` | TXT sintéticos con el encabezado real copiado; RUC de `rucs-prueba.json`; los ZIP se arman en la prueba |
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
- **Clave (H-4)**: el cliente arma `{claveReanudacion}:{libro}:{periodo}:{operacion}`, con `operacion` = `propuesta` | `registro` (T15g: un solo ticket de registro por periodo), que da 5 partes. `claveReanudacion` sigue siendo `{tenant}:{cliente}`, así que T4 no cambia. `AlmacenTicketsRedis` no acepta 4 ni 6 partes (sin el valor por defecto `propuesta`) y rechaza `registro-pen`/`registro-usd`.
- **Presupuesto (H-5)**: cada petición usa `min(timeout del paso, restante de los 90 s)`. Con `restante ≤ 0`, el adaptador lanza `ErrorTransitorioSire("timeout")` sin pedir nada. El `dormir` del sondeo también se recorta a lo que quede. Los 90 s son de la llamada al adaptador (en el registro, de su único ticket).
- **Partes (H-6)**: se procesan en orden y de una en una. Cada parte se baja, se valida (ZIP, UTF-8, encabezado igual al de la 1.ª, filas) y se suelta antes de pedir la siguiente. Al primer error se corta y no se piden más partes. En memoria solo quedan las filas ya validadas; no se devuelven filas mientras falte alguna parte.
- **Token (H-8)**: `conToken` borra la caché solo si el token guardado es el que fue rechazado (comparar y borrar de forma atómica). Si ya hay uno más nuevo, lo usa sin pedir otro.
- **CA-10 «en total» (H-7)**: Decidido por el usuario (2026-11-27): 64 MiB por parte + 256 MiB acumulado entre partes; superado el acumulado → zip_invalido. En el registro el acumulado es el de las partes de su único ticket.

## P-3 · Registro presentado (manual RCE v28, 2026-11-28)
**Servicio**: 5.51 «Descargar RCE por periodo» (pp. 115-117). En el diagrama de la p. 40 cuelga de «¿Se generó el registro? Sí», o sea, del registro ya generado. 5.40 «Exportar preliminar de registro de compras» (pp. 99-100: GET `/rce/preliminar/web/registroslibros/{per}/exportareportepreliminar?codTipoArchivo=0&codOrigenEnvio=2`) baja el **preliminar** y cuelga de «Registrar preliminar»; se descarta. 5.50 (p. 114) es el consolidado (`codProceso` 69 del ejemplo) y comparte URL con 5.51.
**Contrato 5.51** (corregido con la prueba de contrato real del usuario, 12 variantes, 2026-11-28): GET `{BASE_LIBROS}/rce/ajustesposteriores/web/ajustesposteriores/{perTributario}/solicitardescarga`. Query: `codTipoArchivo=0` (txt), `codProceso=70` (el **único** aceptado: 00/01/02 → 422 cod 1026 «Código Proceso no permitido o no valido», con o sin moneda), `codOrigen=2` (no `codOrigenEnvio`), `lisPeriodos={per}` y `codMoneda` **obligatorio** (sin él → 422 cod 1061 «El campo 'codMoneda' es nulo o vacio»). Con 70+PEN y 70+USD: HTTP 200 `{"numTicket":…}`. Va con `Authorization: Bearer`. Luego el mismo flujo de ticket que la propuesta: 5.31 (01/02/05 pendiente, 04/06 listo, 03 con errores) y 5.32 con `codLibro=080000` y el `codProceso`/`perTributario` **que devuelva el ticket**. El cuerpo de error trae `errors[].cod`/`msg`. Columnas del TXT: se asume el layout de la propuesta (CA-13); lo confirma T16.
**Comportamiento de `codMoneda`** (corrida real de contrato con 2 RUC, 2026-11-28): es obligatorio pero **no filtra**. Con `codMoneda=PEN` el archivo trae TODOS los comprobantes del periodo (PEN y USD, cada fila con su `Moneda`); con `USD` devuelve el mismo archivo. El ZIP real tiene 3 entradas (ver ronda 3 · ZIP). El encabezado real difiere del de la propuesta solo en la columna 34 (`ID Proyecto Operadores/Partícipes`, no se mapea).
**Decisiones** (T15g, decisión técnica del orquestador ante la evidencia; sustituyen el diseño de una solicitud por moneda):
- `endpoints.ts`: `COD_PROCESO_REGISTRO = "70"`, `MONEDA_SOLICITUD_REGISTRO = "PEN"`, `COD_SIN_DATOS_REGISTRO = ["1070"]` y `parametrosRegistro(per)` → `{codTipoArchivo:"0", codProceso:"70", codOrigen:"2", lisPeriodos:per, codMoneda:"PEN"}`. No hay lista de monedas ni parámetro de moneda.
- Flujo de `descargarRegistroPresentado`: UNA solicitud 5.51 por periodo, un ticket, un archivo. Mismo flujo que la propuesta (`obtenerTicketListo` con la solicitud 5.51 en lugar de la exportación): retomar el ticket guardado o solicitar y `guardar` una vez; esperar (sondeo de 20 s; «no listado → solicitar una vez más»); `leerPartes` + `mapearCompras`. Un presupuesto de 90 s (H-5) y 256 MiB acumulados entre las partes (H-7). Sin reintento de `codProceso` ni de moneda.
- Clave: `…:compras:{per}:registro` (5 partes; ver H-4). `claves.ts`: `OperacionTicketSire = "propuesta" | "registro"`. `AlmacenTicketsRedis.OPERACIONES` = esas dos; rechaza `registro-pen`, `registro-usd`, cualquier otra operación y claves de 4 o 6 partes (las claves por moneda que hubiera en Redis vencen solas, TTL 1 h).
- Guardar y borrar: reglas de la ronda 2. Se guarda una vez tras la solicitud; se borra al validar todas las partes, con `sin_datos` o ante un error permanente; `ErrorTransitorioSire`/`TokenRechazadoError` lo conservan.
- «Sin datos»: 422 (o 400) al solicitar con algún `cod` ∈ `COD_SIN_DATOS_REGISTRO`, o TXT válido con solo encabezado → `ErrorDatosSire("sin_datos")` (025 lo cuenta y sigue).
- Rechazo de contrato: en la solicitud 5.51, un 400 o 422 sin código de «sin datos» (1061, 1026, cualquier otro o cuerpo ilegible) → `ErrorPortalSire("solicitud_rechazada")`, permanente, sin reintento (excepción a «422 → ErrorDatos» de CA-11, que sigue igual para la propuesta). `ErrorPortalSire` lleva `codigosSunat: readonly string[]` (solo `^\d{1,6}$`, tope 5; nunca `msg`, que puede repetir valores). `transporte` lee ese cuerpo de error solo en este contexto, con `MAX_BYTES_JSON`.
- Filas: NO se verifica que la columna `Moneda` coincida con la pedida; cada fila conserva PEN o USD y solo se valida su forma como en la propuesta (RUC y Periodo propios → si no `respuesta_ajena`; encabezado igual entre partes → si no `encabezado`; valores). Un comprobante (`tipo|serie|numero|tipoDocContraparte|rucContraparte`) repetido en el archivo o entre sus partes → `ErrorPortalSire("respuesta_inesperada")` sin filas; no se deduplica (montos distintos quedarían ocultos).
- Fixtures: `compras-registro-202610-mixto.txt` (8 PEN + 1 USD, encabezado real) y `-solo-encabezado.txt`; `-pen.txt` y `-usd.txt` se eliminan.
- Contrato (`contrato-sire.ts`, `sire.contrato.spec.ts`): una solicitud 70+PEN con el cliente real; informe plano (sin `porMoneda`), con conteo de filas por valor de `Moneda` solo como forma y `diferencia` de encabezado (`ninguna` / `solo_no_mapeadas` / `mapeadas`). El modo diagnóstico no cambia.
**Pruebas (tester, T15g)**: `registro-presentado.http.spec.ts` (una solicitud, ticket único `…:registro`, reanudación, re-solicitud única, transitorios/401, `sin_datos`, `solicitud_rechazada`, comprobante repetido, filas PEN y USD mezcladas, 90 s y 256 MiB), `endpoints.spec.ts`, `contrato-sire.spec.ts`, `claves-041.spec.ts`, `almacen-tickets-redis.int.spec.ts` e `importar-historial-041.int.spec.ts`.
Decidido por el usuario (2026-11-28): codProceso 01→02 y codMoneda omitido; **superado por la evidencia** de T16 (1061/1026). Con la delegación técnica del usuario rige lo de arriba.
Decidido (2026-11-28, evidencia de la corrida real de contrato): codProceso 70 fijo; codMoneda obligatorio; sustituye el 01→02.
Decidido (2026-11-28, evidencia de 2 RUC reales): codMoneda no filtra; una solicitud 70+PEN.

## Decisiones de la ronda 3 · ZIP del registro (T15e)
Evidencia (corrida de contrato, 5.51 → 5.32): `PK\x07\x08` al inicio, EOCD al final, sin ZIP64, cifrado ni descriptor, 3 entradas: `LE#/LE#.txt` con datos (deflate), otra `LE#/LE#.txt` vacía y la carpeta `LE#/`. Regla de `extraerTxtDeZip` (decisión técnica delegada):
- Directorio central con 1..8 entradas (`MAX_ENTRADAS_ZIP`), que lo ocupan exactamente; `enDisco = total`.
- Se ignoran las de directorio (nombre en `/`, método 0, tamaños 0, CRC 0) y las de archivo vacías (método 0, tamaños 0, CRC 0). Cualquier otra cuenta como «con datos»: debe haber exactamente UNA y terminar en `.txt` (0 o ≥ 2 → `zip_invalido`; un duplicado con datos es un 2.º archivo).
- El NOMBRE de TODAS se valida: 1..255 bytes, UTF-8 válido, sin NUL ni controles (C0, DEL, C1), sin `\`, `:` ni `..`, sin `/` inicial ni segmentos vacíos o que empiecen con `.`, a lo sumo una carpeta. Toda entrada vive en la carpeta del archivo con datos (la de directorio es su prefijo exacto). Si el archivo con datos está en una carpeta y no hay entrada de directorio, la carpeta debe llamarse como el archivo sin `.txt` (`LE#/LE#.txt`); así `dir/x.txt` suelto sigue rechazado (CA-10, rondas 1 y 2).
- Cada entrada (también las ignoradas) tiene cabecera local coherente (firma, mismo nombre y método, sin cifrar, antes del directorio central). Sin campo extra ZIP64.
- Siguen: 64 MiB por parte / 256 MiB acumulados, 200:1, inflado acotado a lo declarado, tamaño y CRC verificados, solo métodos 0 y 8. Los nombres solo se validan: nunca se usan como ruta ni se escribe a disco; el error es fijo.

Ronda adversarial 3 (T15f, `ronda3.adv.spec.ts`; decisión técnica delegada), sin tocar lo anterior:
- **H-041-3-1** · Deflate consume EXACTAMENTE el comprimido declarado: `inflateRawSync` de `node:zlib` con `maxOutputLength` (lo declarado ya acotado) y `bytesWritten` = comprimido; cola tras el bloque final, flujo truncado o más largo → `zip_invalido`. La razón 200:1 queda medida sobre lo consumido.
- **H-041-3-2/3-3** · La cabecera local de CADA entrada coincide con la central en nombre, método, CRC y tamaños; sin campo extra ZIP64 ni tamaños 0xFFFFFFFF. Descriptor de datos (bit 3, igual en local y central): rechazado en las ignoradas; en la de datos solo si la local lleva ceros o lo mismo que la central y le sigue un descriptor firmado (`PK\x07\x08`, 16 bytes) idéntico a la central.
- **H-041-3-4** · El archivo empieza con `PK\x03\x04` o con `PK\x07\x08` seguido inmediatamente de `PK\x03\x04`.
- **H-041-3-5/3-6** · Contiguo: cabeceras locales en el orden del central, cada una donde termina la anterior, la última termina en el central, y el central termina donde empieza el EOCD. Sin huecos, solapes ni registros fuera de `largoCentral`.
- **H-041-3-7** · Nombres solo `[A-Za-z0-9._-]` (ASCII) y a lo sumo una `/` separadora (más la final de la carpeta); sin segmento vacío ni que empiece **o termine** con `.` (Windows quita el punto final); sin reservados de Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9, con o sin extensión, sin distinguir mayúsculas). Toda entrada de archivo, también la vacía ignorada, termina en `.txt` exacto (minúscula).
- **H-041-3-8** · Exactamente un EOCD que termina al final del archivo con su comentario, y el comentario no trae otra firma de EOCD.

## Riesgos
- SUNAT cambia el layout o los nombres de columna → `ErrorPortalSire("encabezado")` + alerta (RNF-044); la prueba de contrato lo detecta antes.
- Formas no vistas (NC, USD, boletas, anulados) → P-5; la spec no se cierra sin una corrida de contrato que las incluya o sin decisión del usuario.
- Tickets lentos con volumen → P-4; medir en la prueba de contrato con el periodo más grande disponible.
- 401 del OAuth por un error nuestro (no de la clave) marcaría la credencial inválida → solo 400/401 del endpoint de token; el cuerpo de error se descarta.
- Dos estudios con el mismo cliente RUC → la clave del ticket incluye estudio y cliente (prueba adversarial).
