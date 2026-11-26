# Banco de pruebas SIRE con Postman (solo lectura)

Exploración desechable para conocer las APIs reales de SIRE antes de la spec 032.
**No es código de producción y no se mezcla con `main`.**

Basado en los manuales de SUNAT: *SIRE Compras v28* (RCE, libro `080000`) y *SIRE Ventas v30* (RVIE, libro `140000`).

## Qué incluye (solo lectura)
| Paso | Servicio | Qué hace |
|---|---|---|
| 0 | 5.1 Api Seguridad | Obtiene el token (lo guarda en el entorno) |
| 1 | consultar año y mes | Lista los periodos habilitados |
| 2 | descargar propuesta | **No devuelve datos**: genera un ticket (lo guarda) |
| 3 | consultar estado de ticket | Repetir hasta estado `06` terminado / `04` sin errores; guarda el nombre del archivo |
| 4 | descargar archivo | Baja el ZIP con la propuesta (TXT) |

**No incluye** aceptar, reemplazar, registrar preliminar ni eliminar: esas operaciones cambian el registro real del contribuyente ante SUNAT.

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
