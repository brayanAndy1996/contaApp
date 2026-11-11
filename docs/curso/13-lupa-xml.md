# 13 · La lupa del comprobante: XML UBL, parser seguro y re-evaluación

> Módulo anterior: [12-compras.md](12-compras.md) · Índice: [00-indice.md](00-indice.md)
>
> Cubre la spec **016** (lupa del comprobante y XML, solo compras). Conviene haber leído [03](03-rls-y-withtenant.md), [05](05-bullmq-y-la-cola.md), [08](08-dinero-y-dominio.md) y [10](10-prevalidacion-y-archivo-sire.md).

## Lo que aprenderás

- Qué es el **XML UBL 2.1** de un comprobante electrónico y en qué se diferencia de la fila del SIRE.
- Cómo el **parser seguro** de `packages/domain/src/ubl/` rechaza XML hostiles (XXE, «billion laughs») y XML **ambiguos** antes de leer un solo monto.
- Dónde se guarda el XML (`packages/storage`) y qué guarda la BD (`documento_xml`, `documento_xml_obtencion`, `compra_evaluacion`).
- Cómo llega el XML solo (trabajo `xml.obtener`) o lo sube el contador («Subir XML», «Agregar desde XML»).
- Cómo las reglas de 011 se **re-evalúan** con los montos exactos del XML sin crear una versión nueva de la fila.
- Qué enseña el hallazgo **H-016-8** sobre el principio de **mínimo privilegio**.

---

## 1. El problema: la fila del SIRE es un resumen, no la factura

La propuesta del SIRE trae una fila por comprobante: base imponible, IGV, no gravado, total. Es como el **asiento del Registro de Compras**: dice cuánto, pero no qué se compró. Cuando el motor de reglas de 011 ve una compra mixta (21.48 de valor con 1.61 de IGV), solo puede **estimar** cuánto es gravado («8.94, entre 8.92 y 8.97»). El contador, para estar seguro, tiene que ir a SOL y abrir la factura.

La factura original sí lo dice todo: cada ítem, su afectación y sus impuestos. En el Perú, esa factura electrónica es un archivo **XML** con el formato **UBL 2.1** (Universal Business Language, un estándar internacional de OASIS que SUNAT adoptó para sus comprobantes electrónicos).

El objetivo de 016 (spec, «Objetivo»): que el contador abra la **lupa** de una compra y vea la factura completa sin ir a SUNAT, y que las reglas usen los **montos exactos** del XML.

## 2. UBL 2.1 en cinco minutos

Un XML es texto con etiquetas anidadas, como un expediente con carpetas dentro de carpetas. Este es el comienzo del fixture de la compra mixta, `fixtures/xml/20700000045-01-F001-2056.xml:3-11` (fragmento):

```xml
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>2.0</cbc:CustomizationID>
  <cbc:ID>F001-2056</cbc:ID>
  <cbc:IssueDate>2026-10-05</cbc:IssueDate>
  <cbc:InvoiceTypeCode listID="0101">01</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
```

Lo que importa para ContApp:

| Parte del XML | Qué es, en lenguaje contable |
|---|---|
| Raíz `Invoice`, `CreditNote` o `DebitNote` | Factura o boleta (01, 03), nota de crédito (07), nota de débito (08) |
| `cbc:ID` | Serie y número (`F001-2056`) |
| `AccountingSupplierParty` / `AccountingCustomerParty` | Proveedor (emisor) y cliente (receptor), con su RUC |
| `cac:InvoiceLine` | Una línea de la factura (un ítem) |
| `cac:TaxTotal` → `TaxSubtotal` → `TaxScheme/ID` | El cuadro de impuestos, por tributo (catálogo 05 de SUNAT) |
| `LegalMonetaryTotal/PayableAmount` | El importe total |

Los códigos de tributo que mapea el parser (spec D-2): **1000** gravado e IGV, **9997** exonerado y **9998** inafecto (no gravado), **2000** ISC, **7152** ICBPER, **9999** otros (solo se muestra), y **9995/9996** (exportación y gratuitas) solo aparecen en los ítems y no suman.

Los prefijos (`cbc:`, `cac:`) son como el membrete de cada carpeta: cambian de un emisor a otro, así que el parser los ignora (`removeNSPrefix: true`).

## 3. El parser seguro: abrir un sobre sin que explote

Un XML que llega de afuera (lo sube el usuario o lo devuelve un proveedor) es **no confiable**. El nivel de riesgo de 016 es **A** justamente por esto: un monto mal leído del XML se ve igual de «exacto» que uno bien leído, y la aceptación masiva de 014 aplica sin preguntar las sugerencias exactas.

### Los dos ataques clásicos

XML tiene una función antigua llamada **DTD** (`<!DOCTYPE …>`), que permite declarar **entidades**: abreviaturas que el lector reemplaza por su contenido.

- **XXE (entidad externa).** `<!ENTITY x SYSTEM "file:///etc/passwd">` le dice al lector: «donde veas `&x;`, pega el contenido de este archivo del servidor». Es como un formulario que dice «adjunte aquí la copia del libro de caja del estudio» y un empleado obediente lo hace.
- **«Billion laughs» (mil millones de risas).** Una entidad `a` = «jaja»; `b` = diez veces `a`; `c` = diez veces `b`… Con diez niveles, un archivo de 1 KB se expande a miles de millones de «jaja» y se come la memoria. Es una cadena de fotocopias de fotocopias.

ContApp no se defiende con «leer con cuidado»: **no deja pasar nada que tenga `<!DOCTYPE` o `<!ENTITY`**, ni siquiera dentro de un comentario.

### El orden fijo: primero los bytes, después el texto

`packages/domain/src/ubl/leer.ts:326-337`:

```ts
export function leerUbl(bytes: Uint8Array): DetalleXml {
  try {
    if (!(bytes instanceof Uint8Array)) invalido();
    escanear(bytes);
    const xml = decodificar(bytes);
    if (XMLValidator.validate(xml) !== true) invalido();
    return mapear(new XMLParser(OPCIONES).parse(xml) as Nodo);
  } catch (e) {
    // Un error ajeno (p. ej. el del parser) puede citar la entrada: se descarta entero. El propio se re-crea sin pila previa.
    throw new UblError(e instanceof UblError ? e.codigo : "xml_invalido");
  }
}
```

Cinco pasos, y ninguno parsea antes de que pasen los anteriores:

1. **`escanear`** (`ubl/escaneo.ts`): una pasada lineal sobre los **bytes** con los topes de la decisión P-5.
2. **`decodificar`** (`ubl/decodificar.ts`): bytes → texto, solo `UTF-8` o `ISO-8859-1` (los XML de SUNAT suelen venir en ISO-8859-1).
3. **`XMLValidator`**: ¿está bien formado?
4. **`fast-xml-parser`** con las entidades apagadas.
5. **`mapear`**: de etiquetas a montos con `Money` (módulo 08). Nunca `number`: el lint lo prohíbe también en `ubl/` (`eslint.config.mjs:845`).

Los topes están en `packages/domain/src/ubl/escaneo.ts:14-16`: `TOPE_BYTES` 1.048.576 (1 MiB), `TOPE_ITEMS` 2.000 y `TOPE_PROFUNDIDAD` 32 niveles de anidamiento. Una factura real con 500 ítems pesa mucho menos; el tope es para que un archivo hostil se rechace en tiempo proporcional a su tamaño.

La primera pasada, `escaneo.ts:94-105`:

```ts
/** Pasada 1: tamaño, BOM de UTF-16, NUL y cualquier `<!DOCTYPE` o `<!ENTITY`. */
function escanearBytes(b: Uint8Array): void {
  if (b.length > TOPE_BYTES) invalido();
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) invalido();
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x00) invalido();
    if (c === MENOR && b[i + 1] === EXCLAMACION && (empiezaSinCaso(b, i + 2, DOCTYPE) || empiezaSinCaso(b, i + 2, ENTITY))) {
      invalido();
    }
  }
}
```

Y, por si acaso, el parser se configura sin entidades (`leer.ts:17-33`: `processEntities: false`, `htmlEntities: false`) y con `parseTagValue: false`: así `8.97` llega como **texto** `"8.97"`, no como número, y pasa directo a `Money` sin perder céntimos.

### El error no repite nada

`UblError` tiene solo dos códigos, `xml_invalido` y `xml_incompleto`, con mensajes fijos (`ubl/tipos.ts:66-69`). Si el XML trae una glosa con datos sensibles o un `<script>`, nunca aparece en un log ni en una respuesta de error (D-11).

## 4. XML ambiguos: dos totales en la misma factura (H-016-1 a H-016-7)

La primera ronda adversarial (módulo 09) no buscó XML que rompan el servidor, sino XML que **engañen** al parser. La idea: si una factura trae dos cuadros de totales, ¿cuál vale? Un contador la devolvería al proveedor. ContApp también: la rechaza.

`packages/domain/src/ubl/leer.ts:279-284`:

```ts
  // Un solo total por documento (H-016-2, H-016-5): un segundo TaxTotal, total monetario o importe es ambiguo.
  aLoSumoUno(n, "TaxTotal");
  aLoSumoUno(n, "LegalMonetaryTotal", "RequestedMonetaryTotal");
  const monetario = primero(n, "LegalMonetaryTotal") ?? primero(n, "RequestedMonetaryTotal");
  aLoSumoUno(monetario, "PayableAmount");
  aLoSumoUno(monetario, "TaxInclusiveAmount");
```

Los siete hallazgos de la ronda 1 (decisión técnica (d) de la spec) y cómo se cerraron:

| Hallazgo | El truco | La defensa |
|---|---|---|
| H-016-1 | 2.001 líneas **autocerradas** (`<cac:InvoiceLine/>`) no contaban para el tope de ítems | Toda línea de apertura cuenta, también la autocerrada (`escaneo.ts:132-136`) |
| H-016-2, H-016-5 | `TaxTotal`, `LegalMonetaryTotal`, `PayableAmount` o `TaxInclusiveAmount` duplicados | `aLoSumoUno` (arriba): repetido = `xml_invalido` |
| H-016-3 | Raíz `Invoice` con tipo 07 (nota de crédito disfrazada) | `Invoice` solo admite 01 y 03 (`leer.ts:42-43`, `:196`) |
| H-016-4 | Importes negativos en el XML | Negativo = `xml_invalido`; el signo de la nota de crédito lo pone el mapeo |
| H-016-6 | Declaración de codificación engañosa: `encoding` repetido, con espacios o mal entrecomillado | Gramática estricta de la declaración (`decodificar.ts:10-15`) |
| H-016-7 | `GET xml` leía una ruta de storage sin validar su prefijo | Solo rutas `xml/{tenant}/{cliente}/` del estudio y cliente de la petición; otra da 404 |

`escaneo.ts:128-141` (fragmento), la corrección de H-016-1:

```ts
    const fin = finEtiqueta(b, i + 1);
    if (siguiente === BARRA) {
      profundidad--;
    } else {
      // Toda línea de apertura cuenta para el tope, también la autocerrada (H-016-1): el mapeo la tomaría como ítem.
      if (esLinea(b, i + 1)) {
        lineas++;
        if (lineas > TOPE_ITEMS) invalido();
      }
      if (b[fin - 1] !== BARRA) {
        profundidad++;
        if (profundidad > TOPE_PROFUNDIDAD) invalido();
      }
    }
```

¿Por qué importa la codificación (H-016-6)? Si la cabecera dice dos cosas distintas, el escáner podría leer los bytes de una forma y el parser de otra: como un cheque con el monto en números distinto del monto en letras. Ante la duda, se rechaza.

## 5. Dónde vive el XML: storage y tres tablas

### `packages/storage`: el archivador

El XML crudo (los bytes tal como llegaron) no va a la BD: va a un **almacenamiento de archivos** detrás de un puerto (`packages/storage/src/puerto.ts:2-6`):

```ts
export interface StorageProvider {
  guardar(ruta: string, bytes: Uint8Array): Promise<void>;
  leer(ruta: string): Promise<Uint8Array>;
  eliminar(ruta: string): Promise<void>;
}
```

Hay dos adaptadores: `MockStorage` (en memoria, el de por defecto) y `LocalStorage` (disco, carpeta `./storage`). Se eligen con `STORAGE=mock|local` (`packages/storage/src/index.ts:32-51`). En producción con `mock` no arranca, salvo `PERMITIR_ADAPTADORES_MOCK=1`. S3 queda para el despliegue.

La ruta nunca contiene nada que escriba el usuario. `packages/storage/src/ruta.ts:7-13`:

```ts
/** `xml/{tenant}/{cliente}/{uuid}.xml`. Las tres partes deben ser uuid (minúsculas): nada del usuario entra en la ruta. */
export function rutaXml(tenantId: string, clienteId: string, uuid: string): string {
  for (const parte of [tenantId, clienteId, uuid]) {
    if (typeof parte !== "string" || !RE_UUID.test(parte)) throw new RutaStorageError();
  }
  return `xml/${tenantId}/${clienteId}/${uuid}.xml`;
}
```

Es el mismo principio que los ZIP del módulo 10 (`archivos/{tenant}/{cliente}/{id}.zip`): un archivador con cajones numerados por el sistema, nunca con el nombre que el cliente escribió en la carpeta. Así no hay forma de pedir `../otro-estudio/…`.

### Las tres tablas

| Tabla (migración) | Qué guarda | Permisos |
|---|---|---|
| `documento_xml` (0035) | Un XML por comprobante y número `n` (1, 2, 3…): ruta, SHA-256, tamaño, `origen` (`simulado`, `real`, `subido`), el `detalle` ya parseado (jsonb), autor si se subió | `SELECT, INSERT`: solo inserción, el vigente es el de mayor `n` |
| `documento_xml_obtencion` (0035) | Estado de la búsqueda automática por comprobante: `pendiente`, `no_encontrado`, `credencial`, `transitorio`, con intentos | La única de 016 con `UPDATE` (solo de `estado`, `intentos`, `actualizado_en`) |
| `compra_evaluacion` (0036) | Cada evaluación de reglas de una versión: (compra, versión, `n`, con qué XML) | `SELECT, INSERT` |

`documento_xml` va por **comprobante** (cliente, RUC emisor, tipo, serie, número), no por fila de compra: si descartas la compra y la vuelves a agregar, su XML sigue ahí (D-4). Las tres tienen RLS forzada como todo lo demás (módulo 03), y `documento_xml` solo recibe `GRANT SELECT, INSERT` para backend y worker (`packages/db/migrations/0035_documento_xml.sql:63-67`).

**Reemplazo (P-6).** «Subir XML» se acepta si no hay XML o si el vigente es `simulado`. Con uno `real` o `subido`, `409 xml_existente`. El anterior nunca se borra: es un libro de solo inserción.

**Detalle sin re-parsear (CA-18).** La lupa lee el `detalle` jsonb guardado, no vuelve a parsear el XML. El crudo solo se lee para descargarlo.

## 6. El XML llega solo: el trabajo `xml.obtener`

`packages/queue/src/catalogo.ts:183-189` (fragmento):

```ts
export const XML_OBTENER: DefinicionTrabajo<ParametrosObtenerXml> = {
  tipo: "xml.obtener",
  cola: "xml",
  canal: "ninguno",
  credencial: null,
  permiso: "sire.clasificar",
  idempotente: true,
```

`credencial: null` (P-7): hoy el único proveedor es el mock (`XML_PROVIDER=mock`), que no necesita clave SOL. Cuando el equipo entregue la fuente real, su spec fijará credencial y canal propios.

El recorrido:

```text
 Descarga de la propuesta (013) ── commit ──► trasConfirmar (persistidor de compras)
   │ listarPorObtener + planificarObtencionXml → lotes de ≤ 100, primero las filas con hallazgos
   ▼
 encolar_xml_obtener (función SQL acotada, una por lote, prioridad «programado»)
   ▼
 Worker: xml.obtener, por cada compra del lote
   │ XmlProvider.obtener (fuera de transacción) → leerUbl → compararIdentidad → storage
   ▼
 withTenant: guardarDocumentoXml + fijarObtencion + (si P-4 lo permite) reevaluarComprobante
```

El gancho tras la descarga es `trasConfirmar` (`apps/worker/src/trabajos/persistidores/compras.ts:239-258`). Si falla, solo se registra un código: la descarga de 013 no cambia ni falla (`descargar-propuesta.ts:114-130`).

### ¿Por qué una función acotada para encolar?

En el módulo 05 viste que el **worker no tiene `INSERT` en `job_registro`** (0018): solo el backend crea trabajos. Pero aquí el worker necesita encolar lotes. En vez de darle `INSERT` general, la decisión del usuario (a) del 2026-11-10 fue una **ventanilla**: `encolar_xml_obtener` (0037), una función `SECURITY DEFINER` (módulo 02) que **solo** puede crear un trabajo `xml.obtener` `en_cola` de la cola `xml`, toma el estudio de `app.tenant_id` y aplica el dedupe y el tope de 008. Su `EXECUTE` es solo de `contapp_worker` (`0038_compra_worker_sin_update.sql:178-181`).

(La versión vigente está en 0038, que la reemplaza con `CREATE OR REPLACE` para corregir H-016-9: el candado del tope ahora usa el estudio normalizado en minúsculas.)

Repetir la descarga no duplica nada: el dedupe de 008 reconoce el mismo lote, y `planificarObtencionXml` omite lo que ya tiene XML o está `pendiente` (CA-10).

## 7. Re-evaluar las reglas con el XML

Cuando llega el XML de la compra mixta, R-MIX deja de estimar: con los ítems a la vista sabe que el gravado es **8.97** y el no gravado **12.51**, y su sugerencia pasa a `requiereConfirmacion = false` (CA-6). Con F001-1040 (San Juan), R-ISC sugiere mover 770.00 de DG a ISC respaldado por el XML (CA-7).

### Evaluación numerada: corregir sin rehacer el asiento (P-2)

En 014 los hallazgos se guardaban por (compra, versión, regla). Si el XML llegaba después, re-evaluar la **misma** versión chocaba con esa clave única. Crear una versión nueva no servía: movería `versionBase`, rompería deshacer y las ediciones en curso.

La solución es `compra_evaluacion`: cada versión puede tener varias evaluaciones (1, 2, 3…), y los hallazgos vigentes son **los de la última evaluación de la versión vigente**. Es como adjuntar una nueva hoja de revisión al legajo sin tocar el asiento contable. La migración 0036 hizo un *backfill*: una evaluación `n = 1` sin XML por cada versión existente.

Al llegar o subirse un XML se re-evalúan **todas** las compras vivas del mismo comprobante, en cualquier periodo (`reevaluarComprobante`, H-016-11). Y al **aceptar** una sugerencia, en la lupa o en bloque, se vuelve a evaluar con el XML vigente: si el resultado ya no es el que se mostró, `409 revisar_de_nuevo` (H-016-10).

### La bandera `XML_SIMULADO_EN_REGLAS` (P-4)

El mock entrega XML **simulados**: sirven para ver la lupa, pero no son la factura real. `packages/domain/src/compras/evaluar.ts:122-125` (fragmento):

```ts
function resumenXml(c: CompraEvaluable, opciones: OpcionesEvaluar): ResumenXml | null {
  const xml = c.xml;
  if (xml === undefined || xml === null) return null;
  if (xml.origen === "simulado" && !opciones.xmlSimuladoEnReglas) return null;
```

- Sin la bandera (por defecto, `0`): el simulado se muestra con el distintivo «XML simulado», pero no entra en las reglas ni crea evaluación.
- Con `XML_SIMULADO_EN_REGLAS=1` (está así en `.env.example`, para desarrollo y pruebas): entra como si fuera real.
- Un XML `subido` o `real` entra siempre.

Backend (`escritura.ts:47`) y worker (`trabajos.module.ts:91`, `persistidores/compras.ts:229`) leen la misma bandera. Cambiarla no re-evalúa lo ya guardado: rige desde la siguiente llegada o versión.

## 8. El contador sube el XML

Las rutas (plan, «Contratos») cuelgan de `/clientes/:clienteId/periodos/:periodo/compras`:

| Ruta | Qué hace | Permiso |
|---|---|---|
| `GET /:compraId/detalle` | Todo lo que muestra la lupa (no encola, no re-parsea) | `clientes.ver` |
| `POST /:compraId/xml/obtener` | Encola un `xml.obtener` interactivo de un solo comprobante | `sire.clasificar` |
| `POST /:compraId/xml` | «Subir XML»: cuerpo crudo hasta 1 MiB | `sire.clasificar` |
| `GET /:compraId/xml` | Descarga como adjunto, `application/xml`, `nosniff` | `clientes.ver` |
| `POST /desde-xml/vista-previa` | Parsea y devuelve los campos; no guarda nada | `sire.clasificar` |
| `POST /desde-xml?destino=…[&tipoCambio=…]` | Crea la compra y guarda su XML en una transacción | `sire.clasificar` |

**Subir XML (HU-22).** El XML tiene que ser **de esa compra**: mismo RUC emisor, tipo, serie, número, y el receptor tiene que ser el RUC del cliente (D-3). Si no, `422 xml_ajeno` con los campos que difieren. Es como verificar que la factura que te entregan está a nombre de tu cliente antes de archivarla.

**Agregar desde XML (HU-18, P-9).** Desde «Agregar compra», el contador elige el XML; la vista previa prellena todo y solo pide el **destino** (DG, DGNG, DNG). Si el comprobante es en **USD**, pide además el **tipo de cambio**: el XML no suele traerlo y 014 lo exige. Se valida con el mismo `agregarCompraSchema` que el ingreso manual (`apps/backend/src/modules/compras/desde-xml.service.ts:140-153`).

USD sin tipo de cambio, o PEN con uno, da `400 solicitud_invalida`. Si la compra ya existe, `409 duplicado`.

## 9. La lupa en pantalla

`apps/frontend/components/compras/lupa-compra.tsx` es un modal accesible (`aria-modal`, foco atrapado) con: cabecera, estado del XML (`estado-xml.tsx`), ítems (`items-xml.tsx`), comparación SIRE vs XML por columna con las diferencias resaltadas y la regla que las explica (`comparacion-xml.tsx`), hallazgos y sugerencia, y el historial de la compra y del proveedor.

El teclado (`lupa-compra.tsx:199-234`): **← →** recorren las compras en el orden de la grilla, **Esc** cierra, **Enter** abre la aceptación de la sugerencia visible y un **segundo Enter** la confirma (decisión del usuario (c)). En un campo de texto, las flechas y Enter son del campo.

**«Editar»** (decisión del usuario (b)): la lupa no tiene un formulario propio. El botón recarga la fila, cierra la lupa y abre esa compra en edición en la grilla de 015, con sus mismas rutas y sus mismos 409 y 422 (`lupa-compra.tsx:177-188`). Una sola forma de editar, un solo lugar donde corregir errores.

El estado del XML se muestra siempre en texto: «XML simulado», «XML subido por … el …», «Pendiente», o «No disponible» con «Reintentar» y «Subir XML». Las glosas y la razón social se pintan como **texto** (sin `dangerouslySetInnerHTML`): un `<script>` en una glosa se ve como letras, no se ejecuta (CA-17).

## 10. H-016-8: el permiso que sobraba

Para re-evaluar, el worker tiene que **bloquear** la fila de `compra` (`FOR UPDATE`), igual que toda escritura de 014, para que una edición y la llegada del XML no se pisen (CA-8). En PostgreSQL, `SELECT … FOR UPDATE` exige privilegio `UPDATE` sobre alguna columna. Por eso 0036 le dio al worker `GRANT UPDATE (version_vigente) ON public.compra` (`0036_compra_evaluacion.sql:55`).

La segunda ronda adversarial (`tests/aislamiento/compras-xml-r2.adv.spec.ts`) vio el problema: con ese permiso, el worker **podía mover el puntero `version_vigente`** y crear versiones de compras. Nadie lo hacía en el código, pero si el worker se viera comprometido, podría cambiar qué versión de una compra cuenta. Fue el único hallazgo **alto** de 016.

La corrección, `packages/db/migrations/0038_compra_worker_sin_update.sql:16-17`:

```sql
REVOKE UPDATE ON public.compra FROM contapp_worker;--> statement-breakpoint
REVOKE UPDATE (version_vigente) ON public.compra FROM contapp_worker;--> statement-breakpoint
```

Y para bloquear, otra ventanilla: `bloquear_compras_reevaluar` (`0038:19-37`), una función `SECURITY DEFINER` que **solo** bloquea (`FOR UPDATE`, por id ascendente) las compras vivas del estudio de `app.tenant_id` y devuelve sus ids. No lee ni escribe nada más. Además, un trigger (`0038:43-68`) acota el `INSERT` del worker en `compra_version` a la versión `n = 1` de una compra creada en su misma transacción (lo único que hace la descarga).

**La lección: mínimo privilegio.** A cada rol se le da exactamente lo que necesita, ni una columna más. Es como el auxiliar contable que necesita sellar el libro: le das el sello de «revisado», no la llave del archivo con permiso para arrancar hojas. «Nadie lo usa» no es una defensa; «nadie puede usarlo» sí.

## Práctica

**A. Leer los fixtures con el parser** (desde la raíz, tras `pnpm --filter @contapp/shared build` y `pnpm --filter @contapp/domain build`):

```bash
cd packages/domain && node -e '
const fs = require("fs");
const d = require("./dist");
const x = d.leerUbl(fs.readFileSync("../../fixtures/xml/20700000045-01-F001-2056.xml"));
console.log(x.raiz, x.identidad.serie + "-" + x.identidad.numero, x.moneda, x.items.map(i => i.afectacion + " " + i.valor).join(", "));
console.log(JSON.stringify(x.totales));
const malo = Buffer.from("<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY a \"aaaa\">]><Invoice>&a;</Invoice>");
try { d.leerUbl(malo) } catch (e) { console.log(e.name, e.codigo, "-", e.message) }
const sj = d.leerUbl(fs.readFileSync("../../fixtures/xml/20700000011-01-F001-1040.xml"));
console.log("San Juan:", sj.totales.gravado, sj.totales.isc, sj.totales.total);'
# Invoice F001-2056 PEN gravado 8.97, exonerado 12.51
# {"gravado":"8.97","igv":"1.61","noGravado":"12.51","isc":"0.00","icbper":"0.00","otros":"0.00","total":"23.09"}
# UblError xml_invalido - El archivo no es un comprobante XML válido.
# San Juan: 0.00 770.00 770.00
```

**B. Engañar al parser** (mismo directorio; cada caso modifica el fixture de la mixta):

```bash
node -e '
const fs = require("fs");
const d = require("./dist");
const base = fs.readFileSync("../../fixtures/xml/20700000045-01-F001-2056.xml", "latin1");
const prueba = (nombre, texto) => {
  try { d.leerUbl(Buffer.from(texto, "latin1")); console.log(nombre, "→ aceptado"); }
  catch (e) { console.log(nombre, "→", e.codigo); }
};
const lineas = base.split("\n");
const taxTotal = lineas.slice(61, 92).join("\n");
prueba("original", base);
prueba("TaxTotal duplicado", base.replace(taxTotal, taxTotal + "\n" + taxTotal));
prueba("2.001 líneas autocerradas", base.replace("</Invoice>", "<cac:InvoiceLine/>".repeat(2001) + "</Invoice>"));
prueba("encoding repetido", base.replace("encoding=\"UTF-8\"", "encoding=\"UTF-8\" encoding=\"ISO-8859-1\""));
prueba("profundidad 32", base.replace("</Invoice>", "<a>".repeat(31) + "</a>".repeat(31) + "</Invoice>"));
prueba("profundidad 33", base.replace("</Invoice>", "<a>".repeat(33) + "</a>".repeat(33) + "</Invoice>"));
prueba("1 MiB + 1 byte", base + " ".repeat(1048577 - base.length));'
# original → aceptado
# TaxTotal duplicado → xml_invalido
# 2.001 líneas autocerradas → xml_invalido
# encoding repetido → xml_invalido
# profundidad 32 → aceptado
# profundidad 33 → xml_invalido
# 1 MiB + 1 byte → xml_invalido
```

**C. Correr las pruebas** (no necesitan BD):

```bash
pnpm --filter @contapp/domain test ubl    # 7 archivos, 208 pruebas
pnpm --filter @contapp/storage test       # 7 archivos, 192 pruebas
```

**D. Ver los XML guardados** (con la app levantada y una descarga hecha; `psql` como `postgres`):

```sql
SELECT ruc_emisor, tipo, serie, numero, n, origen, tamano, left(encode(sha256, 'hex'), 12) AS huella, creada_en
FROM documento_xml ORDER BY creada_en DESC LIMIT 5;
```

## Impacto en ContApp

- El contador ve la factura completa (ítems, impuestos, comparación con el SIRE) sin entrar a SOL.
- Las sugerencias de R-MIX y R-ISC pasan de «estimado» a «exacto» con el XML, y la aceptación masiva puede aplicarlas con confianza.
- Un XML hostil o ambiguo no llega a ningún monto: se rechaza antes, sin repetir su contenido en ningún log.
- Ningún XML se pierde ni se sobrescribe: `documento_xml` es de solo inserción y cada evaluación queda numerada.
- El worker tiene exactamente los permisos que necesita: dos funciones acotadas en vez de `INSERT` en la cola y `UPDATE` en compras.
- El día que llegue la fuente XML real, se agrega un `RealXmlProvider` detrás del mismo puerto. El parser, las tablas y la lupa no cambian.

## Errores comunes

- **«Subí el XML y me sale `xml_ajeno`.»** No es de esa compra: difiere el RUC, la serie, el número o el receptor. La respuesta dice qué campo.
- **«Me sale `409 xml_existente`.»** Ya hay un XML `real` o `subido`. Solo se reemplaza un `simulado` (P-6).
- **«El XML llegó pero las sugerencias siguen siendo estimadas.»** Si es `simulado`, revisa `XML_SIMULADO_EN_REGLAS`. Apagada (lo normal fuera de desarrollo), el simulado solo se muestra.
- **«Agregar desde XML en dólares me da 400.»** Falta el tipo de cambio (o sobra en soles). El XML no lo trae y no se toma de `PaymentExchangeRate` (P-9).
- **«Voy a darle `UPDATE` al worker para que bloquee más fácil.»** No: eso es exactamente H-016-8. Se usa `bloquear_compras_reevaluar`.

## Ejercicios

1. ¿Por qué el parser rechaza un `<!DOCTYPE` aunque esté dentro de un comentario, si un comentario no se procesa?
2. Un XML trae dos `cac:TaxTotal` a nivel documento: uno con IGV 1.61 y otro con IGV 0.00. ¿Qué hace ContApp y por qué no usa simplemente el primero?
3. Llega el XML de una compra con un hallazgo R-MIX. ¿Se crea una versión nueva de la fila? ¿Qué cambia en la BD?
4. ¿Por qué el worker encola `xml.obtener` con `encolar_xml_obtener` y no con un `INSERT` en `job_registro`?
5. Después de 0038, ¿qué le pasa al worker si intenta `UPDATE compra SET version_vigente = …`?

<details><summary>Soluciones</summary>

1. Porque la pasada de bytes no intenta interpretar la estructura: busca la marca en cualquier parte (`escaneo.ts:5`). Un escáner que tratara de adivinar qué está «dentro de un comentario» podría equivocarse donde el parser no, que es justo el tipo de desacuerdo que explotan los XML ambiguos (H-016-6). Un comprobante no necesita DTD, así que rechazar siempre no cuesta nada (D-1).
2. Responde `xml_invalido` (`aLoSumoUno`, `leer.ts:280`). Elegir el primero sería adivinar: el escáner, el parser o un humano podrían leer otro, y un monto mal elegido se vería igual de «exacto» (H-016-2).
3. No. Se inserta una `compra_evaluacion` con `n + 1` para la versión vigente y sus hallazgos; la versión, `versionBase` y deshacer no cambian (P-2, D-5, CA-6).
4. Porque el worker no tiene `INSERT` en `job_registro` (0018). La función solo crea un trabajo `xml.obtener` `en_cola` de la cola `xml`, con el estudio de `app.tenant_id`, el dedupe y el tope: mínimo privilegio (decisión del usuario (a), 0037).
5. PostgreSQL lo rechaza por falta de privilegio (42501), antes de mirar ninguna fila: 0038 le revocó todo `UPDATE` sobre `compra` (H-016-8).

</details>

## Para profundizar

- Spec del proyecto: [016 spec](../specs/016-lupa-xml/spec.md), con su [plan](../specs/016-lupa-xml/plan.md) y [tareas](../specs/016-lupa-xml/tasks.md).
- Pruebas adversariales: `packages/domain/src/ubl/ronda1.adv.spec.ts` y `tests/aislamiento/compras-xml-r2.adv.spec.ts`.
- OWASP, XXE: <https://owasp.org/www-community/vulnerabilities/XML_External_Entity_(XXE)_Processing>
- UBL 2.1 (OASIS): <https://docs.oasis-open.org/ubl/UBL-2.1.html>
- fast-xml-parser: <https://github.com/NaturalIntelligence/fast-xml-parser>
- PostgreSQL, `GRANT` y privilegios por columna: <https://www.postgresql.org/docs/current/sql-grant.html>
