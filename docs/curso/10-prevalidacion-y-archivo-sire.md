# 10 · Prevalidación y archivo SIRE: del periodo corregido al ZIP

> Módulo anterior: [09-pruebas-y-calidad.md](09-pruebas-y-calidad.md) · Siguiente: [11-ventas-y-correlatividad.md](11-ventas-y-correlatividad.md) · Índice: [00-indice.md](00-indice.md)
>
> Cubre las specs **012** (núcleo puro: prevalidación, formatos TXT y ZIP) y **012b** (guardado, versiones, descarga y pantalla). Conviene haber leído [03](03-rls-y-withtenant.md), [05](05-bullmq-y-la-cola.md) y [08](08-dinero-y-dominio.md).

## Lo que aprenderás

- Qué es la **prevalidación**, qué bloquea la generación y qué solo avisa.
- Cómo funcionan los **formatos TXT versionados** y por qué hoy solo existe uno **provisional**.
- Cómo se arma el **ZIP** con su SHA-256 y por qué el resultado sale idéntico byte por byte.
- El recorrido completo de «Generar archivo»: previo, **huella**, trabajo `archivo.generar`, storage y versión inmutable.
- Cómo se descarga una versión sin riesgo de servir un archivo alterado o de otro estudio.

---

## 1. El problema: un archivo «procesado con errores»

Cuando el contador sube a SUNAT el TXT de reemplazo del Registro de Compras (RCE) o de Ventas (RVIE), SUNAT lo procesa línea por línea. Basta una línea mala (un IGV que no cuadra, un comprobante repetido, un `|` dentro de la razón social que parte la línea en dos) para que el resultado sea «procesado con errores» y haya que volver a empezar.

La regla de ContApp (regla 11 de `docs/01-definiciones-base.md` §7) es simple: **ningún archivo que genere ContApp sale con errores**. Para lograrlo, antes de escribir una sola línea se revisa el periodo completo, como un auditor que revisa el registro antes de firmarlo.

## 2. Prevalidar: la revisión antes de firmar

La función vive en `packages/domain/src/prevalidacion/prevalidar.ts` y es **pura** (módulo 08): recibe filas y devuelve un veredicto, sin BD ni red.

```ts
prevalidar(filas, contexto) → { apto, errores[], avisos[] }
```

El comentario de cabecera del archivo (`prevalidar.ts:1-9`) resume el orden de las comprobaciones:

1. Lee la entrada **una sola vez** y la congela (así nadie la cambia a mitad de la revisión).
2. Elige el formato con `seleccionarFormato` (sección 3).
3. Revisa cada fila: estructura, fecha, tipo de cambio, cuadre, IGV y conversión USD.
4. Busca duplicados.
5. Si no queda ninguna fila generable, da `SIN_FILAS` (no se genera un TXT vacío).
6. Si hay reglas, corre el motor de 011 para **sugerir** cómo corregir.

### Bloquea o solo avisa

| Bloquea (`errores`) | Solo avisa (`avisos`) |
|---|---|
| Un campo que rompe el formato: obligatorio vacío, demasiado largo, RUC inválido, `\|`, salto de línea, carácter de control o fuera de la codificación | R-ISC: base gravada con IGV 0.00 (San Juan) |
| Total ≠ Σ componentes (tolerancia **0.00**) | R-NEW: proveedor nuevo |
| IGV que no es 18 % ni 10 % de la base (±0.01) | R-GP: posible gasto personal (la «zapatilla») |
| Fila USD sin tipo de cambio o con la conversión descuadrada | Ventas: salto de correlatividad («Falta B001-291») |
| El mismo comprobante dos veces | `RAZON_SOCIAL_RECORTADA` (012b, sección 6) |

No existe un «generar de todos modos» (decisión D16 de 012): la fila se **corrige** o se **excluye**. Tampoco se arregla nada en silencio: un texto con un `|` no se limpia, se reporta (D13).

Cada error lleva `filaId`, código, campo y una explicación con cifras, por ejemplo **«1.61 no es 18 % ni 10 % de 21.48»** (la compra mixta del fixture, CA-1). La pantalla usa el `filaId` para llevarte a esa fila.

> **Una sola verdad aritmética (D1).** La prevalidación no tiene su propia forma de sumar: reutiliza `verificarCuadre`, `igvCuadra`, `convertirAPen` y `redondearSunat` del módulo 08. Si el cuadre cambia algún día, cambia en un solo sitio.

### El resumen de cambios

`resumirCambios(original, vigente)` (`prevalidacion/resumen.ts`) compara lo que llegó del SIRE con lo que vas a enviar: cuántas filas **modificadas**, **excluidas** y **agregadas**, y el impacto en IGV por destino (DG, DGNG, DNG) y total, todo en `Money`. Una fila que editaste y luego devolviste a sus montos originales no cuenta como modificada.

## 3. Formatos TXT versionados

SUNAT cambia de vez en cuando la estructura de sus archivos. Por eso el formato **no** está escrito a mano dentro del serializador: es un **dato** con versión, en `packages/domain/src/formatos/`.

`packages/domain/src/formatos/provisional-rce.ts:17-43` (fragmento):

```ts
export const FORMATO_PROVISIONAL_RCE: FormatoTxt = {
  id: "RCE-REEMPLAZO",
  libro: "compras",
  version: "0-provisional",
  vigenteDesde: "202601",
  oficial: false,
  codificacion: "latin1",
  separador: "|",
  finDeLinea: "\r\n",
  incluyeExcluidas: false,
  campos: [
    campo("periodo", true, 6, "codigo"),
    campo("tipoComprobante", true, 2, "codigo", /^[0-9]{2}$/),
    // … serie, número, fecha, proveedor, razón social, moneda, TC, montos y total
  ],
  nombre: nombreProvisional,
};
```

Las ideas clave:

- **`vigenteDesde`**: para un periodo dado gana la versión más reciente con `vigenteDesde ≤ periodo`. Si el periodo es anterior a todas, `FormatoNoVigenteError`.
- **`oficial: false`**: la estructura oficial de SUNAT todavía **no está en el repositorio** y no se inventa (D10). Este formato es una herramienta para probar el motor. Cuando llegue el anexo de SUNAT con un archivo de muestra aceptado, se agrega como otra entrada con `oficial: true`, sin tocar el motor.
- **Nombres inconfundibles**: los archivos provisionales se llaman `CONTAPP-PROVISIONAL-<RUC>-<AAAAMM>-RCE.txt` (o `RVIE`), para que nadie los confunda con uno oficial (`formatos/nombres.ts:11`).
- Ventas tiene su propio formato, `provisional-rve.ts`, en el mismo registro.

### Seguro por construcción

`generarTxt(filas, cabecera, opciones)` (`formatos/serializar.ts:107`) **llama a `prevalidar` por dentro** y lanza `ArchivoNoPrevalidadoError` si las filas no son aptas (D4). No hay ningún camino que escriba un TXT con filas malas, aunque alguien olvide prevalidar antes.

Además es **determinista** (D6): las mismas filas, en cualquier orden de entrada, dan exactamente los mismos bytes. Las líneas se ordenan por fecha, tipo, serie y número.

## 4. El ZIP y su huella digital

`packages/sunat/src/formatos/empaquetar.ts:138` arma el ZIP en memoria:

```ts
export function empaquetar(txt: Uint8Array, nombres: NombresEmpaquetado, fecha: Date): Empaquetado
// → { zip, nombreZip, sha256Txt, sha256Zip }
```

- Una sola entrada dentro del ZIP, con el nombre del TXT validado (sin `/`, `\`, `..` ni caracteres de control: así se evita el ataque *zip slip*, H-012-29).
- La fecha se **recibe**, no se lee del reloj, para que el ZIP también sea reproducible.
- Devuelve el **SHA-256** del TXT y del ZIP. Un SHA-256 es como la huella digital de un archivo: si cambia un solo byte, cambia la huella completa.

¿Por qué está en `packages/sunat` y no en `packages/domain`? Porque usa `node:crypto` y la librería `fflate`, y el dominio es puro (D2 de 012). El backend necesita prevalidar en línea y **no puede** importar `@contapp/sunat` (CLAUDE.md), así que lo puro (formatos y prevalidación) va en `domain` y solo el ZIP queda en `sunat`, que usa el worker.

## 5. «Generar archivo» de punta a punta (012b)

Ahora todo lo anterior se conecta con la BD, la cola y la pantalla. Es el mismo patrón de los módulos 03, 05 y 06.

```text
 Pantalla (panel «Generar archivo»)
   │ 1. GET …/archivo/previo  → { apto, errores, avisos, resumen, formato, estado, huella }
   │ 2. POST …/archivos { estadoVisto, huella }
   ▼
 Backend ── compara la huella ── 409 resumen_cambiado / 422 prevalidacion_fallida
   │ 3. encola archivo.generar (cola «archivos», sin credenciales)       → 202 { trabajoId }
   ▼
 Worker ── UNA withTenant ──► periodo «generado» ─► TXT ─► ZIP ─► storage ─► INSERT versión
   │ 4. SSE: trabajo terminado
   ▼
 Pantalla: lista de versiones con «Descargar»
```

Las rutas están en `apps/backend/src/modules/archivos/archivos.controller.ts` (compras en la línea 22 y ventas en la 91):

| Ruta | Qué hace | Permiso |
|---|---|---|
| `GET …/{compras\|ventas}/archivos/previo` | Prevalida y resume, sin escribir nada | `clientes.ver` con el cliente asignado |
| `POST …/{compras\|ventas}/archivos` | Encola la generación | `sire.aprobar_generar` |
| `GET …/{compras\|ventas}/archivos` | Lista las versiones | `clientes.ver` |
| `GET …/archivos/:archivoId/zip` | Descarga una versión | `clientes.ver` |

### La huella: «lo que viste es lo que se genera»

Entre que miras el previo y haces clic en «Generar», un compañero puede editar una fila. Para que no se genere algo distinto de lo que revisaste, el previo devuelve una **huella**: el SHA-256 de un texto canónico de todas las filas (`packages/domain/src/archivos/huella.ts:94`, `canonHuella`). El `POST` la devuelve y:

- el **backend** la recalcula: si no coincide, `409 resumen_cambiado` y la pantalla vuelve a mostrar el previo;
- el **worker** la vuelve a calcular dentro de su transacción, por si algo cambió después de encolar.

Backend y worker usan la misma función de armado (`packages/domain/src/archivos/preparar.ts`), así que no pueden discrepar.

### El trabajo `archivo.generar`

`apps/worker/src/trabajos/procesadores/generar-archivo.ts:279-345` (fragmento simplificado):

```ts
return await d.db.withTenant({ tenantId: t.tenantId }, async (tx) => {
  // (0) ¿Este trabajo ya entregó su versión? (reintento) → devolverla tal cual
  // (1) Cliente activo
  // (2) Bloqueo advisory del cliente + periodo + libro
  await bloquearPeriodoLibro(tx, t.clienteId, periodo, libro);
  // (3) Estado: compare-and-set estadoVisto → «generado», ANTES de leer las filas
  const fijado = await fijarEstadoPeriodo(tx, t.clienteId, periodo, estadoVisto, "generado", usuario);
  // (4) Leer filas y preparar igual que el previo
  // (5) Formato oficial o entorno de pruebas, huella igual, apto
  if (sha256Hex(preparado.canon) !== huella) throw new ErrorArchivo("resumen_cambiado");
  if (!preparado.resultado.apto) throw new ErrorArchivo("prevalidacion_fallida");
  // (6) TXT; si sale idéntico a la última versión, no se crea otra (P-5)
  // (7) ZIP → storage → INSERT de la versión
  const paquete = empaquetar(txt.bytes, { nombreTxt: txt.nombreTxt, nombreZip: txt.nombreZip }, ahora());
  await d.storage.guardar(ruta, paquete.zip);
  const version = await insertarVersion(tx, { /* … hashes, conteos, huella, usuario … */ });
  return resultadoDe(version, true);
});
```

Fíjate en cuatro ideas:

1. **Todo en una transacción** (módulo 02). Si algo falla, el periodo vuelve a su estado anterior y no queda versión a medias. Es como un asiento que se registra completo o no se registra.
2. **El estado se fija primero.** Al pasar el periodo a `generado` con `FOR UPDATE`, cualquier edición concurrente espera o recibe `409 periodo_generado`. Nunca sale un archivo que mezcle datos de antes y después de una edición (CA-7).
3. **Rechazos de negocio sin reintento.** `ErrorArchivo` hereda de `ErrorDatos` (módulo 05): reintentar no arregla un IGV mal puesto. La pantalla, al ver el trabajo en error, recarga el previo y muestra la causa vigente.
4. **El ZIP huérfano.** Si la BD falla después de guardar el ZIP, el `catch` lo borra, pero **solo** después de confirmar en una conexión nueva que su versión no existe (`generar-archivo.ts:373-381`). Ante la duda lo conserva: borrar el ZIP de una versión válida sería peor (hallazgo H-012b-3).

### Formato provisional: nunca en producción

`packages/domain/src/archivos/entorno.ts:3`:

```ts
export function permiteProvisional(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
```

Backend y worker usan esta **única** función, y ninguno acepta `permitirProvisional` desde la petición (un cuerpo que lo traiga da 400). En producción, con solo formatos provisionales, el previo funciona pero `generable = false` con motivo `formato_no_oficial`. En desarrollo el archivo sale y la pantalla avisa «Provisional: no subir a SUNAT».

## 6. Versiones inmutables y descarga segura

Cada generación crea una fila en `archivo_generado` (migración `packages/db/migrations/0040_archivo_generado.sql`): versión 1, 2, 3… por cliente, periodo y libro, con usuario, fecha, formato, los dos SHA-256, los conteos del resumen y la ruta del ZIP.

`0040_archivo_generado.sql:62-85` (fragmento):

```sql
ALTER TABLE public.archivo_generado FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.archivo_generado FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) …;
GRANT SELECT ON public.archivo_generado TO contapp_backend;          -- el backend solo lee
GRANT SELECT, INSERT ON public.archivo_generado TO contapp_worker;   -- solo el worker crea
CREATE TRIGGER archivo_generado_inmutable BEFORE UPDATE OR DELETE …  -- nadie cambia ni borra
```

Son tres capas que ya conoces: RLS por estudio (módulo 03), permisos por rol (módulo 02) y un trigger que vuelve la tabla de solo inserción, como un libro contable legalizado.

**Reabrir no borra.** Si reabres el periodo, corriges y generas de nuevo, aparece la versión 2 y la versión 1 se sigue descargando con su hash original. Si generas otra vez sin cambiar nada, no se crea versión (el TXT sería idéntico; P-5).

**La ruta del ZIP** sale de `packages/storage/src/ruta.ts:22`:

```ts
// archivos/{tenant}/{cliente}/{id}.zip — las tres partes deben ser uuid
export function rutaArchivo(tenantId: string, clienteId: string, id: string): string
```

Nada de lo que escribe el usuario entra en la ruta, así que no hay forma de pedir `../otro-estudio/…`.

**Al descargar**, el backend lee la fila con RLS, toma la ruta de la fila (nunca de la petición), y antes de enviar **recalcula el SHA-256** (`leerVerificado`, `archivos.service.ts:183`). Si no coincide con `sha256_zip`, responde `500 archivo_alterado` sin enviar bytes.

### Ventas: estado del periodo y exclusiones

012b también lleva a ventas lo que compras ya tenía (014):

- **Estado del periodo** (`venta_periodo`, migración 0039): `abierto` → `revisado` → `generado`, con reabrir. Con `generado`, descargar, importar o agregar ventas da `409 periodo_generado`.
- **Excluir ventas con error** (`venta_exclusion`): una venta que llegó del SIRE descuadrada no se puede editar (se corrige en el sistema de facturación), pero sí **excluir con motivo** para poder generar el periodo. Se restaura cuando quieras; el registro guarda quién excluyó y quién restauró.

### Razón social larga

Si una razón social pasa de 100 caracteres, el adaptador la recorta a 100 sin partir un emoji y emite el aviso `RAZON_SOCIAL_RECORTADA` (D7 de 012b). Es la única corrección automática, y siempre queda a la vista.

## Práctica

**A. Explorar los formatos** (desde la raíz, tras `pnpm --filter @contapp/shared build` y `pnpm --filter @contapp/domain build`):

```bash
cd packages/domain && node -e '
const d = require("./dist");
const f = d.seleccionarFormato("compras", "202610");
console.log(f.id, f.version, "oficial:", f.oficial, "campos:", f.campos.length);
console.log("¿provisional en producción?", d.permiteProvisional("production"));
try { d.seleccionarFormato("compras", "202512") } catch (e) { console.log(e.constructor.name) }
console.log(d.validarNombreArchivo("CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip"), d.validarNombreArchivo("../x.zip"));'
# RCE-REEMPLAZO 0-provisional oficial: false campos: 21
# ¿provisional en producción? false
# FormatoNoVigenteError
# true false
```

**B. Correr las pruebas de prevalidación y formatos** (no necesitan BD):

```bash
pnpm --filter @contapp/domain test prevalidacion formatos archivos   # 34 archivos, ~800 pruebas
```

**C. Ver las versiones generadas** (con la app levantada y un periodo generado; `psql` como `postgres`):

```sql
SELECT periodo, libro, version, provisional, lineas, left(sha256_zip, 12) AS huella_zip, generado_en
FROM archivo_generado ORDER BY generado_en DESC LIMIT 5;
```

## Impacto en ContApp

- Un archivo con un IGV mal puesto, un duplicado o un `|` suelto **no puede salir**: lo impiden `prevalidar` y `generarTxt`, que prevalida por dentro.
- Lo que el contador revisó en pantalla es exactamente lo que se genera (huella), aunque haya compañeros editando a la vez.
- Cada archivo queda guardado para siempre, con quién y cuándo lo generó y su hash. Ante una observación de SUNAT se puede demostrar qué se envió.
- El día que llegue el formato oficial de SUNAT, se agrega como dato con versión. El motor, la pantalla y las pruebas no cambian.

## Errores comunes

- **«No me deja generar y no veo errores.»** Mira el motivo del previo: con `formato_no_oficial` estás en producción con el formato provisional; con `SIN_FILAS`, todas las filas están excluidas.
- **«Me sale 409 `resumen_cambiado`.»** Alguien cambió una fila después de que abriste el previo. Recarga el previo y revisa de nuevo.
- **«Generé otra vez y no apareció una versión nueva.»** No había cambios: el TXT era idéntico y se devolvió la última versión (P-5).
- **«Quiero quitar el `|` de la razón social desde el código.»** No: la regla es reportar, no limpiar en silencio (D13). Se corrige el dato.
- **«Voy a importar `empaquetar` en el backend.»** El backend no puede importar `@contapp/sunat`; el ZIP lo arma siempre el worker.

## Ejercicios

1. ¿Por qué R-ISC (San Juan, BI con IGV 0.00) solo **avisa** y no bloquea?
2. ¿Qué pasa si llamas a `generarTxt` con una fila descuadrada sin haber llamado antes a `prevalidar`?
3. Entre el previo y tu clic, un compañero edita una fila. ¿Qué responde el `POST` y por qué?
4. ¿Por qué el worker fija el estado `generado` **antes** de leer las filas y no después?
5. Alguien modifica a mano el ZIP guardado en storage. ¿Qué pasa cuando otro usuario lo descarga?

<details><summary>Soluciones</summary>

1. Porque puede ser correcto (un ISC no registrado que el XML aclara) y el contador decide. Solo bloquea lo que haría fallar el archivo en SUNAT: estructura, cuadre, IGV que no es 18 % ni 10 %, USD mal convertido y duplicados (D11 y D18 de 012).
2. Lanza `ArchivoNoPrevalidadoError` y no devuelve bytes: `generarTxt` prevalida por dentro (D4, CA-7).
3. `409 resumen_cambiado`: la huella del previo ya no coincide con la de los datos. La pantalla vuelve a mostrar el previo (P-2).
4. Para que ninguna edición se cuele entre la lectura y la generación: con el periodo en `generado` y la fila bloqueada `FOR UPDATE`, las ediciones esperan o reciben `409 periodo_generado`, y el archivo nunca mezcla datos (D4, CA-7).
5. El backend recalcula el SHA-256 antes de enviar, no coincide con `sha256_zip` y responde `500 archivo_alterado` sin bytes (D8, CA-12).

</details>

## Para profundizar

- Specs del proyecto: [012 spec](../specs/012-prevalidacion-archivos/spec.md) y [012b spec](../specs/012b-generar-archivo/spec.md), con sus `plan.md` y `tasks.md`.
- `docs/03-arquitectura.md` §7.3 (flujo de generación) y §11 (ubicación de los formatos).
- SHA-256 en Node.js (`crypto.createHash`): <https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options>
- fflate (ZIP en JavaScript): <https://github.com/101arrowz/fflate>
