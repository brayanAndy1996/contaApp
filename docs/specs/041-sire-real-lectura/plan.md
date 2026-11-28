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
| crear | `fixtures/sire/http/{compras,ventas,registro}-*.txt` + `fixtures/LEEME.md` | TXT sintéticos con el encabezado real copiado; RUC de `rucs-prueba.json`; los ZIP se arman en la prueba |
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
export class ErrorPortalSire extends ErrorPortal { readonly detalle: "encabezado" | "zip_invalido" | "codificacion" | "respuesta_inesperada" | "estado_desconocido" | "nombre_archivo" }
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
- **Clave (H-4)**: el cliente arma `{claveReanudacion}:{libro}:{periodo}:{operacion}`, con `operacion` = `propuesta` | `registro`, que da 5 partes. `claveReanudacion` sigue siendo `{tenant}:{cliente}`, así que T4 no cambia. `AlmacenTicketsRedis` deja de aceptar 4 partes (sin el valor por defecto `propuesta`).
- **Presupuesto (H-5)**: cada petición usa `min(timeout del paso, restante de los 90 s)`. Con `restante ≤ 0`, el adaptador lanza `ErrorTransitorioSire("timeout")` sin pedir nada. El `dormir` del sondeo también se recorta a lo que quede.
- **Partes (H-6)**: se procesan en orden y de una en una. Cada parte se baja, se valida (ZIP, UTF-8, encabezado igual al de la 1.ª, filas) y se suelta antes de pedir la siguiente. Al primer error se corta y no se piden más partes. En memoria solo quedan las filas ya validadas; no se devuelven filas mientras falte alguna parte.
- **Token (H-8)**: `conToken` borra la caché solo si el token guardado es el que fue rechazado (comparar y borrar de forma atómica). Si ya hay uno más nuevo, lo usa sin pedir otro.
- **CA-10 «en total» (H-7)**: Decidido por el usuario (2026-11-27): 64 MiB por parte + 256 MiB acumulado entre partes; superado el acumulado → zip_invalido.

## P-3 · Registro presentado (manual RCE v28, 2026-11-28)
**Servicio**: 5.51 «Descargar RCE por periodo» (pp. 115-117). En el diagrama de la p. 40 cuelga de «¿Se generó el registro? Sí», o sea, del registro ya generado. 5.40 «Exportar preliminar de registro de compras» (pp. 99-100: GET `/rce/preliminar/web/registroslibros/{per}/exportareportepreliminar?codTipoArchivo=0&codOrigenEnvio=2`) baja el **preliminar** y cuelga de «Registrar preliminar»; se descarta. 5.50 (p. 114) es el consolidado (`codProceso` 69 del ejemplo) y comparte URL con 5.51.
**Contrato 5.51**: GET `{BASE_LIBROS}/rce/ajustesposteriores/web/ajustesposteriores/{perTributario}/solicitardescarga`. Query: `codTipoArchivo=0` (txt), `codProceso` (P-3a), `codOrigen=2` (el nombre es `codOrigen`, no `codOrigenEnvio`, aunque el error 1028 diga lo contrario), `lisPeriodos={per}` y `codMoneda` (P-3b). Va con `Authorization: Bearer` y responde `{"numTicket":"AAAA99999999"}`. Es el mismo flujo de ticket que la propuesta: 5.31 (estados del Anexo III de ventas, p. 80-81: 01/02/05 pendiente, 04/06 listo, 03 con errores) y luego 5.32 con `codLibro=080000` y el `codProceso` y `perTributario` **que devuelva el ticket**. Errores 422 (p. 117): 1005-1007 periodo, 1059-1061 tipo de archivo, 1028-1030 origen, 1138-1139 `codProceso`. El manual **no documenta las columnas** del TXT: se asume el layout de la propuesta (CA-13) y lo confirma la prueba de contrato.
**Decisiones**:
- `endpoints.ts`: `rutaRegistroPresentado(per)` y `parametrosRegistro(per)`, con `COD_PROCESO_REGISTRO` como constante. `perTributario` y `lisPeriodos` son el mismo periodo pedido: un ticket por periodo, porque 025 itera periodo a periodo. El ejemplo del manual (`202305` en la ruta y `lisPeriodos=202212`) se comprueba en la prueba de contrato. Con un ticket de varios periodos, la validación `Periodo` por fila daría `respuesta_ajena`.
- `sire-api-client.http.ts`: `exportar` y `obtenerTicketListo` reciben la URL de solicitud y la `operacion`. `descargarRegistroPresentado` copia a `descargarPropuesta` con `libro="compras"`, clave `…:compras:{per}:registro`, `leerPartes` y `mapearCompras` (sin un mapeo nuevo) y las mismas reglas de guardar y borrar el ticket. Las validaciones se reutilizan tal cual: RUC/periodo de entrada, gramática de `numTicket` y `nomArchivoReporte`, presupuesto de 90 s y topes del ZIP.
- «Sin datos» → `ErrorDatos` (025 lo cuenta y sigue): un 422 al solicitar (lo mapea `transporte`, p. ej. 1070) o un TXT válido sin filas → `ErrorDatosSire("sin_datos")`, y en ambos casos se borra el ticket. Un ticket listo sin archivos sigue siendo `ErrorPortalSire("respuesta_inesperada")`, como en la propuesta, salvo que el contrato muestre que es la forma real de «sin movimiento».
- El servidor falso no cambia: se guiona la ruta nueva. Fixture `fixtures/sire/http/compras-registro-202610.txt` (el mismo encabezado real de la propuesta) y uno con solo el encabezado.
- T16: corregir en Postman el paso 5 (hoy solo manda `codProceso=01`; le faltan `codTipoArchivo`, `codOrigen` y `lisPeriodos`, y daría 422 1061/1028) y llenar `ruta_5_40` con la ruta de arriba. El contrato imprime solo formas de 5.51.
**Pruebas (tester, `sire-api-client.http.spec.ts`; reemplazan el `it.todo` de CA-13)**:
1. `registro: solicita 5.51 por GET con codTipoArchivo=0, codOrigen=2, lisPeriodos=per, perTributario=per y codProceso de P-3a; solo Bearer al host SIRE`
2. `registro: ticket 06 → 5.32 con codLibro=080000 y codProceso/perTributario del ticket → mismas FilaPropuestaSire que la propuesta con el mismo TXT`
3. `registro: varias partes en orden; encabezado distinto entre partes → ErrorPortalSire encabezado`
4. `registro: 422 al solicitar → ErrorDatos; TXT solo con encabezado → ErrorDatosSire sin_datos; ambos borran el ticket`
5. `registro: ticket 03 → ticket_con_errores; estado desconocido → estado_desconocido; listo sin archivos → respuesta_inesperada`
6. `registro: ticket pendiente → guarda clave …:compras:{per}:registro y lanza ticket_pendiente; el reintento retoma sin volver a solicitar`
7. `registro y propuesta del mismo periodo y cliente no comparten ticket guardado`
8. `registro: fila con RUC o Periodo ajeno → respuesta_ajena sin filas`
9. `registro: ruc o periodo fuera de gramática → ErrorDatos sin red`
10. `registro: 401 → TokenRechazadoError conserva el ticket; 5xx/timeout → ErrorTransitorioSire conserva el ticket`
11. Si se elige P-3a (a): `registro: 01 sin datos → pide 02 una vez; 02 sin datos → ErrorDatos`. Según P-3b: `registro: no envía codMoneda` (o `pide PEN y USD y une`).
12. `sire.contrato.spec.ts`: el caso del registro presentado imprime solo formas (columnas, si el encabezado coincide, estados y tiempos).
**Pendiente del usuario**: P-3a (`codProceso`) y P-3b (`codMoneda`). Mientras no respondan, `descargarRegistroPresentado` sigue rechazando.

## Riesgos
- SUNAT cambia el layout o los nombres de columna → `ErrorPortalSire("encabezado")` + alerta (RNF-044); la prueba de contrato lo detecta antes.
- Formas no vistas (NC, USD, boletas, anulados) → P-5; la spec no se cierra sin una corrida de contrato que las incluya o sin decisión del usuario.
- Tickets lentos con volumen → P-4; medir en la prueba de contrato con el periodo más grande disponible.
- 401 del OAuth por un error nuestro (no de la clave) marcaría la credencial inválida → solo 400/401 del endpoint de token; el cuerpo de error se descarta.
- Dos estudios con el mismo cliente RUC → la clave del ticket incluye estudio y cliente (prueba adversarial).
