# 12 · Compras: versiones por fila, estados del periodo y la grilla tipo Excel

> Módulo anterior: [11-ventas-y-correlatividad.md](11-ventas-y-correlatividad.md) · Siguiente: [13-lupa-xml.md](13-lupa-xml.md) · Índice: [00-indice.md](00-indice.md)
>
> Cubre las specs **014** (compras en el backend: tablas, versiones, acciones, estados, resumen y Excel) y **015** (la pantalla de compras). Conviene haber leído [02](02-postgresql.md), [03](03-rls-y-withtenant.md), [06](06-backend-nestjs-sse.md), [08](08-dinero-y-dominio.md) y [10](10-prevalidacion-y-archivo-sire.md).

## Lo que aprenderás

- Cómo se guarda una compra **sin perder nunca lo que dijo el SIRE**: identidad, versiones solo-inserción y un puntero a la versión vigente.
- Cómo encaja el **persistidor de compras** en la descarga común que nació con ventas (013).
- Qué pasa al **clasificar, editar, aceptar una sugerencia, excluir, agregar y deshacer**, y por qué todo es una versión nueva.
- Los **estados del periodo** (`abierto`, `revisado`, `generado`) y los códigos 403/409 que devuelven.
- Dos hallazgos de concurrencia de la ronda adversarial: el **interbloqueo** (H-014-1) y la **foto consistente** del resumen y el Excel (H-014-2).
- Cómo la pantalla (015) muestra 5.000 filas sin trabarse, edita con teclado y suma montos sin usar `number`.

---

## 1. El problema: corregir sin borrar el original

El contador descarga del SIRE la propuesta de compras de un cliente: decenas o miles de comprobantes. Luego corrige: mueve una compra de DG a DNG, arregla el ISC de San Juan, excluye la «zapatilla» del gasto personal, agrega una factura que el SIRE no trajo.

Si cada corrección **sobrescribiera** la fila, perderíamos dos cosas: el valor original (que 012 necesita para `resumirCambios`, módulo 10) y la historia de quién cambió qué. Es como corregir un libro contable con corrector líquido: después nadie puede auditarlo.

ContApp hace lo que haría un buen contador: **nunca borra un asiento; registra uno de ajuste**. Cada cambio es una versión nueva de la fila, y la versión 1 (lo que trajo el SIRE) queda intacta para siempre (RNF-052, D-1 de 014).

## 2. El modelo: cinco tablas

Las migraciones son `packages/db/migrations/0032_compra.sql`, `0033_compra_hallazgo_periodo.sql` y `0034_compra_puntero_vigente.sql`. Todas llevan `tenant_id`, RLS forzada (módulo 03) y montos `NUMERIC(14,2)` (módulo 08).

| Tabla | Qué guarda | Analogía contable |
|---|---|---|
| `compra` | La **identidad** del comprobante: clave, tipo, serie, número, proveedor, fecha, moneda, tipo de cambio, `origen` (`sire` o `agregada`) y el puntero `version_vigente` | La ficha del comprobante en el archivador |
| `compra_version` | Cada versión: `n`, las 10 columnas de monto y el total, `excluida`, `motivo`, `clasificada`, `accion`, usuario y fecha | Los asientos: el original y sus ajustes |
| `compra_operacion` | Cada acción del usuario (una fila o una masiva): periodo, usuario, tipo, estado `vigente`/`deshecha`/`caducada` | El «lote» de asientos de una misma corrección |
| `compra_hallazgo` | Lo que el motor de reglas de 011 encontró en una versión (regla, sugerencia, lecturas) | Las observaciones del auditor |
| `compra_periodo` | El estado del periodo por cliente: `abierto`, `revisado` o `generado`, quién lo marcó y cuándo | El sello de «revisado» y «presentado» |

La clave de identidad junta comprobante y proveedor: `tipo|SERIE|numero|tipoDoc|DOC` (`packages/domain/src/compras/clave.ts:9-11`). Así, `F001-0001040` de un proveedor y `f001-1040` del mismo proveedor son el mismo comprobante (la práctica A lo muestra).

### Quién puede tocar qué

Los permisos de rol (módulo 02) hacen el trabajo grueso. `0032_compra.sql:3-5` (comentario de cabecera):

```sql
--   compra            SELECT/INSERT a backend y worker; UPDATE de (version_vigente, descartada_en) solo al backend; trigger de identidad.
--   compra_version    SELECT/INSERT a backend y worker; ningún UPDATE ni DELETE (la versión 1 es el original, para siempre).
--   compra_operacion  SELECT/INSERT al backend, SELECT al worker; UPDATE de (estado, deshecha_en) solo al backend.
```

`compra_version` es de solo inserción: ningún rol de la aplicación puede hacer `UPDATE` ni `DELETE`. De `compra` solo se pueden cambiar dos columnas: el puntero y la marca de descarte.

### El puntero `version_vigente` y su trigger endurecido

Un `GRANT UPDATE (version_vigente)` deja mover el puntero, pero no dice **hacia dónde**. La ronda adversarial lo demostró (H-014-6): con un `UPDATE` directo se podía apuntar a una versión inexistente o retroceder en silencio. La migración 0034 endurece el trigger.

`packages/db/migrations/0034_compra_puntero_vigente.sql:38-48`:

```sql
  IF NEW.version_vigente IS DISTINCT FROM OLD.version_vigente THEN
    IF NEW.version_vigente < OLD.version_vigente THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'compra: la version vigente no retrocede';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.compra_version v
       WHERE v.tenant_id = NEW.tenant_id AND v.compra_id = NEW.id AND v.n = NEW.version_vigente
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'compra: la version vigente debe existir en compra_version';
    END IF;
  END IF;
```

Tres reglas, como el marcador de un libro que solo avanza:

1. El puntero **no retrocede**. Deshacer no mueve el puntero hacia atrás: crea una versión nueva con los valores anteriores (sección 6).
2. Solo apunta a una versión que **existe** y es de **esa** compra.
3. Las mismas líneas (`0034:32-37`) impiden descartar una compra del SIRE: solo se descartan las agregadas a mano.

Como es un trigger y no un permiso, vale incluso para el superusuario. El comentario de cabecera todavía dice `0033b`: es el nombre con que nació antes de renumerarse a 0034 (plan de 014, «Archivos»).

## 3. La descarga: el persistidor de compras

La descarga de la propuesta es común a ventas y compras y nació en 013 (módulo 11): un solo tipo de trabajo `sire.propuesta.descargar` con `libro`, un procesador común y un **persistidor por libro**. 014 solo agregó el suyo con una línea.

`apps/worker/src/trabajos/persistidores/index.ts:7-10`:

```ts
export const PERSISTIDORES: PersistidoresLibro = {
  compras: persistidorCompras,
  ventas: persistidorVentas,
};
```

El persistidor (`persistidores/compras.ts:199`) cumple el contrato `PersistidorLibro` de tres pasos:

- **`preparar`**: valida cada fila con `Money`, moneda, tipo de cambio y la clave. Una fila ilegible (un monto que no cabe en `NUMERIC(14,2)`, una razón social con el carácter NUL, H-014-4) rechaza **toda** la descarga con `fila_invalida`, sin reintento: todo o nada.
- **`leerExistentes`**: lee la versión 1 de las compras ya guardadas, para que el complemento común decida qué es nuevo.
- **`insertar`**: guarda solo las nuevas como versión 1 y evalúa las reglas de 011 (R-ISC, R-MIX, R-NEW…), guardando sus hallazgos.

Antes de leer lo existente, mira el estado del periodo. `persistidores/compras.ts:204-211` (fragmento):

```ts
  async leerExistentes(tx: TxPersistidor, ctx: ContextoPersistidor) {
    // `FOR SHARE` sobre el estado del periodo (y lo crea `abierto` si falta): una marca de `generado` concurrente espera a esta
    // transacción. `generado` rechaza la descarga antes de crear la propuesta; `revisado` se acepta (DU-21).
    const estado = await leerEstadoPeriodo(tx, ctx.clienteId, ctx.periodo, {
      compartido: true,
    });
    if (estado.estado === "generado") throw new ErrorDatos();
    return leerExistentesCompras(tx, ctx.clienteId, ctx.periodo);
```

**Descargar de nuevo complementa** (DU-2): agrega solo los comprobantes nuevos, no toca ninguna fila existente (ni la que corregiste ni la que agregaste) y cuenta como `distintas` las que difieren de su versión 1. Esas diferencias son un aviso, no un cambio. El resultado del trabajo es `{ propuestaId, recibidas, nuevas, iguales, distintas, claves, truncado }`, igual que en ventas.

## 4. Las acciones: todo es una versión nueva

Las rutas viven bajo `/clientes/:clienteId/periodos/:periodo/compras`, repartidas en `apps/backend/src/modules/compras/compras.controller.ts` (descargar, listar, resumen, propuestas, detalle) y `compras-acciones.controller.ts` (escrituras).

| Ruta | Qué hace | Permiso |
|---|---|---|
| `POST …/:compraId/clasificar` `{versionBase, destino}` | Mueve BI e IGV a DG, DGNG o DNG con `cambiarDestino` de 010 | `sire.clasificar` |
| `POST …/:compraId/editar` `{versionBase, cambios}` | Cambia columnas de monto; el total se recalcula | `sire.clasificar` |
| `POST …/:compraId/calcular` `{cambios}` | Vista previa: total y cuadre, **sin escribir** | `sire.clasificar` |
| `POST …/:compraId/sugerencias/aceptar` | Acepta un hallazgo de 011 | `sire.clasificar` |
| `POST …/:compraId/excluir` · `…/restaurar` · `…/descartar` | Excluir con motivo, restaurar, descartar una agregada | `sire.clasificar` |
| `POST …/compras` | Agregar una compra a mano (201) | `sire.clasificar` |
| `POST …/masivas/{clasificar,aceptar,excluir,restaurar}` | Lo mismo en masa, hasta 5.000 filas | `sire.clasificar` |
| `POST …/deshacer` · `…/rehacer` | Pila de deshacer del usuario en el periodo | `sire.clasificar` |
| `GET …/resumen` · `GET …/exportar.xlsx` | Resumen por casillero y Excel del periodo | `clientes.ver` |

### `versionBase`: «lo que viste es lo que corriges»

Toda escritura lleva `versionBase`: el número de versión que tenías en pantalla. Si otra persona ya creó una versión más nueva, el servidor responde `409 version_obsoleta` y no escribe nada (D-2). Es el mismo principio que la huella del módulo 10, a escala de una fila.

### Un solo punto de escritura

Todas las acciones terminan en la misma función. `packages/db/src/compras/repositorio.ts:391-402`:

```ts
export async function escribirVersiones(
  tx: TxConsulta,
  lote: VersionPorEscribir[],
  evaluar: Evaluar,
): Promise<VersionFila[]> {
  if (lote.length === 0) return [];
  // Primero las versiones y después los punteros: el trigger de `compra` exige que la versión vigente exista (H-014-6).
  const versiones = await insertarVersiones(tx, lote);
  await moverPunteros(tx, lote);
  await evaluarYGuardar(tx, lote, evaluar);
  return versiones;
}
```

Fíjate en el orden: primero la versión, después el puntero (si no, el trigger de la sección 2 lo rechaza), y al final **re-evaluar las reglas** de la fila. `evaluar` llega como parámetro porque `packages/db` no depende de `packages/domain` (regla de capas de 013): quien llama inyecta el cálculo, y `db` solo hace SQL. Así ninguna acción puede olvidarse de re-evaluar.

`moverPunteros` (`repositorio.ts:188-190`) hace un *compare-and-set*: `update compra … where c.id = x.id and c.version_vigente = x.base`. Solo mueve el puntero si sigue donde estaba al leerlo.

### Editar con vista previa: `calcular`

Editar y `calcular` usan la **misma** función pura, así que nunca pueden dar resultados distintos. `packages/domain/src/compras/edicion.ts:49-60` (fragmento):

```ts
  const total = Money.suma(COLUMNAS_COMPRA.map((c) => columnas[c]), moneda);
  // …
  const celdas = PARES_DESTINO.map((par): CeldaCuadre => {
    const bi = columnas[par.bi];
    const igv = columnas[par.igv];
    const cuadra = igvAceptable(bi, igv);
    return { columna: par.igv, cuadra, explicacion: cuadra ? null : igvNoCuadra(igv, bi) };
  });
  return { montos: nuevos, total, cuadre: { cuadra: celdas.every((c) => c.cuadra), celdas } };
```

- El total **no se edita**: siempre es Σ de las 10 columnas (D2 de 010).
- Un IGV que no cuadra **se guarda y se señala** con su explicación («17.00 no es 18 % ni 10 % de 100.00»). Quien bloquea la generación es la prevalidación de 012, no la edición (HU-16).
- Más de 2 decimales o fuera de rango: 400. Se admiten negativos (notas de crédito).

### Sugerencias de 011, una por una o en bloque

Aceptar una sugerencia crea una versión con `accion = sugerencia`; nada se aplica solo. Si la fila cambió desde que se evaluó, `409 revisar_de_nuevo`; si la regla necesita un dato (R-MIX sin XML pide el gravado), `422 requiere_dato`.

En bloque solo entran las sugerencias que **no piden confirmación ni dato** (DU-6, DU-15): R-RED y las respaldadas por el XML. La aceptación en bloque usa el hallazgo **guardado** (DU-22). Lo demás sale como `no_masiva` en el informe y se acepta de a una.

### Excluir, restaurar, agregar y descartar

- **Excluir** (D-6) es una versión con `excluida = true` y motivo opcional (hasta 200 caracteres): sale de los totales y pasa a la vista «excluidas». Restaurar es otra versión.
- **Agregar** (D-7) crea una `compra` con `origen = agregada` y versión 1. Si la clave ya existe, `409 duplicado` con el id de la existente.
- **Descartar** vale solo para una agregada: la quita (no cuenta como excluida) y libera su clave. Una fila del SIRE nunca se descarta: se excluye. Por eso «excluir» una agregada equivale a descartarla (DU-16).

## 5. Estados del periodo

El periodo de compras de un cliente pasa por tres estados (D-9, DU-4), como un expediente que se revisa y se presenta:

```text
 abierto ──(marcar revisado: sire.clasificar)──► revisado ──(012b genera el archivo)──► generado
    ▲                                               │                                    │
    └────────(reabrir con estadoVisto: sire.aprobar_generar)──────────────────────────────┘
```

La regla para escribir es una función pura que usan todos los servicios. `packages/domain/src/compras/bloqueo.ts:23-30`:

```ts
export function puedeEscribir(estado: EstadoPeriodo, permisos: readonly string[]): ResultadoEscritura {
  if (estado === "abierto") return { ok: true };
  if (estado === "revisado") {
    return permisos.includes(PERMISO_APROBAR_GENERAR) ? { ok: true } : { ok: false, codigo: "periodo_revisado" };
  }
  if (estado === "generado") return { ok: false, codigo: "periodo_generado" };
  throw new EstadoPeriodoInvalidoError();
}
```

| Estado | Quién escribe | Si no puede |
|---|---|---|
| `abierto` | Quien tenga `sire.clasificar` | — |
| `revisado` | Solo quien tenga `sire.aprobar_generar` | `403 periodo_revisado` |
| `generado` | Nadie, hasta reabrir | `409 periodo_generado` |

### Reabrir con el estado visto (DU-23)

Reabrir lleva `{ "estadoVisto": "revisado" | "generado" }`: el estado que **viste** al pulsar el botón. Es un *compare-and-set*: si mientras tanto 012b marcó `generado` el periodo que tú viste `revisado`, responde `409 estado_invalido` y no cambia nada. Sin `estadoVisto` (o con otro valor), `400 solicitud_invalida`. Sin `sire.aprobar_generar`, `403 permiso_denegado` (`periodo.service.ts:44`).

La función de la BD que hace el cambio es la misma que usa 012b. `packages/db/src/compras/periodo.ts:65-82` (fragmento):

```ts
export async function fijarEstadoPeriodo(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  desde: EstadoPeriodoCompras,
  hacia: EstadoPeriodoCompras,
  usuarioId: string,
): Promise<EstadoPeriodo | null> {
  await consultar(tx, SQL_CREAR, [clienteId, periodo]);
  const actual = await consultar(tx, SQL_LEER_EXCLUSIVO, [clienteId, periodo]);
  if (actual.rows[0]?.estado !== desde) return null;
  // … UPDATE compra_periodo SET estado = hacia, marcado_por, marcado_en
```

Devuelve `null` si el estado ya no era `desde`. `SQL_LEER_EXCLUSIVO` es un `SELECT … FOR UPDATE`: mientras dura, las acciones (que toman la misma fila con `FOR SHARE`) esperan.

### Lo que 012b consume

Las dos piezas que el módulo 10 usa para generar el archivo vienen de aquí:

- **`fijarEstadoPeriodo`**: el worker pasa el periodo de `estadoVisto` a `generado` **antes** de leer (`generar-archivo.ts:295`).
- **`leerFilasReemplazo(tx, clienteId, periodo, aFila)`** (`packages/db/src/compras/filas-reemplazo.ts:43`): devuelve `{ original, vigente }`. Original es la versión 1 de las filas del SIRE; vigente, la versión vigente de las vivas (excluidas marcadas, descartadas fuera). Las filas PEN llevan `tipoCambio: null`.

Las dos listas se leen en dos sentencias. Por eso el protocolo (comentario de `filas-reemplazo.ts:26-32`) exige fijar `generado` primero y en la misma transacción: así nadie puede colarse entre ambas lecturas.

## 6. Deshacer y rehacer, por usuario y periodo

Cada acción de fila o masiva crea una `compra_operacion`. Deshacer (D-14, DU-3) toma la **última operación vigente del propio usuario en ese periodo** y crea, por cada fila, una versión nueva con `accion = deshacer` que copia los valores de antes. Nada se borra: es un contraasiento.

- Una masiva es **un solo paso** de deshacer.
- Si otra persona cambió alguna de esas filas, `409 fila_cambiada` con los ids y no se escribe nada (`operaciones.ts:327`). La comparación es por **valor**, no por número de versión, para que deshacer y rehacer sobre la misma fila no se confundan con un cambio ajeno.
- Rehacer repone la última operación deshecha y vale hasta tu siguiente acción nueva: entonces las `deshecha` pasan a `caducada`.
- Sin nada pendiente: `409 nada_que_deshacer` o `nada_que_rehacer`.
- Entran en la pila: clasificar, editar, aceptar, excluir y restaurar. **No** entran: agregar, descartar, marcar revisado y reabrir (DU-14).
- Como vive en la BD, la pila sobrevive a recargar la página y la de un usuario no toca la de otro.

## 7. Masivas parciales y el interbloqueo (H-014-1)

Una masiva recibe hasta 5.000 `{ compraId, versionBase }` (`MAX_ITEMS_MASIVA`, `packages/shared/src/compras/masivas.ts:7`; 5.001 es 400). Es **parcial** (DU-5): las filas válidas se aplican en una sola operación y el resto vuelve en un informe, como la constancia de lo procesado y lo observado:

```text
{ operacionId, aplicadas, rechazadas: [{ compraId, codigo }] }
```

Los códigos son `version_obsoleta`, `fila_excluida`, `no_excluida`, `no_masiva`, `requiere_dato`, `revisar_de_nuevo`, `solicitud_invalida` y `no_encontrada`. Un id de otro estudio y uno inexistente dan el mismo `no_encontrada`: no se revela nada.

### Qué es un interbloqueo

Dos contadores necesitan los archivadores A y B. El primero toma A y espera B; el segundo tomó B y espera A. Ninguno avanza. En PostgreSQL eso es un **deadlock** (código `40P01`): la base lo detecta y mata a uno, que recibe un error 500.

La receta clásica es que **todos tomen los archivadores en el mismo orden**. El plan de 014 fija uno: advisory `(cliente, periodo, 'compras')` (solo la descarga) → `compra_periodo` → `compra_operacion` → `compra` por **id ascendente**. `bloquearCompras` lo cumple con `order by id for update` (`repositorio.ts:151-152`).

**El hallazgo H-014-1**: la masiva de excluir con una compra agregada (de id menor) y una del SIRE descartaba la agregada **aparte**, antes de bloquear las demás. Junto con un deshacer o una masiva de clasificar sobre las mismas filas, el orden se cruzaba y saltaba el `40P01`. La corrección bloquea agregadas y del SIRE juntas, en un solo orden de id. `packages/db/src/compras/operaciones.ts:146-150` y `:167-168` (fragmento):

```ts
    /**
     * Las agregadas a mano de `items` se descartan (D-7) en vez de recibir versión: se bloquean junto con las demás en el mismo
     * orden de id (H-014-1). Las del SIRE reciben `transformar` como siempre.
     */
    descartarAgregadas?: boolean;
  // …
  await bloquearDeshechas(tx, e.clienteId, e.periodo, e.usuarioId);
  const filas = await bloquearCompras(tx, validas, e.clienteId, e.periodo);
```

La prueba que lo reproduce está en `apps/backend/src/modules/compras/compras.adv.int.spec.ts:148`.

## 8. Resumen y Excel con una foto consistente (H-014-2)

El resumen por casillero (D-8) compara la versión 1 de las filas del SIRE con la vigente (sin excluidas ni descartadas) y da la diferencia, todo con `Money`, no con `SUM` de SQL: la conversión USD y el redondeo son los de 010. El Excel (D-17) escribe las vigentes en una hoja y las excluidas en otra, con los montos como números exactos y todo texto que empiece por `=`, `+`, `-` o `@` neutralizado con una comilla (`neutralizarTexto`, `escritor-xlsx.ts:47`).

Ambos leen **todo el periodo por lotes**, en varias sentencias. **El hallazgo H-014-2**: en `READ COMMITTED` (el nivel normal, módulo 02) cada sentencia ve los datos confirmados en **su** momento. Si alguien excluía una compra entre la lectura de la hoja de vigentes y la de excluidas, esa compra salía en las dos hojas o en ninguna.

Es como hacer un arqueo de caja mientras siguen cobrando: hay que «congelar» un instante. La corrección agregó una opción explícita a `withTenant`. `packages/db/src/with-tenant.ts:20-25`:

```ts
  /**
   * Lectura consistente (H-014-2): la transacción abre en `REPEATABLE READ READ ONLY`, así que todas sus sentencias ven el
   * mismo instante y no puede escribir ni bloquear filas. Para generar un archivo o un resumen de varias lecturas. Sin esta
   * opción (o en `false`) la transacción es la de siempre, `READ COMMITTED`.
   */
  foto?: boolean;
```

Y la usan el resumen y el Excel. `apps/backend/src/modules/compras/resumen.service.ts:66-67`:

```ts
    // Una foto: todas las lecturas del periodo ven el mismo instante (H-014-2).
    return this.db.withTenant({ ...contextoDe(sesion), foto: true }, async (tx) => {
```

`REPEATABLE READ` hace que todas las sentencias de la transacción vean la base como estaba al empezar; `READ ONLY` garantiza que no escriba. Es una opción explícita: el nivel por omisión no cambia. Por eso **012b no la usa**: necesita escribir el estado `generado`, y resuelve la consistencia con `fijarEstadoPeriodo` (sección 5).

## 9. La pantalla de compras (015)

La pantalla es `apps/frontend/app/(app)/clientes/[clienteId]/compras/page.tsx`, con el periodo en la URL (`?periodo=AAAAMM`). Sus piezas están en `apps/frontend/components/compras/` y el cliente HTTP en `apps/frontend/lib/compras.ts`. No hay ningún cambio de backend: todo el contrato es el de 014. Igual que en el resto del frontend, solo importa `@contapp/shared` (más tres librerías externas).

### Grilla virtualizada: TanStack Table + Virtual

5.000 filas × ~20 columnas son 100.000 celdas. Si el navegador dibujara todas, la pantalla se arrastraría. **Virtualizar** es dibujar solo lo que se ve más un pequeño margen, y reciclar las filas al desplazarse: como una ventanilla que se mueve sobre un libro enorme.

- **TanStack Table** da el modelo de columnas y filas (con columnas fijas a izquierda y derecha, P-8).
- **TanStack Virtual** decide qué filas y qué columnas están en la ventana.
- El teclado, `role="grid"` y la edición son propios.

`apps/frontend/components/compras/grilla-compras.tsx:263-269` (fragmento):

```ts
  const filasVirtuales = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.tipo === "seccion" ? ALTO_SECCION : ALTO_FILA),
    getItemKey: (i) => items[i]?.clave ?? i,
    overscan: MARGEN_FILAS,
```

`overscan` es el margen: 6 filas (`MARGEN_FILAS`, línea 68) y 2 columnas fuera de la vista.

### Carga por cursor

El listado no pide 5.000 filas de golpe: las pide en bloques de 1.000 (`TAMANO_BLOQUE`, `lib/compras.ts:487`) con un **cursor**: cada respuesta trae `siguiente`, que dice «continúa desde aquí», hasta que `siguiente` es `null` (`cargarPeriodo`, `lib/compras.ts:671`). La grilla es usable desde el primer bloque. Si cambias un filtro, la carga anterior se cancela y sus respuestas tardías se descartan (`useSecuencia`, `lib/secuencia.ts`).

A diferencia de «página 3 de 5», un cursor no se desordena si alguien agrega una compra mientras cargas.

### Edición por fila con teclado y cuadre en vivo

Como en una hoja de cálculo (D-6, P-3): Enter, F2 o doble clic abren la fila; Tab y Shift+Tab pasan entre celdas de monto; Esc descarta. Al salir de la fila se envía **un solo** `editar` con todas las celdas cambiadas: una versión y un Ctrl+Z por fila.

Mientras tecleas, el total de la fila se suma en el navegador; a los 300 ms sin teclear (`RETARDO_CALCULAR_MS`, `grilla-compras.tsx:71`) se pide `calcular` para traer el cuadre con su explicación. Si `calcular` falla, queda el total local con el aviso «cuadre no verificado».

**¿No dijimos que el frontend no calcula montos?** Lo que se guarda lo calcula siempre el servidor. La suma local es solo para mostrar, y aun así no usa `number`: `decimal.js` vive en **un solo archivo** del frontend. `apps/frontend/lib/montos-compras.ts:52-56`:

```ts
export function sumar(cadenas: readonly string[]): string {
  let total = new D(0);
  for (const c of cadenas) total = total.plus(leer(c));
  return textoExacto(total);
}
```

Entra texto, sale texto. La prueba estática `apps/frontend/compras.estatico.spec.ts` verifica que ningún otro archivo importe `decimal.js` y que no aparezcan `parseFloat`, `toFixed`, `Number(` ni `innerHTML` sobre montos (CA-5). Un monto con más de 2 decimales se rechaza antes de enviarse (`validarMonto`, `montos-compras.ts:82`), nunca se redondea en silencio.

### Acciones masivas con informe

Casillas por fila, «seleccionar las N del filtro» (tope 5.000) y una barra con clasificar, excluir, restaurar y «Aceptar R-RED» (`barra-masiva.tsx`). Cada ítem lleva el `versionBase` de la fila cargada. El resultado se muestra en `informe-masivo.tsx`: «N aplicadas» y la lista de rechazadas con el comprobante y un motivo legible por código; las `version_obsoleta` se recargan.

### Ctrl+Z / Ctrl+Y

El atajo solo actúa si **esta pantalla** hizo una operación (P-4); el botón «Deshacer» siempre está y, si la operación es anterior, pide confirmar. `apps/frontend/components/compras/deshacer-compras.tsx:207-218` (fragmento):

```ts
    alTeclear: (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
      const tecla = e.key.toLowerCase();
      const cual =
        tecla === "z" && !e.shiftKey
          ? "deshacer"
          : tecla === "y" || (tecla === "z" && e.shiftKey)
            ? "rehacer"
            : null;
      if (cual === null) return false;
      // Dentro de un campo de texto Ctrl+Z es del campo (plan, riesgos).
      if (e.target instanceof Element && e.target.closest(ES_CAMPO)) return false;
```

Al responder, solo se recargan y resaltan las filas afectadas. Con `409 fila_cambiada` la pantalla lista los comprobantes que otra persona cambió, con «Ver filas», y no reintenta sola (DU-26).

### Panel Historial

`historial-compra.tsx` es un panel lateral de solo lectura que pide `GET …/:compraId` y muestra el original del SIRE frente al vigente, cada versión (autor, fecha, acción) y los hallazgos (P-6). Es el libro de asientos de esa compra. El autor se ve como un id corto, porque el contrato solo trae el uuid (nota [017] de `ESTADO.md`).

## Práctica

**A. La edición, el bloqueo y la clave en el dominio** (desde la raíz, tras `pnpm --filter @contapp/shared build` y `pnpm --filter @contapp/domain build`):

```bash
cd packages/domain && node -e '
const d = require("./dist");
const m = d.MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
const r = d.aplicarEdicion(m, { igvDg: "17.00" });
console.log("total:", r.total.toString(), "cuadra:", r.cuadre.cuadra);
console.log(r.cuadre.celdas.find((c) => !c.cuadra).explicacion);
console.log(d.puedeEscribir("revisado", ["sire.clasificar"]));
console.log(d.puedeEscribir("revisado", ["sire.aprobar_generar"]));
console.log(d.puedeEscribir("generado", ["sire.aprobar_generar"]));
console.log(d.claveComprobante({ tipo: "01", serie: "f001", numero: "0001040" }, { tipo: "6", numero: "20100070970" }));'
# total: 117.00 cuadra: false
# 17.00 no es 18 % ni 10 % de 100.00
# { ok: false, codigo: 'periodo_revisado' }
# { ok: true }
# { ok: false, codigo: 'periodo_generado' }
# 01|F001|1040|6|20100070970
```

Observa: el total se recalculó solo, el IGV descuadrado se señala pero no lanza, ni siquiera `sire.aprobar_generar` escribe en `generado`, y la serie en minúsculas y los ceros a la izquierda dan la misma clave.

**B. Pruebas del dominio de compras** (no necesitan BD):

```bash
pnpm --filter @contapp/domain test compras
# Test Files  12 passed (12)
#      Tests  217 passed (217)
```

**C. Pruebas de los montos y la edición del frontend** (sin navegador ni servidor):

```bash
pnpm --filter @contapp/frontend test montos-compras edicion-compras
# Test Files  2 passed (2)
#      Tests  19 passed (19)
```

**D. Ver las versiones de una compra** (con la app levantada y un periodo descargado; `psql` como `postgres`, solo lectura):

```sql
SELECT c.serie, c.numero, c.origen, c.version_vigente,
       v.n, v.accion, v.bi_dg, v.igv_dg, v.isc, v.total, v.excluida
FROM compra c JOIN compra_version v ON v.compra_id = c.id
ORDER BY c.serie, c.numero, v.n LIMIT 20;

SELECT cliente_id, periodo, estado, marcado_en FROM compra_periodo;
```

Tras aceptar R-ISC en F001-1040 verás dos versiones: la 1 con la BI de DG original y la 2 con `accion = sugerencia`, BI DG 0.00 e ISC 770.00, y `version_vigente = 2`.

## Impacto en ContApp

- Lo que trajo el SIRE **no se pierde nunca**: la versión 1 no se puede cambiar ni borrar, ni siquiera con un `UPDATE` a mano (permisos más trigger).
- Cada cifra tiene autor, fecha y acción: ante una observación se puede reconstruir quién movió qué y desde qué valor.
- Dos personas pueden trabajar el mismo periodo: `versionBase`, el orden de bloqueo y deshacer por usuario evitan que una pise a la otra.
- El estado `generado` congela el periodo: lo que salió en el archivo de 012b es lo que está en la BD, hasta que alguien con permiso lo reabra.
- El contador trabaja 5.000 compras como en Excel, con teclado, pero sin que el navegador decida ninguna cifra que se guarde.

## Errores comunes

- **«Me sale 409 `version_obsoleta`.»** Alguien (o tú en otra pestaña) cambió la fila. Recarga la fila y vuelve a aplicar.
- **«No puedo editar y el periodo está `revisado`.»** Sin `sire.aprobar_generar` recibes 403 `periodo_revisado`. Pide a quien tenga el permiso que edite o reabra.
- **«Reabrir me da 409 `estado_invalido`.»** El estado cambió desde que lo viste (por ejemplo, ya se generó). Recarga y reabre con el estado actual.
- **«Ctrl+Z no hace nada.»** El atajo solo vale con una operación hecha en esta pantalla, y dentro de un campo de texto deshace el texto. Usa el botón «Deshacer».
- **«Voy a hacer un `UPDATE compra_version` para arreglar un monto.»** No: ningún rol tiene ese permiso y la historia se rompería. Se crea una versión nueva con una acción.
- **«Sumo los montos con `Number()` en un componente, es solo para mostrar.»** La prueba estática lo rechaza: usa `sumar` de `lib/montos-compras.ts`.

## Ejercicios

1. Deshaces una clasificación. ¿El puntero `version_vigente` vuelve a 1?
2. Una masiva de excluir de 12 filas trae 2 con `versionBase` vieja. ¿Qué pasa con las otras 10?
3. ¿Por qué el resumen usa `withTenant({ foto: true })` y el worker de 012b no?
4. Tu compañero tiene `sire.aprobar_generar` y el periodo está `generado`. ¿Puede editar una fila directamente?
5. ¿Por qué `calcular` y `editar` nunca pueden dar un total distinto?

<details><summary>Soluciones</summary>

1. No. El trigger impide que el puntero retroceda. Deshacer crea una versión nueva (por ejemplo, la 3) con los valores de la versión 1 y `accion = deshacer`, y el puntero avanza a ella (D-14, H-014-6).
2. Las 10 se aplican en una sola operación y las 2 salen en `rechazadas` con `version_obsoleta`. La masiva es parcial, responde 200 y un solo Deshacer revierte las 10 (D-15, CA-18).
3. El resumen solo lee, en varias sentencias, y necesita que todas vean el mismo instante (H-014-2). La foto es `READ ONLY`, y 012b debe escribir `generado`: lo resuelve fijando el estado primero con `FOR UPDATE` en la misma transacción.
4. No. `puedeEscribir("generado", …)` da `periodo_generado` para todos. Primero tiene que reabrir con `estadoVisto: "generado"` (D-9, DU-23).
5. Porque ambos llaman a la misma función pura, `aplicarEdicion` de `packages/domain/src/compras/edicion.ts` (D-16).

</details>

## Para profundizar

- Specs del proyecto: [014 spec](../specs/014-compras-backend/spec.md) y [015 spec](../specs/015-compras-frontend/spec.md), con sus `plan.md` y `tasks.md`. Los hallazgos H-014-1 a H-014-6 están en `docs/specs/ESTADO.md`.
- Niveles de aislamiento de PostgreSQL: <https://www.postgresql.org/docs/current/transaction-iso.html>
- Interbloqueos y bloqueos explícitos: <https://www.postgresql.org/docs/current/explicit-locking.html>
- TanStack Virtual: <https://tanstack.com/virtual/latest>
- TanStack Table: <https://tanstack.com/table/latest>
