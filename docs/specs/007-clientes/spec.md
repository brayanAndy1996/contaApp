# Spec 007 · Clientes, perfil fiscal, importación y credenciales (UI)

Estado: borrador (pendiente de aprobación; hay preguntas abiertas)
Nivel de riesgo: B — (2) sí: guarda y administra claves SOL/API SIRE y filtra clientes por alcance; (4) sí: importación masiva y cupo con concurrencia; (1) no; (3) parcial. Por §2.1 literal ((2) y otra) saldría A: ver P2.
Cubre: RF-030, RF-031, RF-032, RF-033, RF-034, RF-035, RF-036, RF-037, RF-039 (parcial, P7) · HU-06, HU-09, HU-10 (parcial: estado visible; la notificación en la app es de 017). RF-038 sigue en R2.

## Objetivo
Que el contador dé de alta clientes (uno a uno o desde Excel), registre su perfil fiscal y sus claves de forma que solo se escriban (nunca se lean), compruebe que funcionan y vea el estado de cada credencial y de los trabajos que encola. Es la primera spec con UI que encola trabajos (008 D15).

## Alcance
- Migración (desde 0026): `cliente` gana perfil fiscal, datos de contribuyente y `archivado_at`; FK `credencial(tenant_id, cliente_id) → cliente(tenant_id, id)`.
- API de clientes: crear, editar, archivar/reactivar, listar con filtros; ampliar la lectura mínima de 005.
- Importación Excel/CSV con plantilla, vista previa y confirmación; credenciales cifradas con el repositorio de 003.
- Credenciales: guardar (solo escritura), estado por tipo, botón «Verificar» (trabajo en cola con adaptadores mock).
- Frontend: listado, alta, detalle (datos fiscales, credenciales, trabajos), asistente de importación y panel de trabajos con SSE.

## Fuera de alcance
- Eliminación definitiva de un cliente (RF-038, R2). Notificación en la app por credencial inválida (RF-160, 017). Auditoría (017).
- Adaptadores reales de SUNAT (consulta de RUC, login SOL, token SIRE): 009. Aquí solo puertos y mock.
- Filtros por «periodo pendiente» y «mensajes sin leer» (RF-039): sus datos llegan con las specs de SIRE y buzón (P7).
- Roles personalizados y cambios de asignación (005, ya hechos).

## Decisiones
- D1 Esquema: `cliente` agrega `estado_contribuyente`, `condicion_contribuyente` (nulos hasta consultar), `regimen` (`rg|rmt|rer|nrus`), `zona` (`general|amazonia`), `ventas_exoneradas` y `ventas_mixtas` (booleanos), `moneda_habitual` (`PEN|USD`), `archivado_at`. Todos con CHECK; el perfil fiscal es opcional al crear (RF-036; lo consume RF-113 en R2).
- D2 RUC: `validarRuc` (11 dígitos, prefijo 10/15/16/17/20, dígito verificador módulo 11) es función pura en `packages/shared` para que backend y frontend la compartan; el backend la aplica siempre.
- D3 Permisos y alcance: crear/importar `clientes.crear`; editar `clientes.editar`; archivar/reactivar `clientes.archivar`; guardar y verificar credenciales `credenciales.editar`; importar con claves exige `clientes.crear` y `credenciales.editar`. Toda ruta con `:clienteId` usa `ClienteScopeGuard` (inexistente, ajeno y no asignado dan el mismo 404) y todo listado `filtroAlcance`.
- D4 Cupo y bloqueo: crear, importar y reactivar siguen el orden global de 005/006: `bloquearMiembros` del actor, luego `CupoRucs.reservar(tx, tenantId, n)` y después `cliente`, con asignaciones al final. Sin cupo: 409 `cupo_rucs`. `contarRucs` (`packages/db/src/planes/cupo.ts`) y `uso.ts` cuentan solo `archivado_at IS NULL`. RUC repetido en una carrera: 409 `ruc_duplicado` (unique `(tenant_id, ruc)`).
- D5 Archivado: `archivado_at` libera cupo y deja el cliente en solo lectura: editar, credenciales, verificar y asignar dan 409 `cliente_archivado`; el listado lo oculta salvo `archivados=1`. Se agrega «no archivado» a la revalidación del despacho de 008 (D17): el trabajo, también el `programado`, queda `cancelado` con `acceso_retirado`. Reactivar pasa por D4 (puede dar 409 `cupo_rucs`).
- D6 Credenciales: `PUT /clientes/:id/credenciales/:tipo` (`sol` = usuario + clave; `sire_api` = client_id + secret). Cifra el backend con el repositorio de 003 (`ON CONFLICT … DO UPDATE` con parámetros, sin `EXCLUDED`); responde solo el estado, `Cache-Control: no-store`. Ninguna ruta, log, error, exportación ni estado de UI devuelve o conserva el secreto; el formulario se vacía al guardar. Guardar reinicia el estado a `configurada` (trigger de 008).
- D7 Estado: `GET /clientes/:id/credenciales` da, por tipo, `no_configurada|configurada|verificada(fecha)|invalida(motivo)`; el listado trae el resumen. «Inválida» ya impide reintentos (008, RF-044); aquí solo se muestra.
- D8 Verificar: dos tipos en el catálogo de 008, `credencial.verificar_sol` y `credencial.verificar_sire`, con permiso `credenciales.editar`, prioridad de usuario y procesador en el worker, que es quien descifra. Puertos nuevos en `packages/sunat/src/puertos.ts` (`SolAuth`) más `SireAuth` existente, ambos con mock; el resultado se escribe en el estado de la credencial. Tras verificar `sire_api` el trabajo SIRE deja de cancelarse (008 D23); la UI muestra el aviso «si cambió la clave SOL, guarde o verifique de nuevo la credencial SIRE».
- D9 Importación: `.xlsx` o `.csv`, hasta 1.000 filas y 2 MB (y tope de tamaño descomprimido). Dos fases sin estado en el servidor: `vista-previa` y `confirmar` reciben el archivo (memoria, nunca a disco ni a logs) y `confirmar` revalida todo dentro de la transacción de cupo. La vista previa muestra por fila válida/error y motivos (RUC inválido, duplicado en archivo o en el estudio, columna faltante, responsable inexistente o que no puede serlo) y claves como ••••; resumen con filas válidas, con error y cupo restante/excedente. La plantilla se genera en memoria sin datos de ningún estudio.
- D10 Panel de trabajos: lista (`GET /trabajos`) y SSE (`/trabajos/stream`) de 008 consumidos desde el navegador por el rewrite `/api/*` de Next. Debe comprobarse con Next y backend reales que los eventos llegan sin buffering ni compresión (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `compress` desactivado si hace falta), con reconexión y respaldo por sondeo. El stream no renueva la sesión (004).
- D11 Lint de `sql`: no se relaja el veto a la plantilla `sql` de drizzle. Las consultas nuevas viven en repositorios de `packages/db` y se cierra el hueco `import * as d` en la regla (`.raw` y `set_config` siguen prohibidos).
- D12 `apps/frontend` solo depende de `packages/shared` (esquemas zod, `validarRuc`, DTOs). Dinero: no aplica.

## Criterios de aceptación
- [ ] CA-1: Dado un RUC con dígito verificador inválido o prefijo no permitido, cuando se crea o importa, entonces 400 / error de fila; con RUC válido se crea y aparece en el listado.
- [ ] CA-2: Dado un estudio con el cupo lleno, cuando se crea, importa o reactiva, entonces 409 `cupo_rucs` y no se escribe nada; archivar uno libera el cupo (`/plan/uso` cuenta solo activos).
- [ ] CA-3: Dadas dos importaciones simultáneas que juntas superan el cupo, entonces la suma de clientes activos no excede el límite y la otra recibe 409 `cupo_rucs`.
- [ ] CA-4: Dado un asistente con 15 de 120 clientes, cuando lista, busca o abre por URL un cliente ajeno, entonces ve solo 15 y el ajeno da el mismo 404 que uno inexistente (también en credenciales, verificar y archivar).
- [ ] CA-5: Dado el Excel de la plantilla, cuando se sube, entonces la vista previa muestra errores por fila, cupo restante y excedentes, sin ninguna clave (••••); al confirmar se crean los clientes, las credenciales quedan cifradas (AAD con tenant, cliente y tipo) y el archivo no queda en disco ni en logs.
- [ ] CA-6: Dado un archivo con fórmulas, filas repetidas, más de 1.000 filas, o que excede el tamaño permitido, entonces se rechaza o se marca por fila, sin error 500 ni consumo desmedido.
- [ ] CA-7: Dado que se guardan credenciales, entonces la respuesta, los logs y los errores no contienen el secreto, ninguna ruta lo devuelve, el estado pasa a «Configurada» y el formulario queda vacío.
- [ ] CA-8: Dado «Verificar», entonces se encola un trabajo visible en el panel; con mock exitoso el estado pasa a «Verificada (fecha)» y con mock de clave errada a «Inválida (motivo)» sin reintentos.
- [ ] CA-9: Dado un cliente con credencial inválida y otra con SIRE cancelada por D23, cuando se guarda o verifica de nuevo, entonces los trabajos SIRE vuelven a despacharse; la UI muestra el aviso de cambio de clave SOL.
- [ ] CA-10: Dado un cliente archivado, entonces es de solo lectura (409 `cliente_archivado` al escribir), no cuenta para el cupo y un trabajo encolado o programado de ese cliente queda `cancelado` con `acceso_retirado` al despachar.
- [ ] CA-11: Dados datos fiscales (régimen, zona, exoneradas/mixtas, moneda), cuando se guardan con valores fuera del catálogo, entonces 400; los válidos se leen igual al recargar.
- [ ] CA-12: Dado el panel de trabajos abierto en el navegador con el stack real, cuando un trabajo cambia de estado, entonces el evento llega antes de que cierre la conexión (sin buffering del proxy de Next).
- [ ] CA-13: Dadas operaciones concurrentes de crear/importar/archivar/asignar sobre los mismos clientes, entonces no hay interbloqueos (sin 500 por 40P01) y se respeta el orden de bloqueo de 005.
- [ ] CA-14: Dada la regla de lint, entonces `import * as d from "drizzle-orm"` con `d.sql` también se rechaza en `apps/backend`.
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 002 (RLS), 003 (cifrado/repositorio), 004 (sesión), 005 (acceso, asignaciones), 006 (cupo), 008 (cola, estado de credencial).
- Externas: ninguna. Adaptadores en `mock`; los reales llegan con 009.

## Preguntas abiertas
- P1 Consulta de RUC (RF-030 autocompleta razón social, estado y condición; el Excel de RF-031 no trae razón social; el backend no puede llamar a SUNAT).
  - a) (Recom.) Puerto `ConsultaRuc` con mock y trabajo `cliente.consultar_ruc` en cola que completa los datos; mientras tanto la razón social es la del formulario/columna opcional o «RUC <número>». Respeta RF-040 y no cambia al llegar el adaptador real de 009.
  - b) Razón social manual y obligatoria; el autocompletado se difiere a 009 (RF-030 queda parcial y el Excel necesita esa columna).
- P2 Nivel de riesgo. §2.1 literal da A ((2) y (4)); la tabla de §4 dice B.
  - a) (Recom.) B con TDD y una ronda adversarial acotada a credenciales solo-escritura, importación y cupo concurrente: cubre el riesgo real sin el costo de A.
  - b) B puro (sin adversarial).
  - c) A completo (TDD, hasta 2 rondas y revisión final de opus).
- P3 Tamaño: son 8 RF, 3 HU, UI y panel con SSE.
  - a) (Recom.) Partir en 007a (RF-030, 036, 037, 039, esquema, cupo, archivado, consulta de RUC, listado) y 007b (RF-031 a 035, importación, credenciales, verificar, panel de trabajos y SSE): cada mitad queda revisable y la 007b ya parte de clientes estables.
  - b) Una sola spec.
  - c) En tres: 007a clientes, 007b credenciales + panel, 007c importación.
- P4 Importación con errores o exceso de cupo.
  - a) (Recom.) Crear las filas válidas hasta el cupo, en orden de archivo, y reportar el resto como «no importadas»: coincide con RF-031 (muestra cuántas exceden antes de confirmar).
  - b) Todo o nada: si hay un error o exceso no se importa nada.
- P5 RUC del Excel que ya existe en el estudio.
  - a) (Recom.) Error de fila «duplicado» (HU-06); si está archivado, el mensaje indica reactivarlo. Las claves se actualizan por el formulario.
  - b) Actualizar credenciales y responsable del existente.
- P6 Credenciales de un cliente archivado.
  - a) (Recom.) Conservarlas cifradas; el archivado impide usarlas (D5) y al reactivar no hay que reingresarlas.
  - b) Borrarlas al archivar (menos secretos retenidos, pero hay que volver a pedir las claves al reactivar).
- P7 Filtros de RF-039.
  - a) (Recom.) Ahora: responsable, estado de credenciales, archivados y búsqueda por RUC/razón social; «periodo pendiente» y «mensajes sin leer» se agregan cuando existan sus datos (SIRE y buzón).
  - b) Incluir los cinco filtros ya, con los dos sin datos devolviendo vacío (UI inerte).
