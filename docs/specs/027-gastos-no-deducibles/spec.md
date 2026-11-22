# Spec 027 · Gastos no deducibles (R-GP completo)

Estado: **aprobada (2026-11-22)**. U-1 a U-14 decididas por el usuario con la opción (a); matriz base de C y G y lectura de «revisado» precisadas el mismo día (ver «Decisiones del usuario»). Rama `spec/027-gastos-no-deducibles` (desde `main` d77dacc). Plan: `plan.md` · tareas: `tasks.md`.
Nivel de riesgo: **A** (U-1; ESTADO decía B). Por 04 §2.1: (1) no: solo sugiere, R-GP siempre pide confirmación (011) y nada se aplica solo; (2) sí: el diccionario del estudio guarda palabras sacadas de glosas de sus clientes y convive con uno global; una fuga o un cruce mostraría o aplicaría términos de un estudio en otro; (3) sí: una compra que no se marca (falso negativo por historial o umbral) no se nota en la grilla; (4) sí: normalización de texto, 7 señales con pesos, umbral, historial, CIIU, feriados y cambios concurrentes del diccionario. (2) con otras dos da A.
Cubre: RF-116, RF-117, RF-118 · HU-41, HU-42 · 01 §7 regla 15 · nota [R2] «R-GP completo» de `ESTADO.md`. Reutiliza: R-GP mínima, `texto/normalizar.ts` y `DiccionarioGlosas` de 011 (D-5); «Reglas del motor» por estudio de 021 (RF-089, D-9); excluir con motivo de 014 (D-6); glosas por ítem de `documento_xml` y `compra_evaluacion` de 016 (D-2, D-5); R-NEW de 011 y los estados de periodo de 014; `ConsultaRuc` de 007b/009; funciones de plataforma de 006.

## Objetivo
Que el contador vea marcadas como «Posible gasto no deducible» las compras que parecen consumo personal, con un puntaje determinístico (sin IA) y la lista de señales que lo explican, para revisarlas antes de generar el registro; que el estudio ajuste el diccionario de palabras y que el sistema aprenda palabras nuevas cuando el contador excluye una compra.

## Alcance
- **Puntaje de sospecha** (RF-116) puro en `packages/domain`: reemplaza la R-GP mínima de 011 con su mismo código, interruptor, sugerencia (`excluir`) y `requiereConfirmacion = true` (U-10). Suma las señales de R-3 y hay hallazgo si el puntaje ≥ umbral (R-11).
- **Diccionario efectivo** por estudio (RF-117, U-2): global (tabla de plataforma que edita el super-admin) − globales desactivadas por el estudio + palabras propias del estudio, en 6 categorías (U-3) y con frases de excepción (U-4).
- **Matriz giro → categorías permitidas** (S3, U-14): base por sección CIIU en el dominio y ajuste por cliente.
- **CIIU del proveedor y del cliente** (S2, S3, S4, U-7): `ConsultaRuc` devuelve la actividad principal; el worker la consulta y la guarda en caché por estudio 30 días. Mock por defecto (`RUC_CLIENT=mock`).
- **«Aprender estas palabras»** (RF-118, HU-42) al excluir una compra con XML.
- **«Volver a evaluar»** por periodo abierto (U-12): trabajo que crea evaluaciones nuevas (016) sin versiones.
- Pantallas: sección «Gastos no deducibles» en «Reglas del motor» del estudio (umbral y diccionario), diccionario global del super-admin con su historial, categorías permitidas en las reglas del cliente, chip y lupa con puntaje y señales, «Aprender» tras excluir y «Volver a evaluar» en el periodo.
- La descarga (014), la llegada del XML (016), las acciones de la grilla (014), la prevalidación (012) y la generación (012b) usan el mismo contexto: R-GP sigue solo avisando.
- Auditoría (017) según U-13. Migraciones desde **0069** (026 llegó a 0068).

## Fuera de alcance
- IA como señal (RF-116 «W»): el puntaje queda abierto a sumar señales, nada más.
- Exclusión parcial de una compra (solo los ítems personales): el contador edita montos con 014.
- Señal «categoría nueva para el cliente» (parte de S5): requiere guardar categorías por compra; queda como nota. S5 cuenta solo el proveedor nuevo (R-NEW).
- Promover palabras de un estudio al diccionario global, o conteos entre estudios: nunca en 027 (RF-115 por analogía; 033 si algún día).
- Ventas: R-GP es solo de compras. Umbral por cliente (U-6 (c)) y reevaluación automática de todos los periodos (U-12 (c)).
- Adaptador real de la consulta RUC con CIIU: mock por defecto, como 009.

## Reglas
- R-1 · **Nunca excluye solo.** El resultado es un hallazgo R-GP con `requiereConfirmacion = true`; aceptar exige confirmación una a una (en masa es `no_masiva`, 014 D-15). La versión vigente no cambia al evaluar ni al volver a evaluar.
- R-2 · **Determinismo.** Mismas entradas → mismo puntaje, mismas señales y mismo orden, sin depender del orden de ítems, palabras o historial. Sin IO en el dominio: el contexto trae diccionario efectivo, matriz ajustada, CIIU, historial y umbral; los feriados son una lista por año en el dominio.
- R-3 · **Señales y pesos** (fijos en código; solo el umbral se configura). El puntaje es un entero; las señales salen en el orden S1…S7:
  - S1 palabra clave en la glosa de un ítem: +3 por ítem coincidente, tope +6 por compra (U-5); la explicación dice «n de m ítems» y la palabra menor en orden de código entre los ítems coincidentes (independiente del orden de ítems y del diccionario, R-2).
  - S2 rubro del proveedor no relacionado: +3 si la clase CIIU del proveedor está en la lista base de rubros de consumo personal (plan) y su grupo CIIU (3 dígitos) difiere del del cliente. Sin CIIU de alguno: 0.
  - S3 categoría de la glosa no permitida para el giro del cliente: +2 una vez por compra si alguna categoría coincidente no está permitida por la matriz ajustada del cliente (R-13). Sin CIIU del cliente y sin ajuste: 0.
  - S4 fecha de emisión (XML) en sábado, domingo o feriado nacional de la lista del año, con proveedor de comercio minorista (división CIIU 47) o restaurante y bar (grupos 561 y 563): +1. Año sin lista: solo fin de semana.
  - S5 proveedor nuevo para el cliente (mismo criterio que R-NEW, aunque R-NEW esté apagada): +1.
  - S6 historial de exclusiones (U-8): +4 si el proveedor tiene ≥ 2 compras excluidas (versión vigente excluida, 014 D-6) en los 12 periodos anteriores al evaluado (M−12 a M−1; el periodo evaluado M no cuenta).
  - S7 historial de aceptación (U-8): −4 si el proveedor tiene ≥ 3 compras vivas no excluidas en periodos en estado `revisado` o `generado` (decisión del usuario: «revisado» incluye `generado`; `abierto` no cuenta) de los 6 periodos anteriores al evaluado (M−6 a M−1; M no cuenta) y ninguna excluida en esos 6 periodos. S6 y S7 nunca a la vez (si S6 aplica, S7 no).
- R-4 · **Coincidencia** (U-4): la de 011 sobre `tokensDeGlosa` (palabra completa, plural simple `s`/`es`, con o sin punto final, abreviatura con punto ≥ 4 letras prefijo de la palabra, sin tildes ni mayúsculas) **más frases de excepción por palabra**: si una frase de excepción de esa palabra (1 a 3 palabras seguidas, misma normalización) aparece en el mismo ítem, esa palabra no cuenta en ese ítem. Una palabra del diccionario es una sola palabra `[a-z0-9]` de 3 a 40 caracteres, con hasta 5 frases de excepción; hasta 2.000 palabras propias activas por estudio. Base: «zapatilla», «zapato» y «bota» salvo «seguridad»; «polo» salvo «a tierra»; las demás en el plan.
- R-5 · **Sin XML** (U-9): R-GP no se evalúa ni puntúa (como en 011); al llegar el XML (016) se evalúa. Las glosas son texto no confiable (016 D-2, D-11): la explicación lleva solo la palabra del diccionario, la categoría, conteos y textos fijos de cada señal; nunca texto del XML, montos, RUC ni razón social en logs, errores, auditoría ni `resultado` de trabajo.
- R-6 · **Aislamiento.** Palabras propias, globales desactivadas, umbral, ajuste por cliente y caché de CIIU son tablas del estudio con `tenant_id` y RLS forzada; todo dentro de `withTenant()` y escritura solo por funciones acotadas. El diccionario global es tabla de plataforma: los roles de la aplicación solo la leen y se escribe solo por funciones de plataforma (patrón de `plan_crear` de 006: revalidan la sesión viva y el alta en `admin_plataforma`). Ninguna función de plataforma lee tablas del estudio. Id de otro estudio: 404 igual que inexistente.
- R-7 · **Aprender** (RF-118): al excluir una compra con XML (fila o lupa, no en masa), quien tenga `reglas.gestionar` sobre el cliente (U-11) ve hasta 10 términos propuestos: tokens normalizados de sus glosas sin punto final, sin números, unidades (und, kg, pza…), palabras vacías ni términos ya activos en el diccionario efectivo, en orden de primera aparición. Elige cuáles, puede corregir cada término y elige su categoría (obligatoria, de las 6). Se guardan como propias con origen «aprendida», el usuario y la compra de origen; un término que ya existe en el diccionario del estudio se omite y se informa. Solo sobre una compra con versión vigente excluida y XML vigente. No ofrecerlo nunca bloquea ni deshace la exclusión.
- R-8 · **Cuándo rige** un cambio del diccionario (global o del estudio), del umbral o del ajuste por cliente (U-12): en la siguiente evaluación de cada compra (descarga, XML nuevo o acción de la grilla que re-evalúa), y en todo el periodo cuando el usuario pulsa «Volver a evaluar» en un periodo `abierto` (R-12). Los hallazgos ya guardados no cambian solos. R-GP apagada en «Reglas del motor» (021) no se evalúa ni puntúa.
- R-9 · **Interacción con 011/021/025** (U-10): R-GP de 011 se reemplaza (mismo código e interruptor); una regla aprendida activa del proveedor (021) no cambia el puntaje. R-GP no impide que R-HIS (021) o R-STD (025) se apliquen; las demás reglas se evalúan igual.
- R-10 · **Rendimiento.** El diccionario se indexa por token (sin recorrido palabra × token): puntuar 5.000 compras de 20 ítems con 2.000 palabras propias no debe tardar más del doble que la misma evaluación con la R-GP de 011.
- R-11 · **Umbral** (U-6): 3 por defecto (una palabra clave basta), entero de 1 a 20 por estudio en «Reglas del motor».
- R-12 · **Volver a evaluar** (U-12): solo en un periodo de compras `abierto`; encola un trabajo por cliente y periodo (dedupe) que re-evalúa las compras vivas del periodo con el contexto actual y agrega la evaluación `n + 1` (016) solo a las compras cuyos hallazgos cambian; no crea versiones ni mueve punteros. Periodo `revisado` o `generado`: 409.
- R-13 · **Matriz** (U-14, D-6): base por sección CIIU del cliente (tabla en el plan; C y G sin categorías permitidas); el estudio permite o quita categorías por cliente y el ajuste prevalece sobre la base. Sin CIIU del cliente, solo cuentan las categorías quitadas por el ajuste.
- R-14 · **CIIU** (U-7): `ConsultaRuc.consultar` devuelve además la clase CIIU de la actividad principal (4 dígitos o null). El worker, al procesar el XML de una compra (016), consulta fuera de transacción el RUC del proveedor y el del cliente que no estén en la caché del estudio o tengan más de 30 días; `ErrorDatos` guarda «sin dato» (30 días) y `ErrorTransitorio` sigue sin CIIU; ninguno de los dos falla el trabajo del XML. Las demás evaluaciones solo leen la caché. El backend nunca consulta.

## Decisiones de diseño
- **D-1 · Resultado.** `SugerenciaExcluir` suma `puntaje` (entero) y `senales: {codigo: S1…S7, puntos, palabra?, categoria?, items?: {coinciden, total}}[]`; la explicación de R-GP es «Posible gasto no deducible» y la lupa muestra cada señal con un texto fijo. Los hallazgos de 011 sin puntaje se siguen leyendo.
- **D-2 · Persistencia.** Plataforma: `gnd_palabra_global` (palabra única, categoría, excepciones, activa, versión) y `gnd_global_historial` (solo inserción: actor, acción, antes y después), con la semilla inicial en la migración. Estudio: `gnd_palabra_estudio`, `gnd_global_desactivada`, `gnd_config` (umbral y versión), `gnd_cliente_categorias` y `gnd_ciiu` (caché por RUC). Compare-and-set por versión (409 `version_cambiada`).
- **D-3 · Permisos** (U-11). Ver diccionario, umbral y categorías del cliente: `reglas.ver`. Diccionario y umbral del estudio: `reglas.gestionar` con alcance global (Dueño y Administrador, como 021 D-9). Aprender y categorías del cliente: `reglas.gestionar` y cliente visible (incluye Contador asignado). Volver a evaluar: `sire.clasificar` y cliente visible (como las acciones de la grilla). Diccionario global: solo super-admin. Cliente no visible o de otro estudio: 404; archivado: 409 `cliente_archivado` al escribir.
- **D-4 · Auditoría** (U-13). Acciones nuevas del catálogo de 017 (actor usuario): palabra agregada, desactivada, reactivada y aprendida; global desactivada y reactivada por el estudio; umbral cambiado; categorías del cliente cambiadas. Datos: palabra, categoría, origen, umbral antes/después o categorías antes/después; nunca glosas completas. Los cambios del super-admin quedan en `gnd_global_historial` (la auditoría de 017 es por estudio) y se ven en su pantalla.
- **D-6 · Matriz base de C y G sin categorías** (decisión del usuario, 2026-11-22). Manufactura (C) y comercio (G) no permiten ninguna de las 6 categorías en la base: una ferretería que compra ropa suma S3. El estudio agrega por cliente las que vende o fabrica (p. ej. calzado-ropa a una tienda de ropa).
- **D-5 · Contexto único.** Un solo lector en `packages/db` arma el contexto de R-GP (diccionario efectivo, umbral, matriz ajustada, CIIU de caché e historial S6/S7) y el worker y el backend lo pasan igual al dominio en las seis entradas de Alcance, de modo que aceptar re-evalúa con el mismo contexto (si cambió, `sugerencia_obsoleta` como en 011).

## Criterios de aceptación
- [ ] CA-1 (HU-41, R-3): cliente ferretería (CIIU 4752) y compra de una tienda de ropa (CIIU 4771, mock) con glosa «ZAPATILLA URBANA T42» emitida un miércoles, sin ajuste de categorías → hallazgo R-GP «Posible gasto no deducible», puntaje 8 (9 si el proveedor es nuevo), señales «palabra clave: zapatilla (1 de 1 ítems)», «rubro del proveedor no relacionado» y «categoría no permitida para el giro: calzado-ropa» (D-6); con calzado-ropa permitida al cliente en su ajuste, puntaje 6 y sin S3; la versión vigente no cambia.
- [ ] CA-2 (HU-41, S7, U-8): el caso de CA-1 con 3 compras del proveedor en periodos `revisado` o `generado` de M−6 a M−1 y ninguna excluida → el puntaje baja en 4 (8 → 4, sigue marcado con umbral 3); el mismo historial con un proveedor sin CIIU en caché (S1 + S3 − 4 = 1) → bajo el umbral, sin hallazgo; con 2 compras, con una de ellas excluida, o con las 3 en periodos `abierto` o en M−7, vuelve a marcar.
- [ ] CA-3 (R-1): aceptar el hallazgo sin `confirmar` da 422 `requiere_confirmacion`; en masa da `no_masiva`; ninguna descarga, evaluación ni «Volver a evaluar» crea una versión excluida.
- [ ] CA-4 (caso real zapatilla, R-4, U-4): «ZAPATILLAS URBANAS T-42», «zapat. dep.», «ZAPATILLAS.38» y la glosa de F001-5070 de 016 puntúan S1; «zapata de concreto», «zapatilla de seguridad» y «polo a tierra» no. Las pruebas de 011 (`texto/`, `ronda1b`, `ronda2a/b`) siguen en verde (ajustadas solo por la forma nueva del hallazgo).
- [ ] CA-5 (S1–S7): una prueba por señal con su borde: 1, 2 y 3 ítems coincidentes (3, 6 y 6); sábado y feriado de la lista con restaurante (sí) y con ferretería (no); día hábil (no); año sin lista (solo fin de semana); proveedor conocido (S5 = 0); S7 con 3 compras en M−6 (sí) y en M−7 (no); S6 con 2 excluidas en M−12 (sí), 1 (no) y en M−13 (no); S6 y S7 a la vez imposibles; sin CIIU (S2 = S4 = 0); categoría permitida por la matriz base (alimentos-personales en un restaurante, sección I) y quitada en el ajuste del cliente (S3 de 0 a +2); cliente de sección C o G sin ajuste (S3 = +2) y con la categoría permitida en el ajuste (S3 = 0).
- [ ] CA-6 (R-2): permutar ítems, palabras del diccionario o historial no cambia puntaje, señales ni orden; la entrada no se muta; un `__proto__`, una clave extra o un número donde va una cadena en el contexto es rechazo.
- [ ] CA-7 (RF-117, R-6): el estudio A agrega «audifono» y desactiva «polo»; una compra de A con «AUDÍFONOS» se marca y otra con «POLO» no; las mismas glosas en el estudio B dan lo contrario. B no lista, edita ni reactiva palabras de A (404 igual que inexistente); los roles de la aplicación no escriben directo en las tablas nuevas (42501) y las funciones de plataforma rechazan a quien no es super-admin.
- [ ] CA-8 (U-11): Dueño y Administrador editan diccionario y umbral; Contador asignado aprende y ajusta categorías de su cliente pero recibe 403 en diccionario y umbral; Asistente y Lectura reciben 403 en toda escritura de 027 salvo Asistente en «Volver a evaluar»; la UI no ofrece lo que no se puede; un asistente que excluye no ve «Aprender estas palabras».
- [ ] CA-9 (HU-42, R-7): al excluir una compra con glosa «AUDIFONOS BLUETOOTH JBL X2 UND 2.00» se proponen «audifonos», «bluetooth» y «jbl» (no «x2», «und» ni «2.00»); al elegir «audifonos» → entretenimiento la palabra queda propia «aprendida» con usuario y compra; la siguiente evaluación de una compra con «audífono» la marca. Un término inválido (espacios, < 3 letras, > 40), una categoría fuera de las 6, más de 10 términos o una compra no excluida o sin XML es 400/409 y no guarda nada.
- [ ] CA-10 (U-6): el estudio sube el umbral a 9 → el caso de CA-1 (puntaje 8) ya no se marca en la siguiente evaluación; 0, 21 o un decimal es 400; versión vieja es 409 `version_cambiada`.
- [ ] CA-11 (R-5, U-9): sin XML no hay hallazgo ni puntaje R-GP; ninguna explicación, log, error, auditoría ni `resultado` de trabajo contiene texto de la glosa salvo la palabra del diccionario (glosa con `<script>` y canarios incluidos).
- [ ] CA-12 (R-8, R-12, U-12): tras agregar una palabra, los hallazgos guardados no cambian hasta la siguiente evaluación; «Volver a evaluar» en un periodo abierto marca la compra con evaluación `n + 1`, sin versión nueva y sin tocar compras sin cambios; en un periodo revisado o generado da 409; dos pedidos comparten trabajo; con R-GP apagada no hay hallazgo ni puntaje.
- [ ] CA-13 (012, 012b): la prevalidación y la generación usan el diccionario efectivo y el contexto del estudio con el mismo puntaje; R-GP sigue siendo solo aviso y nunca bloquea.
- [ ] CA-14 (U-13): agregar, desactivar, reactivar y aprender palabras, desactivar o reactivar una global, cambiar el umbral y las categorías del cliente dejan su auditoría con actor, antes y después; los cambios del super-admin quedan en el historial global; ninguna entrada lleva glosas completas.
- [ ] CA-15 (R-10): prueba de rendimiento del dominio con 5.000 compras × 20 ítems y 2.000 palabras propias dentro del tope de R-10.
- [ ] CA-16 (R-14, U-7): al llegar el XML, el worker consulta el CIIU del proveedor y del cliente sin caché (mock) y lo guarda en la caché del estudio; dentro de 30 días no vuelve a consultar y después sí; otro estudio consulta por su cuenta; `ErrorTransitorio` y `ErrorDatos` no fallan el trabajo del XML; el backend no importa `@contapp/sunat`.
- [ ] CA-17: suites de `domain`, `shared`, `sunat`, `queue`, `db`, `worker`, `backend` y `frontend` tocadas, `test:aislamiento`, typecheck, lint, `db:migrate` ×2, `cobertura:gastos` ≥ 90 % por archivo y `pnpm e2e` (un caso: compra con zapatillas → chip y lupa con señales → excluir → aprender una palabra → «Volver a evaluar» marca otra compra con esa palabra) en verde.
- [ ] Casos reales aplicables: zapatilla (CA-1, CA-4, CA-9 y la E2E con la glosa de 016 F001-5070). San Juan ISC, mixta 21.48/1.61, redondeo USD y boleta 291: no aplican (se comprueba que R-GP no cambia sus hallazgos).

## Dependencias
- Specs: 006 (funciones de plataforma), 007b y 009 (`ConsultaRuc`), 011, 012, 012b, 014, 015, 016, 017, 021, 022, 025 (todas hechas). La consume 037 (borrado del cliente y del estudio).
- Externas: CIIU real de la ficha RUC (adaptador real; mientras, mock).

## Riesgos
- **Ruido o silencio**: pesos, matriz base, lista de rubros de consumo personal y palabras iniciales son una primera versión; conviene que un contador del equipo revise las tablas del plan antes de la verificación.
- **CIIU ausente**: sin caché (XML aún no procesado, mock sin dato o fallo) S2, S3 y S4 dan 0 y la compra puede no marcarse; se ve en la lupa solo si hay hallazgo.
- **Crecimiento de evaluaciones**: «Volver a evaluar» solo agrega evaluaciones a compras que cambian (R-12).

## Decisiones del usuario (2026-11-22)
Todas con la opción recomendada (a):
- **U-1** Nivel A: TDD y dos rondas adversariales.
- **U-2** Diccionario global de plataforma que edita el super-admin, más capa por estudio (agregar y desactivar) (R-6, D-2).
- **U-3** Las 5 categorías de RF-117 más útiles escolares, con 10–20 palabras cada una (plan).
- **U-4** Coincidencia de 011 más frases de excepción por palabra (R-4).
- **U-5** +3 por ítem coincidente con tope +6 y «n de m ítems» (R-3).
- **U-6** Umbral 3 por defecto, configurable 1–20 por estudio (R-11).
- **U-7** CIIU por `ConsultaRuc` con mock; el worker consulta y guarda en caché por estudio 30 días (R-14). El puerto ya existía (007b): se amplía con la actividad principal en vez de crear otro.
- **U-8** S7 con ≥ 3 compras en periodos revisados de los últimos 6 meses sin excluidas; S6 con ≥ 2 excluidas en 12 meses (R-3).
- **U-9** Sin XML no se evalúa R-GP (R-5).
- **U-10** Reemplaza R-GP (mismo código e interruptor); una regla aprendida no cambia el puntaje (R-9).
- **U-11** Permisos de 021: `reglas.gestionar` (global para diccionario y umbral; sobre el cliente para aprender) y `reglas.ver` (D-3).
- **U-12** Rige en la siguiente evaluación, más «Volver a evaluar» por periodo abierto (R-8, R-12).
- **U-13** Auditar los cambios del estudio y del super-admin (D-4).
- **U-14** Matriz base por sección CIIU y ajuste por cliente (R-13).
- **Precisión de U-8** (sobre la duda 3 del plan): «periodos `revisado`» = estado `revisado` o `generado`; ventanas de 6 y 12 periodos anteriores al evaluado (M−6 a M−1 y M−12 a M−1), sin contar M (R-3).
- **Matriz base de C y G** (sobre la duda 4 del plan): sin categorías permitidas; el estudio las agrega por cliente (D-6, CA-1, CA-2).
- Aceptadas sin cambios: ampliar `ConsultaRuc` en vez de un puerto nuevo; diccionario global con funciones `auth.*` e historial de plataforma; «Volver a evaluar» con `sire.clasificar` y evaluación nueva solo si cambian los hallazgos.

## Notas para otras specs
- **037 (borrado)**: borrar `gnd_cliente_categorias` con el cliente y las tablas `gnd_*` del estudio con el estudio, solo por su camino acotado.
- **Adaptador real de la consulta RUC**: mapear la actividad económica principal a la clase CIIU rev. 4 (4 dígitos).
- **S5 completa**: «categoría nueva para el cliente» necesita guardar la categoría de cada compra excluida o aceptada.
