# 17 · Rendimiento: lo que crece con el volumen

> Módulo anterior: [16-reglas-aprendidas.md](16-reglas-aprendidas.md) · Siguiente: [18-diseno-visual.md](18-diseno-visual.md) · Índice: [00-indice.md](00-indice.md)
>
> Cubre la spec **022** (rendimiento de R1 antes de buzones) y la corrección posterior de la migración 0053. Conviene haber leído [02](02-postgresql.md), [04](04-redis.md), [05](05-bullmq-y-la-cola.md) y [12](12-compras.md).

## Lo que aprenderás

- Por qué algo que tarda 30 ms con 100 filas puede tardar 60 s con 20.000, y cómo medirlo antes de cambiar código.
- Qué es el patrón **N+1** y cómo aparece en ContApp (en Redis, en SQL y en la descarga de 021).
- Cómo leer un **plan de consulta** con `EXPLAIN`, qué hace `ANALYZE` y por qué un plan puede ser bueno hoy y malo mañana.
- Qué es un **índice parcial** y cómo la migración 0053 lo usó para quitar una opción mala al planificador.
- Los seis arreglos de 022: despachador por tramos, `join lateral`, venta por id, tope de avisos, Ctrl+Z de la masiva y archivo de 20.000 filas.

---

## 1. El problema: lo que no se nota con 50 filas

Con los datos de prueba de desarrollo todo es rápido. Pero la spec 023 (buzones) va a encolar cientos de RUCs por estudio, y un estudio grande tiene clientes con miles de compras al mes. La spec 022 buscó, **antes** de 023, todo lo que crece peor que el volumen.

Es como cerrar el mes de un cliente con 20 facturas o con 20.000. Si tu método es «por cada factura, revisar todas las demás», con 20 haces 400 comparaciones; con 20.000, 400 millones. El método no cambió, el volumen sí.

La regla de la spec fue estricta: **no se sube ningún límite de tiempo existente** (se pueden bajar). Y el primer criterio, CA-1, obligó a medir antes de tocar código.

### Medir primero

La tabla «Línea base (CA-1)» de `docs/specs/022-rendimiento/plan.md` registra la mediana de 3 mediciones de cada punto (RP-1 a RP-6) en el volumen de la spec. Dos ejemplos:

| Punto | Volumen | Antes | Después |
|---|---|---|---|
| RP-1 · atención del despachador | 20.000 pistas | 3.279 ms | ~20 ms (ESTADO) |
| RP-2 · `leerExistentesCompras` sin `ANALYZE` | 20.000 compras | 67.855 ms (mediana) | 0,1–0,3 s (ESTADO) |

Medir primero evita optimizar lo que no importa. En RP-5 (Ctrl+Z de la masiva) el reparto mostró que el servidor era el 56 % del tiempo y la recarga de filas el 31 %: se atacó eso y no el render.

## 2. El patrón N+1

**N+1** es hacer una consulta para traer una lista y después **una consulta más por cada elemento**. Con N = 10 no se nota; con N = 20.000 son 20.001 viajes.

En un estudio contable sería pedir al archivo la lista de facturas del mes y después bajar al archivo una vez por cada factura para ver su proveedor, en vez de pedir de una vez «facturas con su proveedor».

022 y 021 encontraron tres variantes:

| Dónde | Forma de N+1 | Arreglo |
|---|---|---|
| Despachador (RP-1) | `ZRANGE 0 -1` de toda la lista de pistas y un `leerTrabajo` por id | Leer solo un tramo de K = 100 |
| Excluir una venta (RP-3) | Leer **todo** el periodo para encontrar una venta | `leerFilaVenta` por id |
| Descarga con reglas (021, módulo 16) | Una llamada a `aplicar_regla_historial` por compra | Lotes de 500 (0052) |

## 3. RP-1: el despachador por tramos

El despachador (módulo 05) atiende a cada estudio con trabajos pendientes. Cuando un estudio se queda sin trabajos `en_cola`, `cerrarEstudioVacio` limpia sus «pistas» en Redis: ids que quedaron en la lista de pendientes aunque el trabajo ya se canceló o despachó (restos).

Antes, cada atención leía la lista **entera** y luego cada id en la BD. Con 20.000 restos, 3,3 s por atención, y el despachador atiende cada 500 ms. La solución fue una constante con nombre. `packages/queue/src/despachador.ts:47-53`:

```ts
/**
 * Ids de la lista de pistas que una atención lee (y, como mucho, borra y relee en BD) por estudio y ciclo (022 RP-1,
 * D-1). Acota el costo de un estudio con muchos restos; no tiene que ver con `VENTANA_CANDIDATOS`, que acota los
 * candidatos de la BD. K = 100 por la medida de T1 (con 500 una atención cuesta 2,6 × la de N = 100). Si la lista tiene
 * más, el cierre repone al estudio en `tenants` y el siguiente ciclo toma otro tramo.
 */
export const TRAMO_PISTAS = 100;
```

Y la lectura acotada, `despachador.ts:307-322`:

```ts
  /** Primeros `TRAMO_PISTAS` ids que la lista de pistas del estudio ya tenía antes de leer la BD (vacío si Redis falla). */
  private async pistasPrevias(
    cola: NombreCola,
    tenantId: string,
  ): Promise<string[]> {
    try {
      return await this.redis.zrange(
        this.k.pend(cola, tenantId),
        "0",
        String(TRAMO_PISTAS - 1),
      );
    } catch {
      registrarFallo("despachador: no se pudo leer la lista de pistas");
      return [];
    }
  }
```

El cierre no vacía todo de una vez: limpia un tramo y, si la lista no quedó vacía, vuelve a anotar al estudio (`despachador.ts:379-381`):

```ts
    await this.redis.srem(this.k.tenants(cola), tenantId);
    if ((await this.redis.zcard(pend)) > 0)
      await this.redis.sadd(this.k.tenants(cola), tenantId);
```

Así 20.000 restos se limpian en ≤ ⌈20.000 / 100⌉ + 1 = 201 ciclos (~100 s), cada uno corto, sin bloquear a otros estudios (P-1 = b). Es como conciliar un banco con 20.000 movimientos pendientes por lotes de 100 al día en vez de quedarse un día entero sin atender a nadie más.

**¿Por qué 100 y no 500?** El plan proponía 500. T1 midió: con K = 500 una atención costaba 83 ms, 2,6 veces la de N = 100, e incumplía CA-5 (≤ 1,5 ×). Solo K = 100 dejaba la razón cerca de 1,0 ×. La constante se eligió con datos, y el comentario dice por qué.

Lo delicado eran las garantías G1–G4 de `cerrarEstudioVacio` (spec 022): nunca borrar un id publicado después de la lectura, re-publicar un trabajo que volvió a `en_cola`, nunca dejar un trabajo en la lista con el estudio fuera de `tenants` y no entrar en un bucle de ciclos vacíos. La ronda adversarial encontró tres casos (H-022-1 a H-022-3), entre ellos un trabajo re-encolado con el mismo id entre dos lecturas que quedaba invisible hasta el reconciliador. Se corrigió releyendo cada id **después** del `ZREM` (`despachador.ts:324-343`, comentario completo).

## 4. RP-2: el `join lateral` y los planes de consulta

### Qué es un plan

Cuando le pides a PostgreSQL una consulta, no la ejecuta tal cual: el **planificador** elige una estrategia (qué índice usar, en qué orden unir tablas) según lo que **cree** que hay en cada tabla. `EXPLAIN` muestra esa estrategia; `EXPLAIN ANALYZE` además la ejecuta y muestra los tiempos reales.

Es como el auditor que, antes de empezar, decide si revisa por muestreo o factura por factura según cuántas facturas **cree** que hay. Si alguien le dijo «hay 3» y hay 20.000, elegirá «una por una contra todas» y tardará días.

Las estimaciones salen de las **estadísticas** de cada tabla (cuántas filas, cómo se reparten los valores). Las calcula `ANALYZE`, a mano o por *autovacuum* cada cierto tiempo. Una tabla recién cargada puede no tenerlas todavía.

### El defecto

`leerExistentesCompras` lee, en cada descarga, las compras del periodo con su **versión 1** (lo que trajo el SIRE) para comparar contra la propuesta nueva (014 D-18). La consulta original unía `compra` con `compra_version` con un join plano. El oráculo que conserva la prueba, `tests/aislamiento/compras-existentes-022.spec.ts:37`:

```sql
  from compra c join compra_version v on v.tenant_id = c.tenant_id and v.compra_id = c.id and v.n = 1
```

T1 midió (plan, «Perfilado»): con tablas recién cargadas **sin** estadísticas, el planificador elegía un `Nested Loop` que recorría un índice de versiones una vez por fila: O(n²). 5.000 compras, 2,7 s; 20.000, 68 s (25 veces más con 4 veces más filas). Cuando autovacuum calculaba las estadísticas, la misma consulta bajaba a 134 ms.

### El arreglo

`packages/db/src/compras/existentes.ts:12-20`:

```ts
const SQL_EXISTENTES = `select c.clave, c.origen, to_char(c.fecha, 'YYYY-MM-DD') as fecha, c.moneda,
    coalesce(c.tipo_cambio::text, '') as tipo_cambio, c.doc_tipo, c.doc_numero,
    v.bi_dg::text as bi_dg, v.igv_dg::text as igv_dg, v.bi_dgng::text as bi_dgng, v.igv_dgng::text as igv_dgng,
    v.bi_dng::text as bi_dng, v.igv_dng::text as igv_dng, v.no_gravado::text as no_gravado, v.isc::text as isc,
    v.icbper::text as icbper, v.otros_tributos::text as otros_tributos, v.total::text as total
  from compra c
  join lateral (select * from compra_version v where v.tenant_id = c.tenant_id and v.compra_id = c.id and v.n = 1 offset 0) v on true
  where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null
  order by c.clave, c.id`;
```

`join lateral` dice «por cada compra, busca **su** versión 1». El `offset 0` es un truco conocido de PostgreSQL: impide que el planificador «aplane» la subconsulta y la vuelva a convertir en el join que elegía mal. Es el mismo patrón que ya usaban `leerFilasReemplazo` y `bloquearCompras` (012b).

La equivalencia se probó contra el oráculo (CA-6): mismo orden, mismos campos, siempre la versión 1, sobre un periodo con SIRE, agregadas, excluidas, descartadas, varias versiones y USD. Una consulta más rápida que devuelve otra cosa no es una mejora.

## 5. El plan malo intermitente y el índice parcial (0053)

Ya con el `join lateral`, el CI falló **a veces**: la primera lectura de 20.000 compras tardó 32,4 s (CI run 43948801592), y en las mediciones de T5 una de 40 corridas tardó 42 s (`compras-existentes-022r.spec.ts:1`). El resto, menos de 1 s.

Un fallo intermitente de tiempo casi siempre es un **plan que cambia**. La causa (comentario de `tests/aislamiento/compras-existentes-022r.spec.ts:1-7`):

1. Un `ANALYZE` (o autovacuum) que ve `compra_version` **sin filas vivas** deja `reltuples = 0`: «esta tabla está vacía».
2. Llega una descarga grande sin un `ANALYZE` nuevo. El planificador estima **1 fila** por estudio.
3. Para buscar la versión de cada compra había dos índices posibles que, con esa estimación, parecían igual de buenos: la única `(tenant_id, compra_id, n)` y `compra_version_operacion_idx (tenant_id, operacion_id)`. A veces elegía el segundo, que trae **todas** las versiones del estudio en cada vuelta: O(n²) otra vez.

Los dos índices venían de la migración 0032. `packages/db/migrations/0032_compra.sql:77`:

```sql
	CONSTRAINT "compra_version_compra_n_unique" UNIQUE("tenant_id","compra_id","n"),
```

Y `0032_compra.sql:94`:

```sql
CREATE INDEX "compra_version_operacion_idx" ON "compra_version" USING btree ("tenant_id","operacion_id");
```

### Un índice parcial

Un **índice parcial** solo incluye las filas que cumplen una condición. Es como un archivador que solo guarda las facturas con nota de crédito: más pequeño, y nadie lo abre para buscar una factura cualquiera.

`packages/db/migrations/0053_compra_version_operacion_parcial.sql:9-10`:

```sql
DROP INDEX IF EXISTS "compra_version_operacion_idx";--> statement-breakpoint
CREATE INDEX "compra_version_operacion_idx" ON "compra_version" USING btree ("tenant_id","operacion_id") WHERE "compra_version"."operacion_id" is not null;
```

Los usos legítimos del índice (deshacer y rehacer una operación, auditoría, la FK hacia `compra_operacion`) siempre filtran `operacion_id = …`, que implica `is not null`: lo siguen usando. La búsqueda de la versión de cada compra **no** filtra por `operacion_id`, así que el planificador ya no puede elegirlo, con o sin estadísticas. No se «convenció» al planificador: se le quitó la opción mala.

La prueba nueva (`compras-existentes-022r.spec.ts`, R-2) reproduce exactamente esas estadísticas (carga, borrado, `ANALYZE` con 0 filas vivas, carga de 20.000 sin `ANALYZE`) y exige la primera lectura ≤ 1,0 s. Antes de 0053, ~29 s.

> **Corrección de 022 hecha en la rama de 021.** El defecto apareció después del merge de 022; la migración 0053 se hizo en la rama de 021, por eso 021 usa 0047–0052 y 0053 es de 022 (ESTADO, «Migraciones»).

## 6. RP-3 a RP-6

**RP-3 · Una venta por id.** Excluir o restaurar una venta leía el periodo completo para encontrar una (`leerFilasVentas`). Ahora `leerFilaVenta` (`packages/db/src/ventas/lectura.ts:169`) usa las mismas columnas con `where cliente_id = $1 and periodo = $2 and id = $3` (`lectura.ts:84-85`). Con 5.000 ventas la llamada tardaba 45 ms frente a 17 ms con 100: cumplía el p95, pero crecía con el periodo (CA-9 pedía mediana ≤ 2 × la de 100).

**RP-4 · Tope de avisos.** El previo del archivo (módulo 10) ya cortaba `errores[]` y `excluidas[]` en 1.000. `avisos[]` no: con 5.000 avisos la respuesta pesaba 494.981 bytes. `apps/backend/src/modules/archivos/previo.ts:255-258`:

```ts
    errores: resultado.errores.slice(0, MAX_ITEMS_PREVIO).map((x) => aErrorDto(x, filas.excluible(x.filaId), filas.comprobanteDe)),
    erroresOmitidos: Math.max(0, resultado.errores.length - MAX_ITEMS_PREVIO),
    avisos: avisos.slice(0, MAX_ITEMS_PREVIO).map((a) => aAvisoDto(a, filas.comprobanteDe)),
    avisosOmitidos: Math.max(0, avisos.length - MAX_ITEMS_PREVIO),
```

El esquema de `packages/shared` lo exige (`packages/shared/src/archivos/respuestas.ts:66-67`):

```ts
  avisos: z.array(avisoPrevioSchema).max(MAX_ITEMS_PREVIO),
  avisosOmitidos: entero,
```

Y la pantalla dice cuántos faltan (`apps/frontend/lib/archivos.ts:67-68`):

```ts
  avisosOmitidos: (n: number) =>
    n === 1 ? "Y 1 aviso más que no se muestra." : `Y ${n} avisos más que no se muestran.`,
```

Solo se corta lo que viaja a la pantalla; `generar` usa la lista completa, así que el TXT, el ZIP y su SHA-256 no cambian (CA-11).

**RP-5 · Ctrl+Z de la masiva.** Deshacer una masiva de 4.850 filas tardaba 1,83 s. El reparto (T1): servidor 1.031 ms, recarga 576 ms (5 `GET` de 1.000 filas, uno tras otro) y ~214 ms de pantalla. En el servidor, T9 dejó de pedir `RETURNING` que nadie leía y solapó la evaluación con las escrituras (`escribirVersiones`, `packages/db/src/compras/repositorio.ts:449`). En el frontend, la recarga pide bloques del máximo que admite el servidor. `apps/frontend/lib/filas-compras.ts:164-176` (fragmento):

```ts
  /**
   * Vuelve a pedir el listado completo con los filtros vigentes y lo cambia de una vez (sin vaciar la grilla).
   * Pide bloques del máximo que admite el servidor (`limite` ≤ 5.000, spec 022 RP-5): como el cursor es opaco no se
   * pueden pedir bloques a la vez, así que se reduce el número de viajes (una masiva de 4.850 filas, 1 en vez de 5).
   */
  const recargarListado = useCallback(async () => {
    // …
      const r = await cargarPeriodo(clienteId, periodo, filtrosActuales.current, {
        senal: new AbortController().signal,
        tamanoBloque: TOPE_SELECCION,
```

Resultado medido en E-06 sin carga (T13): mediana 1.365 ms; ESTADO resume 1,83 → 1,37 s. La meta inicial era ≤ 1,0 s; bajar más exigía cambiar el esquema, y el usuario aceptó ~1,5 s (P-3 revisada). El tope de E-06 **bajó** de 10 s a 3 s.

**RP-6 · Archivo de 20.000 filas.** El perfil mostró que el costo era aritmética `decimal.js`: solo `esMontosReal`, que comprobaba la clase real de los montos con una suma por fila, pesaba ~0,6 s. Se bajó de ~3,1 s a ~2,4 s sin tocar el límite de 5 s (P-4 revisada).

## 7. Medir bien: BD nueva o `ANALYZE`

Una lección se repite en 021 y 022: **una prueba de tiempo sobre una BD reutilizada miente**. Sin estadísticas recientes, `deshacer-masivo-022` midió 10,8 s frente a 1,2 s (ESTADO, nota [pruebas]). Por eso:

- Las pruebas de tiempo miden en **BD nueva** o tras `ANALYZE` de las tablas usadas, **fuera** del tiempo medido.
- Salvo cuando la prueba busca justamente el caso sin estadísticas (CA-7 y 0053): ahí se mide la **primera** lectura tras la carga, porque la mediana de 3 la esconde.
- Con mediana de ≥ 3 muestras, sin `retry` y sin comparar tiempos bajo cobertura (regla de 020 P-4, módulo 15).

## Práctica

**A. Comprobar CA-2 con grep** (ningún `zrange` con `"0", "-1"` en el despachador):

```bash
grep -n 'zrange\|"-1"' packages/queue/src/despachador.ts
# 313:      return await this.redis.zrange(
```

Una sola llamada, la de `pistasPrevias`, con el tramo acotado.

**B. El contrato del tope de avisos** (tras `pnpm --filter @contapp/shared build`):

```bash
cd packages/shared && node -e '
const s = require("./dist");
const campo = s.previoArchivoSchema.shape.avisosOmitidos;
console.log("MAX_ITEMS_PREVIO =", s.MAX_ITEMS_PREVIO);
console.log("4000 ->", campo.safeParse(4000).success, "| -1 ->", campo.safeParse(-1).success, "| 1.5 ->", campo.safeParse(1.5).success);
const avisos = s.previoArchivoSchema.shape.avisos;
console.log("1001 avisos ->", avisos.safeParse(Array(1001).fill({})).success);'
# MAX_ITEMS_PREVIO = 1000
# 4000 -> true | -1 -> false | 1.5 -> false
# 1001 avisos -> false
```

**C. Pruebas que no necesitan BD ni Redis:**

```bash
pnpm --filter @contapp/queue test despachador.spec        # Tests  34 passed (34)
pnpm --filter @contapp/shared test previo                 # Test Files  2 passed (2) · Tests  29 passed (29)
pnpm --filter @contapp/frontend test avisos-omitidos      # Tests  3 passed (3)
```

Las de tiempo y equivalencia (`despachador-022.int.spec.ts`, `compras-existentes-022.spec.ts`, `compras-existentes-022r.spec.ts`) necesitan PostgreSQL y Redis: corren en `pnpm ci:db`.

**D. Mirar un plan** (con la app levantada y un periodo descargado; `psql` como `postgres`; **no se ejecutó al escribir este módulo**). `EXPLAIN` sin `ANALYZE` no ejecuta la consulta, solo muestra el plan:

```sql
-- ¿Qué cree PostgreSQL que hay en cada tabla?
SELECT relname, reltuples, relpages FROM pg_class WHERE relname IN ('compra', 'compra_version');

-- El plan de la búsqueda de versiones (cambia el uuid y el periodo por uno tuyo)
EXPLAIN
SELECT c.clave, v.total
FROM compra c
JOIN LATERAL (SELECT * FROM compra_version v
              WHERE v.tenant_id = c.tenant_id AND v.compra_id = c.id AND v.n = 1 OFFSET 0) v ON true
WHERE c.cliente_id = '<uuid-del-cliente>' AND c.periodo = '202610' AND c.descartada_en IS NULL;
```

Busca en la salida qué índice usa la búsqueda de versiones: debería ser `compra_version_compra_n_unique`, nunca `compra_version_operacion_idx`. Si `reltuples` es 0 en una tabla con datos, faltan estadísticas.

## Impacto en ContApp

- 023 (buzones) puede encolar cientos de RUCs por estudio sin que el despachador se vuelva más lento con cada resto.
- Una descarga repetida de un periodo grande no tarda un minuto por un plan malo, ni hoy ni el día que autovacuum calcule estadísticas a destiempo.
- El previo de un periodo con miles de avisos sigue siendo una respuesta pequeña, y el archivo generado es idéntico al de antes.
- Cada número de la spec tiene una prueba que vigila la regresión, y ningún límite subió.

## Errores comunes

- **«La prueba de tiempo pasa en mi máquina y falla en el CI.»** Revisa si mides en una BD reutilizada o sin estadísticas. Mide en BD nueva o tras `ANALYZE` fuera del tiempo medido; si el caso es justamente sin estadísticas, mide la primera lectura.
- **«Subo el límite de 1 s a 2 s y listo.»** No: la regla de 022 (CA-14) prohíbe subir límites. Un límite que falla es un defecto de rendimiento o de medición.
- **«Agrego `ANALYZE` dentro de la descarga para que el plan sea bueno.»** Arregla un síntoma y cuesta tiempo en cada descarga. 0053 eligió quitar la opción mala para que el plan sea bueno **con o sin** estadísticas.
- **«Borro el `offset 0`, parece que no hace nada.»** Hace: impide que el planificador aplane el lateral y vuelva al join que elegía mal.
- **«Subo `TRAMO_PISTAS` a 1.000 para limpiar más rápido.»** Cada atención se vuelve más cara y se incumple CA-5. K se cambia solo con una medición nueva, como dice su comentario.

## Ejercicios

1. ¿Por qué el arreglo del despachador no lee la lista completa en tramos dentro de un mismo ciclo, hasta vaciarla?
2. Una consulta tarda 134 ms casi siempre y 30 s una vez de cada 40. ¿Qué sospechas primero y cómo lo confirmas?
3. ¿Por qué el índice parcial de 0053 no rompe el deshacer de una operación masiva?
4. En RP-4, ¿por qué se puede cortar `avisos[]` a 1.000 sin que cambie el archivo generado?
5. Da un ejemplo de N+1 de 021 o 022 y explica cómo se quitó.

<details><summary>Soluciones</summary>

1. Porque esa atención volvería a costar lo mismo que antes con N grande (P-1 = a, descartada). Con P-1 = b cada ciclo limpia un tramo de K y vuelve a anotar al estudio: cada atención es corta (≤ 100 ms) y los demás estudios siguen siendo atendidos. Limpiar 20.000 restos tarda ~100 s, y se aceptó.
2. Un plan que cambia según las estadísticas. Se confirma mirando `reltuples` en `pg_class` y el plan con `EXPLAIN` en el caso lento (como hizo `compras-existentes-022r.spec.ts`, que reproduce `reltuples = 0` y una carga grande sin `ANALYZE`).
3. Porque el deshacer filtra `operacion_id = …`, que implica `operacion_id is not null`: la condición del índice parcial se cumple y el planificador lo sigue usando. Solo lo pierden las consultas que no filtran por operación.
4. Porque solo se corta el DTO que viaja a la pantalla; `generar` prevalida con la lista completa y el TXT, el ZIP y su SHA-256 salen idénticos (CA-11, D-5).
5. Por ejemplo, la descarga con reglas de 021: una llamada a `aplicar_regla_historial` por compra (5.000 viajes). Se pasó a `aplicar_reglas_historial` por lotes de 500 con las mismas validaciones (0052): de 6,6 × a ~1,7 × la descarga sin reglas. O RP-3: leer el periodo entero para encontrar una venta, cambiado por `leerFilaVenta` por id.

</details>

## Para profundizar

- Specs del proyecto: [022 spec](../specs/022-rendimiento/spec.md), con su `plan.md` (línea base, perfilado y desvíos ratificados) y `tasks.md`.
- `docs/specs/ESTADO.md`: fila de 022, hallazgos H-022-1 a H-022-3 y el del plan malo intermitente (0053).
- Usar `EXPLAIN`: <https://www.postgresql.org/docs/17/using-explain.html>
- Estadísticas del planificador: <https://www.postgresql.org/docs/17/planner-stats.html>
- `ANALYZE` y autovacuum: <https://www.postgresql.org/docs/17/routine-vacuuming.html#VACUUM-FOR-STATISTICS>
- Índices parciales: <https://www.postgresql.org/docs/17/indexes-partial.html>
- Subconsultas `LATERAL`: <https://www.postgresql.org/docs/17/queries-table-expressions.html#QUERIES-LATERAL>
- `ZRANGE` en Redis: <https://redis.io/docs/latest/commands/zrange/>
