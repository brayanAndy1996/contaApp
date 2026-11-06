# Plan 013 · Ventas (RVIE): descarga, importación, grilla y correlatividad

Referencias: `spec.md` (D = decisiones, CA = criterios). Nivel B con una ronda adversarial acotada a correlatividad e importación (P-11). Los nombres de columnas en BD van en `snake_case`; los DTO, en `camelCase`.

## Archivos
Migraciones 0028 a 0031 (la última aplicada es la 0027; confirmar con `ls packages/db/migrations` antes de crear). Una por tabla, con RLS `ENABLE`/`FORCE`, `tenant_id`, uuid v7 y FK compuesta `(tenant_id, cliente_id) → cliente(tenant_id, id)`.
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/db/migrations/{0028_propuesta,0029_propuesta_diferencia,0030_venta,0031_venta_salto_justificado}.sql` · `packages/db/src/schema/{propuestas,ventas}.ts` | tablas y grants (D1, D4, D8, D15) |
| crear | `packages/db/src/propuestas/*` · `packages/db/src/ventas/*` · modificar `packages/db/src/index.ts` | repositorios: bloqueo advisory, encabezado, diferencias, lectura filtrada, resumen, justificados |
| crear | `packages/domain/src/clave-comprobante/*` | `claveNormalizada` (D17) |
| crear | `packages/domain/src/correlatividad/*` | `analizarCorrelatividad` (D7, D8) |
| crear | `packages/domain/src/complemento/*` | `planificarComplemento` genérico por libro (D16), sin montos ni IO; 014 lo reutiliza |
| crear | `packages/domain/src/ventas/*` | tipos de montos de venta, `resumirVentas` (D11), layout de importación provisional y `validarFilaVenta` (D3, D6, D14b) |
| crear · modificar | `packages/domain/src/formatos/provisional-rve.ts` · `tipos.ts` · `registro.ts` | formato RVIE provisional; `Libro` + `"ventas"`; rechazo de `tipo: "ruc"` fuera del documento (D13) |
| modificar | `eslint.config.mjs` | ampliar la regla contra `number` a `correlatividad/`, `ventas/`, `complemento/`, `clave-comprobante/` (conteos y números de comprobante con `Entero` de `texto/`, que queda fuera de la regla) |
| modificar | `packages/sunat/src/{puertos,index}.ts` · `mock/sire-api-client.mock.ts` · `fixtures/sire/*ventas*.json` · `fixtures/LEEME.md` | `FilaVentaSire`, `PropuestaSire` como unión por `libro`, fixtures de ventas (D12) |
| modificar | `packages/queue/src/{catalogo,index}.ts` | registrar `sire.propuesta.descargar` con `libro` = compras\|ventas (D2) |
| crear | `packages/shared/src/ventas/*` | zod y DTOs: descarga, filtros, fila, página, resumen, correlatividad, justificar, agregar, vista previa e informe de importación, propuestas y diferencias |
| crear | `apps/worker/src/trabajos/procesadores/descargar-propuesta.ts` · `apps/worker/src/trabajos/persistidores/{tipos,index,ventas}.ts` · modificar `trabajos.module.ts`, `iniciar.ts` | procesador común y persistidor de ventas (D2, D3, D16) |
| crear | `apps/backend/src/modules/ventas/*` | rutas de lectura, descarga (encolar), justificar, agregar, quitar, propuestas e importación |
| crear | `apps/frontend/app/(app)/clientes/[clienteId]/ventas/{page.tsx,importar/page.tsx}` · `apps/frontend/components/ventas/*` · `apps/frontend/lib/ventas.ts` · `apps/frontend/pruebas/ventas.ts` | pantalla D14 (solo `@contapp/shared`) |
| crear | `tests/aislamiento/{propuesta,venta}*.spec.ts` · `packages/domain/src/correlatividad/boleta-291.spec.ts` | RLS, inmutabilidad, carreras y el caso real |

## Contratos
Tablas (todas con `tenant_id`; montos `NUMERIC(14,2)`; el tipo de cambio con la escala de `TipoCambio` de 010):
- `propuesta`: `id, cliente_id, periodo char(6), libro ('compras'|'ventas'), fuente ('api'|'importacion'), hash char(64), filas_recibidas, filas_nuevas, filas_iguales, filas_distintas, usuario_id, trabajo_id null, creada_en`; única `(tenant_id, id)` para FK compuestas de `venta` y de `compra`. `CHECK` recibidas = nuevas + iguales + distintas y recibidas ≤ 20.000. Grants `SELECT`/`INSERT`.
- `propuesta_diferencia`: `id, propuesta_id, clave, tipo, serie, numero, origen_existente ('sire'|'manual'), campos text[] (no vacío), valores_sire jsonb (solo cadenas)`. Grants `SELECT`/`INSERT`.
- `venta`: `id, cliente_id, periodo, propuesta_id null (null si y solo si origen = manual), origen ('sire'|'manual'), clave, tipo char(2), serie varchar(4), numero varchar(20), numero_n null (entero si tiene 1 a 8 dígitos), fecha, tipo_doc_contraparte, doc_contraparte, moneda ('PEN'|'USD'), tipo_cambio null, base_gravada, igv, exonerada, inafecta, isc, icbper, otros, total, creada_por null, creada_en`. Única `(tenant_id, cliente_id, periodo, clave)`. Trigger `BEFORE UPDATE OR DELETE`: rechaza todo `UPDATE` y todo `DELETE` salvo el de filas `manual`. Índice de lectura `(cliente_id, periodo, tipo, serie, numero_n)`.
- `venta_salto_justificado`: `id, cliente_id, periodo, tipo, serie, desde, hasta (enteros 1–8 dígitos, desde ≤ hasta), comentario (1–500), usuario_id, creada_en, revertido_por null, revertido_en null`. Única parcial `(cliente_id, periodo, tipo, serie, desde, hasta) WHERE revertido_en IS NULL`. Grants `SELECT`/`INSERT`/`UPDATE` (solo columnas `revertido_*`).

Dominio (funciones puras, sin IO):
- `claveNormalizada(tipo, serie, numero): string`.
- `analizarCorrelatividad(filas: {tipo, serie, numero}[], justificados: {tipo, serie, desde, hasta, comentario}[]): { series: { tipo, serie, estado: 'completa'|'con_faltantes'|'no_evaluable', faltantes: { desde, hasta, estado: 'pendiente'|'justificado'|'parcial', comentario? }[], noEvaluables }[] }`. Sin bandera de bloqueo.
- `resumirVentas(filas): { porTipo: { tipo, cantidad, ...columnas, igv, total }[], total, sinConvertir: { clave, moneda }[], avisos: ('usd_sin_tipo_cambio')[] }` (montos como cadenas, calculados con `Money`).
- `planificarComplemento(existentes: { clave, origen, campos: Record<string,string> }[], recibidas: { clave, campos: Record<string,string> }[]): { nuevas: clave[], iguales: number, distintas: { clave, origenExistente, campos: string[], valoresSire: Record<string,string> }[] }` — genérica: cada persistidor decide qué campos comparar (ventas: fecha, moneda, tipo de cambio, documento y los 8 montos; no la razón social).
- `LAYOUT_VENTAS_PROVISIONAL: { id, version: '0-provisional', oficial: false, columnas }` y `validarFilaVenta(cruda): FilaVentaValidada | ErroresFila`.

Puertos (`packages/sunat/src/puertos.ts`): `FilaVentaSire { tipo, serie, numero, tipoDocContraparte?, docContraparte, fechaEmision, moneda, tipoCambio?, baseGravada, igv, exonerada, inafecta, isc, icbper, otros, total }` y `PropuestaSire = PropuestaComprasSire | PropuestaVentasSire` (unión por `libro`). `FilaPropuestaSire` no cambia.

Persistidor común (worker): `PersistidorLibro { leerExistentes(tx, ctx): Promise<Existente[]>; insertar(tx, ctx, propuestaId, nuevas): Promise<void> }` y el registro `persistidores: Partial<Record<LibroSire, PersistidorLibro>>`. El procesador: token y descarga fuera de la transacción → validar y tope → una `withTenant`: bloqueo advisory `(cliente, periodo, libro)` → `leerExistentes` → `planificarComplemento` → `propuesta` → `propuesta_diferencia` → `insertar`; devuelve como `resultado` del trabajo `{ propuestaId, recibidas, nuevas, iguales, distintas, claves (≤ 40), truncado }` (≤ 4 KB). Libro sin persistidor: `ErrorDatos libro_no_soportado`. 014 agrega `persistidores/compras.ts` y una línea en `persistidores/index.ts`; su `persistirDescarga` se parte en esas dos operaciones (la comparación y el informe viven en común).

Cola: tipo `sire.propuesta.descargar`, parámetros `{ periodo: AAAAMM, libro }`.

Rutas (todas bajo `/clientes/:clienteId/periodos/:periodo/ventas`; `ClienteScopeGuard`; archivado → 409 en toda escritura):
| Método y ruta | Permiso | Resultado |
|---|---|---|
| `POST /descargar` | `sire.descargar` | 202 `{ trabajoId }` |
| `GET /` (`pagina, tamano, q, tipo, serie, min, max`) | `clientes.ver` | página + `total` + `avisos` (`todas_limitada`) |
| `GET /resumen` · `GET /correlatividad` | `clientes.ver` | D11 · D7 |
| `GET /propuestas` · `GET /propuestas/:propuestaId/diferencias` | `clientes.ver` | historial con contadores · diferencias |
| `POST /` (agregar) · `DELETE /:ventaId` (solo `manual`) | `sire.clasificar` | 201 / 204; 400 descuadre, 409 `duplicado` |
| `POST /saltos-justificados` · `DELETE /saltos-justificados/:id` | `sire.clasificar` | 201 / 204 (revierte) |
| `POST /importar/vista-previa` · `POST /importar/confirmar` | `sire.descargar` | informe por fila · 201 con la `propuesta`; 422 `layout_no_oficial`, 413 tamaño, 422 `propuesta_demasiado_grande` |

## Decisiones
- Sin cabecera común de comprobante: `compra` y `venta` son autónomas y solo comparten `propuesta`, `claveNormalizada` y `planificarComplemento` — 014 no queda obligada a un modelo que no usa.
- Persistidor por libro y encabezado con contadores calculados antes de insertarlo — así `propuesta` no se actualiza nunca y 014 no toca nada común.
- El complemento se serializa con un bloqueo advisory por (cliente, periodo, libro) y la clave única es la red de seguridad — dos descargas simultáneas no dan `40P01` ni duplicados (D16).
- Cada tabla va en su migración y solo las columnas `revertido_*` admiten `UPDATE` — mínimo privilegio y trazabilidad hasta 017.
- Resumen y correlatividad se calculan con las filas del periodo en memoria (tope 20.000) con funciones puras — una sola implementación, probada sin BD.
- `PropuestaSire` pasa a unión por `libro` y `FilaPropuestaSire` no cambia — 014 no se rompe.
- El layout de importación vive en `packages/domain` y el lector de archivos es el de 007b — el parser no se reescribe; el bloqueo por `NODE_ENV` lo decide el servicio, nunca la petición.
- Nada de `number` para dinero: el frontend solo muestra cadenas del servidor y no suma.
- Orden de bloqueo en una escritura: advisory del periodo → `cliente` (lectura de archivado) → filas; nunca al revés.

## Riesgos
- Un salto enorme o un número no numérico rompe el análisis → rangos sin expandir, `Entero` y pruebas con 99 999 999 y valores raros (CA-6, adversario).
- Un archivo de importación malicioso (fórmulas, zip bomb, XXE, miles de filas) → se reutiliza el lector de 007b, tope de 20.000 y ataques de T17.
- Contradicción entre el complemento y la inmutabilidad → solo `INSERT`; las diferencias se informan, nunca se aplican.
- Cambio de tipo en `PropuestaSire` rompe compilación de compras o de los fixtures de 009/012 → T4 y T10 corren `typecheck` de `sunat`, `worker` y `domain`.
- La forma de `PersistidorLibro` difiere de la que 014 pidió (`persistir(...)` que devuelve `{ agregadas, existentes, difieren }`): aquí la comparación es común y queda en `propuesta_diferencia`, que responde su pregunta Q-1; T4 de 014 lo reconcilia al rebasar.
- 014 desarrollándose en paralelo toca `puertos.ts` y `catalogo.ts` → 013 se mergea primero; 014 rebasa y solo agrega campos opcionales y su persistidor.
- La regla `tipo: "ruc"` de D13 toca `registro.ts` (nivel A) → pruebas del tester y las suites de 012 completas en verde.
