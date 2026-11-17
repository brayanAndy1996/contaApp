# 16 · Reglas aprendidas: clasificar una vez a cada proveedor

> Módulo anterior: [15-pruebas-e2e.md](15-pruebas-e2e.md) · Siguiente: [17-rendimiento.md](17-rendimiento.md) · Índice: [00-indice.md](00-indice.md)
>
> Cubre la spec **021** (reglas aprendidas, R-HIS). Conviene haber leído [03](03-rls-y-withtenant.md), [08](08-dinero-y-dominio.md), [12](12-compras.md) y [14](14-auditoria-y-notificaciones.md).

## Lo que aprenderás

- Qué es **R-HIS** y por qué no es un hallazgo más del motor de reglas de 011.
- Cómo nace una **regla cliente + proveedor** con «Recordar para este proveedor» y cómo se evita que dos personas la pisen.
- Cómo la descarga crea sola la versión **«Según historial»** sin tocar el original y por qué se puede revertir.
- Cómo se cuentan «aplicada» y «aceptada», y qué son las **confirmaciones anónimas** para el catálogo futuro (033).
- Qué enseñaron los hallazgos de 021: una fila movida a mano que contaba como aceptada y una descarga 6,6 veces más lenta.

---

## 1. El problema: clasificar lo mismo cada mes

Un cliente con ventas exoneradas compra todos los meses al mismo proveedor, y cada mes el contador mueve esas compras de DG (destino gravado) a DNG (destino no gravado). Es el ejemplo de `docs/01-definiciones-base.md` §7 regla 3, que la spec usa como fixture.

Es como un asistente nuevo que cada mes pregunta «¿y esta factura de Ferretería X a qué cuenta va?». Lo razonable es anotarlo una vez en la ficha del proveedor y que el asistente lo aplique solo, **marcando** que lo hizo por la ficha, para que el contador pueda revisarlo.

Eso hace la spec 021:

1. Al clasificar una fila, ContApp ofrece **«¿Recordar para este proveedor en este cliente?»** (RF-110, HU-28).
2. En la descarga del periodo siguiente, las compras de ese proveedor llegan ya clasificadas con la etiqueta **«Según historial»** (RF-111).
3. La versión 1 (lo que trajo el SIRE) **no cambia** (RNF-052) y el contador puede revertir clasificando de nuevo, una a una o en masa (D-1).

> **La única excepción a «nada se aplica solo».** En compras (014 D-4) ninguna sugerencia se aplica sin que el contador la acepte. 021 precisa esa regla: R-HIS al cargar es la única excepción, y por eso la fila lleva etiqueta, filtro y vuelta atrás.

## 2. La regla: cliente + proveedor

Una regla es una fila de `regla_aprendida` (migración 0047): un destino (DG, DGNG o DNG) para un proveedor de un cliente.

`packages/db/migrations/0047_regla_aprendida.sql:30-52` (fragmento):

```sql
CREATE TABLE "regla_aprendida" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"doc_tipo" text NOT NULL,
	"doc_numero" text NOT NULL,
	"destino" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"periodo_aprendido" char(6) NOT NULL,
	-- … creada_por/en, actualizada_por/en, eliminada_en, eliminada_por
	CONSTRAINT "regla_aprendida_destino_valido" CHECK ("regla_aprendida"."destino" IN ('DG', 'DGNG', 'DNG')),
	-- … versión ≥ 1, formato del periodo, largo del documento, baja coherente
);
```

Y la línea 58 fija la clave:

```sql
CREATE UNIQUE INDEX "regla_aprendida_viva_unique" ON "regla_aprendida" USING btree ("tenant_id","cliente_id","doc_tipo","doc_numero") WHERE "regla_aprendida"."eliminada_en" IS NULL;
```

Tres decisiones se leen en esas líneas:

- **Clave cliente + proveedor (D-2).** La misma regla nunca se comparte entre clientes ni entre estudios (RF-115). Si el cliente A manda el proveedor X a DNG, el cliente B del mismo estudio no se entera: puede tener ventas gravadas y necesitar DG.
- **Una sola regla viva** por proveedor. El índice es **parcial** (`WHERE eliminada_en IS NULL`): eliminar es una baja lógica (P-9) y después se puede crear otra regla para el mismo proveedor.
- **`periodo_aprendido`**: la regla solo se aplica a descargas de periodos **posteriores** (P-5). Si «recordaste» en octubre, se aplica desde noviembre.

El documento del proveedor se compara **normalizado**, igual que R-NEW de 011: sin espacios y en mayúsculas (`r-his.ts:35-47`, función `claveDoc`).

### Permisos

El backend tiene `SELECT`, `INSERT` y `UPDATE` solo de algunas columnas, sin `DELETE` (`0047_regla_aprendida.sql:71-73`). El worker **no tiene ningún privilegio** sobre la tabla: la lee por una función acotada (sección 4). Las rutas (D-9, `apps/backend/src/modules/reglas/reglas.controller.ts:14-54` y `motor.controller.ts:18-40`) piden `reglas.ver` para leer y `reglas.gestionar` para escribir; los interruptores del estudio, además, un rol de alcance global. Un cliente de otro estudio o no visible da 404, igual que uno inexistente (CA-5).

## 3. «Recordar para este proveedor»

En la grilla, en la lupa o tras una masiva de **un solo** proveedor (P-2), aparece un aviso no modal. El comentario de `apps/frontend/components/reglas/recordar-proveedor.tsx:20-24` resume su comportamiento:

```ts
// Aviso «Recordar para este proveedor en este cliente» (spec 021, CA-1, P-2, P-3). No es modal: se anuncia con
// `role="status"` y `aria-live="polite"`, NO toma el foco y se acepta con el botón o con Alt+R (la grilla ignora Alt,
// así que no choca con `foco-grilla.ts`). Se oculta solo a los 10 s. No se ofrece sin `reglas.gestionar` ni si ya hay
// una regla activa del proveedor con ese destino. El servidor decide: aquí solo se arma la petición con la
// `versionBase` de la regla viva del proveedor (o `null` si no hay).
```

No toma el foco a propósito: el contador clasifica con el teclado (módulo 12) y un diálogo que interrumpe cada Enter sería insoportable.

### Último gana, pero sin pisar a nadie

Del lado de la BD, `recordarRegla` hace un **compare-and-set** sobre `version`. `packages/db/src/reglas/escritura.ts:28-31`:

```ts
const SQL_RECORDAR_EXISTENTE = `update regla_aprendida
  set destino = $4, activa = true, version = version + 1, periodo_aprendido = $5, actualizada_por = $6, actualizada_en = now()
  where cliente_id = $1 and doc_tipo = $2 and doc_numero = $3 and eliminada_en is null and version = $7
  returning id`;
```

Si otra persona cambió la regla después de que tu pantalla la leyó, `version = $7` ya no coincide, el `UPDATE` no toca nada y la ruta responde **409 `regla_cambiada`** (D-5, CA-9). Para crear, `SQL_CREAR` usa `ON CONFLICT … DO NOTHING` sobre el índice parcial: de dos «Recordar» simultáneos, uno crea y el otro recibe el 409.

Es lo mismo que pasa en un libro de actas: si dos personas corrigen la misma línea, la segunda tiene que leer la corrección de la primera antes de escribir encima.

Antes de escribir, `recordarRegla` (`escritura.ts:78-111`) comprueba que todas las compras sean del cliente, de un solo proveedor (`proveedores_distintos`, 422) y de un solo periodo (`periodos_distintos`, H-021-1-1). Y **nunca crea versiones de filas existentes** (D-5): la regla afecta solo a lo que entre después. Para lo que ya está, existe la masiva de 015.

## 4. La versión «Según historial» en la descarga

### R-HIS, pura en el dominio

`planificarHistorial` decide qué filas nuevas se mueven. `packages/domain/src/reglas/r-his.ts:105-126`:

```ts
export function planificarHistorial(
  filas: readonly FilaEvaluable[],
  reglas: readonly ReglaAprendidaEvaluable[],
  opciones: { readonly rHisActiva: boolean },
): PlanHistorial[] {
  const rHisActiva = leerObjeto(opciones, CLAVES_OPCIONES).get("rHisActiva");
  if (typeof rHisActiva !== "boolean") invalida();
  const porProveedor = reglasPorProveedor(reglas);
  const internas = leerArreglo(filas).map(leerFila);
  if (!rHisActiva) return [];

  const plan: PlanHistorial[] = [];
  for (const fila of internas) {
    if (fila.clave === null) continue;
    const regla = porProveedor.get(fila.clave);
    if (regla === undefined || regla === null) continue;
    const movida = consolidar(fila.montos, regla.destino);
    if (movida === null) continue;
    plan.push(Object.freeze({ filaId: fila.id, reglaId: regla.id, destino: regla.destino, montos: movida }));
  }
  return plan;
}
```

`consolidar` (`r-his.ts:133-142`) devuelve `null` si la base gravada total es 0, si la fila ya está toda en el destino o si la suma no cabe en `NUMERIC(14,2)` (H-021-2-4). Si no, usa `cambiarDestino` de 010: los tres BI y los tres IGV se suman en el par del destino y el **total no cambia**. Todo con `Money` (módulo 08).

> **R-HIS no es un hallazgo.** Las reglas de 011 (R-ISC, R-MIX…) producen sugerencias que el contador acepta. R-HIS no produce `Hallazgo` ni entra en `compra_hallazgo`: se aplica sola y **solo en la descarga** (plan, «Decisiones técnicas»). Por eso, si corriges una fila «Según historial», R-HIS no vuelve a sugerirte nada en esa fila (P-3).

### El worker aplica, la BD verifica

En la transacción de la descarga (014 D-3), el persistidor lee las reglas y los interruptores. `apps/worker/src/trabajos/persistidores/compras.ts:227-237`:

```ts
    // Spec 021 (D-8): las reglas vigentes se leen primero (toman el advisory compartido del estudio hasta el fin de la
    // transacción) y después los interruptores: una descarga aplica con el interruptor que leyó. Con R-HIS apagado no hay reglas.
    const reglas = await reglasHistorialVigentes(tx, ctx.clienteId, ctx.periodo);
    const reglasApagadas = codigosApagados(await leerReglasMotor(tx));
    const rHisActiva = !reglasApagadas.includes("R-HIS");
    const datos = nuevas.map((n) => n.datos);
    // Sin reglas vigentes (o con R-HIS apagado, que no las devuelve) no hay nada que planificar: `insertarCompras` igual que antes.
    const planificado =
      reglas.length > 0 && rHisActiva
        ? planificarHistorialDescarga(datos, reglas, rHisActiva)
        : null;
```

`reglas_historial_vigentes` (`0048_regla_aplicacion.sql:74-101`) devuelve las reglas vivas, activas y con `periodo_aprendido < p_periodo`, bloqueadas `FOR SHARE`: si alguien edita la regla durante la descarga, espera a que termine, y todas las filas de esa descarga quedan con el mismo destino (CA-9).

Lo interesante es **quién escribe** la versión 2. Hoy el worker solo puede insertar la versión `n = 1` de una compra que creó en la misma transacción (0038, módulo 13). En vez de ampliar ese permiso, 021 agrega una función `SECURITY DEFINER` acotada (D-6) que **vuelve a calcular** lo que el dominio decidió. `0048_regla_aplicacion.sql:145-149` exige que la compra sea nueva:

```sql
  -- La compra: viva, creada en esta transaccion y solo con la version 1, que es la vigente.
  SELECT c.id, c.cliente_id, c.periodo, c.doc_tipo, c.doc_numero INTO v_compra
    FROM public.compra c
   WHERE c.tenant_id = v_tenant AND c.id = p_compra AND c.descartada_en IS NULL AND c.version_vigente = 1
     AND c.xmin = pg_current_xact_id()::xid;
```

`xmin` es el número de la transacción que creó la fila: si no es la actual, la compra ya existía y no se toca (CA-4). Después, `0048_regla_aplicacion.sql:173-191` (fragmento) recalcula la consolidación en `NUMERIC` y la compara con lo que mandó el worker:

```sql
  v_bi := v_v1.bi_dg + v_v1.bi_dgng + v_v1.bi_dng;
  v_igv := v_v1.igv_dg + v_v1.igv_dgng + v_v1.igv_dng;
  v_esperado := jsonb_build_object(
    'bi_dg', CASE WHEN v_regla.destino = 'DG' THEN v_bi ELSE 0 END,
    -- … igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng con el mismo CASE; no_gravado, isc, icbper, otros y total de la versión 1
    'total', v_v1.total);
  FOREACH v_clave IN ARRAY v_claves LOOP
    IF (p_datos ->> v_clave)::numeric IS DISTINCT FROM (v_esperado ->> v_clave)::numeric THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'aplicar_regla_historial: aplicacion rechazada';
    END IF;
  END LOOP;
```

Es el principio de **doble firma**: el dominio calcula, la BD comprueba, y si no coinciden la operación **falla cerrada** con 42501 (permiso denegado) y un mensaje fijo, sin montos.

Además, un trigger impide que nadie más finja una versión `historial`. `0048_regla_aplicacion.sql:56-64`:

```sql
CREATE OR REPLACE FUNCTION public.compra_version_historial_acotado() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.accion = 'historial' AND current_user <> 'contapp_migrator' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'compra_version: la version historial solo la escribe aplicar_regla_historial';
  END IF;
  RETURN NEW;
```

Solo el dueño de la función (`contapp_migrator`, que la ejecuta por ser `SECURITY DEFINER`) puede escribir `accion = historial`. Ni el backend ni el worker directo.

### Reversible

La versión 2 queda con `clasificada = true` y la etiqueta «Según historial» en la grilla y la lupa (`apps/frontend/lib/compras.ts:381`). Clasificar de nuevo crea la versión 3 con el destino elegido y la etiqueta desaparece (CA-3). Deshacer esa corrección devuelve la etiqueta, porque se compara **por valor** con la versión `historial` (H-021-2-2, decisión del usuario).

## 5. Aplicada, aceptada y el catálogo anónimo

Cada versión `historial` deja una fila en `regla_aplicacion` (0048, solo inserción). Con eso:

- **Aplicada** = filas con versión `historial` de esa regla (P-4).
- **Aceptada** = las que siguen en el destino de la regla cuando su periodo pasa a `revisado`.

No hay contadores que se suman y restan: se calculan desde registros que nunca se borran (D-8), como un saldo que se obtiene del libro diario y no de una cifra anotada a mano.

La aceptación la registra un trigger al pasar el periodo a `revisado`. Tras las dos rondas adversariales quedó así, `packages/db/migrations/0051_regla_correcciones_r2.sql:27-47` (fragmento):

```sql
     WHERE a.tenant_id = NEW.tenant_id AND c.cliente_id = NEW.cliente_id AND c.periodo = NEW.periodo
       AND c.descartada_en IS NULL
       -- H-021-1-6: una fila excluida no cuenta ni confirma (decision del usuario, 2026-11-13).
       AND NOT v.excluida
       -- H-021-2-1: la vigente tiene base gravada (los BI no suman 0). …
       AND (v.bi_dg + v.bi_dgng + v.bi_dng) <> 0
       -- H-021-1-5: la version `historial` que aplico la regla tambien esta en el destino actual de la regla. …
       AND CASE r.destino
             WHEN 'DG' THEN h.bi_dgng = 0 AND h.igv_dgng = 0 AND h.bi_dng = 0 AND h.igv_dng = 0
             -- … DGNG y DNG igual
           END
       AND CASE r.destino
             WHEN 'DG' THEN v.bi_dgng = 0 AND v.igv_dgng = 0 AND v.bi_dng = 0 AND v.igv_dng = 0
             -- … DGNG y DNG igual
           END
```

`v` es la versión vigente y `h` la versión `historial`. Las dos tienen que estar en el destino actual de la regla.

### Confirmaciones para 033

El futuro catálogo global (RF-087, spec 033) lo cura el super-admin; los estudios solo aportan **conteos anónimos** (D-3). 021 deja todo listo y no crea ninguna lectura entre estudios:

- `regla_confirmacion` (0049) es **solo inserción** y ningún rol de la aplicación la puede leer: el backend solo inserta.
- Se registra una al «Recordar» y otra por cada fila aceptada, **solo** si el proveedor es persona jurídica (RUC 20) y el estudio no apagó el aporte (P-10, Ley 29733).
- No lleva usuario, montos ni razón social.

`packages/domain/src/reglas/catalogo.ts:22-28`:

```ts
/** RUC de persona jurídica: tipo 6 y número de 11 dígitos que empieza en 20. */
const RUC_20 = /^20[0-9]{9}$/;

/** Si el proveedor puede aportar al catálogo compartido (P-10): solo RUC 20. */
export function esRucAportable(doc: DocProveedor): boolean {
  return doc.tipo === "6" && typeof doc.numero === "string" && RUC_20.test(doc.numero);
}
```

Un RUC 10 es de una persona natural: contar cuántos estudios lo clasifican diría algo sobre una persona, y eso queda fuera.

## 6. Las pantallas

- **Reglas del cliente** (`app/(app)/clientes/[clienteId]/reglas/page.tsx`, HU-31): proveedor, destino, estado, aplicada y aceptada; editar el destino, activar, desactivar y eliminar. Cada cambio queda en la auditoría (módulo 14) con valor anterior y nuevo, sin RUC ni razón social en los datos.
- **Reglas del motor** (`app/(app)/configuracion/reglas/page.tsx`, RF-089): el estudio puede apagar R-ISC, R-MIX, R-RED, R-NEW, R-GP y R-HIS, y el aporte al catálogo. La lista sale de `CATALOGO_REGLAS_MOTOR` (`catalogo.ts:13-20`). La **prevalidación de 012 no figura**: no se puede apagar (P-8).

## 7. Lo que enseñaron los hallazgos

021 es de riesgo A y pasó tres rondas adversariales y una revisión final. Dos hallazgos merecen quedarse en la memoria.

### Una fila movida a mano contaba como aceptada (H-021-1-5, media)

Escenario: la regla manda al proveedor X a DG y la descarga crea versiones `historial` en DG. Después el contador edita la regla a DNG y mueve **a mano** algunas filas a DNG. Al revisar el periodo, la versión primera del trigger solo miraba la vigente: estaba en DNG, el destino actual de la regla, así que la contaba como «aceptada» y dejaba una confirmación para el catálogo.

Pero esa fila no la clasificó la regla: la clasificó el contador. Contarla inflaba el éxito de la regla y alimentaba el catálogo de otros estudios con una clasificación manual (P-1 dice que la clasificación manual sin «Recordar» no cuenta). La corrección (0050) exige que **también** la versión `historial` esté en el destino actual: es el segundo `CASE` del fragmento de la sección 5.

**Lección:** cuando un contador se calcula desde el estado final, pregunta **cómo se llegó** a ese estado. Dos caminos distintos pueden dejar la misma fila.

### La descarga con reglas, 6,6 veces más lenta (H-T25-2, media)

La medición de T25b (5.000 compras, 300 reglas, mediana de 3, BD nueva) dio 2.413 ms sin reglas y 15.969 ms con reglas: **6,6 ×**. El plan pedía agrupar si pasaba de 2 ×. Dos causas (`tasks.md`, T25b):

1. Cada compra movida era **un viaje a la BD**: una llamada a `aplicar_regla_historial` con su auditoría, fila por fila.
2. El evaluador validaba el contexto de reglas completo **en cada fila**, así que el costo por fila crecía con la cantidad de reglas.

La corrección (T25c) fue la migración 0052 con `aplicar_reglas_historial` **por lotes de 500**, con exactamente las mismas validaciones y el mismo fallo cerrado, y validar el contexto una sola vez al crear el evaluador. `packages/db/src/reglas/aplicar.ts:73-83`:

```ts
export async function aplicarReglasHistorial(tx: TxConsulta, items: readonly AplicacionHistorial[]): Promise<number> {
  let creadas = 0;
  for (let desde = 0; desde < items.length; desde += LOTE_HISTORIAL) {
    const parte = items.slice(desde, desde + LOTE_HISTORIAL);
    const r = await consultar(tx, SQL_APLICAR_LOTE, [
      JSON.stringify(parte.map((i) => ({ compra: i.compraId, regla: i.reglaId, datos: datosHistorial(i.datos) }))),
    ]);
    creadas += r.rows[0]!.n as number;
  }
  return creadas;
}
```

Resultado medido igual que T25b: 2.107 ms sin reglas y 3.556 ms con reglas, **1,69 ×** (otra serie en otra BD nueva dio 1,48 ×). ESTADO lo resume como 1,5–1,7 ×. Después se corrió una tercera ronda adversarial solo sobre el lote: 10 pruebas, sin hallazgos.

Un detalle del lote enseña algo de PostgreSQL: el puntero `version_vigente` se mueve compra por compra por su clave, porque «un UPDATE con `= ANY` recorre la tabla entera cuando las estadisticas aun no conocen al estudio» (`0052_reglas_historial_lote.sql:287-296`). Agrupar no siempre gana; el módulo [17](17-rendimiento.md) explica por qué las estadísticas cambian el plan.

**Lección:** «todo o nada» no obliga a «uno por uno». Un lote puede ser igual de estricto (un ítem inválido rechaza el lote entero) y mucho más barato.

## Práctica

**A. Ver qué filas mueve R-HIS** (desde la raíz, tras `pnpm --filter @contapp/shared build` y `pnpm --filter @contapp/domain build`):

```bash
cd packages/domain && node -e '
const d = require("./dist");
const m = (v) => d.MontosComprobante.desde("PEN", v);
const fila = (id, num, v) => ({ id, proveedor: { tipo: "6", numero: num }, comprobante: { tipo: "01", serie: "F001", numero: "1" }, montos: m(v) });
const filas = [
  fila("c1", "20100000001", { biDg: "100.00", igvDg: "18.00", total: "118.00" }),
  fila("c2", "20100000001", { biDng: "50.00", igvDng: "9.00", total: "59.00" }),
  fila("c3", "20100000001", { noGravado: "30.00", total: "30.00" }),
  fila("c4", "20999999999", { biDg: "10.00", igvDg: "1.80", total: "11.80" }),
];
const reglas = [{ id: "r1", proveedor: { tipo: "6", numero: "20100000001" }, destino: "DNG" }];
for (const p of d.planificarHistorial(filas, reglas, { rHisActiva: true }))
  console.log(p.filaId, p.reglaId, p.destino, "biDng", p.montos.obtener("biDng").toString(), "igvDng", p.montos.obtener("igvDng").toString(), "biDg", p.montos.obtener("biDg").toString(), "total", p.montos.total.toString());
console.log("R-HIS apagado:", d.planificarHistorial(filas, reglas, { rHisActiva: false }).length);
console.log(d.esRucAportable({ tipo: "6", numero: "20100000001" }), d.esRucAportable({ tipo: "6", numero: "10456789012" }));
console.log(d.CATALOGO_REGLAS_MOTOR.map((r) => r.codigo).join(" "));'
# c1 r1 DNG biDng 100.00 igvDng 18.00 biDg 0.00 total 118.00
# R-HIS apagado: 0
# true false
# R-ISC R-MIX R-RED R-NEW R-GP R-HIS
```

Solo se mueve `c1`. `c2` ya está en DNG, `c3` no tiene base gravada y `c4` es de otro proveedor.

**B. Correr las pruebas de R-HIS y del catálogo** (no necesitan BD):

```bash
pnpm --filter @contapp/domain test r-his catalogo ronda3-lote
#  Test Files  4 passed (4)
#       Tests  85 passed (85)
pnpm --filter @contapp/frontend test components/reglas
#  Test Files  4 passed (4)
#       Tests  41 passed (41)
```

**C. Ver aplicadas y aceptadas por regla** (con la app levantada y un periodo descargado; `psql` como `postgres`, que se salta RLS; solo lectura, **no se ejecutó al escribir este módulo**):

```sql
SELECT r.destino, r.activa, r.periodo_aprendido,
       count(a.id)                    AS aplicada,
       count(x.regla_aplicacion_id)   AS aceptada
FROM regla_aprendida r
LEFT JOIN regla_aplicacion a ON a.tenant_id = r.tenant_id AND a.regla_id = r.id
LEFT JOIN regla_aceptacion x ON x.regla_aplicacion_id = a.id
WHERE r.eliminada_en IS NULL
GROUP BY r.id ORDER BY aplicada DESC LIMIT 10;
```

## Impacto en ContApp

- El contador clasifica **una vez** a cada proveedor de cada cliente. En un estudio con decenas de clientes, son cientos de clics menos al mes.
- Nada se pierde: la versión 1 del SIRE queda intacta, la fila dice «Según historial» y se revierte como cualquier clasificación.
- Una regla mal aprendida no se propaga a otros clientes ni a otros estudios: la clave es cliente + proveedor y RLS separa estudios.
- El catálogo de 033 tendrá datos desde el primer día, sin haber expuesto nada de un estudio a otro.

## Errores comunes

- **«Recordé la regla y las compras de este mes no cambiaron.»** Es lo esperado (D-5, P-5): la regla se aplica a descargas de periodos posteriores. Para las filas de hoy, usa la masiva.
- **«Descargué otra vez el mismo periodo y no se aplicó.»** Las filas que ya existían no son nuevas (014 D-18): la función exige `xmin` de la transacción actual (CA-4).
- **«El aviso “Recordar” no aparece.»** Revisa que tengas `reglas.gestionar`, que la masiva sea de un solo proveedor y que no exista ya una regla activa con ese destino.
- **«Me sale 409 `regla_cambiada`.»** Otra persona cambió la regla después de que la pantalla la leyó. Recarga y vuelve a intentar.
- **«Quiero darle al worker `UPDATE` sobre `compra` para que sea más simple.»** No: el diseño mantiene al worker sin ese permiso (0038, D-6). La escritura pasa por la función acotada que recalcula y falla cerrado.

## Ejercicios

1. ¿Por qué R-HIS no se guarda como un hallazgo en `compra_hallazgo`, como R-ISC o R-MIX?
2. El worker manda a `aplicar_regla_historial` unos montos con el IGV redondeado distinto. ¿Qué pasa con la descarga?
3. ¿Por qué `regla_aprendida` tiene un índice único **parcial** y no uno normal?
4. Un proveedor con RUC 10456789012 se «recuerda» en un estudio con el aporte encendido. ¿Qué filas quedan en `regla_confirmacion`?
5. En H-021-1-5, ¿por qué no bastaba con mirar la versión vigente para decidir si una fila fue aceptada?

<details><summary>Soluciones</summary>

1. Porque R-HIS no sugiere: se aplica sola y solo en la descarga (D-1, plan «R-HIS fuera de la lista de hallazgos»). Así no cambian el CHECK de reglas ni las pantallas de hallazgos, y una fila corregida no vuelve a recibir la sugerencia (P-3).
2. La función recalcula la consolidación en `NUMERIC`, no coincide y lanza 42501 «aplicacion rechazada». La transacción de la descarga queda abortada: falla cerrado, nunca escribe montos que la BD no comprobó (D-6, CA-10).
3. Porque eliminar es una baja lógica (`eliminada_en`, P-9). Con un índice normal, la regla eliminada seguiría ocupando la clave y no se podría crear otra para el mismo proveedor. El parcial solo exige unicidad entre las vivas.
4. Ninguna: solo aportan proveedores con documento tipo 6 y número que empieza en 20 (P-10, `SQL_CONFIRMAR` y `esRucAportable`). La regla sí se crea y se aplica.
5. Porque dos caminos dejan la misma vigente: la regla aplicó DNG, o la regla aplicó DG, se editó a DNG y el contador movió la fila a mano. Solo el primero es una aceptación de la regla. Por eso 0050 exige que también la versión `historial` esté en el destino actual (P-1).

</details>

## Para profundizar

- Specs del proyecto: [021 spec](../specs/021-reglas-aprendidas/spec.md), con su `plan.md` (contratos, orden de bloqueo, desvíos ratificados) y `tasks.md` (T25b y T25c cuentan la medición y el lote).
- `docs/specs/ESTADO.md`: fila de 021 y hallazgos H-021-1-1 a H-T25-2.
- Columnas del sistema (`xmin`) en PostgreSQL: <https://www.postgresql.org/docs/17/ddl-system-columns.html>
- Índices parciales: <https://www.postgresql.org/docs/17/indexes-partial.html>
- Funciones `SECURITY DEFINER` y su `search_path`: <https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY>
