# Plan 007a · Clientes, perfil fiscal, archivado y listado

## Archivos
Migraciones: la última es **0025**; 007a usa **0026** (`clientes_perfil`). T4 confirma con `ls packages/db/migrations` antes de crear y nunca edita una aplicada. 007b numera después de la última de 007a.
| Acción | Ruta | Para qué |
|---|---|---|
| modificar | `packages/db/src/schema/clientes.ts` | columnas nuevas de `cliente` (D1) |
| crear | `packages/db/migrations/0026_clientes_perfil.sql` (`drizzle-kit generate`) | columnas, CHECK, índice parcial de activos |
| crear | `packages/shared/src/clientes/{ruc,esquemas,index}.ts` · modificar `packages/shared/src/index.ts` | `validarRuc`, zod de entrada/salida, DTOs |
| crear | `packages/db/src/clientes/{repositorio,filtros,errores}.ts` · modificar `packages/db/src/index.ts` | crear, editar, archivar, reactivar, leer y listar con filtros (SQL estático parametrizado) |
| modificar | `packages/db/src/planes/{cupo,uso}.ts` | contar solo `archivado_at IS NULL` |
| modificar | `packages/db/src/trabajos/registro.ts` (`SQL_REVALIDAR`) · `packages/queue/src/soporte-pruebas/bd-falsa.ts` si imita la revalidación | «no archivado» en el despacho (D5) |
| modificar | `packages/db/src/acceso/asignaciones.ts` (o su servicio en backend) | 409 `cliente_archivado` al asignar |
| modificar | `apps/backend/src/modules/clientes/{clientes.controller,clientes.module}.ts` · crear `clientes.service.ts` | rutas de D3; reemplaza la lectura mínima de 005 |
| modificar | `apps/backend/src/modules/acceso/errores.ts` · `apps/backend/test/auditoria-rutas.ts` | `ruc_duplicado`, `cliente_archivado`; auditoría de rutas nuevas |
| modificar | `eslint.config.mjs` | cerrar `import * as d` (D8) |
| crear | `apps/frontend/lib/clientes.ts` · `apps/frontend/app/(app)/clientes/nuevo/page.tsx` · `components/{filtros-clientes,datos-fiscales}.tsx` | cliente HTTP, alta, filtros, formulario fiscal |
| modificar | `apps/frontend/app/(app)/clientes/page.tsx` · `[clienteId]/page.tsx` | listado con filtros; detalle con datos fiscales y archivar/reactivar |
| crear | pruebas: `packages/shared/src/clientes/*.spec.ts` · `packages/db/src/clientes/*.spec.ts` · `tests/aislamiento/clientes*.spec.ts` · `apps/backend/src/modules/clientes/*.spec.ts`/`*.int.spec.ts` · `tests/limites/auth-lint.spec.ts` (ampliar) · specs de frontend | cobertura de CA-1 a CA-9 |

## Contratos
**shared**: `validarRuc(ruc: string): boolean` (pura). `CrearClienteInput = {ruc, razonSocial?, responsableId?, perfil?}` · `PerfilFiscal = {regimen: 'rg'|'rmt'|'rer'|'nrus'|null, zona: 'general'|'amazonia', ventasExoneradas: boolean, ventasMixtas: boolean, monedaHabitual: 'PEN'|'USD'}` · `EditarClienteInput = {razonSocial?, perfil?}` (RUC inmutable) · `FiltrosClientes = {responsable?: uuid|'ninguno', credencial?: EstadoCredencial, archivados?: boolean, q?: string≤100}` · `ClienteDto = {id, ruc, razonSocial, estadoContribuyente|null, condicionContribuyente|null, perfil, archivado: boolean, responsable|null, credenciales: {sol, sire_api: EstadoCredencial}}`. Esquemas zod con claves desconocidas descartadas.

**HTTP** (errores `{codigo}`, `no-store`; estudio solo de la sesión):
| Método y ruta | Permiso | Respuesta |
|---|---|---|
| `POST /clientes` | `clientes.crear` | 201 `ClienteDto` · 400 (RUC o catálogo) · 409 `cupo_rucs` · 409 `ruc_duplicado` · 409 `sin_plan` |
| `GET /clientes?…filtros` | `clientes.ver` | 200 `ClienteDto[]` en el alcance |
| `GET /clientes/:clienteId` | `clientes.ver` + `ClienteScopeGuard` | 200 `ClienteDto` · 404 |
| `PATCH /clientes/:clienteId` | `clientes.editar` + guard | 200 `ClienteDto` · 400 · 404 · 409 `cliente_archivado` |
| `POST /clientes/:clienteId/archivar` | `clientes.archivar` + guard | 200 `ClienteDto` (idempotente) · 404 |
| `POST /clientes/:clienteId/reactivar` | `clientes.archivar` + guard | 200 `ClienteDto` · 404 · 409 `cupo_rucs` |
La asignación (005) pasa a responder 409 `cliente_archivado` sobre archivados. `EstadoCredencial = 'no_configurada'|'configurada'|'verificada'|'invalida'`.

**packages/db** (`clientes/`): `crearCliente(tx, tenantId, datos)`, `editarCliente`, `archivarCliente`, `reactivarCliente` (todos con `tx` de `withTenant`; el servicio toma antes `bloquearMiembros` y `CupoRucs.reservar`), `leerClienteDto(tx, id)`, `listarClientesFiltrado(tx, alcance, filtros)`. `contarRucs`/`usoDelEstudio` cuentan activos. `revalidarEncolado` exige `c.archivado_at is null`.

**BD**: `cliente` + `estado_contribuyente text NULL`, `condicion_contribuyente text NULL` (CHECK `char_length` 1–50), `regimen text NULL CHECK IN ('rg','rmt','rer','nrus')`, `zona text NOT NULL DEFAULT 'general' CHECK IN ('general','amazonia')`, `ventas_exoneradas bool NOT NULL DEFAULT false`, `ventas_mixtas bool NOT NULL DEFAULT false`, `moneda_habitual text NOT NULL DEFAULT 'PEN' CHECK IN ('PEN','USD')`, `archivado_at timestamptz NULL`, CHECK de largo de `razon_social` (1–200); índice parcial `(tenant_id) WHERE archivado_at IS NULL`. RLS y grants de tabla de 0002 se mantienen.

## Decisiones
- Orden de bloqueo obligatorio (005/006): `bloquearMiembros` (actor y responsable) → `CupoRucs.reservar` → `cliente` → `asignacion`. Archivar toca solo `cliente` por id; asignar rechaza archivados después de bloquear miembros. T6 lo prueba con carreras antes de implementar el lugar de la llamada.
- El estado de credencial del listado se lee de `credencial.estado` (grant de 0018 al backend); los filtros usan `EXISTS`/`LEFT JOIN` por tipo, sin tocar columnas cifradas.
- `q` usa `ILIKE` con `ESCAPE` y parámetros; el RUC se compara por prefijo. Nada de concatenar texto del usuario en SQL.
- Rutas y repositorios nuevos van en `packages/db`; el backend no importa `sql` de drizzle (D8).
- La razón social ausente se guarda como «RUC <número>»; 007b la reemplaza al consultar el RUC.

## Riesgos
- Interbloqueo entre crear/reactivar/asignar/archivar: lo cubre CA-7 con carreras de dos conexiones (patrón `tests/aislamiento/planes-carreras.spec.ts`).
- Fuga de existencia por 404 distinto entre ajeno e inexistente: CA-3 compara cuerpo y código en todas las rutas con `:clienteId`.
- Listado sin paginación con muchos archivados: solo se incluyen con `archivados=1`; revisar si el uso real lo exige en una spec posterior.
- `contarRucs` cambia el conteo de 006: sus pruebas de cupo deben seguir verdes (T10 las corre).
