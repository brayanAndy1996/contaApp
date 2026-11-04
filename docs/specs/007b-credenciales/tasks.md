# Tareas 007b · Credenciales, importación Excel y panel de trabajos

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior (no comparten archivos) | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

Nivel B con una ronda adversarial acotada (spec D11). Flujo 04 §1.3: pruebas primero (rojo) → implementar (verde) → atacar → corregir → prueba manual → verificar → revisión → cerrar. Rama `spec/007b-credenciales` (desde `origin/main` con 007a y 008). CA y D = `spec.md`; contratos y decisiones = `plan.md`. Las tareas de frontend trabajan contra el contrato HTTP del plan (pruebas con `fetch` simulado) y por eso van en paralelo con el backend.

| #    | Tarea                                                                                              | Rol        | Modelo | Depende de          | TDD | ADV | Estado |
| ---- | -------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------- | --- | --- | ------ |
| T1   | Pruebas de BD: FK de credencial, `verificada`, datos de RUC y carreras (rojo); siembras ajustadas  | tester     | sonnet | —                   | ✓   | —   | [ ]    |
| T2   | Pruebas unitarias: esquemas de shared, puertos y mocks de sunat, catálogo de queue (rojo)          | tester     | sonnet | — ∥ T1              | ✓   | —   | [x]    |
| T3   | Pruebas unitarias: lector `.xlsx`/`.csv`, validación de filas y plantilla (rojo)                   | tester     | sonnet | — ∥ T2              | ✓   | —   | [x]    |
| T4   | Pruebas de integración HTTP: credenciales, importación, carreras de cupo y alta con consulta (rojo)| tester     | sonnet | T1, T2, T3          | ✓   | —   | [ ]    |
| T5   | Pruebas de integración del worker: consultar RUC y verificar credenciales (rojo)                   | tester     | sonnet | T1, T2 ∥ T4         | ✓   | —   | [ ]    |
| T6   | Pruebas del frontend: credenciales, asistente de importación, panel y `next.config` (rojo)        | tester     | sonnet | contrato del plan ∥ T4 | ✓ | —   | [x]    |
| T7   | Migración 0027, esquema y repositorios de `packages/db`                                            | backend    | sonnet | T1                  | ✓   | —   | [ ]    |
| T8   | Puertos y mocks de sunat, esquemas de shared y tipos del catálogo de queue                         | backend    | sonnet | T2 ∥ T7             | ✓   | —   | [x]    |
| T9   | Procesadores del worker y cableado de puertos                                                      | backend    | sonnet | T5, T7, T8          | ✓   | —   | [ ]    |
| T10  | Módulo `credenciales` del backend: cifrado, estado y verificar                                     | backend    | sonnet | T4, T7, T8 ∥ T9     | ✓   | —   | [ ]    |
| T11  | Lector `.xlsx`/`.csv` y validación de filas                                                        | backend    | opus   | T3, T8 ∥ T9, T10    | ✓   | —   | | [x]    |
| T12  | Importación: vista previa, confirmar (cupo, bloqueos), `encolarLote` y alta que encola la consulta | backend    | sonnet | T4, T10, T11        | ✓   | —   | [ ]    |
| T12b | Plantilla `.xlsx` en memoria y ruta de descarga                                                    | backend    | haiku  | T11 ∥ T12           | ✓   | —   | [ ]    |
| T13  | Frontend: cliente HTTP y sección de credenciales del detalle                                       | frontend   | sonnet | T6 ∥ T7–T12b        | ✓   | —   | [x]    |
| T14  | Frontend: asistente de importación                                                                 | frontend   | sonnet | T6, T13 (`lib`)     | ✓   | —   | [ ]    |
| T15  | Frontend: panel de trabajos con SSE, cabecera `no-transform` y `next.config`                       | frontend   | sonnet | T6 ∥ T14            | ✓   | —   | [x]    |
| T16  | Ronda adversarial: credenciales e importación (caja negra, luego blanca; ≤ 15 pruebas)             | adversario | opus   | T9, T10, T12, T12b, T13, T14 | — | ✓ | [ ]    |
| T17  | Corregir hallazgos de la ronda                                                                     | backend    | sonnet | T16                 | —   | —   | [ ]    |
| T18  | Prueba manual del frontend contra el backend real (`pnpm servicios:up`, rewrite de Next y SSE)     | tester     | sonnet | T15, T17            | —   | —   | [ ]    |
| T18a | Corregir los defectos de T18 (solo si los hay)                                                     | backend / frontend | sonnet | T18         | ✓   | —   | [ ]    |
| T19  | Verificar CA-1 a CA-10 con evidencia (suites completas)                                            | tester     | sonnet | T17, T18a           | —   | —   | [ ]    |
| T20  | Revisión contra la spec                                                                            | arquitecto | sonnet | T19                 | —   | —   | [ ]    |
| T21  | Cierre: tasks y commit (el orquestador actualiza ESTADO)                                           | devops     | haiku  | T20                 | —   | —   | [ ]    |

Escalamientos: ninguno previsto. T11 es `opus` por ser el parser de archivos del usuario (04 §3.2); T12 concentra el orden de bloqueo y las carreras de CA-3: si falla 2 veces nace de nuevo en `opus` (04 §3.3). T12b puede escalar a `sonnet` si `haiku` falla una vez. T18 es `tester` y no `devops`: debe leer el comportamiento del stream y decidir; si no consigue un navegador, mide con `curl -N` a través del puerto de Next y lo anota. Si T20 encuentra defectos se añaden T20a (pruebas en rojo) y T20b (corrección) con el precedente de 007a T13a/T13b.

Reglas comunes:

- Un commit por tarea (Conventional Commits `test(007b): …`, `feat(007b): …`, `fix(007b): …`) con el trailer `Co-Authored-By` del modelo que la ejecutó. Las tareas ∥ hacen commit una tras otra. Sin push del subagente: el orquestador lo hace tras cada tarea.
- **Nunca** agregar al índice `docs/explorador/`, `.codex/` ni `AGENTS.md` (cambios ajenos): `git add <rutas>` explícitas, nunca `git add -A`/`.`.
- **Nunca** imprimir ni commitear secretos reales ni el contenido de `.env`. Las pruebas usan canarios (cadenas únicas que se buscan en respuestas, logs, errores y DOM). Ningún `console.log` ni mensaje de error con el cuerpo de las rutas de credenciales e importación.
- Checks: responder solo fallos (`archivo:línea · mensaje`) o «OK» + conteo. Correr solo las pruebas del paquete afectado; las suites completas en T19.
- El tester no toca código de producción; backend y frontend no editan `*.spec.ts` (salvo el ajuste de siembras de T1 y la aserción de cabecera de T15, que dice T6); solo T16 escribe `*.adv.spec.ts`.
- Migraciones: la última aplicada es 0026; 007b usa **0027**. Confirmar con `ls packages/db/migrations` antes de crear. Nunca editar una aplicada. Las pruebas de 002–008 y 007a siguen en verde; si una contradice 007b (p. ej. `Cache-Control: no-store` del stream de 008) se ajusta solo en la tarea de pruebas que lo diga, con comentario.
- Orden de bloqueo obligatorio (`plan.md`, Decisiones): `bloquearMiembros` → `CupoRucs.libres`/`reservar` → `cliente` → `credencial` → `asignacion`.
- Toda dependencia nueva con versión exacta (sin `^`), publicada hace ≥ 2 semanas. En `apps/frontend`, leer `apps/frontend/AGENTS.md` y la guía de `node_modules/next/dist/docs/` que toque antes de escribir.
- Escalar según 04 §3.3 y anotar arriba. Una ambigüedad que cambie la spec no se decide: `requiere usuario` y se informa al orquestador. P1 y P2 de `spec.md` siguen abiertas: se asume (a) en ambas y cambiarlas solo toca T3/T11/T12b (P1) o añade una ruta (P2).

## T1 · Pruebas de BD, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `docs/specs/007b-credenciales/spec.md` (D1, D2, D6; CA-4, CA-5), `plan.md` (Contratos: packages/db; Riesgos), `tests/aislamiento/{soporte,trabajos-soporte,credencial.spec,trabajos-repos.spec}.ts` (patrones y siembras), `packages/db/src/credenciales/{estado,repositorio}.ts` y `packages/db/src/clientes/repositorio.ts` (solo lectura), `packages/db/src/schema/credenciales.spec.ts`.
- **Hacer**: (1) Ajustar, ya en verde, las siembras de `credencial` con `cliente_id` inventado para que creen antes el `cliente` (`tests/aislamiento/{credencial,credencial-r1a.adv,trabajos-funciones,trabajos-repos,trabajos-soporte}`, `packages/db/src/trabajos/exportes.spec.ts`, `packages/queue/src/soporte-pruebas/int.ts`, `apps/worker/test/{bd,trabajos}.ts`), con comentario. (2) `tests/aislamiento/credencial-fk.spec.ts` y `credencial-estado.spec.ts`: FK existente y con ese nombre; 23503 al insertar con cliente inexistente o de otro estudio; borrar un cliente con credenciales rechazado; RLS y grants intactos; `marcarCredencialVerificada` (estado, `estado_at`, motivo nulo; `false` si la versión cambió; un guardado posterior la devuelve a `configurada`; el worker no puede tocar el sobre); `leerEstadoCredenciales` (fecha y motivo, sin columnas del sobre); `completarDatosRuc` (no pisa una razón social editada, sí la provisional «RUC <ruc>», no cruza estudios); `rucsExistentes` (activo y archivado); `crearCliente` con `id` explícito; carrera guardar-vs-verificar sin `40P01`.
- **Hecho cuando**: `pnpm test:aislamiento` falla solo en lo nuevo y por falta de migración y funciones; lo previo (con las siembras ajustadas) sigue verde. Commit `test(007b): FK de credencial, estado verificada y datos de RUC (rojo)`.

## T2 · Pruebas unitarias, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D1, D4, D6, D7), `plan.md` (Contratos: Puertos, Catálogo), `packages/shared/src/clientes/esquemas.spec.ts` (patrón), `packages/sunat/src/mock/sire-auth.mock.spec.ts` y `packages/sunat/src/puertos.ts`, `packages/queue/src/catalogo.spec.ts`.
- **Hacer**: `packages/shared/src/{credenciales,importacion}/*.spec.ts`: esquemas de guardado por tipo (1–256 B UTF-8, sustitutos sueltos, claves desconocidas descartadas, sin `trim` de la clave), DTO de estado, `VistaPrevia` e `Informe` (ningún campo admite el valor de una clave). `packages/sunat/src/mock/{consulta-ruc,sol-auth}.mock.spec.ts` y ampliar el de `SireAuth`: resultado determinista por RUC, centinelas de fallo, `fallar()`, sin eco de la credencial en errores. `packages/queue/src/catalogo-007b.spec.ts`: los tres tipos con la forma exacta del plan (cola, canal, `credencial: null`, permiso, parámetros `{}` estrictos) y que `registrarTipo` rechaza cambiarla.
- **Hecho cuando**: las pruebas fallan solo por falta de código. Commit `test(007b): esquemas, puertos y catálogo (rojo)`.
- **Resultado**: rojo confirmado. Añadidas: `shared/{credenciales,importacion}/esquemas.spec.ts`, `sunat/mock/{consulta-ruc,sol-auth}.mock.spec.ts`, ampliado `sire-auth.mock.spec.ts` (centinela `clientSecret="clave-errada"`), `queue/catalogo-007b.spec.ts`. Contratos que fijan (T8 los sigue): `MockConsultaRuc` (RUC terminado en 7 → `ErrorTransitorio`, en 8 → `ErrorDatos`; `fallar("timeout"|"5xx"|"datos"|null)`), `MockSolAuth` (`claveSol="clave-errada"` → `ErrorCredencial`), esquemas `guardarCredencialSolSchema/SireSchema`, `credencialEstadoSchema`, `vistaPreviaSchema`, `informeImportacionSchema`, `MOTIVOS_FILA_IMPORTACION`; `archivado?` en la fila y en `noImportadas`. Sin stubs: fallan por módulo o tipo inexistente.

## T3 · Pruebas unitarias del lector de archivos, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D7, D8, D9; CA-1, CA-2, CA-8), `plan.md` (Contratos: HTTP y motivos; Decisiones: lector, columnas, celdas), `packages/shared/src/clientes/ruc.ts` (`validarRuc`), `apps/backend/src/modules/clientes/clientes.service.spec.ts` (patrón).
- **Hacer**: `apps/backend/test/soporte-importacion.ts` (genera `.xlsx` y `.csv` en memoria con `fflate`, incluidos los maliciosos) y `apps/backend/src/modules/importacion/{lector-xlsx,lector-csv,validar-filas,plantilla}.spec.ts`. Cubrir: archivo válido; CSV con `,`, `;` y BOM; > 1.000 filas, > 2 MB, vacío y no-zip; bomba de descompresión (entrada que declara poco y expande > 20 MB, miles de entradas, rutas con `..`); XXE, `<!DOCTYPE` y entidades; celdas con fórmula `<f>`; cadenas compartidas, números y espacios en el RUC; solo la primera hoja; cabecera con columna faltante; razón social, usuario SOL o responsable con `=HYPERLINK(...)`/`+`/`@`/control (rechazo por fila) y `clave`/`client_secret` que empiezan con `=`/`-`/`@` (aceptadas); `duplicado_en_archivo` (vale la primera), `credencial_incompleta`, `ruc_invalido` con prefijo 11/12/30; la vista previa serializada no contiene el canario de ninguna clave; la plantilla no trae filas de datos y el lector la acepta.
- **Hecho cuando**: las pruebas fallan solo por falta de código. Commit `test(007b): lector de archivos, validación de filas y plantilla (rojo)`.
- **Resultado**: 82 pruebas en `apps/backend/src/modules/importacion/{lector-xlsx,lector-csv,validar-filas,plantilla}.spec.ts` (81 en rojo por stubs «no implementado»; 1 de sanidad del soporte en verde) y `apps/backend/test/soporte-importacion.ts` (xlsx/csv en memoria con `fflate`, bomba, XXE, rutas, miles de entradas). Contratos fijados en los stubs `tipos.ts`, `lector-*.ts`, `validar-filas.ts`, `plantilla.ts` (`leerXlsx/leerCsv(Uint8Array) → {filas: FilaLeida[]}` con `n` = fila del archivo; `ErrorArchivo.codigo` ∈ `archivo_invalido|columnas_faltantes|demasiadas_filas|archivo_demasiado_grande` (este último → 413); `validarFilas(filas, {existentes, miembros por correo})`; `aVistaPrevia`; `generarPlantilla()`). P1 (a): responsable = correo del miembro activo; rol `lectura` → `responsable_no_asignable`. `fflate@0.8.2` añadido a `devDependencies` del backend: T11 lo pasa a `dependencies`.

## T4 · Pruebas de integración HTTP, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D1, D3–D9; CA-1 a CA-4, CA-6, CA-8 a CA-10), `plan.md` (Contratos: HTTP; Carga de la cola; Decisiones), `apps/backend/test/{soporte,soporte-acceso,soporte-cupo,soporte-clientes,soporte-trabajos,soporte-importacion}.ts`, `apps/backend/src/modules/clientes/clientes-crud.int.spec.ts`, `apps/backend/src/modules/planes/cupo-rucs.int.spec.ts`, `apps/backend/src/modules/trabajos/encolador.int.spec.ts` (patrones).
- **Hacer**: `modules/credenciales/credenciales.int.spec.ts`: guardar `sol` y `sire_api` (200 solo `{tipo, estado}`, `no-store`, el canario no aparece en cuerpo, cabeceras, logs ni errores 400/409/500; sobre en BD con AAD de tenant, cliente y tipo y no descifrable con la fila copiada a otro cliente); `GET` con estado, fecha y motivo; guardar de nuevo reinicia a `configurada`; `verificar` encola `interactivo` y es idempotente; 409 `credencial_no_configurada` (SIRE sin SOL); permisos (`lectura`/asistente → 403); CA-10 (archivado 409, ajeno e inexistente mismo 404 en las tres rutas). `modules/importacion/importacion.int.spec.ts`: CA-1, CA-2, CA-8 (válidas hasta el cupo, existente activo y archivado como `duplicado`, resto `cupo_rucs`), `credenciales.editar` exigida si trae claves, nada queda en disco ni en logs. `importacion-carreras.int.spec.ts`: CA-3 (dos importaciones simultáneas, activos ≤ máximo, sin 500 ni `40P01`). `clientes/clientes-consulta-ruc.int.spec.ts`: alta e importación encolan `cliente.consultar_ruc` (`programado`), el alta no falla con Redis caído, la reserva del 50 % deja `consultasOmitidas`, `encolarLote` por lotes.
- **Hecho cuando**: las pruebas fallan solo por falta de rutas y de lógica. Commit `test(007b): rutas de credenciales e importación (rojo)`.

## T5 · Pruebas de integración del worker, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D1, D6; CA-5, CA-6, CA-9), `plan.md` (Contratos: Puertos, Catálogo; Decisiones: Verificar), `apps/worker/src/trabajos/{ejecutor.int.spec.ts,secretos.int.spec.ts}`, `apps/worker/test/{bd,trabajos}.ts`, `apps/worker/src/trabajos/token-sire/credenciales-sire.ts` (solo lectura).
- **Hacer**: `apps/worker/src/trabajos/procesadores/{consultar-ruc,verificar-credencial}.int.spec.ts` con BD y Redis reales y mocks: `consultar_ruc` completa estado, condición y la razón social provisional, no pisa una editada, deja el cliente intacto y el trabajo `error` con el mock en fallo (transitorio reintenta, de datos no); `verificar_sol` y `verificar_sire` → `verificada(fecha)` o `invalida` + trabajo `error/credencial_invalida` sin reintentos; una credencial `invalida` **sí** se puede verificar (el despachador no cancela estos tipos) y vuelve a `verificada` (CA-6, trabajos SIRE vuelven a despacharse); un guardado durante la verificación no se pisa; el secreto descifrado no aparece en logs ni en `resultado`; el descifrado deja auditoría con motivo `credencial.verificar`.
- **Hecho cuando**: las pruebas fallan solo por falta de procesadores. Commit `test(007b): procesadores del worker (rojo)`.

## T6 · Pruebas del frontend, rojo (tester · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D4–D7, D10; CA-4 a CA-7), `plan.md` (Contratos: HTTP; Decisiones: Panel), `apps/frontend/AGENTS.md`, `apps/frontend/app/(app)/clientes/[clienteId]/{fiscal.spec.tsx,page.tsx}`, `apps/frontend/pruebas/{clientes,soporte}.ts`, `apps/frontend/next.config.spec.ts` (patrones).
- **Hacer**: pruebas de la sección de credenciales (estado por tipo con fecha o motivo; el formulario se vacía y no conserva el valor tras guardar ni tras un error; el canario no queda en el DOM, `localStorage` ni errores; «Verificar» llama a la ruta y muestra el trabajo; aviso «si cambió la clave SOL, guarde o verifique de nuevo la credencial SIRE»; archivado en solo lectura), del asistente (subida con cuerpo crudo, vista previa con •••• y motivos, cupo y excedentes, confirmar, informe de «no importadas» y de duplicado archivado con sugerencia de reactivar, errores 400/413), del panel (lista, resumen de 1.000 trabajos de un tipo en una línea, eventos SSE por lote, reconexión, respaldo por sondeo, estado terminal visible) y de `next.config` (rewrite `/api/*` intacto; la decisión de `compress` queda para T18). Más la aserción de backend `Cache-Control: no-cache, no-transform` en `trabajos/stream*.int.spec.ts` (ajusta el `no-store` de 008, con comentario).
- **Hecho cuando**: fallan solo por falta de pantallas, `lib` y cabecera. Commit `test(007b): pantallas de credenciales, importación y panel (rojo)`.
- **Resultado**: 59 pruebas de frontend en rojo + 1 de backend. `credenciales.spec.tsx` (19: estado con fecha/motivo, PUT sol y sire_api con CSRF, clave sin trim, formulario vacío y canario ausente de DOM/valores/storage tras éxito y tras 400/403/409/500, Verificar 202 con enlace a `/trabajos`, 409, aviso de clave SOL, solo lectura por archivado o sin permiso), `clientes/importar/page.spec.tsx` (18: cuerpo crudo ni JSON ni multipart, vista previa con ••••, motivos, cupo y excedentes, archivado con sugerencia de reactivar, cambiar archivo descarta la vista previa, confirmar con los mismos bytes, informe de no importadas, 400/413/403/500), `trabajos/page.spec.tsx` (20: lista, resumen «640 de 1.000», detalle, eventos SSE partidos/rotos/en lote de 300, reconexión ≤ 5 s con re-sincronía, sondeo ≤ 10 s, aborto al desmontar), `enlaces-007b.spec.tsx` (2: «Trabajos» y «Importar clientes» por permisos) y `next.config.trabajos.spec.ts` (4, ya en verde: guarda del rewrite `/api/*`; `compress` queda para T18). Backend: `stream.int.spec.ts` y `stream.service.spec.ts` esperan `Cache-Control: no-cache, no-transform` y `X-Accel-Buffering: no` (ajustan el `no-store` de 008, con comentario; el unitario falla con `no-store`). Soporte nuevo en `apps/frontend/pruebas/{credenciales,importacion,trabajos}.ts` (textos exactos, canarios, `fetch` con stream SSE controlable). Stubs vacíos `clientes/importar/page.tsx` y `trabajos/page.tsx` para que compile (T14/T15 los reemplazan). Contratos fijados en los comentarios de cada spec: región «Credenciales» con grupos «Credencial SOL»/«Credencial SIRE»; botones «Guardar»/«Verificar»; umbral de resumen > 10 trabajos de un tipo; «Ver detalle»; «Revisar archivo»/«Confirmar importación». `tsc` y `eslint` del frontend limpios.

## T7 · Migración 0027 y repositorios de BD (backend · sonnet)

- **Contexto (leer solo esto)**: `plan.md` (Archivos; Contratos: packages/db), `packages/db/src/schema/credenciales.ts`, `packages/db/src/credenciales/{estado,repositorio}.ts`, `packages/db/src/clientes/repositorio.ts`, `packages/db/migrations/0026_clientes_perfil.sql` (solo el estilo), `tests/aislamiento/credencial-fk.spec.ts`, `credencial-estado.spec.ts`.
- **Hacer**: FK en el esquema drizzle; `drizzle-kit generate` → `0027_credencial_fk_cliente.sql` (idempotente como las anteriores); las funciones del plan con SQL estático parametrizado; exportarlas en `packages/db/src/index.ts`.
- **Hecho cuando**: `pnpm db:migrate` dos veces sin error; lo de T1 en verde; `pnpm --filter @contapp/db test` verde. Commit `feat(007b): migración 0027 y repositorios de credencial y RUC`.

## T8 · Puertos, mocks, esquemas y catálogo (backend · sonnet)

- **Contexto (leer solo esto)**: `plan.md` (Contratos: Puertos, Catálogo), `packages/sunat/src/{puertos,index}.ts` y `mock/sire-auth.mock.ts`, `packages/queue/src/catalogo.ts`, `packages/shared/src/clientes/{esquemas,index}.ts`, las pruebas de T2.
- **Hacer**: puertos y mocks (centinelas documentadas en el JSDoc; añadir la de «clave errada» a `MockSireAuth` sin cambiar su comportamiento por defecto), esquemas de `shared`, registro de los tres tipos en `queue`, `RUC_CLIENT=mock` en `.env.example`.
- **Hecho cuando**: las pruebas de T2 en verde; `tsc` y `eslint` de los cuatro paquetes limpios. Commit `feat(007b): puertos ConsultaRuc y SolAuth, esquemas y tipos de trabajo`.
- **Resultado**: verde (shared 649, sunat 63, queue 282; tsc y eslint limpios). Nuevos: `sunat/{puertos(ConsultaRuc,SolAuth,DatosRuc,CredencialSol),mock/{consulta-ruc,sol-auth}.mock}`, centinela en `MockSireAuth`, `shared/{credenciales,importacion}/esquemas`, tres tipos en `queue/catalogo.ts`, `RUC_CLIENT=mock`. `shared` gana `@types/node` (dev, `^24.0.0` como el resto) y `types:["node"]` solo en `tsconfig.json` (el spec de T2 usa `Buffer`; `tsconfig.build.json` lo deja en `[]`).

## T9 · Procesadores del worker (backend · sonnet)

- **Contexto (leer solo esto)**: `plan.md` (Decisiones: Verificar), `apps/worker/src/trabajos/{ejecutor,iniciar,trabajos.module}.ts`, `apps/worker/src/trabajos/token-sire/credenciales-sire.ts`, `apps/worker/src/credenciales/descifrar-credencial.ts`, las pruebas de T5.
- **Hacer**: `procesadores/{consultar-ruc,verificar-credencial}.ts` como fábricas con sus dependencias (`db`, servicio de credenciales, puertos); registrarlos en `procesadores` de `iniciarTrabajos`; `consultaRucDesdeEntorno` y `solAuthDesdeEntorno` (solo `mock`; otro valor falla al arrancar, como `SIRE_CLIENT`). Sin transacción abierta durante la llamada al puerto (008 D6); lo descifrado se destruye al terminar.
- **Hecho cuando**: T5 en verde; `pnpm --filter @contapp/worker test` y `test:int` verdes. Commit `feat(007b): procesadores consultar RUC y verificar credenciales`.

## T10 · Módulo de credenciales del backend (backend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D3–D6), `plan.md` (Contratos: HTTP; Decisiones: Secretos), `apps/backend/src/modules/clientes/{clientes.controller,clientes.module,clientes.service}.ts` (patrón de guards y errores), `apps/backend/src/modules/acceso/errores.ts`, `apps/backend/src/modules/trabajos/{encolador,trabajos.module}.ts`, `packages/crypto/src/index.ts`, `packages/db/src/credenciales/repositorio.ts`, las pruebas de T4 (`credenciales.int.spec.ts`).
- **Hacer**: `CredencialesModule` (controlador y servicio), `KeyWrapper` por `KEY_PROVIDER`, cifrar con `cifrarCredencial` y guardar con `guardarSobre`, estado con `leerEstadoCredenciales`, verificar con `Encolador`; errores solo `{codigo}`; añadir `credencial_no_configurada` a `errores.ts` y las rutas a `test/auditoria-rutas.ts`.
- **Hecho cuando**: las pruebas de credenciales de T4 en verde; el lint de límites no marca `@contapp/crypto/descifrado`. Commit `feat(007b): credenciales de solo escritura, estado y verificación`.

## T11 · Lector de archivos y validación de filas (backend · opus)

- **Contexto (leer solo esto)**: `spec.md` (D7–D9, D11), `plan.md` (Contratos: motivos; Decisiones: lector, columnas, celdas), `packages/shared/src/clientes/ruc.ts`, `packages/shared/src/importacion/*`, `apps/backend/test/soporte-importacion.ts`, `apps/backend/src/modules/importacion/*.spec.ts` (T3).
- **Hacer**: `lector-xlsx.ts`, `lector-csv.ts` y `validar-filas.ts` (funciones puras sobre `Buffer`/filas: sin IO, sin disco, sin logs; errores con códigos fijos); agregar `fflate` y `fast-xml-parser` con versión exacta. Todo tope se aplica **antes** de reservar memoria (entradas, tamaño declarado y real acumulado, filas).
- **Hecho cuando**: las pruebas de T3 (menos las de plantilla) en verde; `tsc` y `eslint` limpios. Commit `feat(007b): lector xlsx y csv seguro y validación de filas`.
- **Resultado**: 77/82 de T3 en verde (las 5 de `plantilla.spec.ts` quedan para T12b); backend 788 OK, `tsc` y `eslint` limpios. Nuevos `zip-seguro.ts` (directorio central propio: ≤ 500 entradas, rutas sin `..`/`\\`/absolutas, sin ZIP64 ni cifrado, tope declarado por entrada y total; inflado por trozos de 1 KB que aborta al pasar lo declarado o 20 MB reales) y `tabla.ts` (cabecera por nombre normalizado; razón social opcional; filas vacías omitidas; `demasiadas_filas` al superar el tope). `lector-xlsx` rechaza todo `<!` salvo comentarios y CDATA antes de `XMLValidator` y `XMLParser`. `validar-filas` usa `validarRuc`, `puedeSerResponsable` y los esquemas de D4 (un valor > 256 B → `credencial_incompleta`). `fast-xml-parser@5.11.2` y `fflate@0.8.2` en `dependencies`; `overrides` en `pnpm-workspace.yaml` fija `is-unsafe@2.0.2` (la 2.0.3 transitiva es de 2026-11-03). Ojo T12: `VistaPrevia.filas[].motivos` del backend son `{codigo, archivado?}` (stub de T3) y `vistaPreviaSchema` de `shared` espera `string[]` con `archivado` en la fila: el controlador debe proyectar.

## T12 · Servicio de importación y alta con consulta (backend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D1, D3, D7–D9; CA-1 a CA-3, CA-8, CA-9), `plan.md` (Contratos: HTTP; Carga de la cola; Decisiones: orden de bloqueo), `apps/backend/src/modules/clientes/clientes.service.ts`, `apps/backend/src/modules/planes/cupo/cupo-rucs.ts`, `apps/backend/src/modules/trabajos/encolador.ts`, `apps/backend/src/modules/acceso/{usuarios.service,asignaciones.service}.ts` (miembros y `puedeSerResponsable`), `apps/backend/src/modules/importacion/*` (T11), `apps/backend/src/modules/credenciales/*` (T10), las pruebas de T4.
- **Hacer**: `ImportacionService.vistaPrevia` y `.confirmar` (preparación fuera de la transacción con UUID por fila y cifrado; transacción con `bloquearMiembros` → `libres` → `reservar(n)` → `crearCliente` con `id` → `guardarSobre` → `asignar`; re-validación dentro; 200 con el informe), controlador con cuerpo crudo ≤ 2 MB (413 sin leer más), `Encolador.encolarLote` con la reserva del 50 % de `max_pendientes_tenant`, y `ClientesService.crear` que encola `cliente.consultar_ruc` tras el commit sin propagar su fallo.
- **Hecho cuando**: T4 (importación, carreras y consulta de RUC) en verde; `pnpm --filter @contapp/backend test` y `test:int` verdes. Commit `feat(007b): importación de clientes y consulta de RUC al alta`.

## T12b · Plantilla de importación (backend · haiku)

- **Contexto (leer solo esto)**: `plan.md` (Contratos: HTTP, plantilla), `apps/backend/src/modules/importacion/{plantilla.spec.ts,importacion.controller.ts}`, `apps/backend/test/soporte-importacion.ts`.
- **Hacer**: `plantilla.ts` (genera el `.xlsx` en memoria con `fflate`: hoja de datos con la cabecera y hoja «Instrucciones»; sin datos de ningún estudio) y la ruta `GET /clientes/importacion/plantilla` (`clientes.crear`, `Content-Disposition`, `no-store`).
- **Hecho cuando**: las pruebas de plantilla de T3 y T4 en verde. Commit `feat(007b): plantilla de importación`.

## T13 · Frontend: cliente HTTP y credenciales (frontend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D4–D6; CA-4 a CA-6, CA-10), `plan.md` (Contratos: HTTP), `apps/frontend/AGENTS.md`, `apps/frontend/lib/{api,clientes}.ts`, `apps/frontend/app/(app)/clientes/[clienteId]/page.tsx`, las pruebas de T6.
- **Hacer**: `lib/credenciales.ts` y la sección «Credenciales» del detalle (estado, formulario de solo escritura que se vacía siempre —también tras un error—, «Verificar», aviso de clave SOL, solo lectura si está archivado). Sin guardar el secreto en estado más tiempo del que dura el envío, ni en `localStorage`, ni en mensajes de error.
- **Hecho cuando**: las pruebas de credenciales de T6 en verde; `vitest`, `tsc` y `eslint` del frontend limpios. Commit `feat(007b): credenciales en el detalle del cliente`.
- **Resultado**: `lib/credenciales.ts` (listar, guardar, verificar; `MENSAJES_CREDENCIALES`) y `components/credenciales-cliente.tsx` montado en el detalle. Campos no controlados: el secreto se lee al enviar y el formulario se vacía antes de la llamada (éxito o error); nunca va a estado, storage ni mensajes. `credenciales.spec.tsx` 19/19 en verde sin tocar aserciones; resto de 007a/005 intacto; `tsc` y `eslint` limpios. Pendientes de otras tareas: panel, asistente y enlaces (T14/T15). Si el GET de estados falla, cada grupo dice «Estado no disponible» (sin alerta global).

## T14 · Frontend: asistente de importación (frontend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D7–D9; CA-1, CA-8), `plan.md` (Contratos: HTTP), `apps/frontend/lib/{api,clientes}.ts`, `apps/frontend/app/(app)/clientes/page.tsx` (enlace de entrada), las pruebas de T6.
- **Hacer**: extender `api` con cuerpo crudo (sin `JSON.stringify`, con CSRF y `X-Estudio`), `lib/importacion.ts` y `clientes/importar/page.tsx` en tres pasos (subir, vista previa con •••• y motivos, informe), descarga de la plantilla; el archivo se conserva solo en memoria del paso y se descarta al confirmar o cancelar.
- **Hecho cuando**: las pruebas del asistente en verde; `vitest`, `tsc` y `eslint` limpios. Commit `feat(007b): asistente de importación de clientes`.

## T15 · Frontend: panel de trabajos y SSE (frontend · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D10; CA-5, CA-7, CA-9), `plan.md` (Carga de la cola: Panel; Decisiones: Panel), `apps/frontend/AGENTS.md`, `apps/frontend/next.config.ts`, `apps/frontend/app/(app)/layout.tsx`, `apps/backend/src/modules/trabajos/stream.service.ts` (formato de eventos y cabeceras), `packages/shared/src/trabajos/esquemas.ts`, las pruebas de T6.
- **Hacer**: `lib/trabajos.ts` (lector de flujo con `fetch`, reconexión con espera creciente, sondeo de respaldo, validación con `trabajoVistaSchema`), `trabajos/page.tsx` (lista, resumen por tipo, cancelar, motivo visible), enlace en `layout.tsx`; en `stream.service.ts`, `Cache-Control: no-cache, no-transform` (única edición de backend de esta tarea). El stream no renueva la sesión: no lo trates como actividad.
- **Hecho cuando**: las pruebas del panel y de la cabecera en verde; `vitest`, `tsc` y `eslint` limpios. Commit `feat(007b): panel de trabajos con SSE`.
- **Resultado**: verde (`trabajos/page.spec.tsx` 20, `next.config.trabajos.spec.ts` 4, enlace «Trabajos» de `enlaces-007b.spec.tsx`; backend `stream.service.spec.ts` 13 e `stream.int.spec.ts` 17). `lib/trabajos.ts`: `seguirTrabajos` abre el stream con `fetch` (antes de listar, así lo emitido durante el listado queda en el flujo), re-sincroniza con `GET /trabajos` en cada ciclo, reconecta con espera 1→10 s (que acota también el sondeo si el stream no abre) y se detiene ante 401/403; validación con `trabajoVistaSchema`. `trabajos/page.tsx`: resumen si un tipo tiene más de 10, detalle desplegable, eventos por lotes de 250 ms, «Cancelar» en `en_cola` (el permiso lo decide el servidor). Enlace «Trabajos» en `layout.tsx` con `clientes.ver`. Backend: `Cache-Control: no-cache, no-transform` en `stream.service.ts`. Pendiente de T14: el enlace «Importar clientes» de `enlaces-007b.spec.tsx`.

## T16 · Ronda adversarial (adversario · opus)

- **Contexto (leer solo esto)**: primero **solo** `spec.md` (D3–D9, D11; CA-1 a CA-4, CA-8, CA-10) y las rutas públicas de `plan.md` (caja negra); después el código de `apps/backend/src/modules/{credenciales,importacion}`, `apps/worker/src/trabajos/procesadores/`, `packages/db/src/credenciales/` y las pantallas de credenciales e importación (caja blanca).
- **Hacer**: hasta 15 pruebas en `*.adv.spec.ts`/`*.adv.int.spec.ts`, solo sobre: secreto en respuestas, logs, errores y estado de UI; AAD cruzada entre filas (copiar un sobre a otro cliente o tipo y verificar que falla al descifrar); alcance en credenciales y verificar (asistente sin el cliente, desasignado en mitad de la sesión, archivado); parsers (bomba de descompresión, XXE, fórmulas, CSV injection, filas repetidas, números enormes, Unicode); dos importaciones concurrentes contra el cupo y contra el mismo RUC. No modifica código de producción. Cada fallo es un hallazgo `H-007b-n` en el Resultado, con archivo y línea.
- **Hecho cuando**: lista de hallazgos con prueba que falla (o «sin hallazgos»); las que pasan se quedan como regresión. Commit `test(007b): ronda adversarial de credenciales e importación`.

## T17 · Corregir hallazgos (backend · sonnet)

- **Contexto (leer solo esto)**: el Resultado de T16 y los archivos que cita (y sus `*.adv.spec.ts`).
- **Hacer**: corregir cada hallazgo sin tocar las pruebas; si un hallazgo exige cambiar la spec, `requiere usuario`. Si es del parser, relanzar en `opus`.
- **Hecho cuando**: todas las pruebas adversariales en verde y las suites de los paquetes tocados sin regresiones. Commit `fix(007b): hallazgos de la ronda adversarial`.

## T18 · Prueba manual contra el stack real (tester · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (D10; CA-5, CA-7, CA-9), `plan.md` (Riesgos), `.env.example`, `docker-compose.yml`, `package.json` (scripts), `apps/frontend/next.config.ts`.
- **Hacer**: `pnpm servicios:up`; `pnpm db:migrate` y `db:seed`; arrancar backend, worker y frontend en modo producción (`next build && next start`, con `BACKEND_URL`), todo con adaptadores `mock`. Con un usuario del seed y por el puerto de **Next** (no el del backend): (1) guardar credenciales SOL y SIRE y verificar con éxito y con la centinela de clave errada (CA-5, CA-6); (2) abrir `/api/trabajos/stream` con `curl -N` o un navegador y comprobar con marcas de tiempo que cada evento llega al emitirse y que los latidos pasan, durante ≥ 45 s (más allá de los 30 s por defecto de los rewrites), y que sin la cabecera de T15 se vería buffering; si hay buffering, probar `compress: false` y dejar la cifra; (3) subir una plantilla de 2 MB y una de 3 MB por el rewrite (200/413 sin cortar la conexión); (4) importar ~1.000 filas válidas y ver el panel resumir las consultas de RUC y terminar (CA-9, carga de la cola); (5) cerrar la sesión y comprobar que el stream se corta.
- **Hecho cuando**: tabla de evidencia por punto (comando, resultado, tiempos) en el Resultado; los defectos se anotan como `D-n` para T18a. Commit `docs(007b): evidencia de la prueba manual`.

## T18a · Corregir defectos de la prueba manual (backend / frontend · sonnet)

- **Contexto (leer solo esto)**: el Resultado de T18 y los archivos que cita.
- **Hacer**: pruebas automáticas en rojo para lo que se pueda reproducir sin el stack (la regresión mínima) y su corrección; si T18 no encuentra defectos, se marca `[x]` sin cambios. Si hay que cambiar `next.config.ts` (`compress`, tiempo de proxy), también su prueba.
- **Hecho cuando**: cada `D-n` cerrado con prueba y se repite el punto correspondiente de T18. Commit `fix(007b): defectos de la prueba manual`.

## T19 · Verificar criterios (tester · sonnet)

- **Contexto (leer solo esto)**: `spec.md` (CA-1 a CA-10), `plan.md` (Contratos), `git diff origin/main...HEAD --stat`.
- **Hacer**: correr las suites completas (`pnpm db:migrate` dos veces, `pnpm test:aislamiento`, `pnpm --filter @contapp/{shared,db,sunat,queue,worker,backend,frontend} test`, `test:int` de worker y backend, `lint`, `typecheck`) y llenar la tabla CA → prueba o comando → resultado. CA-7 con la evidencia de T18.
- **Hecho cuando**: todo en verde y cada CA con evidencia, o la lista de lo que falta. Commit `docs(007b): verificación de criterios`.

## T20 · Revisión contra la spec (arquitecto · sonnet)

- **Contexto (leer solo esto)**: `spec.md`, `plan.md`, la tabla de T19, el Resultado de T16–T18 y `git diff origin/main...HEAD --stat`; del código solo `apps/backend/src/modules/{credenciales,importacion}`, `apps/worker/src/trabajos/procesadores/` y `packages/queue/src/catalogo.ts`.
- **Hacer**: verificar cada CA con la evidencia, el orden de bloqueo, que ninguna ruta devuelve secretos ni filtra existencia, que `apps/backend` no descifra ni llama a SUNAT, que `apps/frontend` solo depende de `packages/shared`, que los hallazgos de T16 quedaron cerrados y que P1/P2 siguen como el usuario respondió. Listar lo que falte; las ambigüedades de producto se devuelven como pregunta.
- **Hecho cuando**: dictamen «aprobada» o lista de defectos. Commit `docs(007b): revisión contra la spec`.

## T21 · Cierre (devops · haiku)

- **Contexto (leer solo esto)**: `docs/specs/007b-credenciales/tasks.md`, `git status`.
- **Hacer**: marcar `[x]` en esta tabla, poner `Estado: hecha` en `spec.md` y marcar CA-1 a CA-10, commit final y avisar al orquestador, que actualiza `ESTADO.md` (007b hecha; siguiente 009). Sin `git add -A`.
- **Hecho cuando**: árbol limpio salvo cambios ajenos y `tasks.md` al día. Commit `docs(007b): tareas hechas y spec cerrada`.
