# Tareas 023 · Buzones SOL: captura y aviso crítico

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con las indicadas (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel A (spec). Flujo 04 §1.3: pruebas primero (rojo) → implementar (verde) → cobertura → atacar (2 rondas) → corregir (con pruebas del tester) → prueba manual → verificar → revisión de Opus → cerrar. Rama `spec/023-buzones-captura`. CA, D y P (decididas el 2026-11-17) = `spec.md`; contratos y decisiones = `plan.md`. Migraciones 0054–0056 (T11) y 0057–0058 (T18, T21).

| #   | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
| --- | ----- | --- | ------ | ---------- | --- | --- | ------ |
| T1  | Pruebas de dominio: clasificación, franjas, plan de captura, aviso, adjuntos, HTML → texto (rojo) | tester | sonnet | — ∥ T2, T3, T4 | ✓ | — | [x] |
| T2  | Pruebas de `shared/buzon`, `buzon_critico`, acciones de auditoría y catálogo de la cola (rojo) | tester | sonnet | — ∥ T1, T3, T4 | ✓ | — | [x] |
| T3  | Pruebas del puerto `SolPortal` y de `MockSolPortal` (rojo) | tester | sonnet | — ∥ T1, T2, T4 | ✓ | — | [x] |
| T4  | Pruebas de BD: tablas, RLS, grants, funciones acotadas, candado del ciclo, aviso, auditoría, concurrencia (rojo) | tester | sonnet | — ∥ T1, T2, T3 | ✓ | — | [x] |
| T5  | Pruebas del worker: captura, apertura y programador con varios workers (rojo) | tester | sonnet | T2 ∥ T6, T7, T8–T11 | ✓ | — | [x] |
| T6  | Pruebas HTTP y de fronteras: rutas de buzón, bajo demanda, lectura, descarga (rojo) | tester | sonnet | T2 ∥ T5, T7, T8–T11 | ✓ | — | [x] |
| T7  | Pruebas de componentes: botón, lista, detalle, campana, nombres de trabajos (rojo) | tester | sonnet | T2 ∥ T5, T6, T8–T11 | ✓ | — | [x] |
| T8  | Dominio: `packages/domain/src/buzon/` | backend | opus | T1 ∥ T9, T10, T11 | ✓ | — | [x] |
| T9  | `shared` y `queue`: contratos, tipos de trabajo y repetible de sistema | backend | sonnet | T2 ∥ T8, T10, T11 | ✓ | — | [x] |
| T10 | `sunat`: `SolPortal`, `MockSolPortal`, fixtures y selección en el worker | backend | sonnet | T3 ∥ T8, T9, T11 | ✓ | — | [x] |
| T11 | Migraciones 0054–0056, esquema drizzle y `packages/db/src/buzon/` | backend | opus | T4 ∥ T8, T9, T10 | ✓ | — | [x] |
| T12 | Worker: `sol.buzon.revisar`, `sol.buzon.abrir` y `buzon.programar` | backend | opus | T5, T8, T9, T10, T11 ∥ T13, T14 | ✓ | — | [x] |
| T13 | Backend: módulo `buzon` | backend | sonnet | T6, T9, T11 ∥ T12, T14 | ✓ | — | [x] |
| T14 | Frontend: botón en la ficha, vista mínima, campana y panel de trabajos (estilo A) | frontend | sonnet | T7, T9 ∥ T10–T13 | ✓ | — | [x] |
| T15 | Cobertura ≥ 90 %: `domain/buzon`, `db/buzon`, mock, módulo `buzon`, procesadores; en CI | devops | haiku | T12, T13 ∥ T14 | — | — | [x] |
| T16 | Ronda adversarial 1: aislamiento, permisos, storage, adjuntos y contenido hostiles, secretos (≤ 15 pruebas) | adversario | opus | T12, T13, T15 ∥ T14, T22 | — | ✓ | [x] |
| T17 | Pruebas de las correcciones de la ronda 1 (rojo) | tester | sonnet | T16 | ✓ | — | [x] |
| T18 | Corregir los hallazgos de la ronda 1 (migración 0057 si hace falta) | backend | opus | T17 | — | — | [x] |
| T19 | Ronda adversarial 2: programador y cola, capturas cortadas, avisos, clasificación disfrazada (≤ 15 pruebas) | adversario | opus | T18 | — | ✓ | [x] |
| T20 | Pruebas de las correcciones de la ronda 2 (rojo) | tester | sonnet | T19 | ✓ | — | [x] |
| T21 | Corregir los hallazgos de la ronda 2 (migración 0058 si hace falta) | backend | opus | T20 | — | — | [x] |
| T22 | E2E prioridad 1: «Revisar buzón ahora» → crítico → campana → «Abrir» → contenido y adjunto | tester | sonnet | T12, T13, T14 ∥ T16–T21 | — | — | [x] |
| T23 | Prueba manual con el sistema levantado y adaptadores en `mock` | tester | sonnet | T21, T22 | — | — | [x] |
| T23a | Defectos de pantalla de la prueba manual (T23a-1 a T23a-5) | frontend | sonnet | T23 | — | — | [x] |
| T24 | Verificar CA-1 a CA-13 con evidencia, suites completas, `db:migrate` ×2 y cobertura | tester | sonnet | T23 | — | — | [x] |
| T25 | Revisión final contra la spec | arquitecto | opus | T24 | — | — | [ ] |
| T25a | Pruebas de los defectos de la revisión final (rojo) | tester | sonnet | T25 | ✓ | — | [ ] |
| T25b | Corregir los defectos de la revisión final | backend | opus | T25a | — | — | [x] |
| T26 | Cierre: `tasks.md`, `spec.md` y commit (el orquestador actualiza `ESTADO.md`) | devops | haiku | T25b | — | — | [ ] |

Paralelismo (por oleadas; dentro de una oleada no se comparten archivos):
- **Oleada 1**: T1 (`packages/domain/src/buzon/*.spec.ts`) ∥ T2 (`packages/shared/src/buzon/`, `packages/queue/src/*-023.spec.ts`) ∥ T3 (`packages/sunat/src/mock/sol-portal*.spec.ts`) ∥ T4 (`tests/aislamiento/buzon-*`, `packages/db/src/buzon/*.spec.ts`).
- **Oleada 2**: T5 (pruebas del worker) ∥ T6 (pruebas del backend y `tests/limites/`) ∥ T7 (pruebas del frontend), que necesitan los nombres de T2; a la vez, cada implementación de un paquete empieza en cuanto están sus pruebas: T8 (`domain`) tras T1 ∥ T9 (`shared`, `queue`) tras T2 ∥ T10 (`sunat`, `fixtures/sol/`, `apps/worker/src/adaptadores/`) tras T3 ∥ T11 (`packages/db`) tras T4. Hasta siete tareas a la vez.
- **Oleada 3**: T12 (`apps/worker/src/trabajos/`) ∥ T13 (`apps/backend/src/modules/buzon/`, `app.module.ts`) ∥ T14 (`apps/frontend/`). T14 puede empezar en la oleada 2 (tras T7 y T9): trabaja contra el contrato de `shared` y sus pruebas simulan la API. T15 ∥ T14.
- **Ataque y E2E**: las rondas y sus correcciones van en serie (T16 → T18 → T19 → T21). T22 ∥ T16–T21 (archivos de `tests/e2e/`). Si una ronda no deja fallos, se saltan sus dos tareas de corrección (se marcan `[x]` «sin hallazgos»).
- T10 toca `apps/worker/src/adaptadores/adaptadores.module.ts` y T12 no; T12 toca `apps/worker/src/trabajos/iniciar.ts` y T10 no. T9 es la única que edita `packages/queue/src/worker/index.ts`; T11 la única que edita `packages/db/src/trabajos/sistema.ts`.

Escalamientos: T8, T11 y T12 nacen en `opus` (clasificación crítica, RLS y funciones `SECURITY DEFINER`, descifrado y programador concurrente; 04 §3.2). T9, T10, T13 o T14 pasan a `opus` si fallan 2 veces. T15 y T26 pasan a `sonnet` si `haiku` falla una vez. T16 y T19 son `opus` por regla; T18 y T21 en `opus` porque tocan funciones acotadas y el programador. Si T23 encuentra defectos de pantalla se añade T23a (frontend · sonnet); si T25 encuentra defectos, T25a (pruebas en rojo) y T25b (corrección), como en 021.

Reglas comunes:

- Un commit por tarea (Conventional Commits `test(023): …`, `feat(023): …`, `fix(023): …`, `chore(023): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push del subagente: el orquestador lo hace.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` ajenos: `git add <rutas>` explícitas, nunca `-A` ni `.`. Nunca leer ni imprimir `.env`. Sin `reset`, `stash` ni `clean`.
- Ningún log, error, `resultado`, `params` de notificación ni `datos` de auditoría con clave o usuario SOL, asunto, contenido, nombre de adjunto ni RUC (D-10). Las pruebas usan canarios en esos campos y los buscan en todos esos lugares.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo. Correr solo las pruebas del paquete afectado; las suites completas, en T24.
- El tester no toca código de producción; backend y frontend no editan `*.spec.ts` ajenos; solo T16 y T19 escriben `*.adv.spec.ts` / `*.adv.int.spec.ts`. Las pruebas de las correcciones las escribe el tester, no quien corrige.
- Migraciones: 023 usa **0054–0056** y, si hacen falta, **0057–0058**; confirmar con `ls packages/db/migrations` y el diario antes de crear; nunca editar una aplicada (0043 tampoco: los destinatarios se copian en una función nueva). Las pruebas de 002–022 siguen en verde.
- Toda consulta de negocio dentro de `withTenant()`; nunca desactivar RLS. `apps/backend` no importa `@contapp/sunat` ni descifra. Adaptadores en `mock`. Sin dependencias nuevas.
- Tiempo: el dominio recibe `ahora`; el candado y las franjas en BD usan `clock_timestamp()`. Ninguna prueba duerme: reloj inyectable o filas fijadas como `contapp_migrator`.
- Una ambigüedad nueva que cambie la spec no se decide: `requiere usuario` y se informa al orquestador.

## T1 · [ ] Pruebas de dominio, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-5, D-7, D-9; P-2, P-3, P-5, P-10; CA-1, CA-3, CA-5, CA-6, CA-8), `plan.md` (Contratos: Dominio), `packages/domain/src/texto/normalizar.ts` (lo que ya existe para normalizar), `packages/domain/src/reglas/r-new.spec.ts` (modelo de fixtures), `packages/domain/src/index.ts`.
- **Hacer**: `packages/domain/src/buzon/{clasificar,programacion,captura,adjunto,texto-plano}.spec.ts`. Clasificación (CA-5): tabla con código de tipo y asuntos de las cuatro categorías con tildes, mayúsculas, espacios dobles, «R.D.», «Res. de Multa», «REQ. FISCALIZACIÓN», homoglifos cirílicos (`с`, `о`, `а`) y caracteres de control → críticos con la categoría correcta; código que contradice el asunto → gana el código; palabra clave débil («embargo», «multa» suelta) → crítico `duda`; comunes del fixture → «otro»; `CATALOGO_BUZON.version` ≥ 1 y solo cuatro categorías críticas. Franjas (CA-1): desfase estable en 0..179; plan 720 con ancla 02:40 → vencida a las 14:41 si la última fue 02:41 y no si fue 14:40; plan 1440 → nunca vencida antes de su ancla ni encolable fuera de 02:00–05:00; 60 y 240; cambio de día y de mes en hora de Lima; `null` → vencida; `seleccionarVencidos` respeta `cupo` y el orden. Captura (CA-3, P-5): 450 mensajes en páginas → 200, 200 y 50 sin huecos; conocidos solo actualizan; corte por `MAX_PAGINAS_CAPTURA`; relleno con `cursor_pendiente`; `sincronizado` al final. Aviso (CA-6): primera sincronización con crítico de hace 29 y 31 días; cliente sincronizado avisa siempre; no crítico nunca. Adjuntos (CA-8): `../`, NUL, controles, bidi, nombre vacío y de 300 caracteres; MIME por firma contra lo declarado; 20 MiB exactos y +1; suma que pasa 50 MiB; ZIP opaco. HTML: `<script>`, `<style>`, comentarios, `on*=`, entidades, `<br>` y `<p>`, entrada de 2 MiB.
- **Hecho cuando**: compilan contra las firmas del plan y fallan por «no implementado»; las demás de `domain` siguen verdes. Commit `test(023): dominio de buzones en rojo`.

## T2 · [ ] Pruebas de `shared` y de la cola, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP, Cola; BD 0056 para las acciones), `packages/shared/src/notificaciones/esquemas.ts`, `packages/shared/src/auditoria/acciones.ts`, `packages/shared/src/reglas/` (modelo de módulo), `packages/queue/src/catalogo.ts`, `packages/queue/src/catalogo-016.spec.ts` (modelo), `packages/queue/src/worker/index.ts` (líneas 160–260).
- **Hacer**: `packages/shared/src/buzon/*.spec.ts`: `CATEGORIAS_BUZON`, `mensajeBuzonFilaSchema`, `detalleMensajeSchema` (contenido `string | null`), `listarMensajesQuery` (cursor, `limite` 1..100), `estadoBuzonSchema`, códigos `captura_reciente`, `credencial_no_configurada`, `credencial_invalida`, `cliente_archivado`. `notificacionSchema` acepta `buzon_critico` con `{categoria, mensajeId}` estrictos y rechaza un `asunto` o un RUC en `params`. Acciones de auditoría de 0056. `packages/queue/src/catalogo-023.spec.ts`: `sol.buzon.revisar` y `sol.buzon.abrir` con cola, canal, credencial, permiso, idempotencia y parámetros estrictos; dedupe igual para dos `revisar` del mismo cliente. `packages/queue/src/worker/sistema-023.spec.ts`: `payloadSistemaSchema` acepta `{tipo: "buzon.programar"}` y rechaza claves extra; `programarBuzon()` llama a `upsertJobScheduler` con id fijo y `every: 60000` (cola simulada), dos llamadas → un repetible.
- **Hecho cuando**: fallan por «no implementado»; las de `shared` y `queue` existentes siguen verdes. Commit `test(023): contratos y tipos de trabajo de buzones en rojo`.

## T3 · [ ] Pruebas del puerto y del mock, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-1, D-2; CA-3, CA-4, CA-7, CA-8), `plan.md` (Contratos: Puerto), `packages/sunat/src/puertos.ts` (`SolAuth`, `CredencialSol`), `packages/sunat/src/errores.ts`, `packages/sunat/src/mock/sol-auth.mock.spec.ts` y `xml-provider.mock.spec.ts` (modelo de `inyectar` y `fallar`), `fixtures/LEEME.md`.
- **Hacer**: `packages/sunat/src/mock/sol-portal.mock.spec.ts` y `sol-portal.fixtures.spec.ts`. Buzón determinista por RUC (fixture y generado) con una coactiva, una RD, una RM, un requerimiento y comunes; orden de lo reciente a lo antiguo y cursor estable; `listarMensajes` nunca marca leídos (`leidosMarcados()` vacío) y no cuenta como `obtenerMensaje`; `obtenerMensaje` cuenta llamadas, devuelve HTML o texto y declara `marcaLeido`; adjunto > tope → `omitido: "tamano"` sin leerlo entero; `fallar("credencial" | "transitorio", {veces, despuesDe})` en la página 2; credencial con canarios ausente de los errores; latencia `SOL_MOCK_LATENCIA_MS`. Selección: `SOL_PORTAL=playwright` falla al arrancar (`apps/worker/src/adaptadores/adaptadores.module.spec.ts` no se edita: archivo nuevo `adaptadores-023.spec.ts`).
- **Hecho cuando**: fallan por «no implementado»; las de `sunat` siguen verdes. Commit `test(023): puerto y mock del buzón SOL en rojo`.

## T4 · [ ] Pruebas de BD, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-3 a D-6, D-9; P-2, P-4, P-5, P-8, P-10; CA-1, CA-2, CA-6, CA-9, CA-11, CA-13), `plan.md` (Contratos: BD, Programador, orden de bloqueo), `packages/db/migrations/0037_encolar_xml_obtener.sql` (función de encolado acotada), `0043_notificacion.sql` (líneas 98–170), `tests/aislamiento/trabajos-soporte.ts`, `notificaciones-soporte.ts`, `auditoria-soporte.ts`, `tests/aislamiento/trabajos-encolar-xml.spec.ts` (modelo; no repetir).
- **Hacer**: `tests/aislamiento/buzon-{tablas,programacion,aviso,concurrencia}.spec.ts` y `packages/db/src/buzon/*.spec.ts`. Catálogo: RLS `FORCE`, grants del plan (nadie `DELETE`; backend sin `INSERT` en mensaje; worker sin `UPDATE` de categoría, crítico ni avisado; `buzon_programacion` sin grants directos), FK compuesta que impide adjunto con mensaje de otro cliente, CHECK de rutas con el estudio y cliente de la fila. Aislamiento (CA-9): dos estudios con el mismo id de SUNAT; sin `withTenant` no se ve nada. Programación (CA-1, CA-2): `encolar_buzon_programados` rechaza cliente archivado, sin credencial, `invalida`, estudio sin suscripción o con prueba vencida, cliente con captura viva, cliente de otro estudio y más de `lote_estudio` ids; respeta `max_pendientes_tenant − reserva`; fija tipo, prioridad, clave y `ultima_programada_en`; `buzon_candidatos` y `sistema.estudios_buzon` devuelven solo ids y enteros. Candado: dos `ciclo_tomar` simultáneos → uno; antes del intervalo → vacío; candado vencido → otro lo toma; `renovar` de quien lo perdió → `false`; cambiar `intervalo_min` surte efecto en la siguiente llamada. `buzon_elevar_prioridad`: solo `revisar` en cola del mismo estudio. Aviso (CA-6): trigger con responsable, sin responsable (Dueños y Administradores activos, no desactivados), igual a 0043; crítico sin aviso reciente o de cliente sincronizado → 42501; crítico antiguo en primera sincronización sin aviso → acepta y no notifica; rollback → sin notificación; repetir el `INSERT` con `ON CONFLICT` → una notificación. Auditoría de las cinco acciones con actor y sin datos sensibles. Retención (CA-13): archivar el cliente conserva filas. Concurrencia (CA-11): 10 rondas de programador ∥ «Revisar ahora» (estado → trabajo) sin interbloqueo y con un trabajo vivo; dos inserciones del mismo mensaje → una fila y un aviso por destinatario.
- **Hecho cuando**: fallan por «no implementado»; las de 002–022 siguen verdes. Commit `test(023): BD de buzones en rojo`.

## T5 · [ ] Pruebas del worker, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-5, D-9, D-10; CA-1, CA-3, CA-4, CA-6, CA-7, CA-10, CA-11), `plan.md` (Contratos: Programador, Worker), `apps/worker/src/trabajos/procesadores/verificar-credencial.int.spec.ts` (arnés con credencial SOL y mock), `apps/worker/src/trabajos/procesadores/obtener-xml.int.spec.ts` (storage mock), `apps/worker/src/trabajos/procesadores/auth-purgar.int.spec.ts` (trabajo de sistema), `apps/worker/src/trabajos/notificador.int.spec.ts`.
- **Hacer**: `apps/worker/src/trabajos/procesadores/{revisar-buzon,abrir-mensaje,programar-buzon}.int.spec.ts`. Captura: primera captura del fixture → metadatos, categorías, avisos solo de críticos ≤ 30 días, `obtenerMensaje` sin llamadas y `leidosMarcados()` vacío (CA-4); 450 mensajes en tres capturas (CA-3); repetir no duplica y actualiza leído; `ErrorCredencial` antes del login y en la página 2 (P-4: página 1 guardada con avisos, `invalida`, un aviso, sin reintento; la siguiente con clave nueva continúa); `ErrorTransitorio` → mismo resultado final; dos capturas del mismo mensaje → una fila y un aviso. Apertura: contenido HTML guardado como texto; adjuntos con SHA-256, saneados, omitidos por MIME, tamaño y tope del mensaje; segunda apertura sin llamar al portal; fallo de la transacción → sin archivos sueltos. Programador: con reloj de BD fijado, tres instancias del procesador lanzadas a la vez durante 10 ciclos → cada cliente vencido una vez y un solo ciclo en curso; instancia que muere con el candado → otra lo toma al vencer; estudio de 720 clientes y otro de 1 → el de 1 se encola en el primer ciclo; `BUZON_PROGRAMADOR=off` no registra el repetible. Canarios (CA-10) en usuario, clave, asunto, contenido y nombre de adjunto ausentes de logs, `resultado` y `params`.
- **Hecho cuando**: fallan por «no implementado»; las del worker siguen verdes. Commit `test(023): captura, apertura y programador en rojo`.

## T6 · [ ] Pruebas HTTP y de fronteras, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (D-6, D-8; P-1, P-6; CA-2, CA-4, CA-8, CA-9, CA-10, CA-13), `plan.md` (Contratos: HTTP), `apps/backend/src/modules/compras/descarga.int.spec.ts` (descarga y cabeceras), `apps/backend/src/modules/trabajos/encolador.int.spec.ts` (encolado y publicación), `apps/backend/test/` (sembrado y sesiones), `tests/limites/limites.spec.ts` (modelo de frontera).
- **Hacer**: `apps/backend/src/modules/buzon/{revisar,lectura,abrir,descarga}.int.spec.ts` y `tests/limites/buzon-fronteras.spec.ts`. `revisar`: 202, 200 con la viva, elevación de `programado` (y nuevo puntaje en Redis), 409 de cada caso, 429 con `Retry-After` dentro de 10 min de la última solicitud o captura terminada, 50 pedidos → un trabajo, 403 sin `buzon.ver`, auditoría `captura_solicitada`. Lectura: cursor y orden; detalle con y sin contenido; `contenido_visto` auditado solo con contenido. `abrir`: 403 para Lectura, 202, 200 si ya se obtuvo, dedupe. Descarga: bytes y SHA-256 idénticos, `attachment` con nombre saneado, `nosniff`, `no-store`; adjunto omitido → 404. Aislamiento (CA-9): cliente, mensaje y adjunto de otro estudio, no asignado o cruzados → 404 idéntico al inexistente. Archivado (CA-13): lectura sigue, `revisar` 409. Frontera (CA-10): ningún archivo de `apps/backend/src` importa `@contapp/sunat` ni `@contapp/crypto` para descifrar.
- **Hecho cuando**: fallan por «no implementado» (404 de ruta); las del backend siguen verdes. Commit `test(023): rutas de buzón en rojo`.

## T7 · [ ] Pruebas de componentes, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (P-1, P-6, P-9; CA-2, CA-4, CA-6, CA-8), `plan.md` (Contratos: Frontend), `apps/frontend/components/notificaciones/notificaciones.spec.tsx` (modelo de simulación de la API), `apps/frontend/components/reglas/tabla-reglas-cliente.spec.tsx` (modelo de tabla), `apps/frontend/diseno.estatico.spec.ts` (lo que exige el estilo A).
- **Hacer**: `apps/frontend/components/buzon/{revisar-buzon,lista-mensajes,detalle-mensaje}.spec.tsx` y `components/notificaciones/buzon-critico.spec.tsx` (archivo nuevo; no editar los existentes). Botón: estados encolado (enlace al panel), 429 con minutos, deshabilitado con motivo (archivado, sin credencial, `invalida`). Lista: «Crítico · Coactiva» como texto, fecha y leído en SUNAT. Detalle: contenido con `<script>` mostrado como texto (ningún nodo `script` ni atributo `on*` en el DOM), adjuntos como enlaces, omitidos con motivo, «Abrir en SUNAT» solo con `buzon.marcar_leido` y tras confirmar en el diálogo. Campana: texto de `buzon_critico` con cliente y categoría y enlace a `?mensaje=`. Panel de trabajos: nombres de los dos tipos. Componentes de `components/ui` y sin colores fuera de los tokens.
- **Hecho cuando**: fallan por componente ausente; las del frontend siguen verdes. Commit `test(023): pantallas de buzón en rojo`.

## T8 · [ ] Dominio (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Dominio; Decisiones técnicas), pruebas de T1, `packages/domain/src/texto/{normalizar,index}.ts`, `packages/domain/src/index.ts`, `packages/shared/src/buzon/` (si T9 ya lo dejó; si no, los códigos del plan).
- **Hacer**: `packages/domain/src/buzon/{catalogo,normalizar,clasificar,programacion,captura,adjunto,texto-plano,index}.ts`; exportar por la lista cerrada de `index.ts`. Sin IO, sin `Date.now()` (todo con `ahora`), sin dependencias nuevas.
- **Hecho cuando**: las de T1 y todas las de `domain` pasan; typecheck y lint limpios (incluidos los de `tests/limites/dominio*`). Commit `feat(023): clasificación, franjas y captura del buzón en el dominio`.

## T9 · [ ] `shared` y `queue` (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP, Cola), pruebas de T2, `packages/shared/src/{index.ts,notificaciones/esquemas.ts,auditoria/acciones.ts}`, `packages/queue/src/{catalogo,index}.ts`, `packages/queue/src/worker/index.ts` (líneas 160–260).
- **Hacer**: `packages/shared/src/buzon/` (esquemas, respuestas, errores, `CATEGORIAS_BUZON`); `buzon_critico` en `notificacionSchema`; acciones de auditoría; `SOL_BUZON_REVISAR` y `SOL_BUZON_ABRIR` registrados; `buzon.programar` en `payloadSistemaSchema` y `programarBuzon()` en `ColaSistema`.
- **Hecho cuando**: las de T2 y todas las de `shared` y `queue` pasan; `build` de ambos y typecheck de los consumidores limpios (un `switch` exhaustivo que falle por `buzon_critico` o `buzon.programar` se anota para T12/T14, no se arregla aquí). Commit `feat(023): contratos y tipos de trabajo de buzones`.

## T10 · [ ] `sunat`: puerto y mock (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Puerto), pruebas de T3, `packages/sunat/src/{puertos,errores,index}.ts`, `packages/sunat/src/mock/{sol-auth.mock,xml-provider.mock,ruta-fixture}.ts`, `apps/worker/src/adaptadores/adaptadores.module.ts`, `fixtures/LEEME.md`.
- **Hacer**: `SolPortal` y sus tipos en `puertos.ts`; `mock/sol-portal.mock.ts`; `fixtures/sol/buzon/` (un RUC de `rucs-prueba.json` con las cuatro categorías, variantes de asunto y adjuntos PDF, XML, PNG, ZIP y uno hostil) y su línea en `LEEME.md`; token `SOL_PORTAL` en `adaptadores.module.ts` con la misma variable que `SolAuth`.
- **Hecho cuando**: las de T3 y todas las de `sunat` y del módulo de adaptadores pasan; `fixtures.humo.spec.ts` verde; typecheck y lint limpios. Commit `feat(023): puerto SolPortal y MockSolPortal`.

## T11 · [ ] Migraciones y `packages/db` (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: BD, Programador, orden de bloqueo; Riesgos), pruebas de T4, `packages/db/migrations/0037_encolar_xml_obtener.sql`, `0038_compra_worker_sin_update.sql` (trigger acotado del worker), `0042_auditoria_capturas.sql` (una captura y su trigger), `0043_notificacion.sql` (líneas 98–170), `0045_auditoria_ronda_r1.sql` (CHECK de acciones), `0053_compra_version_operacion_parcial.sql` (cabecera), `meta/_journal.json` (última entrada), `packages/db/src/schema/{trabajos,notificaciones,index}.ts`, `packages/db/src/trabajos/{sistema,registro}.ts`, `packages/db/src/xml/documentos.ts` (modelo de repositorio).
- **Hacer**: 0054–0056 según el plan (repetibles: `CREATE OR REPLACE`, `DROP … IF EXISTS`, `GRANT`/`REVOKE`; DDL de drizzle para las tablas), entradas 54–56 del diario y snapshots, `schema/buzon.ts`, `src/buzon/{lectura,escritura,programacion,index}.ts` y en `trabajos/sistema.ts` `estudiosBuzon`, `tomarCiclo`, `renovarCiclo`, `soltarCiclo`. No editar 0043.
- **Hecho cuando**: `pnpm db:migrate` dos veces en verde; las de T4 pasan (`pnpm test:aislamiento -- tests/aislamiento/buzon-*` y `pnpm --filter @contapp/db test`); las de 002–022 siguen verdes; typecheck y lint limpios. Commit `feat(023): tablas, funciones acotadas y candado del buzón`.

## T12 · [ ] Worker (backend · opus)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Programador, Worker), pruebas de T5, `apps/worker/src/trabajos/procesadores/{verificar-credencial,obtener-xml,auth-purgar}.ts` (descifrado, storage, sistema), `apps/worker/src/trabajos/{iniciar,registro,notificador,encolar-xml}.ts`, exports de `packages/db/src/buzon/index.ts`, `packages/domain/src/buzon/index.ts` y `packages/sunat/src/puertos.ts`.
- **Hacer**: `procesadores/{revisar-buzon,abrir-mensaje,programar-buzon}.ts`; registro de los dos tipos, caso `buzon.programar` en `procesarSistema` y `programarBuzon()` en `iniciar.ts` (salvo `BUZON_PROGRAMADOR=off`); dueño del candado aleatorio por proceso. Medir un ciclo con 2.000 clientes en 3 estudios y anotarlo.
- **Hecho cuando**: las de T5 y todas las del worker pasan (`pnpm --filter @contapp/worker test` y `test:int`); typecheck y lint limpios. Commit `feat(023): captura, apertura y programador del buzón`.

## T13 · [ ] Backend: módulo `buzon` (backend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP), pruebas de T6, `apps/backend/src/modules/trabajos/{encolador,errores}.ts`, `apps/backend/src/modules/compras/{compras.controller,apoyo,errores}.ts` (guard, `exigirCliente`, mapeo de errores), `apps/backend/src/modules/archivos/archivos.controller.ts` (descarga desde storage), `apps/backend/src/modules/storage/storage.module.ts`, `apps/backend/src/app.module.ts`.
- **Hacer**: `apps/backend/src/modules/buzon/` con las rutas del plan; validación con `shared`; `Cache-Control: no-store`; 404 uniforme; `revisar` en el orden del plan (estado `FOR UPDATE` → vivo/elevar → enfriamiento → `encolar` → auditar) y `publicar` tras el commit; descarga en flujo desde storage. Registrar el módulo.
- **Hecho cuando**: las de T6 pasan; las del backend siguen verdes; typecheck y lint limpios. Commit `feat(023): rutas del buzón y revisión bajo demanda`.

## T14 · [ ] Frontend (frontend · sonnet)
- **Contexto (leer solo esto)**: `plan.md` (Contratos: Frontend), pruebas de T7, `docs/specs/038-diseno-visual/plan.md` (solo «Tokens del estilo A» y la lista de componentes), `apps/frontend/components/ui/index.ts`, `apps/frontend/lib/{api,reglas}.ts` (patrón de llamadas, sin editar `reglas.ts`), `apps/frontend/app/(app)/clientes/[clienteId]/page.tsx`, `apps/frontend/app/(app)/clientes/[clienteId]/reglas/page.tsx` (modelo de página), `apps/frontend/components/notificaciones/texto-notificacion.tsx`, `apps/frontend/app/(app)/trabajos/page.tsx`, `apps/frontend/lib/auditoria.ts`.
- **Hacer**: `lib/buzon.ts`, `components/buzon/{revisar-buzon,lista-mensajes,detalle-mensaje}.tsx`, `clientes/[clienteId]/buzon/page.tsx`, botón y enlace en la ficha, caso `buzon_critico` en la campana, nombres de los tipos en el panel de trabajos y textos de las acciones de auditoría. Solo componentes de `components/ui` y tokens; nada de `dangerouslySetInnerHTML`; mensajes de 409/429 en español.
- **Hecho cuando**: las de T7 pasan; las del frontend y `diseno.estatico.spec.ts` siguen verdes; typecheck y lint limpios. Commit `feat(023): revisar buzón, vista mínima y aviso en la campana`.

## T15 · [x] Cobertura (devops · haiku)
- **Contexto (leer solo esto)**: `package.json` (raíz: `cobertura:reglas` como modelo), `.github/workflows/ci.yml`, `packages/domain/vitest.cobertura*.config.mts`, `apps/worker/vitest.cobertura*.config.mts` (modelo).
- **Hacer**: `cobertura:buzon` (`packages/domain/src/buzon/`, `packages/db/src/buzon/`, `packages/sunat/src/mock/sol-portal.mock.ts`, `apps/backend/src/modules/buzon/`, `apps/worker/src/trabajos/procesadores/{revisar-buzon,abrir-mensaje,programar-buzon}.ts`), umbral 90 % en líneas y ramas, paso en CI.
- **Hecho cuando**: `pnpm cobertura:buzon` ≥ 90 % (o lista de lo que falta, sin bajar el umbral) y el paso aparece en `ci.yml`. Commit `chore(023): cobertura de buzones`.

## T16 · [ ] Ronda adversarial 1 (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (completo), `plan.md` (Contratos), 04 §2.3 (catálogo: aislamiento, permisos y alcance, archivos, secretos). Caja negra primero (rutas y funciones públicas); luego caja blanca (0054–0056, `packages/db/src/buzon/`, `apps/backend/src/modules/buzon/`, `apps/worker/src/trabajos/procesadores/abrir-mensaje.ts`, `packages/domain/src/buzon/{adjunto,texto-plano}.ts`).
- **Hacer**: ≤ 15 pruebas `*.adv.spec.ts` / `*.adv.int.spec.ts`: `clienteId`/`mensajeId`/`adjuntoId` de otro estudio, otro cliente o cruzados; cliente desasignado con sesión viva; Lectura que pide «Abrir»; ruta de storage armada a mano o con `..`; llamar a las funciones acotadas con `set_config` de otro estudio, sin estudio o desde el rol equivocado; worker que intenta cambiar categoría o avisado; adjunto con nombre hostil, MIME falso, ZIP bomba y PDF con JavaScript; HTML con `<script>`, `<img onerror>`, entidades que forman etiquetas y comentarios anidados; canarios de clave y usuario SOL en errores del portal, `resultado`, SSE y respuestas.
- **Hecho cuando**: las pruebas están en el repo; cada fallo es un hallazgo `H-023-1-n` con severidad en el resultado de la tarea. Commit `test(023): ronda adversarial 1`.

## T17 · [ ] Pruebas de las correcciones de la ronda 1, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: resultado de T16 (hallazgos), sus pruebas, `spec.md` (los CA citados).
- **Hacer**: una prueba normal (no adversarial) por hallazgo que fije el comportamiento esperado por la spec.
- **Hecho cuando**: fallan por el defecto; commit `test(023): correcciones de la ronda 1 en rojo`.

## T18 · [ ] Corregir la ronda 1 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de T16, pruebas de T16 y T17, solo los archivos que señalan.
- **Hacer**: corregir sin quitar aserciones. Un cambio de BD va en **0057** (repetible). Un hallazgo que exija cambiar la spec se escala: `requiere usuario`. Si toca el frontend, la parte de pantalla la hace `frontend · sonnet` en la misma tarea.
- **Hecho cuando**: las de T16 y T17 pasan; las suites de los paquetes tocados siguen verdes. Commit `fix(023): hallazgos de la ronda 1`.

## T19 · [ ] Ronda adversarial 2 (adversario · opus)
- **Contexto (leer solo esto)**: `spec.md` (completo), `plan.md` (Programador, BD, Worker), 04 §2.3 (catálogo: cola y concurrencia), resultado de T16–T18. Caja negra y luego blanca (`programar-buzon.ts`, `revisar-buzon.ts`, 0055–0057, `packages/domain/src/buzon/{clasificar,normalizar,programacion,captura}.ts`).
- **Hacer**: ≤ 15 pruebas: tres workers con ticks simultáneos y relojes de proceso desfasados; worker que muere con el candado y a mitad de un estudio; intervalo cambiado durante un ciclo; estudio de 720 clientes y otro de 1; cola al tope y «Revisar ahora» con la reserva; 50 «Revisar ahora» seguidos y en paralelo contra el programador; captura cortada antes, durante y después del commit de un mensaje, y apertura cortada entre storage y commit; `ErrorCredencial` en cada página; mismo mensaje en dos capturas; asunto crítico disfrazado (homoglifos fuera del mapa, abreviaturas nuevas, espacios de ancho cero) para que salga «otro»; worker que guarda un crítico reciente sin aviso o encola fuera de la función; primera sincronización que cruza el límite de 30 días.
- **Hecho cuando**: igual que T16 (`H-023-2-n`). Commit `test(023): ronda adversarial 2`.

## T20 · [ ] Pruebas de las correcciones de la ronda 2, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: resultado de T19, sus pruebas, `spec.md` (los CA citados).
- **Hacer / Hecho cuando**: como T17. Commit `test(023): correcciones de la ronda 2 en rojo`.

## T21 · [x] Corregir la ronda 2 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de T19, pruebas de T19 y T20, solo los archivos que señalan.
- **Hacer / Hecho cuando**: como T18; un cambio de BD va en **0058**. Commit `fix(023): hallazgos de la ronda 2`.

## T22 · [ ] E2E prioridad 1 (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-2, CA-4, CA-6, CA-8, CA-12), `tests/e2e/flujos/{notificaciones,lupa}.e2e.ts` (modelo, sin editarlos), `tests/e2e/soporte/{siembra,cola,api}.ts`, `tests/e2e/soporte/selectores/notificaciones.ts`.
- **Hacer**: `tests/e2e/flujos/buzon.e2e.ts` y `soporte/selectores/buzon.ts`, con `BUZON_PROGRAMADOR=off`: cliente con credencial SOL del RUC del fixture → «Revisar buzón ahora» en la ficha → trabajo en el panel → aviso en la campana («Coactiva») → enlace a la vista mínima → «Abrir en SUNAT» y confirmar → contenido como texto → descargar el PDF (SHA-256 igual al del fixture) → segundo «Revisar ahora» → mensaje de espera.
- **Hecho cuando**: `pnpm e2e -- buzon` pasa 3 veces seguidas, sin `retry` ni `test.only`. Commit `test(023): e2e de buzones`.

## T23 · [x] Prueba manual (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA), `docs/specs/019-docker-local/` (cómo levantar el sistema local, solo la sección de arranque), resultado de T23 de `docs/specs/021-reglas-aprendidas/tasks.md` (formato del informe).
- **Hacer**: sistema completo (BD nueva migrada dos veces y sembrada, Redis en un índice propio, backend, frontend y **dos** workers) con adaptadores en `mock`, `SOL_MOCK_LATENCIA_MS` > 0 y el programador encendido con `intervalo_min` bajo (fijado como `contapp_migrator`). A mano y por la interfaz: «Revisar buzón ahora» y su espera; aviso en la campana del responsable y, sin responsable, del Dueño; vista mínima, «Abrir en SUNAT», contenido y descarga de adjuntos (incluido el hostil, omitido); Lectura sin «Abrir»; credencial `invalida` a mitad (`fallar`) y su aviso; cliente archivado; ciclos del programador con los dos workers (una captura por cliente, `ultimo_ciclo_*` en BD) y uno detenido a la fuerza; 1440 × 900 y 390 × 844, teclado y foco. Defectos de pantalla → T23a.
- **Hecho cuando**: resultado con entorno, pasos, lo visto y los defectos (o «sin defectos»); procesos detenidos y Redis vaciado; no se toca código de producción.

**Resultado (2026-11-17 noche de Lima, rama `spec/023-buzones-captura` sobre `c37e079`, Node 22.22.0, Chromium de Playwright 1440×900 y 390×844, es-PE)**

*Entorno.* Sin Docker: PostgreSQL 17 y Redis ya activos; `CORREO_PROVIDER=consola`. BD nueva `contapp_023m` (migrada dos veces y sembrada), Redis índice 11, `SIRE_CLIENT`, `SOL_PORTAL`, `XML_PROVIDER` y `KEY_PROVIDER` en `mock`, `STORAGE=local`, `SOL_MOCK_LATENCIA_MS=1500`. Backend `:4230`, frontend `:3230` (build de producción) y **dos** workers (`BUZON_PROGRAMADOR=off` en la fase 1 y encendido en la fase 2). `buzon_programacion.intervalo_min` = 5 y `plan.frecuencia_buzon_min` del plan `corporativo` = 5, fijados por SQL con la conexión de migraciones (`MIGRATIONS_DATABASE_URL`; `current_user` resultó `postgres`). Un estudio (corporativo) con Dueño, Admin, Contador, Asistente y Lectura, y siete clientes: C1 `20700000002` (fixture del buzón, responsable Contador), C2 `…011` y C5 `…061` y C6 `…070` y C7 `…096` (sin responsable; buzón generado), C3 `…045` (responsable Contador) y C4 `…053` (a archivar). Clave SOL de C1 por la ficha (Guardar y Verificar); las de C2 a C7 por `PUT /credenciales/sol`; todo lo demás por la interfaz. Para `fallar` y un buzón de 230 mensajes (no hay palanca desde la interfaz ni por entorno) se usó un precargador `--import` **fuera del repo** que llama a `MockSolPortal.fallar`/`inyectar` desde un archivo de control y limita la página a 100 (la captura se detiene a los 200 nuevos de la primera página, así que sin eso no hay segunda página). Capturas y harness fuera del repo, en el scratchpad `t23/`.

*Pasos y lo visto (todo en español; sin errores de consola salvo los 409 y 429 que se citan).*
1. «Revisar buzón ahora» (Dueño, C1): sin clave SOL el botón está deshabilitado con «Primero guarda la clave SOL del cliente.». Con ella: «Revisión encolada.» + enlace al panel; el trabajo pasa «Ejecutando» (1,5 s de latencia) a «Completado». Segundo pedido: «Se revisó hace poco. Podrás pedirlo de nuevo en N min.» (429, `Retry-After`); 12 pedidos simultáneos dejan un solo trabajo y la UI dice «Ya hay una revisión en curso.».
2. Campana: C1 tiene responsable (Contador) y solo él recibe los 6 `buzon_critico` («Mensaje crítico en el buzón SOL de CONTRIBUYENTE PRUEBA: Coactiva», etc.; el Dueño solo recibe sus `trabajo_terminado`). C2 y C7 no tienen responsable: reciben Dueño y Admin (5 y 5 críticos) y nadie más. En BD, avisos = mensajes avisados × destinatarios, sin duplicados tras 5 ciclos y reinicios.
3. Vista mínima: lista (asunto, categoría, fecha en Lima, lectura en SUNAT; «Cargar más» con 230 mensajes), detalle sin contenido («El contenido aún no se obtuvo.»), «Abrir en SUNAT» con diálogo «¿Abrir este mensaje en SUNAT?» y «Apertura encolada.»; tras recargar el contenido sale como texto (el HTML de FX-0002 sin etiquetas ni script en el DOM). Descarga del PDF de FX-0001 por el enlace: SHA-256 igual al del fixture; por API `attachment`, `nosniff`, `no-store`; adjunto inexistente 404.
4. Adjuntos de FX-0005: `anexos-requerimiento.zip` se descarga; `recibofdp.exe` y `passwd.pdf` (nombres saneados) salen «Tipo de archivo no permitido» sin enlace; FX-0010 (ZIP de 25 MB) sale «Supera los 20 MB». FX-0003 (PNG) y FX-0002 (PDF y XML) se descargan.
5. Lectura (colaborador asignado por la ficha): ve lista y contenido ya obtenido y baja el adjunto; no ve «Abrir en SUNAT»; `POST …/abrir` por API da 403 `permiso_denegado`; sí puede «Revisar buzón ahora» (`buzon.ver`). Contador sobre un cliente no asignado: 404 en lista y en revisar.
6. Credencial inválida a mitad (C5, `fallar` credencial después de la página 1 de 100): quedan 100 mensajes con 2 avisos, el trabajo termina «Con error · Credencial inválida» sin reintento, la ficha muestra «Inválida» y el botón deshabilitado («La clave SOL fue rechazada por SUNAT. Actualízala para revisar el buzón.»); aviso `credencial_invalida` una vez a Dueño y Admin. Con la clave guardada de nuevo (y pasados los 10 min) la captura continúa: 230 mensajes distintos, 5 críticos y 5 avisos exactamente, `sincronizado_en` fijado. Antes del login (centinela `clave-errada`, C3): no se guarda nada (200 → 200), `invalida`, un aviso al Contador (responsable).
7. Cliente archivado (C4, ya con 12 mensajes): «El cliente está archivado y es de solo lectura.»; «Revisar buzón ahora» deshabilitado en ficha y en la vista; lista y detalle siguen legibles; ningún ciclo lo captura.
8. Programador con dos workers (`intervalo_min` 5): ciclos a las 22:39:48, 22:45:48, 22:50:48, 22:55:48 y 23:00:48 (hora de Lima) con `ultimo_ciclo_inicio`/`fin` en `buzon_programacion`; en cada uno C1, C2, C5, C6 y C7 reciben exactamente un `sol.buzon.revisar` `programado` (5 por cliente en 5 ciclos, ninguno doble), C4 (archivado) y C3 (inválida) ninguno; C3, con la clave corregida, entra en el ciclo siguiente (uno). Un `kill -9` a un worker con su trabajo en curso: el otro retoma los trabajos tras unos 30 s (los demás esperan en cola hasta entonces) y el interrumpido se completa con `intentos=1`; sin pérdidas ni mensajes duplicados. Tras el primer `kill -9` el `ciclo_dueno` de `buzon_programacion` cambió y los ciclos siguieron sin repetirse.
9. 1440×900 y 390×844: sin desborde horizontal de página en ficha, lista, detalle, panel de trabajos ni campana. A 390 la lista de mensajes pierde columnas (T23a-2).
10. Teclado y foco: diálogo de «Abrir» con foco inicial en «Cancelar», Tab atrapado entre «Cancelar» y «Confirmar», Esc lo cierra; enlaces de la lista y botón con contorno visible (2 px); Enter en el aviso de la campana lleva al mensaje. Hallazgos de foco en T23a-3.
11. Secretos (CA-10): en los logs de backend, workers y frontend no aparecen la clave, el usuario SOL, `clave-errada`, RUC, asuntos ni nombres de adjunto. Auditoría: `buzon.captura_solicitada`, `buzon.apertura_solicitada`, `buzon.contenido_obtenido` (con trabajo), `buzon.contenido_visto` y `buzon.adjunto_descargado`.

*Observaciones que no son defecto de 023.* (a) Con dos workers el estado «leído» del mock vive en memoria de cada proceso: tras «Abrir» en uno, la captura en el otro informa «No leído en SUNAT» y baja el valor (FX-0001 abierto aparece «No leído»); con SOL real lo da SUNAT. (b) El enfriamiento de 10 min cuenta también la captura que terminó con error de credencial: quien corrige la clave espera hasta 10 min para «Revisar ahora» (el programador no tiene esa espera); conforme a la spec, se deja para decisión. (c) Los ciclos salen cada 5 o 6 min con `intervalo_min` 5 (ticks de 60 s). (d) Next mantiene la página anterior oculta en el DOM (dos `<main>`, la anterior con `display:none`); y tras navegar por enlaces el foco queda en `body` en toda la app. (e) C5 y C3 muestran mensajes extra (12 generados) porque reiniciar los workers perdió la inyección del harness.

*Defectos de pantalla (T23a, frontend · sonnet). Ninguno bloquea; no hay defectos de backend ni de worker.*
- **T23a-1 · media.** «Revisar buzón ahora» sigue deshabilitado tras guardar la clave SOL en la misma ficha (sin credencial o inválida) hasta recargar la página. `apps/frontend/components/buzon/revisar-buzon.tsx:34-49` (el estado de la credencial se lee una sola vez con `[clienteId]`; `deshabilitado` en `:58` y `:91`). Reproducir: cliente con clave SOL inválida o sin configurar → en su ficha guardar la clave SOL → el botón sigue gris. Captura `24-c5-tras-fix.png`.
- **T23a-2 · media.** A 390 px la tabla de mensajes corta «Categoría» («Crítico · Coactiv…») y esconde Fecha y Lectura en SUNAT tras un desplazamiento interno sin pista; la categoría crítica no se lee. `apps/frontend/components/buzon/lista-mensajes.tsx:25-56` (`Table` con `overflow-x-auto`). Reproducir: viewport 390×844 en `/clientes/:id/buzon` con mensajes. Captura `31-390-lista.png`.
- **T23a-3 · baja.** Foco perdido: (a) Esc o «Cancelar» en «¿Abrir este mensaje en SUNAT?» deja el foco en `body` en vez de volver a «Abrir en SUNAT» (`Dialog` controlado sin disparador, `detalle-mensaje.tsx:222-223`); (b) al pulsar «Revisar buzón ahora» con Enter el botón se deshabilita mientras `ocupado` y el foco cae a `body` (`revisar-buzon.tsx:58,91`; usar `aria-disabled`). Reproducir: foco en el botón con Tab y Enter; en (a) Esc. Captura `11-dialogo-abrir.png`.
- **T23a-4 · baja.** «Abrir en SUNAT» se ofrece habilitado en un cliente archivado y al confirmar responde 409 con el mensaje de solo lectura, mientras «Revisar buzón ahora» sí queda deshabilitado. `apps/frontend/components/buzon/detalle-mensaje.tsx:118,164` (`ofrecerAbrir` no considera `archivado`). Reproducir: archivar un cliente con mensajes → detalle de un mensaje sin contenido → «Abrir en SUNAT» → Confirmar. Captura `28-abrir-archivado.png`.
- **T23a-5 · baja.** Tras «Apertura encolada.» el detalle no se refresca solo («El contenido aún no se obtuvo.» hasta recargar), y Lectura ve ese texto sin saber quién puede abrir el mensaje. `apps/frontend/components/buzon/detalle-mensaje.tsx:118-173`. Reproducir: Contador → «Abrir en SUNAT» → Confirmar y esperar; Lectura → mensaje sin contenido. Capturas `12-apertura-encolada.png`, `16-lectura-sin-abrir.png`.

*Cierre.* Backend, frontend, los dos workers y los monitores detenidos; Redis índice 11 vaciado (`FLUSHDB`); puertos 4230 y 3230 libres; `contapp_023m` se deja sin borrar. No se tocó código de producción ni `contapp`.

## T23a · [x] Defectos de pantalla de la prueba manual (frontend · sonnet)
- **Contexto (leer solo esto)**: la sección «Defectos de pantalla» del resultado de T23 (T23a-1 a T23a-5) y los archivos que cita.
- **Hacer**: corregir los cinco defectos con prueba de componente por cada uno (la ficha habilita el botón al guardar la clave; la lista a 390 px muestra la categoría; foco devuelto al cerrar el diálogo y conservado al revisar; «Abrir» no se ofrece en archivados; el detalle refresca el contenido y explica a Lectura).
- **Hecho cuando**: pruebas del paquete `frontend` en verde y `pnpm e2e -- buzon` sigue pasando; se anota el commit aquí.

## T24 · [x] Verificar (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-13), `tasks.md` (resultados), `package.json` (scripts).
- **Hacer**: cada CA con su evidencia (prueba o comando); suites de `domain`, `shared`, `sunat`, `queue`, `db`, `backend`, `worker`, `frontend`, `test:aislamiento`, `tests/limites`, typecheck, lint, `pnpm db:migrate` ×2, `pnpm cobertura:buzon`, `pnpm ci:db` y `pnpm e2e`.
- **Hecho cuando**: tabla CA → evidencia → OK/falta en el resultado; todo en verde o la lista de lo que falta.

**Resultado (2026-11-19, rama `spec/023-buzones-captura` sobre `76dd485`, Node 22.22.0, BD limpia `contapp_023v`: `db:migrate` ×2 y `db:seed`)**

Suites (todas en verde salvo la cobertura de `db`):

| Suite | Archivos | Pruebas |
|---|---|---|
| `domain` | 130 | 2808 (+3 todo) |
| `shared` | 52 | 2257 |
| `sunat` (`test:int`: sin archivos) | 23 | 353 |
| `queue` / `queue test:int` | 25 / 15 | 559 / 116 |
| `db` | 74 | 1060 |
| `backend` / `backend test:int` | 103 / 125 | 1259 / 3040 |
| `worker` / `worker test:int` | 45 / 42 | 459 / 434 |
| `frontend` | 120 | 1076 |
| `tests/limites` | 14 | 347 |
| `test:aislamiento` | 102 | 2893 |
| `pnpm ci:db` (build, migrate ×2, seed, aislamiento, worker int, backend int) | — | OK |
| `pnpm typecheck` / `pnpm lint` | — | OK / OK |
| `pnpm e2e` (`E2E_CORREO=consola`) | — | 90 pasan, incl. `flujos/buzon.e2e.ts` (2) |
| `pnpm cobertura:buzon` | domain 10/216, sunat 3/91, db 17/241 (FALLA), backend 9/170 (OK), worker 8/78 (OK) | `db`: umbral de 90 % por archivo |

| CA | Evidencia | Estado |
|---|---|---|
| CA-1 | `packages/domain/src/buzon/programacion.spec.ts`, `tests/aislamiento/buzon-programacion.spec.ts`, `buzon-concurrencia.spec.ts`, `apps/worker/src/trabajos/procesadores/programar-buzon.int.spec.ts` | OK |
| CA-2 | `apps/backend/src/modules/buzon/revisar.int.spec.ts` (403, 429 `captura_reciente` con `Retry-After`, 50 pedidos → 1 trabajo), `tests/aislamiento/buzon-programacion.spec.ts` (`buzon_elevar_prioridad`, reserva), `packages/db/src/buzon/solicitud.spec.ts`. Nota (decisión del usuario): una captura que terminó por credencial inválida no cuenta para el enfriamiento de 10 min (`fallaPorCredencialBuzon`; `revisar-credencial-invalida.int.spec.ts`, `solicitud.spec.ts`) | OK |
| CA-3 | `packages/domain/src/buzon/captura.spec.ts`, `captura-r2.spec.ts`, `revisar-buzon.int.spec.ts` (450 en tres capturas, repetir no duplica) | OK |
| CA-4 | `revisar-buzon.int.spec.ts` (`leidosMarcados()` vacío, 0 `obtenerMensaje`), `abrir.int.spec.ts`, `abrir-mensaje.int.spec.ts`, `packages/sunat/src/mock/sol-portal.mock.spec.ts` | OK |
| CA-5 | `packages/domain/src/buzon/clasificar.spec.ts` | OK |
| CA-6 | `tests/aislamiento/buzon-aviso.spec.ts` (responsable, Dueños/Administradores, 42501, primera sincronización, rollback, `ON CONFLICT`), `revisar-buzon.int.spec.ts`, `apps/frontend/components/buzon/buzon-critico.spec.tsx`. Nota (decisión del usuario, tras la ronda 2): una fecha ilegible se guarda con la fecha de captura y la regla de 30 días usa el reloj de la BD (`packages/db/src/buzon/escritura-r2.spec.ts`, `tests/aislamiento/buzon-r2.spec.ts`, `packages/domain/src/buzon/captura-r2.spec.ts`, `sol-portal.mock.validacion.spec.ts`) | OK |
| CA-7 | `revisar-buzon.int.spec.ts`, `buzon-r1.int.spec.ts`, `buzon-r2.int.spec.ts` (`ErrorCredencial` antes del login y en la página 2; `ErrorTransitorio`) | OK |
| CA-8 | `adjunto.spec.ts`, `texto-plano.spec.ts`, `saneo.spec.ts`, `abrir-mensaje.int.spec.ts`, `descarga.int.spec.ts`, `tests/e2e/flujos/buzon.e2e.ts` (descarga idéntica) | OK |
| CA-9 | `tests/aislamiento/buzon-tablas.spec.ts`, `buzon-r1.spec.ts`, `lectura.int.spec.ts`, `abrir.int.spec.ts`, `r1.adv.int.spec.ts`, `descarga.int.spec.ts` | OK |
| CA-10 | `buzon-r1.adv.int.spec.ts`, `buzon-r2.adv.int.spec.ts`, `packages/db/src/buzon/buzon-r2.adv.spec.ts`, `tests/limites/buzon-fronteras.spec.ts` | OK |
| CA-11 | `tests/aislamiento/buzon-concurrencia.spec.ts`, `programar-buzon.int.spec.ts`, `abrir-mensaje.int.spec.ts` | OK |
| CA-12 | tabla de suites de arriba, `pnpm ci:db`, `pnpm e2e` (90/90), `db:migrate` ×2 sobre BD nueva | OK |
| CA-13 | `tests/aislamiento/buzon-tablas.spec.ts` (archivar conserva filas, rutas), `buzon-estado-bloquear.spec.ts` | OK |

**Falta (T24 estaba `[ ]`; cerrado con T24a)**:
- `pnpm cobertura:buzon`, parte `db` (repetida una vez, mismo resultado): `packages/db/src/buzon/solicitud.ts:32` · ramas 88,88 % < 90 %; la rama `t instanceof Date ? t : new Date(String(t))` de `fallaPorCredencialBuzon` (commit 76dd485) no tiene prueba para el caso no-`Date`. Por eso el script encadenado no llegó a `backend` y `worker`; corridos aparte pasan (backend 96,96 % rama; worker 97,32 %).
- Corrección: prueba nueva (tester) que cubra la rama; no se tocó producción.

**T24a (2026-11-19, tester · sonnet)**: dos pruebas nuevas en `packages/db/src/buzon/solicitud.spec.ts` (`terminado_en` como string ISO y como texto de pg con desfase → `Date` del mismo instante). `pnpm cobertura:buzon` completo en verde (exit 0), todo ≥ 90 %: `db` ramas 96,29 % (`solicitud.ts` ya no figura entre los archivos bajo el umbral); `domain` 94,4 %, `sunat` 95,05 %, `backend` 96,96 %, `worker` 97,32 %. Producción sin tocar. Con esto T24 queda `[x]`.

## T25 · [ ] Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, resultado de T24, `git diff main...HEAD --stat` y los archivos que la revisión necesite.
- **Hacer**: contrastar cada CA, D-n y P-n con la evidencia; ratificar o rechazar desvíos del plan (sección «Desvíos ratificados» en `plan.md`).
- **Hecho cuando**: veredicto con lo que falta; si hay defectos, T25a y T25b.

**Resultado (2026-11-19, arquitecto · opus, sobre `8591319`)**: **no aprobado; dos defectos** (T25a/T25b). CA-1 a CA-13 tienen la evidencia de T24 (suites, `ci:db`, `e2e` y `cobertura:buzon` en verde); D-1 a D-10 y P-1 a P-10 se cumplen salvo lo de abajo. Decisiones del usuario U-1 a U-4 añadidas a `spec.md`; desvíos en «Desvíos ratificados» de `plan.md` (cuatro ratificados, uno rechazado).
- **R-1 · alta (D-9, CA-3; disponibilidad).** Una captura no termina si el portal devuelve una página sin mensajes utilizables con `siguiente` no nulo (vacía, o con todos los ids inválidos y descartados por `sanearPagina`): `packages/domain/src/buzon/captura.ts:140` solo corta la página «todo repetido» si `mensajes.length > 0`, y `apps/worker/src/trabajos/procesadores/revisar-buzon.ts:247` no cuenta esa página para `MAX_PAGINAS_CAPTURA`; el `for (;;)` de `revisar-buzon.ts:194` no tiene tope de páginas leídas. Con un cursor que se repite, el trabajo corre sin fin con el lock del RUC y un hueco de la cola `sol` (`concurrencia_global` 2). Comprobado: `planificarCaptura({cursorPendiente:"relleno", …, paginasLeidas:0}, {mensajes:[], siguiente:"p2"}, ∅)` → `terminada: false`.
- **R-2 · baja (D-6, U-4, CA-2).** `fallaPorCredencialBuzon` (`packages/db/src/buzon/solicitud.ts:30`) solo reconoce `estado = 'error'`; una captura que el despachador cancela con `cancelado` + `credencial_invalida` (`packages/queue/src/despachador.ts:257`, credencial invalidada por otro trabajo del cliente mientras esperaba) no se excluye, y tras corregir la clave «Revisar buzón ahora» da 429 hasta 10 min.
- Observaciones sin tarea: los hallazgos `H-023-1-n` y `H-023-2-n` solo constan en comentarios del código, no en el resultado de T16/T19; el enfriamiento usa `Date.now()` del backend frente a instantes de la BD (ver `plan.md`).

## T25a · [ ] Pruebas de los defectos de la revisión final, rojo (tester · sonnet)
- **Contexto (leer solo esto)**: resultado de T25 (R-1, R-2), `plan.md` («Desvíos ratificados»), `spec.md` (U-4), `packages/domain/src/buzon/captura-r2.spec.ts` (modelo), `apps/worker/src/trabajos/procesadores/buzon-r2.int.spec.ts` (modelo con `fallar`/`inyectar`), `packages/db/src/buzon/solicitud.spec.ts`.
- **Hacer**: R-1: en `packages/domain/src/buzon/captura-r3.spec.ts`, una página sin mensajes con `siguiente` no nulo → `terminada: true`, `sincronizado: false` y cursor pendiente no nulo (con y sin relleno); el tope `MAX_PAGINAS_LECTURA` corta con relleno pendiente aunque las páginas sean de conocidos distintos. En `apps/worker/src/trabajos/procesadores/buzon-r3.int.spec.ts`, mock que devuelve siempre una página vacía (y otra con todos los ids inválidos) con un `siguiente` que se repite: el trabajo termina, `listarMensajes` se llama un número acotado de veces y `cursor_pendiente` queda no nulo. R-2: en `solicitud.spec.ts`, la última captura `cancelado` + `credencial_invalida` devuelve su `terminado_en`; `cancelado` con otro motivo devuelve `null`.
- **Hecho cuando**: las nuevas fallan por el defecto; las demás de `domain`, `db` y `worker` siguen verdes. Commit `test(023): defectos de la revisión final en rojo`.

## T25b · [x] Corregir los defectos de la revisión final (backend · opus)
- **Contexto (leer solo esto)**: resultado de T25, pruebas de T25a, `packages/domain/src/buzon/captura.ts`, `apps/worker/src/trabajos/procesadores/revisar-buzon.ts`, `packages/db/src/buzon/solicitud.ts`.
- **Hacer**: R-1: en `planificarCaptura`, una página sin mensajes (tras sanear) con `siguiente` corta como «todo repetido»; `MAX_PAGINAS_LECTURA` (holgado, p. ej. 500) en el dominio, `EstadoCaptura` recibe las páginas leídas y corta con relleno pendiente; el worker pasa `leidas`. R-2: `estado in ('error','cancelado') and motivo = 'credencial_invalida'`. Sin migración ni cambios de contrato HTTP.
- **Hecho cuando**: las de T25a pasan; `domain`, `db`, `worker`, `backend test:int` (buzón) y `pnpm cobertura:buzon` en verde; typecheck y lint limpios. Commit `fix(023): defectos de la revisión final`. Después, T25 se repite solo sobre R-1 y R-2 y se marca `[x]`.

## T26 · [ ] Cierre (devops · haiku)
- **Contexto (leer solo esto)**: resultado de T25, `tasks.md`, `spec.md` (estado y CA).
- **Hacer**: marcar tareas y CA, estado de la spec «hecha (fecha)». Commit `docs(023): cierre` con rutas explícitas. El orquestador actualiza `ESTADO.md` (migraciones usadas y la siguiente libre).
- **Hecho cuando**: `git status` limpio en los archivos de 023 y el commit hecho.
