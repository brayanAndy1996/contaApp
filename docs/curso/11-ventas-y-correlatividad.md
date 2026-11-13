# 11 · Ventas y correlatividad: la propuesta del SIRE y la boleta 291

> Módulo anterior: [10-prevalidacion-y-archivo-sire.md](10-prevalidacion-y-archivo-sire.md) · Siguiente: [12-compras.md](12-compras.md) · Índice: [00-indice.md](00-indice.md)
>
> Cubre la spec **013** (ventas RVIE: descarga, importación, grilla y correlatividad). Conviene haber leído [03](03-rls-y-withtenant.md), [05](05-bullmq-y-la-cola.md) y [08](08-dinero-y-dominio.md).

## Lo que aprenderás

- Qué es el **modelo común de propuesta** (`propuesta`, `propuesta_diferencia`) y por qué un solo trabajo `sire.propuesta.descargar` sirve a ventas y a compras.
- Por qué las ventas del SIRE son **inmutables** y cómo una nueva descarga **complementa** sin pisar lo trabajado.
- Cómo se importa la propuesta desde TXT o Excel en **dos fases**, y por qué el layout provisional **falla cerrado** fuera de desarrollo.
- Cómo se arma la grilla, el **resumen en soles** y la marca «No cuadra».
- Cómo se detectan los **saltos de numeración** (la boleta 291), cómo se justifican y cómo se agrega la venta faltante.

---

## 1. El problema: la boleta que nadie ve

En el Registro de Ventas, una boleta que falta no hace ruido. Si en caja se emitieron la B001-290, la B001-291 y la B001-292, pero al SIRE solo llegaron la 290 y la 292, la suma del mes se ve «razonable» y nadie se da cuenta. Meses después, SUNAT pregunta por la 291.

Un contador con experiencia revisa la **correlatividad**: que los números de cada serie vayan seguidos. La spec 013 hace esa revisión automática y la pone delante del contador en cuanto abre las ventas del periodo: «Falta B001-291». Él decide: la **justifica** («Boleta anulada en caja») o **agrega** la venta faltante.

Para llegar ahí, antes hay que traer las ventas: desde el SIRE (descarga) o desde un archivo (importación). Esa es la otra mitad del módulo.

## 2. El modelo común de propuesta

SUNAT llama **propuesta** a lo que el SIRE le ofrece al contribuyente como su registro del mes. Ventas y compras se descargan casi igual, así que 013 creó un núcleo común que 014 (compras) reutiliza sin tocarlo (D1, P-1):

| Tabla | Qué guarda | Analogía contable |
|---|---|---|
| `propuesta` (migración 0028) | El **encabezado** de cada descarga o importación: cliente, periodo, `libro` (`compras` o `ventas`), `fuente` (`api` o `importacion`), hash del contenido y cuatro contadores | La carátula del legajo que te entregó el cliente, con cuántas hojas trae |
| `propuesta_diferencia` (0029) | Los comprobantes que el SIRE trajo **distintos** de lo ya guardado: qué campos difieren y el valor del SIRE | La nota «ojo, esta factura vino con otro total» |
| `venta` (0030) | Las filas de ventas, con sus ocho montos `NUMERIC(14,2)` | El registro de ventas propiamente dicho |
| `venta_salto_justificado` (0031) | Las justificaciones de saltos de numeración | La nota al margen «la 291 se anuló en caja» |

La regla de los contadores la impone un `CHECK` en la BD: `recibidas = nuevas + iguales + distintas`, con `recibidas ≤ 20000` (`packages/db/migrations/0028_propuesta.sql:27-28`). No hay tabla de «periodo» común ni cabecera común de comprobante: cada libro tiene su propia tabla y solo comparten la propuesta, la clave normalizada y el complemento.

### Un trabajo, un persistidor por libro

La descarga es un trabajo de la cola (módulo 05) de tipo `sire.propuesta.descargar`, que lleva el `libro` en sus parámetros.

`packages/queue/src/catalogo.ts:154-168`:

```ts
export const SIRE_PROPUESTA_DESCARGAR: DefinicionTrabajo<ParametrosDescargarPropuesta> =
  {
    tipo: "sire.propuesta.descargar",
    cola: "sire",
    canal: "sire",
    credencial: "sire_api",
    permiso: "sire.descargar",
    idempotente: true,
    parametros: z
      .object({
        periodo: periodoSireSchema,
        libro: z.enum(["compras", "ventas"]),
      })
      .strict(),
  };
```

El procesador es uno solo. Lo propio de cada libro (cómo validar sus filas, cómo leer lo guardado, cómo insertar) vive en un **persistidor**, y el registro es un simple diccionario.

`apps/worker/src/trabajos/persistidores/index.ts:7-10`:

```ts
export const PERSISTIDORES: PersistidoresLibro = {
  compras: persistidorCompras,
  ventas: persistidorVentas,
};
```

Piénsalo como un estudio con un procedimiento único de recepción de documentos y un asistente especializado por libro. Cuando 014 llegó, solo agregó `persistidorCompras` y una línea aquí. Antes de eso, pedir compras daba `libro_no_soportado`.

## 3. La descarga: todo o nada y complementaria

`apps/worker/src/trabajos/procesadores/descargar-propuesta.ts:76-99` (fragmento):

```ts
    if (propuesta.libro !== libro || !Array.isArray(propuesta.filas))
      throw new ErrorPropuesta("respuesta_inconsistente");
    if (propuesta.filas.length > TOPE_FILAS)
      throw new ErrorPropuesta("propuesta_demasiado_grande");

    const preparadas = persistidor.preparar(propuesta.filas);
    const hash = hashContenido(libro, periodo, preparadas);
    const ctx = { clienteId: t.clienteId, periodo };

    const resultado = await d.db.withTenant({ tenantId: t.tenantId }, async (tx) => {
      const aplicado = await aplicarComplemento(tx, {
        // … clienteId, periodo, libro, fuente: "api", hash, usuarioId, trabajoId …
        filas: preparadas,
        leerExistentes: (x) => persistidor.leerExistentes(x, ctx),
        planificar: planificarComplemento,
        insertar: (x, propuestaId, nuevas) =>
          persistidor.insertar(x, ctx, propuestaId, nuevas),
      });
```

El recorrido, en orden:

1. **Token y descarga fuera de la transacción** (008 D6): no se deja una transacción abierta esperando a SUNAT.
2. **Tope de 20.000 filas recibidas** (`TOPE_FILAS`, D19). Más da `propuesta_demasiado_grande` y no se guarda nada.
3. **`preparar` valida todas las filas.** Una sola ilegible lanza `fila_invalida` y no se guarda nada, ni el encabezado (D3). Omitir una fila en silencio es justo el daño que se quiere evitar.
4. **Una sola `withTenant`** (módulo 03): bloqueo advisory por (cliente, periodo, libro) → leer lo existente → planificar → `propuesta` → `propuesta_diferencia` → filas nuevas (`packages/db/src/propuestas/complemento.ts:84-128`).

Una fila **legible pero descuadrada** sí se guarda, tal como llegó. No se corrige ni se descarta: se marca al leer (sección 6).

### Complementar, no reemplazar (D16, D18)

¿Qué pasa si descargas el mismo periodo dos veces? El usuario eligió **complementar** (P-2): se agregan solo los comprobantes cuya **clave** no existe, y nada de lo ya guardado se toca.

`packages/domain/src/complemento/index.ts:92-104` (fragmento):

```ts
  for (const r of recibidas) {
    const existente = porClave.get(r.clave);
    const primera = primeras.get(r.clave);
    const base = primera ?? existente?.campos;
    if (primera === undefined) primeras.set(r.clave, r.campos);
    if (base === undefined) {
      nuevas.push(r.clave);
      continue;
    }
    const difieren = camposQueDifieren(base, r.campos);
    if (difieren.length === 0) iguales++;
    else distintas.push(diferencia(r.clave, existente?.origen ?? "sire", difieren, r.campos));
  }
```

Cada comprobante recibido cae en uno de tres montones: **nueva** (se inserta), **igual** (solo se cuenta) o **distinta** (se informa en `propuesta_diferencia`, nunca se aplica). D18 resuelve los repetidos dentro de la misma descarga: se guarda la primera aparición y las siguientes se comparan con ella. Así la cuenta siempre cierra.

La función no sabe nada de montos: compara cadenas (`asegurarCadenas` rechaza cualquier valor que no sea texto). Cada persistidor decide qué campos comparar; ventas compara fecha, moneda, tipo de cambio, documento y los 8 montos, nunca la razón social.

Lo que SUNAT dejó de traer **no se borra**. Es como un auditor que recibe una segunda copia del registro: anota lo nuevo y las discrepancias, pero no tacha lo que ya estaba archivado.

### La clave normalizada (D17)

¿Cómo se sabe que dos filas son el mismo comprobante? Por su clave.

`packages/domain/src/clave-comprobante/index.ts:14-22`:

```ts
/** Serie normalizada (D17): mayúsculas ASCII; es la que agrupa la correlatividad y la que se guarda. */
export function serieNormalizada(serie: string): string {
  return mayusculasAscii(serie);
}

/** `claveNormalizada("03", "b001", "00291")` → `"03|B001|291"`. El tipo no se toca. */
export function claveNormalizada(tipo: string, serie: string, numero: string): string {
  return `${tipo}|${mayusculasAscii(serie)}|${numero.replace(CEROS_IZQUIERDA, "")}`;
}
```

`b001` y `B001` son la misma serie; `00291` y `291` son el mismo número. La clave es **única** por cliente y periodo en `venta`, y es la red de seguridad si dos descargas corren a la vez: el bloqueo advisory las pone en fila, y la clave única impide duplicados aunque algo falle.

### Inmutables por construcción (D4)

Las ventas del SIRE no se editan: si una boleta está mal, se corrige en el sistema de facturación del cliente. La BD lo garantiza con un trigger.

`packages/db/migrations/0030_venta.sql:60-77` (fragmento):

```sql
CREATE OR REPLACE FUNCTION public.venta_inmutable() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'venta: las filas no se modifican';
  END IF;
  IF OLD.origen <> 'manual' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'venta: solo se pueden quitar las filas agregadas a mano';
  END IF;
  RETURN OLD;
END
$$;
-- …
CREATE TRIGGER venta_inmutable BEFORE UPDATE OR DELETE ON public.venta
  FOR EACH ROW EXECUTE FUNCTION public.venta_inmutable();
```

Nadie hace `UPDATE` de una venta, y solo se pueden borrar las de origen `manual` (las que agregó el contador). `propuesta` y `propuesta_diferencia` tienen solo permisos `SELECT`/`INSERT`. Es el libro legalizado otra vez (módulo 10): se escribe, no se borronea.

## 4. Importar desde TXT o Excel: dos fases

Mientras no haya adaptador real del SIRE, o si el cliente trae su propio archivo, la propuesta se **importa** (RF-051). Las rutas están en `apps/backend/src/modules/ventas/ventas.controller.ts`, bajo `clientes/:clienteId/periodos/:periodo/ventas` (línea 35):

| Fase | Ruta | Qué hace |
|---|---|---|
| 1 | `POST …/importar/vista-previa` | Lee el archivo en memoria y devuelve, por fila, `valida` o `error` con sus motivos y advertencias. **No escribe nada.** |
| 2 | `POST …/importar/confirmar` | Vuelve a leer y validar todo; si hay **una** fila con error responde `422 filas_con_errores`; si no, aplica el **mismo** `aplicarComplemento` de la descarga con `fuente: "importacion"`. |

Es como el borrador del asiento que revisas antes de mayorizar: la vista previa te deja ver los problemas sin comprometer el libro, y la confirmación no confía en la vista previa (revalida).

El formato del archivo se detecta por el contenido: si empieza con `PK` es un `.xlsx`; si no, texto separado por `,` o `;` (D25). El lector es el de 007b (rechaza fórmulas, topes de tamaño y descompresión, XXE). Una fila legible pero descuadrada, o en USD sin tipo de cambio, sale **válida con advertencia** (`descuadre`, `tipo_cambio_requerido`, D22) y se puede confirmar; se guarda tal cual.

### El layout provisional y H-013-5

Las columnas del archivo son un **layout versionado** en el dominio, igual que los formatos TXT del módulo 10: `LAYOUT_VENTAS_PROVISIONAL` (`packages/domain/src/ventas/layout.ts:27`), con `id: "RVIE-IMPORTACION-PROVISIONAL"` y `oficial: false`. SUNAT no ha entregado el anexo oficial, así que no se inventa.

`apps/backend/src/modules/ventas/importar-propuesta.service.ts:139-143`:

```ts
function exigirLayoutOficial(): void {
  const entorno = process.env["NODE_ENV"];
  if (LAYOUT_VENTAS_PROVISIONAL.oficial) return;
  if (entorno !== "development" && entorno !== "test") throw new VentasError("layout_no_oficial");
}
```

Fíjate en la forma de la condición. La primera versión decía, en esencia, «si es `production`, rechaza». La ronda adversarial (H-013-5) encontró que con `NODE_ENV` ausente, `prod`, `Production` o `staging` el layout provisional se aceptaba: la regla **fallaba abierta**. La corrección (D20) invierte la lógica: solo se acepta en `development` o `test`, y **cualquier otra cosa** da `422 layout_no_oficial`. Es una **lista blanca** en vez de una lista negra.

Analogía: un portero que deja pasar a todos menos a los de la lista negra deja pasar a cualquiera que escriba mal su nombre. Uno que solo deja pasar a los de la lista de invitados no.

Además, el valor se lee del entorno del servidor, **nunca** de la petición.

## 5. La grilla y el resumen en soles

`GET …/ventas` devuelve una página filtrada y ordenada en el servidor (tipo, serie, número), con `tamano` de 10, 25, 50 o `todas`. «Todas» entrega como máximo **5.000** filas con el aviso `todas_limitada` (D10). Los filtros de monto (`min`, `max`) llegan como cadenas decimales y se comparan en `NUMERIC(14,2)`, nunca como `number` (módulo 08).

`GET …/ventas/resumen` agrupa por tipo de comprobante: cantidad, una suma por cada columna (incluidas exonerada e inafecta, para que un cliente de la Amazonía no vea ceros), IGV y total, **todo en soles** (D11). Las notas de crédito traen montos negativos y restan. Una venta en USD se convierte columna por columna.

`packages/domain/src/ventas/resumen.ts:65-77`:

```ts
/** Cada componente × tc con redondearSunat; el total es la suma de los componentes convertidos. */
function enSolesUsd(f: FilaResumenVenta, tc: TipoCambio): Soles {
  const m = {} as Record<ColumnaVenta, Money>;
  for (const c of COMPONENTES_VENTA) {
    // redondearSunat conserva la moneda (USD): se reexpresa en PEN por su cadena canónica.
    m[c] = Money.desde(redondearSunat(Money.desde(f[c], "USD").por(tc)).toString(), "PEN");
  }
  m.total = Money.suma(
    COMPONENTES_VENTA.map((c) => m[c]),
    "PEN",
  );
  return m;
}
```

Es el mismo método de 010 D7 que viste en el módulo 08: redondear cada columna convertida y sumar después, para que el total en soles cuadre con sus partes. Una venta USD **sin** tipo de cambio no se suma: va a `sinConvertir` y la respuesta trae el aviso `usd_sin_tipo_cambio` (P-10). Es mejor un aviso visible que un total silenciosamente incompleto.

## 6. «No cuadra»

Una venta del SIRE puede llegar con el total distinto de la suma de sus siete componentes. No se corrige (sería alterar lo que declaró el emisor), pero tampoco se esconde (D26). El cuadre se calcula **al leer**, sin columna en la tabla.

`packages/domain/src/ventas/layout.ts:125-134`:

```ts
export function cuadraVenta(montos: Readonly<Record<ColumnaVenta, string>>, moneda: Moneda): boolean {
  const total = Money.desde(montos.total, moneda);
  const componentes = COMPONENTES_VENTA.map((c) => Money.desde(montos[c], moneda));
  try {
    return verificarCuadre({ moneda, total, componentes: () => componentes }, TOLERANCIA_CUADRE).cuadra;
  } catch {
    // El único error posible es MontoFueraDeRangoError: la suma excede NUMERIC(14,2), así que no cuadra.
    return false;
  }
}
```

El backend lo pone en cada fila como `cuadra` (`apps/backend/src/modules/ventas/apoyo.ts:139`) y la grilla pinta la etiqueta roja (`apps/frontend/components/ventas/grilla-ventas.tsx:68-72`, con el texto «No cuadra» de `apps/frontend/lib/ventas.ts:146`). Una venta **agregada a mano** siempre cuadra: si no, el backend la rechaza con `400 venta_descuadrada` (D9).

## 7. Correlatividad: la boleta 291

La función pura vive en `packages/domain/src/correlatividad/index.ts`. Recibe las filas del periodo (`tipo`, `serie`, `numero` como texto) y las justificaciones vigentes, y devuelve una lista de series.

`packages/domain/src/correlatividad/index.ts:168-190` (fragmento):

```ts
export function analizarCorrelatividad(
  filas: readonly FilaNumeracion[],
  justificados: readonly Justificado[],
): ResultadoCorrelatividad {
  const grupos = new Map<string, Grupo>();
  for (const f of filas) {
    const serie = serieNormalizada(f.serie);
    const k = claveGrupo(f.tipo, serie);
    // … crea el grupo (tipo, serie) si no existe …
    const n = enteroDeDigitos(typeof f.numero === "string" ? f.numero.replace(CEROS_IZQUIERDA, "") : f.numero);
    if (n === null) g.noEvaluables++;
    else g.numeros.push(n);
  }
  const porSerie = agruparJustificados(justificados);
  const ordenados = [...grupos.values()].sort((a, b) => comparar(a.tipo, b.tipo) || comparar(a.serie, b.serie));
  return {
    series: ordenados.map((g) => analizarGrupo(g, indexarRangos(porSerie.get(claveGrupo(g.tipo, g.serie)) ?? []))),
  };
}
```

Las reglas, contadas por un contador:

- **Cada tipo y serie por separado.** La nota de crédito 07 F001 no se mezcla con las facturas 01 F001.
- **Solo dentro del periodo** (P-5): se revisa del menor al mayor número presente. Si la serie empieza en la 10, no se reclaman la 1 a la 9 (eso sería mirar el mes anterior).
- **Rangos, no listas.** Si faltan la 402, 403 y 404, sale una sola entrada `{ desde: 402, hasta: 404 }`. Un salto de 99 999 999 números no consume memoria.
- **Serie normalizada** (H-013-7): `B001` y `b001` son la misma serie y salen como `B001`, igual que en la clave (sección 3). Antes de la corrección, la correlatividad las separaba y mostraba un faltante que el contador no podía cerrar: al agregarlo, la clave decía «duplicado».
- **Ceros a la izquierda** (H-013-8, D21): `0000000291` es la 291. Sin ceros, el número debe tener de 1 a 8 dígitos ASCII; si no (`ABC`, `+291`, `２９１`), cuenta en `noEvaluables` y nunca produce un error 500 ni un hueco inventado.
- **Solo alerta** (P-6): el resultado no tiene ninguna bandera de bloqueo. 012b lo muestra como aviso al generar (módulo 10).

### Justificar, revertir, agregar

Cada faltante tiene un estado:

| Estado | Cuándo |
|---|---|
| `pendiente` | Ninguna justificación lo toca |
| `parcial` | Una justificación cubre solo una parte del rango; el resto sigue alertando |
| `justificado` | Las justificaciones cubren todos sus números (con el comentario si lo cubre una sola) |

Justificar es `POST …/ventas/saltos-justificados` con comentario de 1 a 500 caracteres y permiso `sire.clasificar` (P-7). Justificar un rango que no falta da `400 salto_fuera_de_faltante`. **Revertir** (`DELETE …/saltos-justificados/:justificacionId`) no borra: llena `revertido_por` y `revertido_en`, así queda quién y cuándo.

**Agregar la venta** (`POST …/ventas`) la crea con origen `manual`: cuenta como presente en la correlatividad, el salto desaparece y la propuesta original queda intacta (CA-8). Si repite la clave de otra fila, incluso del SIRE, da `409 duplicado`.

<!-- simulador: correlatividad -->

## 8. La ronda adversarial (resumen)

013 es nivel B, con ronda adversarial acotada a la correlatividad y la importación (P-11). El adversario encontró ocho hallazgos, todos corregidos (tabla de `docs/specs/ESTADO.md`):

- **H-013-1 (alta, DoS):** un `.xlsx` con unos 5 millones de filas vacías tardaba ~7,5 s en rechazarse, porque el lector analizaba la hoja entera antes de contar. Ahora `fragmentosDeFilas` (`apps/backend/src/modules/importacion/lector-xlsx.ts:115`) entrega las filas **una a una** y el tope corta mientras se lee. Es como contar las hojas del fólder mientras las sacas, en vez de fotocopiar el fólder entero y después contar.
- **H-013-2 (media, DoS):** un `.csv` con 8 millones de columnas en la cabecera; ahora el lector descarta las columnas de más al leer.
- **H-013-3:** un comentario con el carácter NUL daba 500; ahora 400.
- **H-013-4:** el tope de 20.000 se aplicaba al periodo entero y bloqueaba el periodo; ahora se aplica solo a lo recibido en cada descarga o importación (D19).
- **H-013-5:** el layout provisional fallaba abierto (sección 4).
- **H-013-6, H-013-7, H-013-8:** la serie y los ceros a la izquierda no se trataban igual en la descarga, la clave y la correlatividad (sección 7).

### Lo que agregó 012b después

013 no permitía editar, excluir ni cerrar ventas. 012b añadió el **estado del periodo de ventas** (`venta_periodo`: abierto, revisado, generado) y la **exclusión con motivo** de ventas del SIRE con error (`venta_exclusion`). Por eso `persistidorVentas.leerExistentes` ahora rechaza la descarga si el periodo está `generado`. Lo viste en el módulo 10, sección 6.

## Práctica

**A. La boleta 291 en vivo** (desde la raíz, tras `pnpm --filter @contapp/shared build` y `pnpm --filter @contapp/domain build`):

```bash
cd packages/domain && node -e '
const d = require("./dist");
const f = (serie, numero) => ({ tipo: "03", serie, numero });
const r = d.analizarCorrelatividad([f("B001","290"), f("B001","292"), f("B003","400"), f("B003","405")], []);
console.log(JSON.stringify(r.series));
const j = d.analizarCorrelatividad([f("B001","290"), f("B001","292")], [{ tipo: "03", serie: "b001", desde: 291, hasta: 291, comentario: "Anulada en caja" }]);
console.log(JSON.stringify(j.series[0].faltantes));
console.log(JSON.stringify(d.analizarCorrelatividad([f("b001","290"), f("B001","0000000291"), f("B001","292"), f("B001","ABC")], []).series));
console.log(d.claveNormalizada("03", "b001", "00291"));'
# [{"tipo":"03","serie":"B001","estado":"con_faltantes","faltantes":[{"desde":291,"hasta":291,"estado":"pendiente"}],"noEvaluables":0},{"tipo":"03","serie":"B003","estado":"con_faltantes","faltantes":[{"desde":401,"hasta":404,"estado":"pendiente"}],"noEvaluables":0}]
# [{"desde":291,"hasta":291,"estado":"justificado","comentario":"Anulada en caja"}]
# [{"tipo":"03","serie":"B001","estado":"completa","faltantes":[],"noEvaluables":1}]
# 03|B001|291
```

Observa: la B003 da un solo rango (401 a 404); la justificación con `b001` en minúsculas cubre la `B001`; `0000000291` cierra el hueco y `ABC` solo suma a `noEvaluables`.

**B. Complemento, cuadre y resumen** (mismo directorio):

```bash
node -e '
const d = require("./dist");
const plan = d.planificarComplemento(
  [{ clave: "03|B001|290", origen: "sire", campos: { total: "118.00" } },
   { clave: "03|B001|291", origen: "manual", campos: { total: "59.00" } }],
  [{ clave: "03|B001|290", campos: { total: "120.00" } },
   { clave: "03|B001|291", campos: { total: "59.00" } },
   { clave: "03|B001|293", campos: { total: "10.00" } }]);
console.log(JSON.stringify(plan));
const m = (o) => ({ baseGravada: "0.00", igv: "0.00", exonerada: "0.00", inafecta: "0.00", isc: "0.00", icbper: "0.00", otros: "0.00", ...o });
console.log(d.cuadraVenta(m({ baseGravada: "100.00", igv: "18.00", total: "118.00" }), "PEN"),
            d.cuadraVenta(m({ baseGravada: "100.00", igv: "18.00", total: "118.01" }), "PEN"));
const r = d.resumirVentas([
  { clave: "01|F001|10", tipo: "01", moneda: "PEN", ...m({ baseGravada: "100.00", igv: "18.00", total: "118.00" }) },
  { clave: "07|F001|1", tipo: "07", moneda: "PEN", ...m({ baseGravada: "-50.00", igv: "-9.00", total: "-59.00" }) },
  { clave: "01|F002|5", tipo: "01", moneda: "USD", tipoCambio: "3.745", ...m({ baseGravada: "10.00", igv: "1.80", total: "11.80" }) },
  { clave: "01|F002|6", tipo: "01", moneda: "USD", ...m({ baseGravada: "10.00", igv: "1.80", total: "11.80" }) }]);
console.log(JSON.stringify({ porTipo: r.porTipo.map(t => [t.tipo, t.cantidad, t.baseGravada, t.igv, t.total]), total: r.total.total, sinConvertir: r.sinConvertir, avisos: r.avisos }));
console.log(d.LAYOUT_VENTAS_PROVISIONAL.id, d.LAYOUT_VENTAS_PROVISIONAL.oficial, d.LAYOUT_VENTAS_PROVISIONAL.columnas.length);'
# {"nuevas":["03|B001|293"],"iguales":1,"distintas":[{"clave":"03|B001|290","origenExistente":"sire","campos":["total"],"valoresSire":{"total":"120.00"}}]}
# true false
# {"porTipo":[["01",2,"137.45","24.74","162.19"],["07",1,"-50.00","-9.00","-59.00"]],"total":"103.19","sinConvertir":[{"clave":"01|F002|6","moneda":"USD"}],"avisos":["usd_sin_tipo_cambio"]}
# RVIE-IMPORTACION-PROVISIONAL false 16
```

Comprueba a mano la factura USD: 10.00 × 3.745 = 37.45 y 1.80 × 3.745 = 6.741 → 6.74; total 44.19. Con la F001-10 (118.00) da 162.19 para el tipo 01. La nota de crédito resta: 162.19 − 59.00 = 103.19. La F002-6 sin tipo de cambio no suma y sale en `sinConvertir`.

**C. Correr las pruebas de la correlatividad** (no necesitan BD):

```bash
pnpm --filter @contapp/domain test correlatividad
#  Test Files  4 passed (4)
#       Tests  63 passed (63)
```

Incluye `boleta-291.spec.ts` (el caso real sobre el fixture), `correlatividad.adv.spec.ts` (la ronda adversarial) y `correcciones-t18.spec.ts` (H-013-7 y H-013-8). Para todo el dominio de 013: `pnpm --filter @contapp/domain test correlatividad clave-comprobante complemento ventas` (16 archivos, 251 pruebas en esta corrida).

**D. Ver las propuestas y las ventas manuales** (con la app levantada y una descarga hecha; `psql` como `postgres`):

```sql
SELECT periodo, libro, fuente, filas_recibidas, filas_nuevas, filas_iguales, filas_distintas, creada_en
FROM propuesta ORDER BY creada_en DESC LIMIT 5;

SELECT tipo, serie, numero, origen, total
FROM venta WHERE origen = 'manual' ORDER BY creada_en DESC LIMIT 5;
```

## Impacto en ContApp

- La boleta 291 ya no pasa desapercibida: el contador ve el salto en cuanto abre el periodo y deja constancia de por qué falta, con su nombre y fecha.
- Lo que llegó del SIRE queda tal cual, para siempre: si SUNAT observa, se puede mostrar qué ofreció el SIRE y qué agregó el contador.
- Volver a descargar es seguro: no se pierde lo trabajado, y lo que cambió en SUNAT queda informado en `propuesta_diferencia`.
- El núcleo común permitió a 014 (compras) agregar su libro con un archivo y una línea de registro.
- Cuando llegue el layout oficial de SUNAT, se agrega como otra versión con `oficial: true` y la importación funciona en producción sin tocar el resto.

## Errores comunes

- **«Importar me da 422 `layout_no_oficial` en el servidor de pruebas.»** El layout provisional solo se acepta con `NODE_ENV` exactamente `development` o `test`. `staging` o vacío fallan a propósito (D20).
- **«Quiero corregir el total de una venta del SIRE.»** No se puede: el trigger `venta_inmutable` rechaza todo `UPDATE`. Se corrige en el sistema de facturación del cliente y se vuelve a descargar; mientras tanto, la grilla muestra «No cuadra» y 012b permite excluirla con motivo.
- **«Descargué otra vez y el total de la 290 sigue igual.»** Es lo esperado: complementar no pisa lo existente. Mira las diferencias de esa propuesta (`GET …/propuestas/:propuestaId/diferencias`).
- **«Agregué la B001-291 y da 409 `duplicado`.»** Ya existe una fila con esa clave (quizás `b001` o `00291`). Revisa la grilla antes de agregar.
- **«La serie empieza en la 10 y no me avisa de la 1 a la 9.»** Correcto: solo se revisa entre el menor y el mayor número del periodo (P-5).
- **«Voy a sumar el resumen en el frontend.»** No: el frontend solo muestra cadenas del servidor y no suma (regla de `number`, módulo 08).

## Ejercicios

1. Un periodo tiene B001-290, B001-292 y una B001-291 agregada a mano y justificada. El SIRE trae ahora B001-290 con otro total y B001-293. ¿Qué cuenta la nueva `propuesta` y qué pasa con la 290 guardada?
2. ¿Por qué la regla del layout provisional se escribió como «solo `development` o `test`» y no como «todo menos `production`»?
3. Las filas son B001-290, b001-291 y B001-0000000292. ¿Qué devuelve `analizarCorrelatividad` para esa serie?
4. Una descarga trae 20.001 filas. ¿Qué se guarda?
5. ¿Por qué `cuadra` se calcula al leer y no se guarda como columna en `venta`?

<details><summary>Soluciones</summary>

1. Una propuesta con 1 nueva (la 293) y 1 distinta (la 290, campo `total`) (CA-11). La 290 guardada queda intacta y la diferencia se informa en `propuesta_diferencia`; la 291 y su justificación siguen igual (D16).
2. Porque una lista negra falla abierta: con `NODE_ENV` ausente, `prod` o `staging` el layout se aceptaba (H-013-5). La lista blanca falla cerrada: todo lo que no sea exactamente `development` o `test` da `422 layout_no_oficial` (D20).
3. Una sola serie `B001`, `completa`, sin faltantes y con `noEvaluables: 0`: la serie se normaliza a mayúsculas y los ceros a la izquierda se ignoran (H-013-7, H-013-8).
4. Nada: `propuesta_demasiado_grande` antes de abrir la transacción, sin encabezado ni filas (D19). El tope es de las filas recibidas, no del periodo.
5. Porque `venta` es inmutable: no se podría actualizar la columna si cambiara la regla de cuadre, y el dominio ya tiene una sola verdad aritmética (`verificarCuadre`). Calcularlo al leer no requirió migración (D26).

</details>

## Para profundizar

- Spec del proyecto: [013 spec](../specs/013-ventas/spec.md), con su [plan](../specs/013-ventas/plan.md) y `tasks.md`; hallazgos H-013-1 a H-013-8 en [ESTADO](../specs/ESTADO.md).
- El caso real en pruebas: `packages/domain/src/correlatividad/boleta-291.spec.ts`.
- Bloqueos advisory de PostgreSQL: <https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS>
- Triggers en PL/pgSQL: <https://www.postgresql.org/docs/current/plpgsql-trigger.html>
