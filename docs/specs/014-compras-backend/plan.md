# Plan 014 · Compras (backend)

## Archivos
Migraciones: 013 usa 0028 a 0031; 014 usa **0032** (`compras`) y **0033** (`compras_periodo_hallazgo`). La tarea confirma con `ls packages/db/migrations` y con el diario de drizzle ya mergeado de 013, y nunca edita una migración aplicada. Rama `spec/014-compras-backend` desde `main`; al mergear 013 se hace `git merge main` antes de las tareas marcadas «espera 013».
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/domain/src/compras/{clave,identidad,edicion,resumen,fila-reemplazo,bloqueo,masivas}.ts` y `index.ts` · modificar `packages/domain/src/index.ts` | Dominio puro D-1, D-5, D-8, D-9, D-10, D-15 |
| modificar | `eslint.config.mjs` | Ampliar la regla contra `number` y la de «sin IO» a `compras/` (CA-16) |
| crear | `packages/shared/src/compras/*` · modificar `packages/shared/src/index.ts` | zod y DTOs: acciones, masivas, filtros, cursor, informes, resumen, estado |
| modificar | `packages/sunat/src/puertos.ts` · `mock/sire-api-client.mock.ts` · `fixtures/sire/*` · `fixtures/LEEME.md` | `FilaPropuestaSire` ampliada (opcionales) y fixtures sintéticos (F001-4062 USD, volumen 5.000) |
| crear | `packages/db/migrations/0032_compras.sql`, `0033_compras_periodo_hallazgo.sql` · `packages/db/src/schema/compras.ts` | Tablas, RLS forzada, grants, trigger de identidad, índices |
| crear | `packages/db/src/compras/{repositorio,versiones,operaciones,periodo,evaluacion,persistidor,filas-reemplazo}.ts` · modificar `packages/db/src/index.ts` | Acceso a datos, CAS, masivas, deshacer/rehacer, estado, persistidor de la descarga, entrega a 012b |
| crear/modificar | registro de persistidores de 013 (ruta exacta en T4) · `apps/worker/src/trabajos/procesadores/` | Persistidor de compras y su registro |
| crear | `apps/backend/src/modules/compras/{compras.module,compras.controller,compras-acciones.controller,compras.service,acciones.service,masivas.service,historial.service,periodo.service,exportar.service}.ts` · modificar `app.module.ts` | Rutas del contrato |
| modificar | `apps/backend/src/modules/importacion/plantilla.ts` (o extraer `escritor-xlsx.ts`) | Reutilizar el escritor xlsx en memoria para exportar (D-17) |
| crear | pruebas: `packages/{domain,shared,db}/src/compras/*.spec.ts` · `tests/aislamiento/compras-*.spec.ts` · `apps/worker/.../persistidor-compras.int.spec.ts` · `apps/backend/src/modules/compras/*.int.spec.ts` · `*.adv.spec.ts` | CA-1 a CA-20 |

## Contrato exigido a 013 (lo que 014 consume de `main`)
1. Tabla `propuesta(id, tenant_id, cliente_id, periodo, libro, fuente, hash, usuario_id, creada_at)` solo `INSERT`/`SELECT` para los roles de la app; FK compuesta `(tenant_id, id)` para que `compra.propuesta_id` apunte a ella.
2. Tipo `sire.propuesta.descargar` con `{ periodo, libro: "compras" | "ventas" }` ya con los dos valores en su forma (`registrarTipo` rechaza cambiarla).
3. Procesador: obtiene el token y las filas sin transacción abierta y llama a `persistidores[libro].persistir(tx, { propuesta, filas, usuarioId })`, que devuelve `{ agregadas, existentes, difieren: string[] }`; lo guarda en el `resultado` del trabajo (tope de 4 KB: total y hasta 40 claves). Libro sin persistidor: `ErrorDatos` sin reintento.
4. Regla de descarga repetida alineada con D-18 de la spec (DU-2 rige también para ventas).
5. Migraciones 0028–0031 y su diario en `main`.
T4 reconcilia este contrato con lo realmente mergeado y corrige este plan antes de tocar la base de datos.

## Contratos
**HTTP** bajo `/clientes/:clienteId/periodos/:periodo/compras` (`periodo` AAAAMM; errores `{codigo}`; `Cache-Control: no-store`; estudio solo de la sesión; `ClienteScopeGuard`; las rutas estáticas van antes de `:compraId`):
| Método y ruta | Permiso | Respuesta |
|---|---|---|
| `POST /descargar` | `sire.descargar` (+ `sire.aprobar_generar` si el periodo está `revisado`) | 202 `TrabajoVista` · 403 `periodo_revisado` · 404 · 409 `cliente_archivado` \| `periodo_generado` \| `credencial_no_configurada` |
| `GET /?cursor&limite&vista&alertas&proveedorNuevo&q` | `clientes.ver` | 200 `{filas[FilaCompraVista], siguiente\|null}` |
| `GET /resumen` | `clientes.ver` | 200 `{estado, casilleros{original, vigente, diferencia}, conIgv{n,…}, sinIgv{n,…}, filasSinConvertir[]}` |
| `GET /exportar.xlsx` | `clientes.ver` | 200 `.xlsx` en memoria (D-17) |
| `GET /:compraId` | `clientes.ver` | 200 `{original, vigente, versiones[], hallazgos[]}` · 404 |
| `POST /:compraId/clasificar` `{versionBase, destino}` | `sire.clasificar` | 200 `FilaCompraVista` + cuadre · 400 · 403 · 404 · 409 `version_obsoleta` \| `fila_excluida` \| `periodo_generado` |
| `POST /:compraId/editar` `{versionBase, cambios}` | `sire.clasificar` | 200 `FilaCompraVista` + cuadre por celda · 400 (decimales o rango) · mismos 409 |
| `POST /:compraId/calcular` `{cambios}` | `sire.clasificar` | 200 `{total, cuadre}` sin escribir · 400 |
| `POST /:compraId/sugerencias/aceptar` `{versionBase, regla, confirmar?, dato?}` | `sire.clasificar` | 200 · 409 `revisar_de_nuevo` \| `version_obsoleta` · 422 `requiere_dato` `{dato}` |
| `POST /:compraId/excluir` `{versionBase, motivo?}` · `POST /:compraId/restaurar` `{versionBase}` · `POST /:compraId/descartar` `{versionBase}` | `sire.clasificar` | 200 · 409 (`descartar` solo agregadas: 409 `no_descartable`) |
| `POST /` agregar `{tipo, serie, numero, proveedor…, fecha, moneda, tipoCambio?, montos}` | `sire.clasificar` | 201 · 400 · 409 `duplicado` `{id}` |
| `POST /masivas/{clasificar,aceptar,excluir,restaurar}` `{items[{compraId, versionBase}≤5000], …}` | `sire.clasificar` | 200 `{operacionId\|null, aplicadas, rechazadas[{compraId, codigo}]}` · 400 (5.001) |
| `POST /deshacer` · `POST /rehacer` | `sire.clasificar` | 200 `{operacionId, filas}` · 409 `fila_cambiada` `{ids}` \| `nada_que_deshacer` \| `nada_que_rehacer` |
| `POST /estado/revisar` · `POST /estado/reabrir` | `sire.clasificar` · `sire.aprobar_generar` | 200 `{estado, por, en}` · 409 `estado_invalido` |
Toda escritura: 403 `periodo_revisado` (sin `sire.aprobar_generar`), 409 `periodo_generado`, 409 `cliente_archivado`. Los montos viajan como cadenas decimales.

**BD** (todas con `tenant_id`, RLS `ENABLE` + `FORCE`, uuid v7, NUMERIC(14,2), prueba de catálogo de 002):
- `compra(id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero, razon_social, fecha, moneda, tipo_cambio, origen, version_vigente, descartada_at)`. Trigger: solo `version_vigente` y `descartada_at` (de NULL a fecha, una vez) son mutables. Índice único parcial `(tenant_id, cliente_id, periodo, clave) WHERE descartada_at IS NULL`.
- `compra_version(id, compra_id, n, 10 montos + total, excluida, motivo≤200, clasificada, accion, operacion_id, usuario_id, creada_at)`; único `(compra_id, n)`; solo `INSERT`/`SELECT`.
- `compra_operacion(id, cliente_id, periodo, usuario_id, tipo, estado vigente|deshecha|caducada, referencia_id, creada_at, deshecha_at)`; `INSERT`/`SELECT` y `UPDATE (estado, deshecha_at)`.
- `compra_hallazgo(id, compra_id, version_n, regla, sugerencia jsonb, lecturas jsonb, requiere_confirmacion, creada_at)`; solo inserción, clave `(compra_id, version_n, regla)`; los hallazgos de una fila son los de su versión vigente.
- `compra_periodo(cliente_id, periodo, estado, marcado_por, marcado_at)`, PK `(tenant_id, cliente_id, periodo)`; `fijarEstadoPeriodo(tx, clienteId, periodo, desde, hacia)` con compare-and-set.
- Orden de bloqueo obligatorio: `compra_periodo` (`FOR SHARE` en acciones; `FOR UPDATE` al cambiar estado) → `compra_operacion` → `compra` por id ascendente.

**Dominio** (`packages/domain/src/compras/`, sin IO): `claveComprobante`, `aplicarEdicion(montos, cambios) → {montos, total, cuadre}`, `resumirCompras(filas, tiposCambio)` (`tiposCambio` = mapa id de la compra → tipo de cambio como cadena; solo se consulta para filas USD), `aFilaReemplazo`, `puedeEscribir(estado, permisos) → ok | {codigo}`, `sugerenciaEsMasiva`.

**packages/db**: `persistirDescarga` (el persistidor), `aplicarAccion`, `aplicarMasiva`, `deshacer`, `rehacer`, `leerFilasReemplazo(tx, clienteId, periodo) → {original, vigente}`, `fijarEstadoPeriodo`, `agregarCompra`.

## Decisiones
- **Un solo punto de escritura de versión** (`crearVersion`): comprueba `versionBase`, inserta la versión, mueve el puntero con CAS, re-evalúa la fila y guarda sus hallazgos, todo en la transacción — así ninguna acción olvida re-evaluar (nota [014]).
- **Deshacer sin tocar historia**: restaura copiando los valores de la versión anterior (o de la deshecha, al rehacer) en versiones nuevas con `operacion_id` propio; una operación nueva del usuario pasa sus `deshecha` a `caducada`, así rehacer vale solo hasta la siguiente acción. Entran en la pila clasificar, editar, aceptar, excluir y restaurar.
- **Resumen y Excel en el servidor con `Money`** sobre las ≤ 5.000 filas leídas, no con `SUM` de SQL: la conversión USD y el redondeo son los de 010. La lectura de cadenas `NUMERIC` nunca pasa por `number`.
- **Estado del periodo y permisos en una función pura** (`puedeEscribir`) que usan todos los servicios; la descarga la comprueba al encolar y otra vez al persistir (el estado pudo cambiar).
- **Excel**: montos como celdas numéricas escritas desde la cadena exacta; solo el texto se neutraliza (un monto negativo no empieza «-» como texto). Se reutiliza el escritor de 007b.
- **Descarga repetida**: `difieren` compara, contra la versión 1, los 10 montos, el total, la moneda, el tipo de cambio y la fecha por igualdad exacta de cadenas; la razón social no entra (es texto no confiable y cambia sin importar).
- El persistidor de ventas es de 013; el de compras se registra en el mismo registro y no importa nada de ventas.
- Ningún log lleva montos, claves ni razones sociales; errores con códigos, nunca el mensaje crudo del adaptador.

## Riesgos
- **013 cambia el contrato**: T4 lo reconcilia; si 013 crea una cabecera común de comprobante, `compra` sigue autónoma y se anota.
- **Choque de migraciones o del diario drizzle**: por eso la BD espera el merge de 013 y el número lo confirma la tarea.
- **Interbloqueos entre masivas, deshacer y descarga repetida**: orden único de bloqueo (arriba) y prueba concurrente (CA-3, CA-18).
- **Resultado del trabajo de 4 KB**: el informe `difieren` se recorta a 40 claves más el total; si el usuario quiere la lista completa hará falta una tabla (pregunta abierta Q-1).
- **Volumen** (5.000 filas × evaluación de reglas): la re-evaluación por fila usa el entorno ya armado (índice de proveedores del periodo) y no relee el periodo; se mide en CA-15.
- **Fórmulas en el Excel**: el adversario ataca razón social y glosa; la neutralización es una función con prueba propia.
