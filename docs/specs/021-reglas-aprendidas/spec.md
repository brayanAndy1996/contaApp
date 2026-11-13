# Spec 021 · Reglas aprendidas (R-HIS)

Estado: aprobada (2026-11-13). Rama `spec/021-reglas-aprendidas`. Plan: `plan.md` · tareas: `tasks.md`.
Nivel de riesgo: **A**. Por 04 §2.1: (1) sí: una regla aplicada sola cambia la clasificación de filas que van al TXT de reemplazo (012b), y un destino mal aprendido mueve crédito fiscal; (2) sí: las reglas son del cliente y las confirmaciones se guardan para un conteo entre estudios (033), así que una fuga cruzaría estudios o clientes; (3) sí: entre cientos de filas, una reclasificada por el sistema no se nota sin su etiqueta; (4) sí: descargas repetidas, masivas, «Recordar» concurrente y reglas que se cruzan con R-ISC/R-MIX en la misma fila.
Cubre: RF-086, RF-089, RF-110, RF-111, RF-114, RF-115 · HU-28, HU-31 · RNF-052 (no debilitarlo) · 01 §7 reglas 5 y 13 · notas [R2] de R-HIS y «Recordar» (016 P-8) de `ESTADO.md`.

## Objetivo
Que el contador clasifique una sola vez a cada proveedor de un cliente: al guardar su criterio puede pedir «Recordar», y en las cargas siguientes las compras de ese proveedor llegan ya clasificadas con la etiqueta «Según historial», sin tocar el original y con vuelta atrás. Además, que vea y administre esas reglas por cliente y que el estudio pueda activar o desactivar las reglas del motor.

## Alcance
- **Regla aprendida** por cliente + proveedor (tipo y número de documento normalizados, como R-NEW de 011) con destino DG, DGNG o DNG, estado activa/inactiva, autor y fechas (D-2).
- **«Recordar para este proveedor en este cliente»** (RF-110, HU-28) al clasificar una fila en la grilla (015) y en la lupa (016; se habilita el botón que 016 P-8 dejó fuera). Crea la regla o actualiza su destino.
- **R-HIS** (RF-086) en `packages/domain/src/reglas/`: pura, recibe las reglas del cliente en el contexto de `evaluarReglas` y sugiere `cambiarDestino` de 010.
- **Aplicación al cargar** (RF-111, D-1): dentro de la transacción de la descarga (014 D-3), a las compras nuevas de esa descarga se les crea la versión 2 con `accion = historial` y la regla que la originó. La grilla y la lupa la muestran como «Según historial».
- **Pantalla de reglas del cliente** (RF-114, HU-31): proveedor, destino, estado, veces aplicada y aceptada; editar el destino, desactivar, activar y eliminar.
- **Reglas del motor por estudio** (RF-089): lista con código y descripción simple de cada regla de 011 y R-HIS, con interruptor por estudio. Una regla apagada no se evalúa en las evaluaciones siguientes.
- **Registro de confirmaciones** (D-3) por estudio, con RLS, listo para que 033 lo cuente. 021 no crea ninguna lectura entre estudios.
- Auditoría (017) de crear, editar, activar, desactivar y eliminar reglas, del interruptor por estudio y de cada versión `historial` (actor: sistema, con la regla).
- Migraciones **0047–0051**: reglas y configuración por estudio; aplicaciones, `accion = historial` y la función acotada del worker (D-6); confirmaciones; las restantes, para la ronda adversarial.

## Fuera de alcance
- Grupos de proveedor (01 §7 regla 5, «y luego por grupo»): fuera de R2 (D-2).
- Catálogo global y su conteo entre estudios (RF-087): 033. Importar historial (RF-112) y modo estándar de selva (RF-113): 025.
- Reglas sobre montos, exclusión o no deducible (R-GP, RF-116): solo se aprende el destino.
- Ventas: R-HIS es solo de compras.
- Que «Recordar» cambie filas que ya existen (de este u otros periodos): para eso está la masiva de 015 (D-5).
- Prellenar el destino en «Agregar compra» o «Agregar desde XML»: queda como nota.

## Decisiones del usuario (2026-11-13)
- **D-1 · Aplicación automática y reversible.** Al cargar un periodo nuevo, la regla se aplica sola como versión del sistema con la etiqueta «Según historial». La versión 1 (SIRE) no cambia (RNF-052) y el contador la revierte clasificando de nuevo, una a una o en masa. Esto precisa 014 D-4 («nada se aplica solo»): la única excepción es R-HIS al cargar.
- **D-2 · Clave cliente + proveedor.** Una regla por (estudio, cliente, tipo y número de documento del proveedor). Sin grupos de proveedor en R2. Nunca se comparte entre clientes ni entre estudios (RF-115).
- **D-3 · Confirmaciones para el catálogo.** El catálogo global (RF-087, 033) lo cura el super-admin; los estudios solo aportan conteos anónimos por RUC de proveedor, a partir de N estudios. 021 guarda cada confirmación (estudio, cliente, RUC del proveedor, destino, fecha; sin montos ni usuario visible fuera del estudio) en una tabla solo inserción con RLS forzada. Ningún rol de la aplicación ni ruta de 021 lee confirmaciones de otro estudio.

Preguntas P-1 a P-10 respondidas el 2026-11-13, todas con la opción (a). Se conservan sus IDs porque los CA y el plan las citan.
- **P-1 = (a) · Qué cuenta como confirmación (D-3).** El «Recordar» explícito, más cada fila «Según historial» que sigue en el destino de la regla cuando su periodo pasa a `revisado`. Una clasificación manual sin «Recordar» no cuenta.
- **P-2 = (a) · «Recordar» en la clasificación masiva.** Se ofrece un solo «Recordar» cuando todas las filas seleccionadas son del mismo proveedor; con proveedores mezclados no se ofrece.
- **P-3 = (a) · El contador corrige el resultado de una regla.** En esa fila R-HIS no se vuelve a sugerir ni a aplicar; se ofrece «Recordar» con el destino nuevo y la regla no cambia sola.
- **P-4 = (a) · Contadores.** Aplicada = filas con versión `historial`. Aceptada = las que siguen en el destino de la regla cuando su periodo pasa a `revisado`.
- **P-5 = (a) · Periodos a los que se aplica.** Solo descargas de periodos posteriores al periodo en que se aprendió la regla (el de la fila donde se pidió «Recordar»).
- **P-6 = (a) · Fila con regla y con otro hallazgo (R-ISC, R-MIX, R-RED).** La regla se aplica igual y las demás reglas se evalúan sobre la versión `historial`.
- **P-7 = (a) · Quién puede «Recordar».** Quien tenga `reglas.gestionar` sobre un cliente visible (D-9).
- **P-8 = (a) · Qué reglas se pueden apagar por estudio (RF-089).** Todas las de 011 (R-ISC, R-MIX, R-RED, R-NEW, R-GP) y R-HIS. La prevalidación de 012 nunca.
- **P-9 = (a) · Eliminar una regla.** Baja lógica: deja de mostrarse y de aplicarse, las versiones pasadas conservan su «Según historial» y sus confirmaciones salen del conteo de 033.
- **P-10 = (a) · Qué confirmaciones se registran para 033 (Ley 29733).** Solo de proveedores con RUC que empieza en 20 (personas jurídicas). El estudio puede apagar el aporte en su configuración; apagado, no se registra ninguna.

## Decisiones de diseño
- **D-4 · Dónde vive cada cosa.** R-HIS y el cálculo de «aceptada» son puros en `packages/domain`. El backend guarda reglas y responde a «Recordar»; el worker aplica R-HIS en la descarga. Todo dentro de `withTenant()`; el backend nunca llama a SUNAT.
- **D-5 · Alcance de «Recordar».** Solo afecta a las compras que entren después. No crea versiones de filas existentes. Si ya hay una regla para el proveedor, actualiza el destino (último gana, compare-and-set por `versionBase` de la regla; 409 `regla_cambiada` si otra persona la cambió).
- **D-6 · Escritura del worker.** Hoy el worker solo inserta la versión `n = 1` de una compra creada en la misma transacción (0038). La versión `historial` se escribe con una función `SECURITY DEFINER` acotada: solo `n = 2`, solo `accion = historial`, solo para compras creadas en esa transacción y solo con un `cambiarDestino` de la regla activa. No se amplían los permisos del worker sobre `compra` ni `compra_version`.
- **D-7 · Qué filas reciben la versión.** Solo compras nuevas de la descarga (versión 1 del SIRE), de un proveedor con regla activa, con R-HIS activo en el estudio y con base gravada distinta de cero; si el destino ya coincide, no se crea versión. La fila se re-evalúa tras la versión (014 D-4) y deja de marcarse como R-NEW.
- **D-8 · Aplicaciones y contadores.** Cada versión `historial` deja una fila en `regla_aplicacion` (solo inserción: regla, compra, versión, periodo). «Aplicada» y «aceptada» se calculan desde ahí (P-4), sin contadores mutables.
- **D-9 · Permisos.** Ver reglas del cliente: `reglas.ver` y cliente visible. «Recordar», editar, activar, desactivar y eliminar: `reglas.gestionar` y cliente visible (P-7). Interruptor por estudio: `reglas.gestionar` con rol de alcance global. Cliente de otro estudio o no visible: 404, igual que uno inexistente.
- **D-10 · Sin datos sensibles en trazas.** Ni montos, razones sociales ni RUC en logs ni en el `resultado` de los trabajos; el `resultado` de la descarga suma solo el conteo de filas «Según historial».

## Criterios de aceptación
- [ ] CA-1 (HU-28, RF-110): al clasificar una fila en la grilla o en la lupa, se ofrece «¿Recordar para este proveedor en este cliente?» sin cortar el flujo de teclado de 015; aceptarlo crea la regla con ese destino, y sin `reglas.gestionar` no se ofrece y la ruta da 403.
- [ ] CA-2 (HU-28, RF-111, D-1, D-7): con una regla DNG para el proveedor X, la descarga del periodo siguiente deja sus compras con versión 2 `accion = historial`, destino DNG, la etiqueta «Según historial» en la grilla y en la lupa, y la versión 1 idéntica byte a byte a lo que trajo el SIRE.
- [ ] CA-3 (D-1, reversible): clasificar de nuevo una fila «Según historial» (una o en masa por el filtro «Según historial») crea otra versión con el destino elegido y quita la etiqueta; el resumen y 012b ven el destino vigente.
- [ ] CA-4 (D-7, P-5): no reciben versión las filas con regla inactiva o eliminada, con R-HIS apagado en el estudio, sin base gravada, con el destino ya igual, de un periodo igual o anterior al periodo en que se aprendió la regla, ni las filas que ya existían antes de la descarga (descarga repetida, 014 D-18).
- [ ] CA-5 (D-2, RF-115, aislamiento): una regla del cliente A nunca se aplica al cliente B del mismo estudio ni a otro estudio, aunque el proveedor sea el mismo; leer, editar o eliminar una regla con un `clienteId` o `reglaId` de otro estudio o cliente no visible da 404 igual que uno inexistente; con RLS forzada, una consulta sin `withTenant()` no ve filas.
- [ ] CA-6 (D-3, P-1, P-10): cada «Recordar» explícito y cada fila «Según historial» que sigue en el destino de la regla cuando su periodo pasa a `revisado` dejan una fila en `regla_confirmacion` del estudio si el RUC del proveedor empieza en 20 y el aporte del estudio está encendido; con RUC 10, con documento que no es RUC o con el aporte apagado no se registra nada; un rol de la aplicación no puede leer confirmaciones de otro estudio (prueba con dos estudios) ni actualizarlas o borrarlas; ninguna ruta de 021 devuelve datos de confirmaciones fuera del estudio.
- [ ] CA-7 (HU-31, RF-114): la pantalla de reglas del cliente muestra proveedor, destino, estado, veces aplicada (filas con versión `historial`) y aceptada (las que seguían en el destino de la regla cuando su periodo pasó a `revisado`); editar el destino, desactivar, activar y eliminar (baja lógica: la regla deja de mostrarse y de aplicarse, y las versiones pasadas conservan su «Según historial») se reflejan en la siguiente descarga y quedan en la auditoría con valor anterior y nuevo.
- [ ] CA-8 (RF-089): la lista del estudio muestra código y descripción simple de cada regla; apagar cualquiera de R-ISC, R-MIX, R-RED, R-NEW, R-GP o R-HIS hace que no aparezcan sus hallazgos en las evaluaciones siguientes, sin borrar los ya guardados (solo inserción), y la prevalidación de 012 no se puede apagar.
- [ ] CA-9 (D-5, concurrencia): dos «Recordar» del mismo proveedor a la vez dejan una sola regla; el segundo con la versión vieja da 409 `regla_cambiada`. Editar la regla durante una descarga deja todas las filas de esa descarga con un mismo destino (el leído en su transacción).
- [ ] CA-10 (D-6): el worker no puede insertar una versión `historial` con `n ≠ 2`, en una compra que no creó en esa transacción ni con un destino distinto al de la regla activa (falla cerrado, 42501); sigue sin `UPDATE` sobre `compra`.
- [ ] CA-11 (P-6): una fila con regla y con R-ISC o R-MIX recibe igual su versión `historial`, y sus hallazgos se evalúan sobre esa versión (en el destino de la regla); aceptar después esa sugerencia da los mismos montos que darían clasificar a mano la fila en ese destino y aceptarla, sin R-HIS.
- [ ] CA-12 (P-3): tras corregir el destino de una fila «Según historial», R-HIS no vuelve a sugerirlo ni a aplicarlo en esa fila, se ofrece «Recordar» con el destino nuevo y la regla queda igual (mismo destino y misma versión) mientras el contador no lo acepte.
- [ ] CA-13 (D-10): ningún log, error ni `resultado` contiene montos, razones sociales ni RUC; la auditoría de una versión `historial` lleva actor sistema y el id de la regla.
- [ ] CA-14: suites de `domain`, `db`, `backend`, `worker` y `frontend` tocadas, typecheck, lint, `db:migrate` ×2 y `pnpm e2e` (prioridad 1, con un caso «Recordar» → descarga siguiente → «Según historial» → revertir) en verde.
- [ ] Casos reales aplicables: ninguno de la lista. Se usa el ejemplo de 01 §7 regla 3 (cliente con ventas exoneradas, proveedor recurrente → DNG) como fixture.

## Dependencias
- Specs: 010 (`cambiarDestino`), 011 (`evaluarReglas`, R-NEW), 013/014 (descarga, versiones, D-4, D-9, D-14, D-15, D-18), 015 (grilla, masiva, filtros), 016 (lupa, evaluación numerada, 0038), 017 (auditoría). La consume 033 (catálogo) y 025 (aprendizaje de arranque).
- Externas: ninguna.

## Preguntas abiertas
Ninguna. P-1 a P-10 pasaron a «Decisiones del usuario» (2026-11-13).
