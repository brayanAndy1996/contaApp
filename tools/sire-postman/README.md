# Banco de pruebas SIRE con Postman (solo lectura)

Exploración desechable para conocer las APIs reales de SIRE antes de la spec 032.
**No es código de producción**: solo herramientas manuales de lectura, referenciadas por la spec 041. Sin credenciales: se llenan en *Current value*, local.

Basado en los manuales de SUNAT: *SIRE Compras v28* (RCE, libro `080000`) y *SIRE Ventas v30* (RVIE, libro `140000`).

## Qué incluye (solo lectura)
| Paso | Servicio | Qué hace |
|---|---|---|
| 0 | 5.1 Api Seguridad | Obtiene el token (lo guarda en el entorno) |
| 1 | consultar año y mes | Lista los periodos habilitados |
| 2 | descargar propuesta | **No devuelve datos**: genera un ticket (lo guarda) |
| 3 | consultar estado de ticket | Repetir hasta estado `06` terminado / `04` sin errores; guarda el nombre del archivo |
| 4 | descargar archivo | Baja el ZIP con la propuesta (TXT) |
| 5 | 5.51 registro presentado en **PEN** (solo Compras) | Pide la descarga con `codTipoArchivo=0`, `codProceso=70` (el único aceptado), `codOrigen=2`, `lisPeriodos` y `codMoneda=PEN` (obligatorio); con 200 guarda `numTicket` y sigue con 3 y 4 |
| 5b | 5.51 registro presentado en **USD** (solo Compras) | Igual que el 5, con `codMoneda=USD`. Un ticket por moneda: haz 5, 3 y 4 con PEN y luego 5b, 3 y 4 con USD |
| 6 | 5.40 exportar preliminar (solo Compras) | La ruta del manual va en la variable `ruta_5_40` (no está en el repo); si da `numTicket`, sigue con 3 y 4 |

**No incluye** aceptar, reemplazar, registrar preliminar ni eliminar: esas operaciones cambian el registro real del contribuyente ante SUNAT. Los pasos 5, 5b y 6 solo piden descargas (P-3 de la spec 041). `descargarRegistroPresentado` usa 5.51 (el 5.40 baja el *preliminar*): `codProceso=70` con `codMoneda` PEN y USD (sin `codMoneda` SUNAT responde 422 cod 1061; con 00, 01 o 02, 422 cod 1026).

## Uso
1. Postman → *Import* → `sire.postman_collection.json` y `sire-local.postman_environment.json`.
2. Selecciona el entorno **SIRE · local (plantilla)** y llena la columna **Current value** (no *Initial value*):
   `client_id`, `client_secret`, `ruc`, `usuario_sol`, `clave_sol`, `periodo` (`yyyymm`).
   - `client_id`/`client_secret`: SOL → *Credenciales de API SUNAT*, aplicación con la URI **"MIGE RCE y RVIE – SIRE"** y alcance Web.
   - Alternativa más segura: Postman *Vault* y usar `{{vault:clave_sol}}`, etc.
3. Ejecuta **0. Obtener token**.
4. En *Compras* o *Ventas*: 1 → 2 → 3 (repetir hasta que diga *Archivo listo*) → 4 con **Send and Download**.
5. Mira la **Console** de Postman (abajo): los scripts imprimen estados y nombres de campos, nunca el token.

## Seguridad
- Llena solo *Current value*: es local y no se sincroniza ni se exporta.
- No exportes el entorno con valores, no compartas el workspace y no pegues tokens, claves ni respuestas en chats.
- Guarda los ZIP fuera del repo o en `tools/sire-postman/respuestas/` (ignorada por git).

## Qué anotar para la spec 032
Sin datos reales (RUC, montos o nombres), anota:
- La forma de la respuesta del token (nombres de campos, `expires_in`).
- La forma de la respuesta de periodos y de tickets (campos y estados vistos, cuánto tarda en terminar).
- El nombre del archivo y la estructura del ZIP (cuántos archivos, nombre, separador, cuántas columnas tiene el TXT y su encabezado).
- Los errores reales (código HTTP y `cod`/`msg`).
- Dudas del manual a confirmar: si la consulta de tickets exige `codLibro`/`codOrigenEnvio` (van desactivados), si la propuesta de compras exige `numSerieCDP`/`numCDP` (van desactivados) y el valor de `codTipoArchivoReporte` cuando es `null`.

## Validez de comprobantes (CPE) — `cpe-validez.postman_collection.json`
Manual SUNAT «Consulta Integrada de Comprobante de Pago por Servicio Web v2.0». Usa el mismo entorno, con variables propias:
- **Credenciales distintas a SIRE**: SOL → *Empresas → Comprobantes de pago → Consulta de Validez de Comprobantes de Pago → Credenciales de API SUNAT*. Llena `cpe_client_id` y `cpe_client_secret`.
- Token con `clientesextranet` y `grant_type=client_credentials` (sin clave SOL).
- `ruc` = quien consulta; en el cuerpo, el comprobante a validar (`cp_ruc_emisor` = RUC del emisor).
- La consola traduce `estadoCp`, `estadoRuc` y `condDomiRuc` e imprime los tipos reales de los campos (el manual dice `Integer` pero su ejemplo devuelve texto).

## Prueba de contrato del SIRE (spec 041, la corres tú; solo lectura)
1. Define en tu terminal (o en `packages/sunat/.env`, ignorado por git) `SIRE_CONTRATO_CLIENT_ID`, `_CLIENT_SECRET`, `_RUC`, `_USUARIO`, `_CLAVE` y `_PERIODO` (AAAAMM de un periodo **pasado**; mejor uno con notas de crédito, dólares y boletas).
   `SIRE_CONTRATO_PERIODO` acepta **varios periodos separados por comas** (p. ej. `202510,202509,202508`, hasta 12): la prueba recorre todos y, al final, imprime una línea de totales P-5/P-6 (NC, ND, USD con TC, boletas, sin documento, negativos, errores de codificación) para ver rápido si hay casos de cada tipo. Un periodo sin datos no falla la prueba.
2. Ejecuta la prueba. En PowerShell (define también las otras seis variables con `$env:NOMBRE="valor"`, o ponlas en `packages/sunat/.env`):
   ```powershell
   $env:SIRE_CONTRATO="1"
   $env:SIRE_CONTRATO_PERIODO="202510,202509,202508"
   pnpm --filter @contapp/sunat test:contrato
   ```
   En bash: `SIRE_CONTRATO=1 pnpm --filter @contapp/sunat test:contrato`. Sin `SIRE_CONTRATO=1` no corre nada, y nunca corre en `test`, `test:int` ni en CI. Corre cuatro casos: token, compras, ventas y el **registro presentado de compras (5.51)**, que usa el cliente real con `codProceso=70` y `codMoneda` **PEN** y **USD** (dos solicitudes, un ticket por moneda, cada uno hasta el archivo; unión de filas). La salida del registro sale **por moneda** (líneas `[contrato-sire] registro-presentado AAAAMM PEN: …` y `… USD: …`): solicitud (HTTP, `codigosSunat`, si devolvió ticket), «sin datos» si aplica, ticket (estados y tiempos), archivos (ZIP legible, columnas, si el encabezado es igual al de la propuesta de compras y qué faltan/sobran, filas y conteo por valor de la columna `Moneda`) y las formas de las filas de su TXT; al final, una línea con la unión. Pasa si no hay error, o si las dos monedas dicen «sin datos»; por moneda con ticket exige estados del anexo III, que termine en 04/06, al menos un archivo legible, encabezado igual al de la propuesta y que toda fila traiga en `Moneda` la moneda pedida. Si SUNAT rechaza una solicitud 5.51, la salida trae el código HTTP y los campos `cod` y `msg` del error (nunca el cuerpo).
   **Fallos HTTP**: en todo fallo (token, exportar, ticket, descarga, registro) la prueba imprime una línea `[contrato-sire] … FALLO HTTP n en <paso>` con el código HTTP, las claves de primer nivel del cuerpo de error y `cod`/`msg` (el principal y los de cada elemento de su lista de errores: `errors`, `errores`, `detalle`…; `msg` acotado a 200 caracteres y con los números de 6+ dígitos tapados). Nunca el cuerpo completo ni datos del contribuyente. El fallo de un caso (p. ej. ventas) no impide que corran los demás.
   **`SIRE_CONTRATO_DIAGNOSTICO=1`** (opcional, apagado por defecto; además de `SIRE_CONTRATO=1`): agrega un caso que, para el registro presentado de compras de cada periodo, hace 12 GET de 5.51 en secuencia (`codProceso` 70, 01, 02 y 00, cada uno sin `codMoneda`, con `codMoneda=PEN` y con `codMoneda=USD`) e imprime por variante solo HTTP, tiempo y `cod`/`msg`. Si una variante devuelve `numTicket`, solo lo informa (no sigue el flujo del ticket). El modo normal no cambia (70 con PEN y con USD). Solo GET a los hosts del SIRE ya permitidos. PowerShell: `$env:SIRE_CONTRATO_DIAGNOSTICO="1"` (para apagarlo: `Remove-Item Env:SIRE_CONTRATO_DIAGNOSTICO`).
3. Solo hace el POST del token y GET; no escribe nada en SUNAT y solo habla con `api-seguridad.sunat.gob.pe` y `api-sire.sunat.gob.pe`.
4. La salida son líneas `[contrato-sire]` con formas y tiempos (campos, estados del ticket, columnas, tipos, conteos): nunca filas, montos, RUC, tickets ni tokens. Pégalas en la tarea T16 de `docs/specs/041-sire-real-lectura/tasks.md`; si algo falla, pega solo el nombre de la prueba y la clase/detalle del error.
5. Antes o después, prueba en Postman los pasos 5 y 5b de Compras (70 con PEN y con USD) y anota solo el código HTTP, los nombres de campo, los estados del ticket y las columnas del TXT (P-3).
