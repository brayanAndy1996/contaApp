# Plan 031 · Consulta de auditoría con filtros e historial por cliente

<!-- Tope: ~900 palabras (04-metodologia §7 regla 13). D-n, CA-n y P-n = spec.md. -->

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| crear | `packages/db/migrations/0088_auditoria_consulta.sql` (+ `meta/`) | Nueva `auditoria_descifrado_listar`, índices (D-7) |
| modificar | `packages/db/src/schema/{auditoria,credenciales}.ts` | Declarar los índices en drizzle |
| modificar | `packages/db/src/auditoria/lectura.ts` | Filtros y alcance en las dos ramas (D-1, D-3) |
| crear | `packages/db/src/auditoria/opciones.ts` | Miembros y clientes del selector (D-6); exportar en los `index.ts` |
| crear | `packages/shared/src/auditoria/consulta.ts` | Zod de consulta y opciones, `rangoLima` (D-2); exportar |
| crear | `apps/backend/src/modules/auditoria/consulta.ts` | Leer la consulta estricta (zod + `decodificarCursor`) |
| modificar | `apps/backend/src/modules/auditoria/auditoria.{controller,service}.ts` | Filtros, 404, `/opciones` |
| modificar | `apps/frontend/app/(app)/configuracion/auditoria/page.tsx`, `apps/frontend/lib/auditoria.ts` | Filtros en la URL, avisos, enlace de compras (P-2, P-3) |
| crear | `apps/frontend/components/auditoria/filtros-auditoria.tsx` | Barra de filtros |
| modificar | `apps/frontend/app/(app)/clientes/[clienteId]/page.tsx` | Enlace «Ver historial» (P-1) |
| modificar | `tests/aislamiento/escalada.adv.spec.ts` | Firma nueva de la función |

## Contratos
**HTTP** (ambos `auditoria.ver`, `Cache-Control: no-store`; 403 sin permiso, 400 `solicitud_invalida`):
- `GET /auditoria?usuarioId&clienteId&accion=a&accion=b&desde=AAAA-MM-DD&hasta=AAAA-MM-DD&cursor` → `PaginaAuditoria` (sin cambios, D-5). `accion` repetida (una sola se toma como lista). `clienteId` no visible → 404 `no_encontrado`. El cursor vale solo con los mismos filtros; el cliente lo descarta al cambiarlos.
- `GET /auditoria/opciones?q&clienteId` → `{ miembros: {id, nombre, activo}[], clientes: {id, ruc, razonSocial, archivado}[] }`. Miembros: todos los no eliminados del estudio, por nombre. Clientes visibles con el alcance: `q` (1–60) por prefijo de RUC o razón social `ILIKE` con comodines escapados, máx. 20; `clienteId` agrega ese cliente si es visible (para pintarlo al recargar).

**Shared** (`auditoria/consulta.ts`):
- `consultaAuditoriaSchema` (`z.strictObject`): `usuarioId?`/`clienteId?` UUID; `accion?` 1–10 de `accionAuditoriaSchema`, sin repetir; `desde?`/`hasta?` fecha de calendario válida; `desde ≤ hasta`; `cursor?` string.
- `consultaOpcionesAuditoriaSchema` (estricto) y `opcionesAuditoriaSchema`.
- `rangoLima(desde?, hasta?) → { desde: Date | null; hastaExclusivo: Date | null }` con UTC−05:00 fijo (Perú sin horario de verano): `desde` 00:00 Lima, `hasta` + 1 día 00:00 Lima.

**DB**:
- `listarAuditoria(tx, { antes?, limite?, alcance: Alcance, filtros?: FiltrosAuditoria })`, `FiltrosAuditoria = { usuarioId, clienteId, acciones, desde, hastaExclusivo }` (cada uno `null` = sin filtro). `alcance` es obligatorio: sin él no compila.
- `opcionesAuditoria(tx, { q, clienteId, alcance })`.
- `auditoria_descifrado_listar(p_antes timestamptz, p_antes_id uuid, p_limite int, p_cliente_id uuid, p_desde timestamptz, p_hasta timestamptz, p_global boolean, p_usuario uuid)`: `p_global` true = todo el estudio; false = clientes asignados a `p_usuario` (asignaciones del mismo `app.tenant_id`); `null`, o `false` sin usuario = nada (falla cerrado). `DROP` de la firma de 017. Dueño `contapp_migrator`, `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`, `REVOKE` de `PUBLIC` y de cada rol, EXECUTE solo `contapp_backend`.
- Índices: `auditoria (tenant_id, usuario_id, ocurrida_en DESC, id DESC)`, `auditoria (tenant_id, accion, ocurrida_en DESC, id DESC)`, `auditoria_descifrado (tenant_id, <ms>, id DESC)` y `(tenant_id, cliente_id, <ms>, id DESC)`, con `<ms>` una expresión inmutable de los milisegundos (p. ej. `date_trunc('milliseconds', created_at AT TIME ZONE 'UTC') DESC`) que la función use igual en `WHERE` y `ORDER BY`. El EXPLAIN de T5 fija el plan.

## Decisiones
- Cada rama de la unión lleva sus filtros, su `ORDER BY` y su `LIMIT`; el texto SQL es fijo y todo valor viaja como `$n` (D-1, CA-7). La rama de descifrados recibe `LIMIT 0` cuando hay `usuarioId` o cuando `accion` no incluye `credencial.descifrada` (D-4).
- El alcance asignado agrega `cliente_id IS NOT NULL AND filtroAlcance(...)` en la rama de `auditoria` y `p_global = false` en la función (P-5, D-3). El servicio lo saca siempre de `alcanceDe(acceso)`, nunca de la petición.
- Orden del servicio: zod (400 sin abrir transacción) → `withTenant` → `clienteVisible` si hay `clienteId` (404) → página → «¿hay siguiente?» con los mismos filtros → autores, objetivos y clientes por lote como en 017.
- `leerConsulta` de notificaciones no cambia; auditoría usa su lector propio. La prueba de 017 que exigía 400 para `usuarioId`/`clienteId` pasa a exigirlo con valores no UUID (contrato nuevo, aprobado); `tenantId` y `limite` siguen dando 400.
- Pantalla: los filtros viven en la URL con los mismos nombres de la API; sin `desde`/`hasta` aplica los últimos 30 días (hoy Lima − 29 → hoy) y `todo=1` los quita (P-2). Cambiar un filtro descarta el cursor. Usuario inactivo con «(inactivo)». Con filtro de usuario, aviso de que los descifrados no registran autor. `compra.operacion` enlaza a `/clientes/{id}/compras?periodo={datos.periodo}` solo con `compras.ver` (P-3). La ficha muestra «Ver historial» solo con `auditoria.ver` y abre `/configuracion/auditoria?clienteId=…&todo=1`.
- CA-9 se mide como escala, no con tope de reloj (regla del proyecto): razón entre ¼ de la carga y la carga completa con tiempo de CPU del proceso de PG de la conexión (`pg_backend_pid()` + `/proc/<pid>/stat`; si la BD no es local, búferes de `EXPLAIN (ANALYZE, BUFFERS)`), rondas intercaladas como `medirEscala`, tope ≤ 2 (índice ≈ 1; lineal ≈ 4), y EXPLAIN con el índice esperado por filtro. El p95 en ms va a `resultados.md`, informativo.
- Nivel B: sin umbral de cobertura; T11 es la revisión contra la spec.

## Riesgos
- Alcance asignado con muchos clientes: `EXISTS` sobre el índice de fecha puede recorrer de más. Lo muestran el EXPLAIN y CA-9; entonces `LATERAL` por cliente asignado sobre `auditoria_cliente_idx`, conservando `filtroAlcance` como predicado.
- `date_trunc` sobre `timestamptz` no es inmutable: un índice mal declarado no se usa o no se crea. Lo detectan el EXPLAIN y CA-2 (bordes de milisegundo y de cursor entre ramas).
- Un `null` que llegue a `p_global` o al alcance haría ver de más: falla cerrado en la función y `alcance` obligatorio en TypeScript; lo ataca T9.
- Romper 017 (CA-3, cursor): sus suites siguen corriendo.
- La zona fija −05:00 vive en un solo helper con prueba.
