# Spec 020 · Deuda técnica de R1

Estado: aprobada (2026-11-12, decisiones P-1 a P-5 del usuario). Rama `spec/020-deuda-r1` desde `main` (578c81b). Plan en `plan.md` y tareas en `tasks.md`.
Nivel de riesgo: **C** (P-1 = b, P-2 = a, P-5 = a). Por §2.1: (1) no, porque no cambia montos, clasificación ni el armado del TXT/ZIP: solo textos, horas y nombres de descarga; (2) no, porque no abre superficie nueva. CA-8 de auth protege contra la enumeración de cuentas, y CA-2 exige que su prueba siga detectando la fuga; (3) sí, porque una hora mal convertida o un estado de credencial viejo no se notan a simple vista; (4) no: la cola (DT-9/DT-10) y el borrado de auditoría (DT-11) quedan fuera.
Cubre: RNF-031, RNF-035 y RNF-071 (no debilitarlos) · HU-09, HU-25, HU-26 · notas abiertas de R1 de `ESTADO.md` (decisión del usuario 2026-11-12).

## Objetivo
Cerrar la deuda de R1 anotada en `ESTADO.md` antes de R2: pruebas de tiempo que fallan a veces en CI, defectos menores de pantalla y la deuda de mantenimiento que no espera a R2. Los usuarios no deberían ver horas en UTC ni estados viejos, y una corrida en rojo del CI tiene que indicar un defecto real.

## Alcance (nota de origen → requisito)
| Nota de `ESTADO.md` | Requisito de 020 | Decisión |
|---|---|---|
| [pruebas] Umbrales bajo cobertura: `lectura.int.spec.ts` CA-15 y `auth.r1b.adv.int.spec.ts` CA-8; [pruebas] `generar-archivo.int.spec.ts` CA-13 (012b) y `ejecutor.int.spec.ts:523` | **DT-1** Estabilizar las cuatro pruebas sin cambiar los límites: la aserción de tiempo se evalúa solo sin instrumentar (P-4) y con mediana de varias muestras, y la espera de `:523` se ajusta a su causa | incluido |
| [pruebas] `restaurarConfig` de las adversariales del worker solo repone `sire`, `sol` y `xml` | **DT-2** `restaurarConfig` repone todas las colas de `config_sistema`, también `archivos` | incluido |
| [clientes] La ficha no refresca las credenciales tras verificar; [frontend] deuda de 007b (lo mismo, «Inválida» con el código crudo y «Cancelar» sin permiso) | **DT-3** La ficha se refresca sola al terminar la verificación, «Inválida» muestra un texto en español y «Cancelar» (en `trabajos/page.tsx`) solo aparece con permiso | incluido |
| [frontend] El panel «Generar archivo» tapa columnas a 1440 px | **DT-4** Con el panel abierto, a 1440 px, ninguna columna de la grilla de compras queda tapada | incluido |
| [frontend] La lupa y el Historial muestran horas en UTC | **DT-5** Toda fecha con hora de la UI sale en hora de Lima con `fechaHoraLima` de `lib/fechas.ts` (P-3) | incluido |
| [frontend] Deuda de 012b: `resumen_fuera_de_rango`, códigos de ventas sin traducir, versiones sin usuario ni SHA-256 y con el mismo nombre de ZIP | **DT-6** Mensajes para esos códigos; lista de versiones con autor, fecha, SHA-256 y un nombre de descarga distinto por versión | incluido |
| [frontend] Deuda de 012b: desborde de 27 px a 390 px por «Usuarios» | — | excluido: RNF-071 (escritorio ≥ 1366 px). Va con la vista móvil de buzones de R2 |
| [mantenimiento] T11e: si el stream tarda > 3 s, un evento perdido solo vuelve al recargar | **DT-7** Cuando el stream conecta después del listado, el panel de trabajos vuelve a leer el listado una vez | incluido |
| [mantenimiento] El CHECK `NOT VALID` de 0044 falla con las filas locales con µs | **DT-8** Migración 0046: normaliza `notificacion.creada_en` a ms y valida su CHECK; `auditoria` (inmutable, nunca se actualiza) sigue `NOT VALID`, como se documenta en 0044 | incluido |
| [rendimiento] El despachador hace `ZRANGE 0 -1` en cada atención (018 T11c) | DT-9 | excluido (P-1 = b): va a la spec de rendimiento. Hoy no falla: O(N) solo pesa con miles de `en_cola` |
| [mantenimiento] El SADD sin ZADD por `contarPendientes` (018 T11c) | DT-10 | excluido (P-1 = b): límite aceptado. Con Redis caído al encolar, el reconciliador lo repone en ≤ 30 s, sin pérdida |
| [mantenimiento] La purga de auditoría a 5 años (017 D-7, RNF-021) | DT-11 | excluido (P-2 = a): la nota sigue abierta con fecha límite 2031 (la primera fila cumple 5 años entonces); va a una spec de retención (RNF-020/021, Ley 29733) |
| [mantenimiento] El trigger `compra_version_worker_acotado` falla con `SAVEPOINT` | — | excluido: es latente y falla cerrado (42501), y ningún camino usa `SAVEPOINT`. La nota sigue abierta |
| [mantenimiento] Unificar el escritor xlsx de compras con la plantilla de 007b | — | excluido: la nota pide hacerlo cuando haya un segundo Excel, y todavía no lo hay |
| [rendimiento] El Ctrl+Z de la masiva (018 P-3); `leerExistentesCompras`, excluir venta por id y `avisos[]` sin tope (012b T25); [refactor] el desborde duplicado | — | excluido: van a la spec de rendimiento (decisión del usuario para P-3 de 018) |
| [pruebas] `seed-r2b.adv.spec.ts:29`, `lupa.e2e.ts:305` y las adv de 013 T22a | — | excluido: cada nota se activa si la prueba vuelve a fallar en CI, y no consta que haya pasado. Si falla, se aplica el mecanismo de DT-1 |
| [pruebas] El aviso de `ci:cierre` y las limpiezas de soporte; [proceso] | — | excluido: son reglas de uso para suites nuevas, no deuda |
| [R2], [R3], [lupa de ventas], [RF-005/006] | — | excluido: son funcionalidad de R2 o R3 |
| [despliegue], [infra], [real], [oficial], [diferido], [dependencias] | — | excluido: dependen de la spec de despliegue, de los adaptadores reales o del formato oficial |
| [usuario] El check requerido de la E2E en `main` | — | excluido: es un ajuste de GitHub que hace el usuario fuera del repo |
| [013] Observaciones de T22 (`leerFilasVentas` sin tope; el worker no revisa si el cliente se archivó) y las notas de regla o límite aceptado ([004], [005], [006], [007b], [014], [015], [permisos]…) | — | excluido: la etiqueta no es de las pedidas o el límite ya está aceptado. Las de [013] T22 entran si el usuario lo pide |

## Fuera de alcance
- Lo excluido en la tabla. Ninguna pantalla, endpoint ni regla nueva de R2.
- Cambiar los límites de RNF-031/035 o del CA-8 de 004, o reintentar una prueba (`retry`) para que pase.
- Cambiar el código de la cola (`packages/queue/src/despachador.ts`, `reconciliador.ts`) o la inmutabilidad de `auditoria`.

## Criterios de aceptación
- [ ] CA-1 (DT-1): las cuatro pruebas pasan 20 veces seguidas en local con carga (4 suites en paralelo, como en el CI) sin ningún fallo, y en 3 corridas seguidas del CI. CA-15, CA-13 y CA-8 toman la mediana de al menos 3 muestras (CA-8 ya usa 30 pares intercalados). La causa del fallo de `ejecutor.int.spec.ts:523` queda escrita en `tasks.md`, y su arreglo no quita ninguna aserción.
- [ ] CA-2 (DT-1, la garantía no se debilita): los límites siguen en 2 s (CA-15), 5 s (CA-13) y `|Δmediana| ≤ max(5 ms, 10 %)` (CA-8). Ninguno de los archivos lleva `retry` (comprobado con grep). Una prueba de la suite de auth inyecta un retraso de 20 ms solo en la rama de correo existente y comprueba que la comparación de CA-8 lo detecta; en la verificación, esa prueba detecta la fuga en ≥ 9 de 10 corridas. Con el límite a la mitad de la mediana medida, CA-15 y CA-13 fallan (comprobación manual, sin commit).
- [ ] CA-3 (DT-1, P-4): con `CONTAPP_COBERTURA=1`, la parte funcional de cada prueba corre igual y la aserción de tiempo no se evalúa (sin factor de holgura); `pnpm ci:db` (sin instrumentar) la evalúa en cada push.
- [ ] CA-4 (DT-2): después de una suite que cambia `config_sistema` de `archivos`, la siguiente ve los valores originales de las cuatro colas.
- [ ] CA-5 (DT-3): con el estado «Verificando», al terminar el trabajo la ficha pasa a «Verificada» o «Inválida» sin recargar (prueba de componente y aserción en E-03). Para «Inválida», el texto es en español y el código crudo no aparece. Sin permiso para cancelar (008 D9: quien encoló, Dueño o Administrador), «Cancelar» no se muestra.
- [ ] CA-6 (DT-4): en E2E a 1440×900, con el panel «Generar archivo» abierto, ninguna cabecera de columna se cruza con el panel y todas se alcanzan con el desplazamiento de la grilla.
- [ ] CA-7 (DT-5, P-3): `2026-10-20T15:00:00.000Z` se muestra como «20/10/26, 10:00 a. m.» (hora de Lima, `fechaHoraLima`) en la lupa, en el Historial y en las versiones del archivo, aunque el proceso corra con `TZ=UTC`. `grep -rn "UTC\|slice(11, 16)" apps/frontend/components apps/frontend/lib --include=*.ts --include=*.tsx | grep -v '\.spec\.'` solo encuentra el comentario de cabecera de `lib/fechas.ts`. Las fechas sin hora (emisión, periodo, vencimiento) no cambian de día.
- [ ] CA-8 (DT-6): `resumen_fuera_de_rango`, `CUADRE`, `USD_SIN_TC` y `SALTO_CORRELATIVIDAD` muestran su texto (prueba de componente). Cada versión muestra autor, fecha en hora de Lima y SHA-256, y se descarga con un nombre distinto que lleva su número de versión.
- [ ] CA-9 (DT-7): una prueba de componente conecta el stream a los 4 s, y un trabajo que cambió de estado entre el listado y la conexión se ve con su estado final sin recargar.
- [ ] CA-10 (DT-8): `db:migrate` ×2 queda en verde y `notificacion_creada_en_ms` aparece como validado. En una BD con una notificación con µs anterior a 0046, marcarla como leída responde 200. `auditoria` no cambia: tiene el mismo conteo y el mismo resumen de filas antes y después.
- [ ] CA-11: las suites de los paquetes tocados, el typecheck, el lint y `pnpm e2e` (prioridad 1) quedan en verde. Las notas de `ESTADO.md` cerradas por 020 se tachan con «(cerrada por 020)».
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 001 a 019 (hechas). Toca código de 004, 007b, 008 (solo pruebas), 012b, 014/015, 016, 017 y 018.
- Externas: ninguna.

## Decisiones del usuario (2026-11-12)
Todas en la opción recomendada.
- **P-1 · Deuda de la cola → (b) fuera.** DT-9 pasa a la spec de rendimiento y DT-10 queda como límite aceptado. Hoy no fallan, y tocan el código de cierre de T11c, que dio H-018-1 y H-018-2.
- **P-2 · Purga de auditoría → (a) fuera.** DT-11 se excluye; la nota sigue con fecha límite 2031. Hoy no borraría nada y exige un camino que salte la inmutabilidad de 0041; encaja en una spec de retención.
- **P-3 · Zona y formato → (a)** hora de Lima con `fechaHoraLima` (`es-PE` corto, «20/10/26, 10:00 a. m.»), el formato de auditoría y notificaciones (017). Un solo formato en toda la app.
- **P-4 · Tiempos bajo cobertura → (a) no se comparan.** Con `CONTAPP_COBERTURA=1` la prueba corre pero no evalúa el tiempo; la garantía la da el paso sin instrumentar (`pnpm ci:db`), con medianas. Los límites no cambian. En CA-8 de auth, una prueba inyecta 20 ms para comprobar que sigue detectando la enumeración de cuentas.
- **P-5 · División → (a)** una sola 020 de nivel C.
- **P-6 · Nombre del ZIP de una versión anterior → `_vN`** (2026-11-12): se revisa cuando llegue el formato oficial de SUNAT (nota [oficial]).
- **P-7 · Fechas sin hora → solo el día** (2026-11-12): pasan al día de Lima, sin añadir la hora.
