# Fixtures sintéticos (spec 009)

Todo lo de esta carpeta es **sintético**: inventado para el desarrollo y las pruebas de los mocks de `packages/sunat` (D17). No son comprobantes, contribuyentes ni registros reales. Las razones sociales, direcciones y distritos llevan «PRUEBA». La fuente XML real la entrega el equipo después; estos archivos no la reemplazan.

## Archivos

| Ruta | Qué es |
|---|---|
| `rucs-prueba.json` | RUC de prueba: el contribuyente, los proveedores de cada caso y un proveedor genérico. Es la única fuente de RUC de esta carpeta. |
| `xml/{ruc}-01-{serie}-{numero}.xml` | Una factura UBL 2.1 por caso de la tabla (5 XML, todos compras). |
| `sire/{ruc}-compras-{periodo}.json` | Propuesta de compras del contribuyente de prueba: una fila por XML, con los montos mal ubicados que corrige 011 en San Juan y en la mixta. |
| `sire/{ruc}-ventas-{periodo}.json` | Propuesta de ventas del contribuyente de prueba, con las columnas de `FilaVentaSire`: boletas B001-290 y B001-292 (sin la 291), una serie F001 completa, una nota de crédito, dos ventas USD (con y sin tipo de cambio), una serie B003 con saltos y una fila exonerada. Sin XML. Ver «Ventas» abajo. |
| `sire/{ruc}-registro-compras-{periodo}.json`, `sire/generico-registro-compras.json`, `sire/{ruc}-registro-sin-datos.json` | Registro de compras ya presentado (spec 025, `descargarRegistroPresentado`): mismo formato que la propuesta, archivos distintos. El genérico es una plantilla de un periodo que el mock repite en el periodo pedido (mismo día), con proveedores de `rucs-prueba.json` y los casos de U-2 por periodo: dominante DNG (ISC), bajo umbral (MIXTO), mixto en la misma fila (BOLSAS), empate (USD), nota de crédito `07` en negativo (CALZADO), dominante DG (GENERICO) y un proveedor con DNI (`tipoDocContraparte` 1). `{ruc}-registro-sin-datos.json`, si existe, es una lista JSON de periodos AAAAMM sin registro (dan `ErrorDatos`); no hay uno en el repositorio, las pruebas lo generan. |
| `sire/20700000100-compras-202610.json` | Propuesta de compras del cliente de Huánuco (01 §7 regla 3: zona Amazonía, ventas exoneradas, sin mixtas), para R-STD de la spec 025. El RUC es el último de `rucs-prueba.json`. |
| `sire/generico-compras.json`, `sire/generico-ventas.json` | Conjunto genérico por libro, para un RUC y un periodo sin fixture propio. Es una plantilla y no lleva RUC del contribuyente. El de ventas trae solo las boletas B001-290 y B001-292. |
| `sol/buzon/{ruc}.json` | Buzón SOL del contribuyente de prueba para `MockSolPortal` (spec 023, `SOL_PORTAL=mock`): forma `{mensajes: [...]}` con asunto, remitente, fecha ISO con zona, `codigoTipo`, `leidoEnSunat`, contenido (texto o HTML, uno con `<script>`) y adjuntos `{idSunat, nombre, base64}` o `{idSunat, nombre, tamano}` (bytes sintéticos que no se materializan si pasan el tope). Trae una coactiva, una RD, una RM, un requerimiento y comunes, con variantes de asunto (tildes, mayúsculas, abreviaturas); adjuntos PDF, XML, PNG, ZIP, dos de nombre hostil (`..\`, NUL, bidi) y uno de 25 MiB que sale omitido por tamaño. Un RUC sin archivo recibe un buzón generado por el mock, determinista por RUC. Sin RUC de 11 dígitos fuera de `rucs-prueba.json`; máximo 1 MiB. |
| `sol/pdt621/{ruc}.json` | PDT 621 del contribuyente de prueba para `MockSolPortal.obtenerDeclaraciones621` (spec 026, `SOL_PORTAL=mock`): forma `{periodos: {AAAAMM: [Declaracion621] \| "error_datos"}}` (un periodo ausente es «sin declaración»). El de `20700000002` (cliente de la E2E de 026, 01 §7.4) trae 11 meses declarados (2025-11 a 2026-09) con ventas gravadas y exoneradas, 2026-10 sin declarar, una rectificatoria (2026-06) y prorrata usada «72.00» en 2026-09. Un RUC sin archivo recibe un PDT generado por el mock, determinista por RUC. Montos como cadenas con dos decimales; máximo 1 MiB. |
| `ruc/ciiu.json` | Clase CIIU (4 dígitos) de la actividad principal por RUC para `MockConsultaRuc` (spec 027, `RUC_CLIENT=mock`): objeto `{ruc: clase \| null}`; `null` es «el padrón no informa la clase». Trae la ferretería `20700000002` (4752, cliente de la E2E de 027), el proveedor de zapatillas `20700000070` (4771), un restaurante `20700000045` (5610), el proveedor genérico `20700000096` (`null`) y el cliente de Huánuco `20700000100` (4711). Un RUC que no está recibe una clase determinista del mock. Un defecto del archivo hace que el mock rechace con `ErrorDatos`; máximo 1 MiB. Solo RUC de `rucs-prueba.json`. |
| `generarFilasComprasVolumen` (código en `packages/sunat/src/mock/sire-api-client.mock.ts`) | Las 5.000 filas de compras de CA-15. Se generan y no se guardan como archivo, porque el mock rechaza los de más de 1 MiB. Son deterministas, con RUC y razones sociales de `rucs-prueba.json` (sin el contribuyente) y números que terminan en 0-6. |

Cada `sire/*.json` tiene `libro`, `periodo` (AAAAMM) y `filas`. En compras, los campos de cada fila son los de `FilaPropuestaSire`: desde 014 traen `razonSocialContraparte`; `tipoDocContraparte` es opcional y ausente significa «6» (RUC), así que los fixtures de compras no lo traen. En ventas son los de `FilaVentaSire` (`tipo`, `serie`, `numero`, `tipoDocContraparte` solo con documento, `docContraparte`, `fechaEmision`, `moneda`, `tipoCambio` solo en USD, `baseGravada`, `igv`, `exonerada`, `inafecta`, `isc`, `icbper`, `otros` y `total`). Ventas ya no usa las columnas de compras (`biDg`, `igvDg`, `noGravado`…). Los montos van como cadenas con dos decimales, y `tipoCambio` (tres decimales) aparece solo en USD; una venta USD puede no traerlo, y entonces no suma en el resumen.

## Reglas

- **Nombres.** XML `{ruc}-{tipo}-{serie}-{numero}.xml`; SIRE `{ruc}-{libro}-{periodo}.json`; genéricos `generico-{libro}.json`.
- **Campos.** `tipo` de 2 caracteres (`01` factura, `03` boleta, `07` nota de crédito). `serie` de 4 alfanuméricos en mayúsculas (`F001`, `F002`, `B001`, `B003`). `numero` de 1 a 8 dígitos, sin ceros a la izquierda.
- **Últimos dígitos.** Ningún RUC ni número de comprobante termina en **7, 8 ni 9**: son los centinelas de los mocks (D5). Los montos no tienen esa restricción (`8.97` y `21.48` son válidos).
- **RUC.** 11 dígitos, prefijo 20 y dígito verificador módulo 11 válido (`validarRuc`). Todos los de esta carpeta terminan en 0-6.
- **Contraparte en ventas.** `docContraparte` es `-` para el consumidor final, sin `tipoDocContraparte`. Con documento, `tipoDocContraparte` es `6` (RUC, el mismo código que usa 012 en `TIPO_DOC_RUC`) y `docContraparte` es un RUC de `rucs-prueba.json`. Los roles de esa tabla son de compras: en ventas el RUC solo identifica al cliente de prueba.
- **Notas de crédito.** `tipo` `07` con montos negativos, también el total (010 D6).

## Casos y cifras

### Compras

| Caso | Archivo | Dato en el XML | Fila SIRE (compras) |
|---|---|---|---|
| San Juan | `xml/20700000011-01-F001-1040.xml` | ISC 2000 de 770.00 separado; valor 0.00, IGV 0.00, total 770.00 | DG 770.00 e IGV DG 0.00: el ISC va en DG (mal ubicado) |
| Mixta | `xml/20700000045-01-F001-2056.xml` | Gravado 8.97 con IGV 1.61 (18 %); no gravado (exonerado, 9997) 12.51; valor 21.48; total 23.09 | DG 21.48 e IGV DG 1.61: todo en DG (mal ubicado) |
| ICBPER | `xml/20700000053-01-F001-3064.xml` | ICBPER 7152 por línea: 3 bolsas × 0.50 = 1.50; IGV 18.00 sobre 100.00; total 119.50 | DG 100.00, IGV DG 18.00, ICBPER 1.50 (correcta) |
| Redondeo USD | `xml/20700000061-01-F001-4062.xml` | En USD: BI 0.15, IGV 0.03, total 0.18; TC 3.300 (sintético, 010 CA-13) | USD, TC 3.300: DG 0.15, IGV DG 0.03, total 0.18 |
| Zapatilla | `xml/20700000070-01-F001-5070.xml` | Línea «Par de zapatillas deportivas de prueba»: 150.00 + IGV 27.00 | DG 150.00, IGV DG 27.00, total 177.00 |

### Ventas (`sire/20700000002-ventas-202610.json`)

Sin XML. Montos en la moneda del comprobante. Cada (tipo, serie) se evalúa por separado (CA-6).

| Caso | Filas (tipo, serie-número) | Qué cubre |
|---|---|---|
| Boleta 291 | 03 B001-290 (118.00) y 03 B001-292 (59.00) | Falta B001-291 (CA-6, CA-8, CA-11) |
| Serie completa | 01 F001-10, F001-11 y F001-12 | «Numeración completa»; empieza en 10, así que no genera faltantes anteriores |
| Nota de crédito | 07 F001-1: base -50.00, IGV -9.00, total -59.00 | La NC resta (CA-9) |
| USD con tipo de cambio | 01 F002-1: base 200.00, IGV 36.00, total 236.00 USD, TC 3.300 (778.80 PEN) | Conversión a soles (CA-9) |
| USD sin tipo de cambio | 01 F002-2: total 118.00 USD, sin `tipoCambio` | `sinConvertir` y `usd_sin_tipo_cambio` (CA-9) |
| Salto de varios números | 03 B003-400, B003-401 y B003-405 | Faltan B003-402 a B003-404 (un rango) |
| Base exonerada | 01 F001-12: exonerada 150.00, total 150.00 | Columna `exonerada` |

## Notas sobre las cifras

- **Mixta.** La tabla llama «total 21.48» al valor de venta (8.97 gravado + 12.51 no gravado). El importe total con IGV es 23.09. Es lo que cuadra con IGV 18 %: `igvEsperado(8.97, 18 %) = 1.61` (010).
- **San Juan.** La fila tiene 770.00 en DG. Como el total de la fila debe igualar al del XML, el XML no tiene valor de venta: valor 0.00, ISC 770.00, total 770.00.
- **ICBPER.** No hay tarifa documentada en `docs/`, así que se usa 0.50 por bolsa, como indica el plan. Es un valor de prueba.
- **USD.** Los montos van en la moneda del comprobante. La conversión a PEN la hace 010 con el TC (D7).
- **Genéricos.** El periodo `202610` es de ejemplo. Los genéricos no tienen RUC del contribuyente; el mock los usa cuando no existe el fixture del RUC y periodo pedidos.

## Qué no es

- Los XML están bien formados (`xmllint --noout`) y cuadran: los totales son la suma del desglose y el IGV es el 18 % de su base. **No** se validaron contra los XSD de UBL ni contra las reglas de SUNAT, y no llevan firma.
- No es un registro de SUNAT. No copiar a otros entornos ni tratar como datos reales.
