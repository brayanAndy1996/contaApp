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
| Registro | según P-3 | — |

Mapeo (encabezado normalizado → campo). Compras: `Tipo CP/Doc.`→`tipo`, `Serie del CDP`→`serie`, `Nro CP o Doc. Nro Inicial (Rango)`→`numero`, `Tipo Doc Identidad`→`tipoDocContraparte`, `Nro Doc Identidad`→`rucContraparte`, `Apellidos Nombres/ Razón Social`→`razonSocialContraparte`, `Fecha de emisión`, `Moneda`, `Tipo de Cambio` (solo USD), `BI Gravado DG/DGNG/DNG`, `IGV / IPM DG/DGNG/DNG`, `Valor Adq. NG`→`noGravado`, `ISC`, `ICBPER`, `Otros Trib/ Cargos`→`otros`, `Total CP`; control: `RUC`, `Periodo`; sin equivalente (P-2): `IMB`, `Nro Final (Rango)`. Ventas: `BI Gravada`→`baseGravada`, `IGV / IPM`→`igv`, `Mto Exonerado`, `Mto Inafecto`, `ISC`, `ICBPER`, `Otros Tributos`→`otros`, `Total CP`, `Nro Doc Identidad`→`docContraparte`; control `Ruc`, `Periodo`; sin equivalente (P-2): `Valor Facturado Exportación`, `Dscto BI`, `Dscto IGV / IPM`, `BI Grav IVAP`, `IVAP`, `Nro Final (Rango)`; ignoradas: CAR, vencimiento, doc. modificado, FOB, gratuitas, tipo de operación, `Est. Comp.`, `CLU*`.

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

## Riesgos
- SUNAT cambia el layout o los nombres de columna → `ErrorPortalSire("encabezado")` + alerta (RNF-044); la prueba de contrato lo detecta antes.
- Formas no vistas (NC, USD, boletas, anulados) → P-5; la spec no se cierra sin una corrida de contrato que las incluya o sin decisión del usuario.
- Tickets lentos con volumen → P-4; medir en la prueba de contrato con el periodo más grande disponible.
- 401 del OAuth por un error nuestro (no de la clave) marcaría la credencial inválida → solo 400/401 del endpoint de token; el cuerpo de error se descarta.
- Dos estudios con el mismo cliente RUC → la clave del ticket incluye estudio y cliente (prueba adversarial).
