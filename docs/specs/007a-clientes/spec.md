# Spec 007a · Clientes, perfil fiscal, archivado y listado

Estado: hecha. Aprobada por el usuario el 2026-11-03 (respuestas a P1–P7 y razón social provisional; «sigue con la 007»).
Nivel de riesgo: B — (2) sí: lista y abre clientes por alcance; (4) sí: cupo de RUCs con concurrencia; (1) no; (3) parcial. Por §2.1 literal ((2) y otra) saldría A, pero esta parte no maneja secretos: las credenciales y la importación van en 007b. Decisión del usuario (D9): B, sin ronda adversarial aquí.
Cubre: RF-030 (parcial: alta y validación del RUC; el autocompletado llega con 007b), RF-036, RF-037, RF-039 (parcial: cuatro filtros, D11). Sigue en R2: RF-038.
Parte 2: `docs/specs/007b-credenciales/spec.md` (RF-030 autocompletado, RF-031 a 035, HU-06, HU-09, HU-10).

## Objetivo
Que el administrador dé de alta clientes con RUC válido, registre su perfil fiscal, los archive y reactive respetando el cupo del plan, y los encuentre con filtros, viendo cada usuario solo los que le corresponden.

## Alcance
- Migración 0026 (`clientes_perfil`): `cliente` gana datos de contribuyente, perfil fiscal y `archivado_at`.
- `validarRuc` en `packages/shared` (backend y frontend).
- API: crear, editar, archivar y reactivar; lectura ampliada; listado con filtros. Cupo de RUCs real (`CupoRucs.reservar`) y conteo solo de activos.
- Revalidación del despacho de 008: un cliente archivado cancela sus trabajos.
- Regla de lint `sql` (cierre del hueco `import * as d`).
- Frontend: listado con filtros, alta, detalle con datos fiscales, archivar/reactivar.

## Fuera de alcance
- Credenciales (guardar, estado detallado, «Verificar»), importación Excel, consulta de RUC (`ConsultaRuc`), panel de trabajos y SSE, FK `credencial → cliente`: 007b.
- Eliminación definitiva (RF-038, R2). Notificaciones y auditoría (017). Adaptadores reales de SUNAT (009).
- Filtros «periodo pendiente» y «mensajes sin leer» (D11): se agregan cuando existan sus datos (SIRE, buzón).
- Cambios de asignación y roles (005, ya hechos).

## Decisiones
- D1 Esquema: `cliente` agrega `estado_contribuyente` y `condicion_contribuyente` (texto 1–50, nulos hasta que 007b los consulte), `regimen` (`rg|rmt|rer|nrus`, nulo = sin definir), `zona` (`general|amazonia`, por defecto `general`), `ventas_exoneradas` y `ventas_mixtas` (booleanos, por defecto falso), `moneda_habitual` (`PEN|USD`, por defecto `PEN`) y `archivado_at`. Todos con CHECK. Índice parcial de activos por estudio. El perfil fiscal es opcional al crear (RF-036; lo consume RF-113 en R2). `razon_social` sigue obligatoria (1–200): sin ella se guarda «RUC <número>» hasta que 007b la complete (decisión del usuario, 2026-11-03: «Provisional (Recom.)»). Los grants de `cliente` son de tabla: no hay grants nuevos.
- D2 RUC: `validarRuc` (11 dígitos, prefijo 10/15/16/17/20, dígito verificador módulo 11) es función pura en `packages/shared`; el backend la aplica siempre y el frontend la reutiliza para el mensaje en línea.
- D3 Permisos y alcance: crear `clientes.crear`; editar `clientes.editar`; archivar y reactivar `clientes.archivar`; leer y listar `clientes.ver`. Toda ruta con `:clienteId` usa `ClienteScopeGuard` (inexistente, ajeno y no asignado dan el mismo 404) y todo listado `filtroAlcance`. Crear acepta un `responsableId` opcional (regla D18 de 005: debe poder ser responsable).
- D4 Cupo y bloqueo: crear y reactivar siguen el orden global de 005/006: `bloquearMiembros` del actor (y del responsable), luego `CupoRucs.reservar(tx, tenantId, 1)` y después `cliente`, con la asignación al final. Sin cupo: 409 `cupo_rucs` y no se escribe nada. `contarRucs` (`packages/db/src/planes/cupo.ts`) y `uso.ts` cuentan solo `archivado_at IS NULL`. RUC repetido (también si el existente está archivado): 409 `ruc_duplicado` (unique `(tenant_id, ruc)`). Archivar solo libera: no toma el bloqueo de cupo ni toca miembros.
- D5 Archivado: `archivado_at` libera cupo y deja el cliente en solo lectura: editar y asignar dan 409 `cliente_archivado` (007b lo extiende a credenciales y verificar); el listado lo oculta salvo `archivados=1`. Se agrega «no archivado» a la revalidación del despacho de 008 (D17, `revalidarEncolado`): el trabajo, también el `programado`, queda `cancelado` con `acceso_retirado`. Reactivar pasa por D4 (puede dar 409 `cupo_rucs`).
- D6 Credenciales de un archivado (era P6; decisión del usuario, 2026-11-03: opción (a) recomendada, «conservarlas cifradas»): archivar no toca `credencial`; el archivado impide usarlas (D5) y al reactivar no se reingresan.
- D7 Listado: `GET /clientes?responsable=<usuarioId|ninguno>&credencial=<estado>&archivados=1&q=<texto>`; los filtros se combinan con AND y con `filtroAlcance`. `credencial` coincide si alguno de los dos tipos (`sol`, `sire_api`) está en ese estado; `no_configurada` = tipo sin fila. `q` busca prefijo de RUC o fragmento de razón social (comodines escapados, máx. 100 caracteres). Cada fila trae responsable, perfil fiscal resumido y el estado de ambas credenciales (solo estado, ningún secreto). Orden por razón social e id; sin paginación (tope práctico 720 activos).
- D8 Lint de `sql` (era D11 del borrador): no se relaja el veto a la plantilla `sql` de drizzle. Las consultas nuevas viven en repositorios de `packages/db` y se cierra el hueco `import * as d from "drizzle-orm"` en la regla (`.raw` y `set_config` siguen prohibidos).
- D9 Nivel y partición (eran P2 y P3; decisión del usuario, 2026-11-03: «P2 = nivel B con una ronda adversarial acotada a credenciales e importación» y «P3 = partir en 007a y 007b», ambas la opción recomendada): esta spec es B sin ronda adversarial; la ronda adversarial se hace en 007b.
- D10 Archivos compartidos: `apps/frontend` solo depende de `packages/shared` (esquemas zod, `validarRuc`, DTOs). Dinero: no aplica.
- D11 Filtros (era P7; decisión del usuario, 2026-11-03: opción (a) recomendada): ahora responsable, estado de credencial, archivados y búsqueda por RUC/razón social; «periodo pendiente» y «mensajes sin leer» después.
- D12 Fronteras con otras decisiones del usuario del 2026-11-03: P1 (puerto `ConsultaRuc` con mock y trabajo en cola), P4 (importación parcial) y P5 (RUC existente = error de fila «duplicado») son de 007b (sus D1, D5 y D6).

## Criterios de aceptación
Entre paréntesis, el CA del borrador de 007 (commit 0bbddf6).
- [x] CA-1 (borrador CA-1): Dado un RUC con dígito verificador inválido o prefijo no permitido, cuando se crea, entonces 400; con RUC válido se crea, aparece en el listado y, sin razón social, queda como «RUC <número>». Con `responsableId` válido queda asignado como responsable.
- [x] CA-2 (CA-2): Dado un estudio con el cupo lleno, cuando se crea o reactiva, entonces 409 `cupo_rucs` y no se escribe nada; archivar uno libera el cupo (`/plan/uso` cuenta solo activos); un RUC repetido da 409 `ruc_duplicado`.
- [x] CA-3 (CA-4): Dado un asistente con 15 de 120 clientes, cuando lista, busca o abre por URL un cliente ajeno, entonces ve solo 15 y el ajeno da el mismo 404 que uno inexistente (también al editar, archivar y reactivar).
- [x] CA-4 (CA-11): Dados datos fiscales (régimen, zona, exoneradas/mixtas, moneda), cuando se guardan con valores fuera del catálogo, entonces 400; los válidos se leen igual al recargar.
- [x] CA-5 (CA-10): Dado un cliente archivado, entonces es de solo lectura (409 `cliente_archivado` al editar o asignar), no cuenta para el cupo, sus credenciales siguen cifradas, y un trabajo encolado o `programado` suyo queda `cancelado` con `acceso_retirado` al despachar; al reactivar (con cupo) vuelve a despacharse.
- [x] CA-6 (nuevo, D7 y D11): Dados clientes con distinto responsable, estado de credencial y archivado, cuando se filtra por cada criterio y por sus combinaciones, entonces solo salen los que cumplen todos, dentro del alcance del usuario; `q` con `%`, `_` o comillas no altera la consulta.
- [x] CA-7 (CA-13): Dadas operaciones concurrentes de crear, archivar, reactivar y asignar sobre los mismos clientes, entonces no hay interbloqueos (sin 500 por 40P01), se respeta el orden de bloqueo de 005 y la suma de activos nunca excede el límite.
- [x] CA-8 (CA-14): Dada la regla de lint, entonces `import * as d from "drizzle-orm"` con `d.sql` también se rechaza en `apps/backend`.
- [x] CA-9 (nuevo): Dado el frontend, entonces el listado aplica los filtros, el alta muestra el error de RUC en línea (con `validarRuc`), el detalle edita los datos fiscales, archivar/reactivar piden confirmación y el 409 `cupo_rucs` se muestra con el uso del plan; quien no tiene `clientes.crear`/`editar`/`archivar` no ve esas acciones.
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 002 (RLS), 004 (sesión), 005 (acceso, asignaciones, `ClienteScopeGuard`), 006 (cupo, `/plan/uso`), 008 (despacho y su revalidación, D17).
- Externas: ninguna.

## Preguntas abiertas
- Ninguna. (P1–P7 respondidas el 2026-11-03; ver D6, D9, D11 y D12.)
