# Plan 007b · Credenciales, importación Excel y panel de trabajos

## Archivos
Migraciones: la última es **0026** (007a); 007b usa **0027** (`credencial_fk_cliente`). La tarea confirma con `ls packages/db/migrations` antes de crear y nunca edita una aplicada.
| Acción | Ruta | Para qué |
|---|---|---|
| modificar | `packages/db/src/schema/credenciales.ts` · crear `packages/db/migrations/0027_credencial_fk_cliente.sql` (`drizzle-kit generate`) | FK `(tenant_id, cliente_id) → cliente(tenant_id, id)` (D2) |
| modificar | `packages/db/src/credenciales/{estado,repositorio}.ts` · `packages/db/src/clientes/repositorio.ts` · `packages/db/src/index.ts` | `marcarCredencialVerificada`, `leerEstadoCredenciales` (con fecha y motivo), `completarDatosRuc`, `rucsExistentes`, `crearCliente` con `id` opcional |
| modificar | `packages/sunat/src/{puertos,index}.ts` · crear `src/mock/{consulta-ruc,sol-auth}.mock.ts` | puertos `ConsultaRuc` y `SolAuth` con mock y centinelas deterministas |
| modificar | `packages/queue/src/{catalogo,index}.ts` | registrar `cliente.consultar_ruc`, `credencial.verificar_sol`, `credencial.verificar_sire` |
| crear | `packages/shared/src/credenciales/*` · `packages/shared/src/importacion/*` | zod y DTOs de credenciales, estado e informe de importación |
| crear | `apps/worker/src/trabajos/procesadores/{consultar-ruc,verificar-credencial}.ts` · modificar `trabajos.module.ts`, `iniciar.ts` | procesadores y cableado de puertos (`RUC_CLIENT`, `SOL_PORTAL`, `SIRE_CLIENT`; todos `mock`) |
| crear | `apps/backend/src/modules/credenciales/*` | rutas D4–D6, cifrado con `KeyWrapper`, verificar |
| crear | `apps/backend/src/modules/importacion/{lector-xlsx,lector-csv,validar-filas,plantilla,importacion.service,importacion.controller}.ts` | D7–D9 |
| modificar | `apps/backend/src/modules/clientes/clientes.service.ts` · `trabajos/{encolador,stream.service}.ts` · `main.ts`/`crearApp` · `package.json` | alta encola la consulta; `encolarLote`; cabecera `no-transform`; cuerpo crudo ≤ 2 MB en la importación; dependencias `@contapp/crypto`, `fflate`, `fast-xml-parser` (versión exacta) |
| crear/modificar | `apps/frontend/lib/{credenciales,importacion,trabajos}.ts` · `app/(app)/clientes/[clienteId]/{page,credenciales}.tsx` · `clientes/importar/page.tsx` · `trabajos/page.tsx` · `layout.tsx` · `next.config.ts` | UI de D4–D10 |
| crear | pruebas: `tests/aislamiento/credencial-fk*.spec.ts` · `packages/*/src/**/*.spec.ts` · `apps/worker/src/trabajos/procesadores/*.int.spec.ts` · `apps/backend/src/modules/{credenciales,importacion}/*.spec.ts`/`*.int.spec.ts` · `*.adv.spec.ts` · specs de frontend | CA-1 a CA-10 |
| modificar | `.env.example` | `RUC_CLIENT=mock` |

## Contratos
**HTTP** (errores `{codigo}`, `Cache-Control: no-store`; estudio solo de la sesión; `:clienteId` con `ClienteScopeGuard`):
| Método y ruta | Permiso | Respuesta |
|---|---|---|
| `PUT /clientes/:clienteId/credenciales/:tipo` (`sol` `{usuario, clave}` · `sire_api` `{clientId, clientSecret}`, 1–256 B UTF-8) | `credenciales.editar` | 200 `{tipo, estado}` · 400 · 404 · 409 `cliente_archivado` |
| `GET /clientes/:clienteId/credenciales` | `clientes.ver` | 200 `[{tipo, estado, fecha\|null, motivo\|null}]` (los dos tipos; nunca sobre ni secreto) |
| `POST /clientes/:clienteId/credenciales/:tipo/verificar` | `credenciales.editar` | 202 `TrabajoVista` · 404 · 409 `cliente_archivado` \| `credencial_no_configurada` |
| `POST /clientes/importacion/vista-previa` (cuerpo crudo `.xlsx`/`.csv` ≤ 2 MB) | `clientes.crear` (+ `credenciales.editar` si trae claves) | 200 `VistaPrevia {filas[{n, ruc, estado, motivos[], tieneSol, tieneSire}], validas, conError, cupoLibre, excedentes}` · 400 `archivo_invalido` \| `columnas_faltantes` \| `demasiadas_filas` · 413 |
| `POST /clientes/importacion/confirmar` (mismo cuerpo) | igual | 200 `Informe {creadas, noImportadas[{n, ruc, motivo}], consultasEncoladas, consultasOmitidas}` |
| `GET /clientes/importacion/plantilla` | `clientes.crear` | 200 `.xlsx` en memoria (cabecera y hoja «Instrucciones»; ninguna fila de datos, para que subirla intacta no cree nada) |
| `GET /trabajos/resumen` (T18a, D-1; 008 solo listaba 100) | sesión con estudio (mismo alcance que `GET /trabajos`) | 200 `[{tipo, estado, total}]` de todos los trabajos visibles |
Motivos de fila: `ruc_invalido`, `duplicado_en_archivo`, `duplicado` (con `archivado: true` para la sugerencia de reactivar), `responsable_inexistente`, `responsable_no_asignable`, `credencial_incompleta`, `celda_peligrosa`, `cupo_rucs`. Las rutas con 2 segmentos `importacion/*` no chocan con `:clienteId`.

**Puertos** (`packages/sunat`): `ConsultaRuc.consultar(ruc): Promise<{razonSocial, estado, condicion}>` · `SolAuth.verificar({ruc, usuarioSol, claveSol}): Promise<void>` (`ErrorCredencial` si la rechaza). `SireAuth` no cambia. Los mocks traen centinelas documentadas (RUC que termina en cierto dígito, `claveSol`/`clientSecret` con un valor fijo) para simular fallo con el stack real.

**Catálogo** (`packages/queue`): `cliente.consultar_ruc` (cola `xml`, canal `ninguno`, `credencial: null`, permiso `clientes.crear`, parámetros `{}`) · `credencial.verificar_sol` (cola `sol`, canal `sol`) · `credencial.verificar_sire` (cola `sire`, canal `sire`); ambos `credencial: null`, permiso `credenciales.editar`, parámetros `{}`, idempotentes (dedupe por cliente). Prioridad: verificar `interactivo`; consultar RUC `programado`.

**packages/db**: `marcarCredencialVerificada(tx, clienteId, tipo, version)` (`UPDATE` condicionado a `xmin::text = version`, igual que `marcarCredencialInvalida`; rol worker) · `leerEstadoCredenciales(tx, clienteId)` · `completarDatosRuc(tx, clienteId, {razonSocial, estado, condicion})` (`razon_social` solo si `= 'RUC ' || ruc`) · `rucsExistentes(tx, rucs[])` → `{ruc, archivado}` · `DatosCliente.id?` (para cifrar antes de la transacción con el AAD final).

**BD**: solo la FK de 0027. Sin columnas nuevas: `estado/estado_motivo/estado_at` y sus grants son de 0018; el motivo `credencial_invalida` basta (los fallos transitorios no cambian el estado).

## Carga de la cola (~1.000 `cliente.consultar_ruc`)
Límites de 008 en `config_sistema`: cola `xml` global 8, por estudio 4, `max_pendientes_tenant` 2.000 (tope atómico en el `INSERT`), 3 reintentos. Decisiones:
- **Cola `xml`, canal `ninguno`, prioridad `programado`**: sin lock por RUC y detrás de cualquier trabajo `interactivo` del mismo estudio; el reparto entre estudios sigue siendo round-robin. No se crea cola nueva (tocaría los CHECK de 008, nivel A); si 009 descubre un límite real de la consulta RUC, se baja `concurrencia_tenant` en caliente o se evalúa la cola propia entonces.
- **Reserva**: la importación (y el alta) solo encola mientras `pendientes(xml) < max_pendientes_tenant / 2` (1.000); el resto se informa en `consultasOmitidas`. Así 1.000 consultas nunca agotan el tope que necesitan `xml.obtener` (012/016) del mismo estudio. Una fila omitida queda con la razón social provisional (P2).
- **Lotes**: `Encolador.encolarLote` inserta de 100 en 100 en su propia `withTenant` y publica la pista y el evento tras cada commit; se hace **después** de la transacción de importación (si falla, los clientes ya existen y solo se cuenta la omisión). No se encola dentro del bloqueo de cupo.
- **Drenaje**: el despachador de 008 entrega un trabajo por estudio y cola en cada ciclo (`despachadorMs` 500), así que la cola `xml` despacha ~2 trabajos por segundo por estudio sin importar `concurrencia_tenant` ni lo que dure la consulta: 1.000 tardan ~8,5 min (medido en T18 con el mock, 511 s). El usuario lo aceptó en R1 (D-3 de T18); se revisa en 009 con la consulta real. Cada trabajo termina `completado` o `error`; los reintentos transitorios usan el backoff de 008.
- **Panel**: 1.000 trabajos de un tipo se resumen en una línea («Consultando datos de RUC: 640 de 1.000»), con detalle desplegable, y los eventos SSE se aplican por lotes (≤ 4 repintados por segundo).

## Decisiones
- **Orden de bloqueo** (005/006): `bloquearMiembros` (actor y responsables) → `CupoRucs.libres` (toma el bloqueo del cupo) → `n = min(válidas, libres)` → `reservar(n)` → `cliente` → `credencial` → `asignacion`. La preparación pesada (lectura, validación, UUID por fila y **cifrado de las claves**) va **antes** de la transacción, para no llamar a un KMS con el bloqueo tomado; la transacción solo hace SQL.
- **Lector propio mínimo**: `.xlsx` con `fflate` (descompresión con tope de entradas, tamaño por entrada y total, rechazo de rutas raras) y `fast-xml-parser` con entidades desactivadas y rechazo previo de `<!DOCTYPE`/`<!ENTITY`; sin `xlsx` (SheetJS) ni `exceljs` por superficie y mantenimiento. `.csv` UTF-8 (con o sin BOM), separador `,` o `;`. Tope de 1.000 filas, 2 MB y 20 MB descomprimidos; todo en memoria. Cuerpo crudo y no `multipart`: sin dependencia ni disco temporal.
- **Columnas**: la cabecera de la plantilla es obligatoria (falta una → 400 `columnas_faltantes`); solo `RUC` exige valor. Un par SOL o SIRE a medias → `credencial_incompleta`. Repetidos: la primera aparición vale y las demás son `duplicado_en_archivo`.
- **Celdas peligrosas**: una celda con fórmula real (`<f>`) se rechaza siempre; texto que empieza con `= + - @` o control se rechaza en razón social, usuario SOL, `client_id` y responsable. Las **claves** (`clave`, `client_secret`) aceptan cualquier carácter imprimible (una clave real puede empezar con `-` o `@`): se cifran y no se exportan nunca.
- **Secretos**: `KeyWrapper` por `KEY_PROVIDER` (mock por defecto); solo `cifrarCredencial` en el backend, nunca `@contapp/crypto/descifrado` (lo vigila el lint). Ningún `logger`, filtro de excepciones ni auditoría de rutas recibe el cuerpo de estas rutas; los errores de cifrado se reducen a `{codigo}`. La vista previa devuelve solo `tieneSol/tieneSire`, nunca los valores.
- **Verificar** (D6): el procesador lee `versionCredencial` al empezar, descifra con `descifrarCredencial` (motivo `credencial.verificar`), llama al puerto y escribe `verificada` o `invalida` solo si la versión sigue siendo la misma (un guardado concurrente gana). Ante `ErrorCredencial` marca `invalida` y relanza (el trabajo queda `error/credencial_invalida`, sin reintentos). `verificar_sire` usa el puerto directo, no la caché de token.
- **Alta de 007a**: `ClientesService.crear` encola `cliente.consultar_ruc` tras el commit y sin propagar su fallo; no cambia su contrato HTTP.
- **Panel**: el navegador abre `/api/trabajos/stream` con `fetch` y lector de flujo (lleva `X-Estudio`; `EventSource` no puede), con reconexión (el servidor cierra a los 5 min) y respaldo por sondeo a `GET /trabajos`. Cabecera del stream `Cache-Control: no-cache, no-transform`; `compress: false` en Next solo si T18 lo demuestra necesario.

## Riesgos
- La FK rompe pruebas que siembran `credencial` con un `cliente_id` inventado (~10 archivos de 003/008: `tests/aislamiento`, `apps/worker/test`, `packages/queue/src/soporte-pruebas/int.ts`, `packages/db/src/trabajos/exportes.spec.ts`): T1 las ajusta en verde antes de la migración.
- Next reescribe `/api/*` con `http-proxy`: buffering por compresión, tiempo máximo de la petición y límite de cuerpo en la subida de 2 MB solo se ven con el stack real (T18); ninguna prueba unitaria los cruza.
- Una verificación que termina tras un guardado nuevo no debe pisar el estado (versión `xmin`); lo cubren T1/T5 y la ronda adversarial.
- El mock de `SireAuth` solo falla por programación; T8 le añade la centinela para que T18 reproduzca «clave errada» sin código.
- `contapp_worker` tiene `UPDATE` de tabla completo sobre `cliente` (0002): `completarDatosRuc` escribe solo 3 columnas; estrechar el grant queda fuera de 007b.
