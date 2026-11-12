# Spec 020 · Deuda técnica de R1

Estado: borrador (2026-11-12). Rama `spec/020-deuda-r1` desde `main` (578c81b). Sin `plan.md` ni `tasks.md` hasta resolver P-1 a P-5.
Nivel de riesgo propuesto: **C** si se aceptan las recomendaciones de P-1 y P-2; **B** si entra la cola o la purga, con adversarial solo en esos puntos. Por §2.1: (1) no, porque no cambia montos, clasificación ni el armado del TXT/ZIP: solo textos, horas y nombres de descarga; (2) no, porque no abre superficie nueva. CA-8 de auth protege contra la enumeración de cuentas, y CA-2 exige que su prueba siga detectando la fuga; (3) sí, porque una hora mal convertida o un estado de credencial viejo no se notan a simple vista; (4) no, salvo que entren DT-9/DT-10 (cola concurrente) o DT-11 (borrado de auditoría inmutable).
Cubre: RNF-021 (solo si P-2 = b), RNF-031, RNF-035 y RNF-071 (no debilitarlos) · HU-09, HU-25, HU-26 · notas abiertas de R1 de `ESTADO.md` (decisión del usuario 2026-11-12).

## Objetivo
Cerrar la deuda de R1 anotada en `ESTADO.md` antes de R2: pruebas de tiempo que fallan a veces en CI, defectos menores de pantalla y la deuda de mantenimiento que no espera a R2. Los usuarios no deberían ver horas en UTC ni estados viejos, y una corrida en rojo del CI tiene que indicar un defecto real.

## Alcance (nota de origen → requisito)
| Nota de `ESTADO.md` | Requisito de 020 | Decisión |
|---|---|---|
| [pruebas] Umbrales bajo cobertura: `lectura.int.spec.ts` CA-15 y `auth.r1b.adv.int.spec.ts` CA-8; [pruebas] `generar-archivo.int.spec.ts` CA-13 (012b) y `ejecutor.int.spec.ts:523` | **DT-1** Estabilizar las cuatro pruebas sin cambiar los límites: la aserción de tiempo se mide sin instrumentar (P-4) y con mediana de varias muestras, y la espera de `:523` se ajusta a su causa | incluido |
| [pruebas] `restaurarConfig` de las adversariales del worker solo repone `sire`, `sol` y `xml` | **DT-2** `restaurarConfig` repone todas las colas de `config_sistema`, también `archivos` | incluido |
| [clientes] La ficha no refresca las credenciales tras verificar; [frontend] deuda de 007b (lo mismo, «Inválida» con el código crudo y «Cancelar» sin permiso) | **DT-3** La ficha se refresca sola al terminar la verificación, «Inválida» muestra un texto en español y «Cancelar» (en `trabajos/page.tsx`) solo aparece con permiso | incluido |
| [frontend] El panel «Generar archivo» tapa columnas a 1440 px | **DT-4** Con el panel abierto, a 1440 px, ninguna columna de la grilla de compras queda tapada | incluido |
| [frontend] La lupa y el Historial muestran horas en UTC | **DT-5** Toda fecha con hora de la UI sale en hora de Lima, con `lib/fechas.ts` (P-3) | incluido |
| [frontend] Deuda de 012b: `resumen_fuera_de_rango`, códigos de ventas sin traducir, versiones sin usuario ni SHA-256 y con el mismo nombre de ZIP | **DT-6** Mensajes para esos códigos; lista de versiones con autor, fecha, SHA-256 y un nombre de descarga distinto por versión | incluido |
| [frontend] Deuda de 012b: desborde de 27 px a 390 px por «Usuarios» | — | excluido: RNF-071 (escritorio ≥ 1366 px). Va con la vista móvil de buzones de R2 |
| [mantenimiento] T11e: si el stream tarda > 3 s, un evento perdido solo vuelve al recargar | **DT-7** Cuando el stream conecta después del listado, el panel de trabajos vuelve a leer el listado una vez | incluido |
| [mantenimiento] El CHECK `NOT VALID` de 0044 falla con las filas locales con µs | **DT-8** Migración 0046: normaliza `notificacion.creada_en` a ms y valida su CHECK; `auditoria` (inmutable, nunca se actualiza) sigue `NOT VALID`, como se documenta en 0044 | incluido |
| [rendimiento] El despachador hace `ZRANGE 0 -1` en cada atención (018 T11c) | **DT-9** Lectura acotada de las pistas, sin perder las garantías de `cerrarEstudioVacio` | según P-1 (recom.: excluir) |
| [mantenimiento] El SADD sin ZADD por `contarPendientes` (018 T11c) | **DT-10** El reconciliador publica (ZADD + SADD) los `en_cola` que no tienen pista | según P-1 (recom.: excluir) |
| [mantenimiento] La purga de auditoría a 5 años (017 D-7, RNF-021) | **DT-11** Trabajo de sistema `auditoria.purgar` | según P-2 (recom.: excluir) |
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

## Criterios de aceptación
- [ ] CA-1 (DT-1): las cuatro pruebas pasan 20 veces seguidas en local con carga (4 suites en paralelo, como en el CI) sin ningún fallo, y en 3 corridas seguidas del CI. CA-15 y CA-13 toman la mediana de al menos 3 muestras. La causa del fallo de `ejecutor.int.spec.ts:523` queda escrita en `tasks.md`, y su arreglo no quita ninguna aserción.
- [ ] CA-2 (DT-1, la garantía no se debilita): los límites siguen en 2 s (CA-15), 5 s (CA-13) y `|Δmediana| ≤ max(5 ms, 10 %)` (CA-8). Ninguno de los archivos lleva `retry` (comprobado con grep). Con un retraso de 20 ms inyectado solo en la rama de correo existente, CA-8 falla en ≥ 9 de 10 corridas; con el límite a la mitad de la mediana medida, CA-15 y CA-13 fallan.
- [ ] CA-3 (DT-1, P-4): con `CONTAPP_COBERTURA=1`, la parte funcional de cada prueba corre igual, y `pnpm ci:db` (sin instrumentar) evalúa la aserción de tiempo en cada push.
- [ ] CA-4 (DT-2): después de una suite que cambia `config_sistema` de `archivos`, la siguiente ve los valores originales de las cuatro colas.
- [ ] CA-5 (DT-3): con el estado «Verificando», al terminar el trabajo la ficha pasa a «Verificada» o «Inválida» sin recargar (prueba de componente y aserción en E-03). Para «Inválida», el texto es en español y el código crudo no aparece. Sin permiso para cancelar, «Cancelar» no se muestra.
- [ ] CA-6 (DT-4): en E2E a 1440×900, con el panel «Generar archivo» abierto, ninguna cabecera de columna se cruza con el panel y todas se alcanzan con el desplazamiento de la grilla.
- [ ] CA-7 (DT-5): `2026-10-20T15:00:00.000Z` se muestra como las 10:00 de Lima en la lupa, en el Historial y en las versiones del archivo, aunque el proceso corra con `TZ=UTC`. El grep no encuentra el texto «UTC» ni `slice(11, 16)` en `components/` ni en `lib/`. Las fechas sin hora (emisión, periodo, vencimiento) no cambian de día.
- [ ] CA-8 (DT-6): `resumen_fuera_de_rango`, `CUADRE`, `USD_SIN_TC` y `SALTO_CORRELATIVIDAD` muestran su texto (prueba de componente). Cada versión muestra autor, fecha en hora de Lima y SHA-256, y se descarga con un nombre distinto que lleva su número de versión.
- [ ] CA-9 (DT-7): una prueba de componente conecta el stream a los 4 s, y un trabajo que cambió de estado entre el listado y la conexión se ve con su estado final sin recargar.
- [ ] CA-10 (DT-8): `db:migrate` ×2 queda en verde y `notificacion_creada_en_ms` aparece como validado. En una BD con una notificación con µs anterior a 0046, marcarla como leída responde 200. `auditoria` no cambia: tiene el mismo conteo y el mismo resumen de filas antes y después.
- [ ] CA-11: las suites de los paquetes tocados, el typecheck, el lint y `pnpm e2e` (prioridad 1) quedan en verde. Las notas de `ESTADO.md` cerradas por 020 se tachan con «(cerrada por 020)».
- [ ] CA-12 (solo si P-1 = a): cada atención lee como máximo K pistas (K constante). Las suites de T11c (`despachador-t11c*`, `carreras-r2b`) y una ronda adversarial sobre DT-9/DT-10 pasan. Si Redis cae al encolar, el trabajo recibe ZADD y SADD en la primera pasada del reconciliador.
- [ ] CA-13 (solo si P-2 = b): `auditoria.purgar` borra solo las filas con más de 5 años, sin desactivar RLS ni el trigger de inmutabilidad para otros roles, y deja rastro en la auditoría. Una ronda adversarial no consigue borrar filas más recientes ni de otro alcance.
- [ ] Casos reales aplicables: ninguno.

## Dependencias
- Specs: 001 a 019 (hechas). Toca código de 004, 007b, 008, 012b, 014/015, 016, 017 y 018.
- Externas: ninguna.

## Preguntas para el usuario
- **P-1 · ¿Entra la deuda de la cola (DT-9 ZRANGE, DT-10 SADD sin ZADD)?** (a) Entra, con TDD y adversarial en esas tareas: 020 sube a B. (b) Queda fuera: DT-9 va a la spec de rendimiento y DT-10 queda como límite aceptado **(Recom.)**. Razón: hoy no fallan (O(N) solo pesa con miles de `en_cola`; DT-10 solo retrasa ≤ 30 s con Redis caído), y tocan el código de cierre de T11c, que dio H-018-1 y H-018-2.
- **P-2 · ¿Entra la purga de auditoría a 5 años (DT-11)?** (a) Fuera; la nota sigue con fecha límite, porque la primera fila cumple 5 años en 2031 **(Recom.)**. Razón: hoy no borraría nada y exige un camino que salte la inmutabilidad de 0041. Encaja mejor en una spec de retención (RNF-020/021, Ley 29733). (b) Entra, como trabajo de sistema del worker con función `SECURITY DEFINER` y una ronda adversarial: 020 sube a B.
- **P-3 · ¿Qué zona horaria y formato?** (a) Hora de Lima con `fechaHoraLima` (`es-PE` corto, «20/10/26, 10:00 a. m.»), el formato que ya usan auditoría y notificaciones (017) **(Recom.)**. Razón: un solo formato en toda la app. (b) Hora de Lima en 24 h, «2026-10-20 10:00», cambiando también auditoría y notificaciones. (c) La zona del navegador: no se recomienda, porque un contador de viaje vería otra hora que su equipo.
- **P-4 · ¿Las aserciones de tiempo se evalúan bajo cobertura?** (a) No: con `CONTAPP_COBERTURA=1` la prueba corre, pero no evalúa el tiempo; la garantía la da `pnpm ci:db`, que corre sin instrumentar y con medianas **(Recom.)**. Razón: la instrumentación v8 cambia los tiempos, y la corrida sin instrumentar es la que se parece a producción. (b) Sí, con un factor por paquete, como CA-13 ×3: sigue fallando con carga. (c) Un job de CI aparte, en serie y sin cobertura: suma minutos de CI.
- **P-5 · ¿Se divide la spec?** (a) Una sola 020 de nivel C, si la cola y la purga quedan fuera (P-1 = b, P-2 = a) **(Recom.)**. Razón: unas 8 tareas pequeñas, la mayoría en paralelo (frontend y pruebas). (b) Si entra la cola o la purga, dividirla: 020a (DT-1 a DT-8, C, aprobación en bloque) y 020b (DT-9 a DT-11, B, TDD + adversarial), para que lo de bajo riesgo no espere al resto.
