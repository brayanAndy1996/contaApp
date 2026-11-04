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

## Revisión T13 (ratificaciones)
- **`q` (D7)**: ratificada. `filtros.ts` busca siempre prefijo de RUC y fragmento de razón social (así lo dice D7); `%`, `_` y `\` se escapan y se buscan como literales (`escape '\'`). La heurística «letras o solo dígitos» de T7 ya no existe (cambio de T9, probado por `clientes-filtros.int.spec.ts`: `q=%` solo encuentra «100%…»). Las dos ramas de `filtros.ts` son equivalentes; no se unifican porque `filtros.spec.ts` fija el patrón `%sac%`.
- **`archivados=1` suma archivados a activos**: ratificada. Coincide con D5 («lo oculta salvo `archivados=1`») y con la casilla «Mostrar archivados». «Solo archivados» sería otra decisión de producto: no se pide.
- **`responsableId` no asignable = 409 `miembro_no_asignable`; ajeno o inexistente = 404 `no_encontrado`**: ratificada (igual que la asignación de 005). El 404 no revela nada fuera del estudio.
- **403 antes que 404 en PATCH, archivar y reactivar**: ratificada. Es el orden `PermisoGuard` → `ClienteScopeGuard` de 005 (D5). Hoy solo Dueño y Administrador tienen esos permisos y son de alcance global, así que el 404 uniforme de esas rutas se prueba con ellos.
- **Select de responsable con `clientes.asignar`**: ratificada en el frontend (`nuevo/page.tsx`). Hoy `clientes.crear`, `clientes.asignar` y `usuarios.ver` los tienen los mismos roles (Dueño y Administrador); si se separan, el select necesitaría también `usuarios.ver` (lee `/usuarios`). El backend no exige `clientes.asignar` para `responsableId` en `POST /clientes` (D3 solo dice «acepta un `responsableId` opcional»); sin efecto con la matriz actual. Ver pregunta abierta.
- **UI en HTML + Tailwind sin shadcn**: ratificada por precedente (005, 006; 001 §5 difiere shadcn hasta que una spec lo necesite). `docs/03-arquitectura.md` («Tailwind + shadcn/ui») queda sin cumplir: pregunta abierta.
- **Contrato frontend↔backend**: revisado archivo por archivo, sin desajustes. Defectos menores de frontend D1 a D3 en `tasks.md` (T13).

Respuestas del usuario (2026-11-04): P1 «Dejar y anotar (Recom.)»: `POST /clientes` con `responsableId` no exige `clientes.asignar`; revisar si alguna vez se separan los permisos de crear y asignar. P2 «Corregir el doc (Recom.)»: 03 §UI ahora dice HTML + Tailwind, sin shadcn hasta que una spec lo necesite.

Preguntas que se hicieron al usuario:
1. `POST /clientes` con `responsableId`: (a) dejarlo como está y anotarlo en D3 (recomendada: sin efecto con los roles actuales); (b) exigir además `clientes.asignar` en el servidor.
2. shadcn/ui: (a) seguir sin él hasta que una spec lo exija y corregir 03 §UI para decirlo (recomendada); (b) introducirlo en una spec propia antes de la siguiente de UI.
