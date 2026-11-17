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
| T19 | Ronda adversarial 2: programador y cola, capturas cortadas, avisos, clasificación disfrazada (≤ 15 pruebas) | adversario | opus | T18 | — | ✓ | [ ] |
| T20 | Pruebas de las correcciones de la ronda 2 (rojo) | tester | sonnet | T19 | ✓ | — | [ ] |
| T21 | Corregir los hallazgos de la ronda 2 (migración 0058 si hace falta) | backend | opus | T20 | — | — | [ ] |
| T22 | E2E prioridad 1: «Revisar buzón ahora» → crítico → campana → «Abrir» → contenido y adjunto | tester | sonnet | T12, T13, T14 ∥ T16–T21 | — | — | [x] |
| T23 | Prueba manual con el sistema levantado y adaptadores en `mock` | tester | sonnet | T21, T22 | — | — | [ ] |
| T24 | Verificar CA-1 a CA-13 con evidencia, suites completas, `db:migrate` ×2 y cobertura | tester | sonnet | T23 | — | — | [ ] |
| T25 | Revisión final contra la spec | arquitecto | opus | T24 | — | — | [ ] |
| T26 | Cierre: `tasks.md`, `spec.md` y commit (el orquestador actualiza `ESTADO.md`) | devops | haiku | T25 | — | — | [ ] |

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

## T21 · [ ] Corregir la ronda 2 (backend · opus)
- **Contexto (leer solo esto)**: hallazgos de T19, pruebas de T19 y T20, solo los archivos que señalan.
- **Hacer / Hecho cuando**: como T18; un cambio de BD va en **0058**. Commit `fix(023): hallazgos de la ronda 2`.

## T22 · [ ] E2E prioridad 1 (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-2, CA-4, CA-6, CA-8, CA-12), `tests/e2e/flujos/{notificaciones,lupa}.e2e.ts` (modelo, sin editarlos), `tests/e2e/soporte/{siembra,cola,api}.ts`, `tests/e2e/soporte/selectores/notificaciones.ts`.
- **Hacer**: `tests/e2e/flujos/buzon.e2e.ts` y `soporte/selectores/buzon.ts`, con `BUZON_PROGRAMADOR=off`: cliente con credencial SOL del RUC del fixture → «Revisar buzón ahora» en la ficha → trabajo en el panel → aviso en la campana («Coactiva») → enlace a la vista mínima → «Abrir en SUNAT» y confirmar → contenido como texto → descargar el PDF (SHA-256 igual al del fixture) → segundo «Revisar ahora» → mensaje de espera.
- **Hecho cuando**: `pnpm e2e -- buzon` pasa 3 veces seguidas, sin `retry` ni `test.only`. Commit `test(023): e2e de buzones`.

## T23 · [ ] Prueba manual (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA), `docs/specs/019-docker-local/` (cómo levantar el sistema local, solo la sección de arranque), resultado de T23 de `docs/specs/021-reglas-aprendidas/tasks.md` (formato del informe).
- **Hacer**: sistema completo (BD nueva migrada dos veces y sembrada, Redis en un índice propio, backend, frontend y **dos** workers) con adaptadores en `mock`, `SOL_MOCK_LATENCIA_MS` > 0 y el programador encendido con `intervalo_min` bajo (fijado como `contapp_migrator`). A mano y por la interfaz: «Revisar buzón ahora» y su espera; aviso en la campana del responsable y, sin responsable, del Dueño; vista mínima, «Abrir en SUNAT», contenido y descarga de adjuntos (incluido el hostil, omitido); Lectura sin «Abrir»; credencial `invalida` a mitad (`fallar`) y su aviso; cliente archivado; ciclos del programador con los dos workers (una captura por cliente, `ultimo_ciclo_*` en BD) y uno detenido a la fuerza; 1440 × 900 y 390 × 844, teclado y foco. Defectos de pantalla → T23a.
- **Hecho cuando**: resultado con entorno, pasos, lo visto y los defectos (o «sin defectos»); procesos detenidos y Redis vaciado; no se toca código de producción.

## T24 · [ ] Verificar (tester · sonnet)
- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-13), `tasks.md` (resultados), `package.json` (scripts).
- **Hacer**: cada CA con su evidencia (prueba o comando); suites de `domain`, `shared`, `sunat`, `queue`, `db`, `backend`, `worker`, `frontend`, `test:aislamiento`, `tests/limites`, typecheck, lint, `pnpm db:migrate` ×2, `pnpm cobertura:buzon`, `pnpm ci:db` y `pnpm e2e`.
- **Hecho cuando**: tabla CA → evidencia → OK/falta en el resultado; todo en verde o la lista de lo que falta.

## T25 · [ ] Revisión final (arquitecto · opus)
- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, resultado de T24, `git diff main...HEAD --stat` y los archivos que la revisión necesite.
- **Hacer**: contrastar cada CA, D-n y P-n con la evidencia; ratificar o rechazar desvíos del plan (sección «Desvíos ratificados» en `plan.md`).
- **Hecho cuando**: veredicto con lo que falta; si hay defectos, T25a y T25b.

## T26 · [ ] Cierre (devops · haiku)
- **Contexto (leer solo esto)**: resultado de T25, `tasks.md`, `spec.md` (estado y CA).
- **Hacer**: marcar tareas y CA, estado de la spec «hecha (fecha)». Commit `docs(023): cierre` con rutas explícitas. El orquestador actualiza `ESTADO.md` (migraciones usadas y la siguiente libre).
- **Hecho cuando**: `git status` limpio en los archivos de 023 y el commit hecho.
