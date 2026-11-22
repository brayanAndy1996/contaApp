# Spec 026 · Prorrata e IGV estimado

Estado: **hecha (2026-11-22)**. U-1 a U-13 decididas por el usuario con la opción (a). Rama `spec/026-prorrata-igv` (desde `main` 4d976cd). Plan: `plan.md` · tareas: `tasks.md`.
Nivel de riesgo: **A**. Por 04 §2.1: (1) sí: un coeficiente mal calculado cambia el crédito fiscal DGNG y el IGV que el contador le anticipa al cliente; (2) sí: el trabajo entra a SOL con la clave del cliente y guarda sus declaraciones por cliente; (3) sí: un mes mal tomado o un redondeo distinto mueve el porcentaje unas centésimas y no se ve; (4) sí: orígenes por mes (declarado, rectificatoria, SIRE, manual), meses faltantes, notas de crédito, USD, división por cero y obtención concurrente con el buzón. (1) y (2) con otras dos dan A.
Cubre: RF-130 a RF-135 · HU-35, HU-36 · 01 §7 reglas 4 y 17 · RNF-034, RNF-042, RNF-050, RNF-051, RNF-070. HU-35 se lee con U-1: la prorrata de 2026-10 usa 2025-11 a 2026-10 (el ejemplo de HU-35, 2025-10 a 2026-09, queda reemplazado).

## Objetivo
Que el contador no arme la prorrata en Excel: el sistema obtiene de SOL los PDT 621 declarados, arma la ventana de 12 meses con el origen de cada monto, permite completar a mano lo que falte, calcula el coeficiente y el IGV estimado del mes con las compras ya clasificadas en ContApp, y avisa si la prorrata que usó en su declaración no coincide (HU-35, HU-36).

## Alcance
- **Obtener declaraciones** (RF-130, U-12): a pedido desde la pantalla de prorrata del cliente, «Obtener declaraciones» encola `sol.declaraciones.descargar` (cola y canal `sol`, credencial `sol`) para la ventana del mes elegido M (R-1). El worker usa un método nuevo del puerto `SolPortal`; adaptador `MockSolPortal` por defecto (`SOL_PORTAL=mock`). Lo obtenido se guarda y se reutiliza; no hay obtención programada. El backend nunca llama a SUNAT ni descifra la clave.
- **Cálculo puro** en `packages/domain/src/prorrata/`: ventana, precedencia de orígenes, coeficiente (RF-131) e IGV estimado (RF-134), con `Money`/`Factor`/`redondearSunat` de 010.
- **Pantalla** `clientes/[id]/prorrata` (RF-132): tabla mes a mes (ventas gravadas, exportaciones, no gravadas, total y origen por mes), gráfico de barras de gravadas + exportaciones frente a no gravadas, coeficiente, IGV estimado y avisos.
- **Mes manual** (RF-133, U-4): ingresar o corregir los montos de un mes sin declaración; queda marcado «manual» con autor, fecha y motivo, y su historial.
- **Prorrata usada ingresada** (U-9): si el PDT de M no la trae, el contador puede ingresarla.
- **IGV estimado del mes** (RF-134, HU-36, U-8): IGV de ventas − crédito DG − (crédito DGNG × prorrata) con el detalle de cada componente y «a pagar», «saldo a favor» o «cero».
- **Alerta de diferencia** (RF-135, U-10).
- Permiso nuevo `prorrata.gestionar` (U-11), auditoría (017) y migraciones desde **0065** (025 llegó a 0064). Disponible en todos los planes (U-13): sin control de `features`.

## Fuera de alcance
- Adaptador real `PlaywrightSolPortal` para PDT 621 y el mapeo a casillas reales: spec del adaptador SOL real (RNF-042). 026 fija un layout provisional en `puertos.ts`.
- Saldo a favor de meses anteriores, percepciones y retenciones (U-8); comparar el IGV estimado con el IGV declarado; generar o presentar el PDT 621; prorrata de renta o IVAP.
- Obtención programada o masiva para todos los clientes (U-12).
- Ventana menor a 12 meses por inicio de actividades: se cubre con meses manuales en 0 (U-5).
- Separar exportaciones en las ventas del SIRE (013): cambia el layout de 013; aquí se usa R-2b.
- Cambiar la clasificación DG/DGNG/DNG desde esta pantalla: se hace en compras (014/015).

## Reglas de negocio
- **R-1 · Ventana** (U-1): para el mes M se usan los 12 meses que terminan en M, incluido M (Reglamento de la LIGV, art. 6 num. 6.2). M = 2026-10 → 2025-11 a 2026-10. M no puede ser posterior al mes en curso (hora de Lima).
- **R-2 · Montos por mes** (U-2): `gravadas` = base imponible de ventas gravadas; `exportaciones` aparte; `noGravadas` = exoneradas + inafectas. Notas de crédito restan. No cuentan IGV, ISC, ICBPER ni «otros». Todo en soles; en un mes SIRE las USD se convierten como el resumen de 013 (`redondearSunat(columna × tc)` por fila) y una USD sin tipo de cambio no suma y deja aviso en su mes.
- **R-2b · Exportaciones en un mes SIRE** (derivada de U-2, U-3 y U-4): el layout de ventas de 013 no separa exportaciones, así que un mes SIRE toma `exportaciones = 0` y lleva el aviso «El SIRE no separa exportaciones: si el cliente exportó este mes, ingrésalo a mano». Si algún mes declarado o manual de la ventana tiene `exportaciones ≠ 0`, el coeficiente suma el aviso «Este cliente declaró exportaciones: revisa los meses SIRE». El contador lo corrige ingresando el mes como manual (permitido: no tiene declaración, R-5), que desplaza al SIRE.
- **R-3 · Coeficiente**: `numerador = Σ(gravadas + exportaciones)`, `total = numerador + Σ noGravadas`, `porcentaje = numerador / total × 100` redondeado a 2 decimales mitad hacia arriba (U-7). Cociente con decimal exacto dentro del dominio (operación nueva, sin exponer `Decimal`); nunca `number`.
- **R-4 · Casos límite** (U-6): `total = 0` → «no determinable», sin IGV estimado y con el motivo; `numerador = 0` con `total > 0` → 0,00 % válido (crédito DGNG 0) con aviso «revisa si esas compras son DNG»; solo gravadas o exportaciones → 100,00 %. Un mes con totales negativos (más notas que ventas) se muestra tal cual; si el acumulado da `numerador < 0`, `total ≤ 0` o `numerador > total` (no gravadas acumuladas negativas), «no determinable».
- **R-5 · Origen y precedencia** (U-3, U-4): por mes, **declarado** (PDT 621 vigente: la presentación de mayor número de orden, original o rectificatoria) > **manual** > **SIRE** (ventas de 013 del periodo, con el periodo de ventas cargado; un periodo cargado sin filas es SIRE en 0). Un mes declarado no admite manual (409 `mes_declarado`). Si llega una declaración para un mes que tenía manual, gana la declarada; el manual queda en el historial y el mes muestra «Reemplazado por la declaración». Si algún mes de la ventana es SIRE o manual, el coeficiente es «provisional».
- **R-6 · Meses faltantes** (U-5): si algún mes de la ventana no tiene ningún origen, no se calcula el coeficiente ni el IGV estimado y se listan los meses que faltan; el contador los completa a mano (montos en 0 = «sin operaciones»; sirve también para meses anteriores al inicio de actividades).
- **R-7 · IGV estimado de M** (U-8): `igvVentas` = IGV de las ventas de M (las mismas filas que suman en el resumen de 013; notas restan); `creditoDg` = `igvDg` vigente de las compras de M (las mismas filas que suman en el resumen de 014); `creditoDgng = redondearSunat(Σ igvDgng × porcentaje / 100)` con el porcentaje ya redondeado; DNG no da crédito (se muestra informativo). `resultado = igvVentas − creditoDg − creditoDgng`: > 0 «a pagar», < 0 «saldo a favor», = 0 «cero». Si el periodo de ventas o el de compras de M no está cargado, se dice cuál falta y no se estima. Se muestra el estado del periodo de compras (abierto/revisado/generado) y la nota fija «Estimado: no incluye saldo a favor anterior, percepciones ni retenciones».
- **R-8 · Diferencia** (U-9, U-10): prorrata usada de M = la del PDT vigente de M; si no la trae, la ingresada por el contador (si el PDT la trae, no se admite ingreso: 409 `prorrata_declarada`; si una declaración posterior la trae, gana la declarada). Con coeficiente calculado y prorrata usada, alerta cuando `|calculada − usada| ≥ 0,01` puntos, con ambos valores y su origen. Sin prorrata usada o con coeficiente no calculado, no hay alerta.

## Decisiones de diseño
- **D-1 · Puerto.** `SolPortal.obtenerDeclaraciones621(credencial, {periodo})` → todas las presentaciones del PDT 621 de ese periodo (lista vacía = sin declaración), cada una con: periodo, número de orden, fecha de presentación, original/rectificatoria, base e IGV de ventas gravadas, exportaciones, ventas no gravadas (exoneradas + inafectas), IGV de adquisiciones DG y DGNG y `prorrataUsada` (cadena con hasta 2 decimales o `null`). Montos como cadenas decimales. Lanza `ErrorCredencial`, `ErrorTransitorio`, `ErrorDatos` o `ErrorPortal` como 023. Layout provisional (Riesgos).
- **D-2 · Mock.** `MockSolPortal` resuelve las declaraciones con el mismo orden de origen que el buzón (`inyectar` → `{dirFixtures}/pdt621/{ruc}.json` → generado determinista por RUC, sin reloj ni azar); el generado incluye meses sin declaración, una rectificatoria, un mes con `ErrorDatos`, exportaciones y una prorrata usada distinta de la calculada. No conserva la credencial.
- **D-3 · Trabajo.** Parámetros estrictos `{periodo}` (AAAAMM); el cliente sale del trabajo y la ventana (12 periodos, R-1) se deriva en el worker. Lee SOL por periodo fuera de transacción y escribe todo en una sola transacción, sin `SAVEPOINT` (nota de 0038), por una función acotada que solo inserta presentaciones nuevas y el registro de la obtención. Dedupe de 008 por cliente y periodo; el bloqueo por RUC de 008 lo serializa con `sol.buzon.*`. Credencial inválida: `credencial_invalida`, sin reintento y sin escribir nada (01 §3). Un periodo con `ErrorDatos` queda «sin declaración» y el resto sigue.
- **D-4 · Persistencia.** Tablas solo de inserción: `declaracion_mensual` (una fila por presentación), `prorrata_obtencion` (una por obtención: periodos leídos y sin declaración), `prorrata_mes_manual` y `prorrata_usada_manual` (una fila por versión; la vigente es la de mayor versión y una versión «eliminada» deja el mes sin manual). Compare-and-set por versión (409 `mes_cambiado`). Todas con `tenant_id`, RLS forzada y `NUMERIC(14,2)` (porcentajes `NUMERIC(5,2)`). Escritura solo por funciones `SECURITY DEFINER`. El coeficiente y el IGV se calculan al leer (no se usa `prorrata_calculo` de 03 §8). La función del worker no lee ni escribe ventas, compras ni manuales.
- **D-5 · Permisos** (U-11). Ver: `prorrata.ver` y cliente visible. Obtener, guardar o eliminar el manual y guardar la prorrata usada: `prorrata.gestionar` (Dueño, Administrador y Contador) y cliente visible. Cliente no visible o de otro estudio: 404 igual que inexistente; archivado: 409 `cliente_archivado` al escribir (lectura permitida). Sin credencial SOL o marcada inválida: 409 `credencial_no_configurada` / `credencial_invalida` sin encolar (como 023); el manual sigue disponible.
- **D-6 · Auditoría.** Acciones nuevas del catálogo cerrado de 017: `prorrata.declaraciones_obtenidas` (actor trabajo: periodo, periodos leídos, sin declaración, nuevas), `prorrata.mes_manual_guardado`, `prorrata.mes_manual_eliminado` y `prorrata.usada_guardada` (actor usuario: cliente, periodo, versión). Montos y motivos quedan en las filas versionadas, no en la auditoría ni en logs.
- **D-7 · Sin secretos ni datos en trazas.** Ni clave SOL, ni montos, ni RUC en logs, errores ni `resultado` del trabajo (solo conteos).
- **D-8 · Frontend.** Gráfico en SVG propio con los tokens de 038, sin dependencias nuevas; texto con términos de SUNAT (RNF-070). Origen por mes con etiqueta; «provisional» si algún mes es SIRE o manual; avisos de R-2b, R-4, R-5 y R-7 en texto.

## Criterios de aceptación
- [x] CA-1 (HU-35, RF-130, R-1): con credencial SOL válida y el mock con 12 PDT, «Obtener declaraciones» de 2026-10 guarda las presentaciones y la pantalla muestra 2025-11 a 2026-10 con gravadas, exportaciones, no gravadas, origen «declarado» y el coeficiente; una segunda obtención no duplica filas.
- [x] CA-2 (R-3, R-4, U-6, U-7): `calcularProrrata` da lo esperado en la tabla de casos (todo gravado, todo no gravado, solo exportaciones, mixto con redondeo en el tercer decimal arriba y abajo, …,5 exacto, notas de crédito, total 0, numerador 0, acumulados negativos, `numerador > total`, montos de 12 dígitos) y coincide con un oráculo en pruebas por propiedades (10.000 casos); ninguna ruta usa `number` para montos (lint/prueba).
- [x] CA-3 (R-5, R-2b): con un mes declarado, otro manual y otro solo SIRE, cada uno sale con su origen y el coeficiente «provisional»; una rectificatoria posterior queda vigente sin borrar la original; un PDT nuevo sobre un mes manual gana y avisa; un mes SIRE da exportaciones 0 con su aviso y, si otro mes declaró exportaciones, el aviso del coeficiente.
- [x] CA-4 (RF-133, R-6, U-4, U-5): con un mes faltante no se calcula y se lista el mes; guardar el manual (también en 0) lo calcula y lo marca «manual» con autor y motivo; con versión vieja da 409 `mes_cambiado`; un mes declarado da 409 `mes_declarado`; eliminar el manual vuelve el mes a SIRE o faltante y el historial conserva todas las versiones.
- [x] CA-5 (HU-36, R-7, U-8): con ventas de M (013) y compras de M clasificadas (014) en DG, DGNG y DNG, el IGV estimado muestra cada componente y coincide con el cálculo a mano del fixture (a pagar, saldo a favor y cero); `igvVentas` y `creditoDg` coinciden con los resúmenes de 013 y 014; reclasificar una compra de DG a DGNG cambia el resultado en la lectura siguiente; DNG no suma crédito; sin periodo de ventas o de compras cargado no se estima y se dice cuál falta.
- [x] CA-6 (RF-135, R-8, U-9, U-10): con prorrata usada del PDT de M distinta en 0,01 se muestra la alerta con ambos valores; igual no; sin prorrata usada no; ingresada a mano cuando el PDT no la trae alerta igual y marca su origen; con prorrata en el PDT el ingreso da 409 `prorrata_declarada`.
- [x] CA-7 (D-3): el backend no llama a SUNAT; el trabajo lee fuera de la transacción y escribe en una sola sin `SAVEPOINT`; un periodo con `ErrorDatos` queda «sin declaración»; credencial inválida → falla sin reintento, marca `credencial_invalida` y no inserta nada; dos pedidos del mismo cliente y periodo comparten trabajo; con `sol.buzon.revisar` del mismo RUC en curso, se serializan.
- [x] CA-8 (aislamiento): con RLS forzada, sin `withTenant()` no se ven declaraciones, obtenciones ni manuales; ids cruzados de cliente o estudio dan 404; nadie escribe directo en las tablas nuevas (solo por funciones) ni las borra o actualiza; la función del worker no inserta en otro cliente ni toca ventas, compras ni manuales; prueba de catálogo de 002 con las tablas nuevas, caso HU-40 por ruta y funciones `SECURITY DEFINER` nuevas en `escalada.adv.spec.ts`.
- [x] CA-9 (D-5, U-11, U-13): Dueño, Administrador y Contador asignado obtienen y guardan; Asistente y Lectura (solo `prorrata.ver`) ven y reciben 403 al escribir, sin botones; cliente archivado: 409 al escribir; funciona igual en todos los planes.
- [x] CA-10 (D-6, D-7): cada obtención, manual guardado o eliminado y prorrata usada guardada deja su auditoría; ningún log, error ni `resultado` contiene clave SOL, montos ni RUC (canarios); el mock no retiene la credencial.
- [x] CA-11 (volumen): obtener 12 periodos con el mock termina en < 5 s en CI; la pantalla con 12 meses (todos SIRE) y M con 5.000 ventas y 5.000 compras responde con p95 < 300 ms (RNF-034); 300 clientes del mismo estudio pidiendo a la vez no ocupan más que la concurrencia por tenant de la cola `sol` (008).
- [x] CA-12: suites de `domain`, `shared`, `sunat`, `db`, `queue`, `worker`, `backend` y `frontend` tocadas, `test:aislamiento`, typecheck, lint, `db:migrate` ×2, `cobertura:prorrata` ≥ 90 % por archivo y `pnpm e2e` (un caso: obtener declaraciones del mock → completar un mes manual → coeficiente → IGV estimado con compras DG/DGNG → alerta de prorrata usada distinta) en verde.
- [x] Casos reales aplicables: ninguno de la lista. Fixture de 01 §7 regla 4 (cliente con ventas gravadas y exoneradas y compras mixtas en DGNG), en `prorrata.e2e.ts`.

## Dependencias
- Specs: 007b (credencial SOL), 008 (cola, dedupe, bloqueo por RUC), 010 (`Money`, `Factor`, `redondearSunat`), 013 (ventas y su resumen), 014 (compras vigentes y su resumen), 017 (auditoría), 023 (`SolPortal`, `MockSolPortal`), 038 (estilo). La consumen el adaptador SOL real y 037 (borrado del cliente).
- Externas: layout real del PDT 621 en SOL y su mapeo a casillas (mientras, mock).

## Riesgos
- **Normativo**: ventana (U-1), qué cuenta como no gravado (U-2) y redondeo (U-7) siguen el reglamento según lo decidido; conviene que un contador del equipo revise la tabla de casos de CA-2 antes de la verificación.
- **Layout provisional**: si el PDT real no trae exportaciones aparte o la prorrata usada, cambia el adaptador; RF-135 queda cubierta por la prorrata ingresada (U-9).
- **Exportaciones desde SIRE** (R-2b): un mes SIRE de un exportador subestima el numerador hasta que el contador lo ingresa a mano; se avisa y queda «provisional».
- **IGV estimado no es la declaración** (U-8): sin saldo anterior, percepciones ni retenciones el resultado puede diferir del PDT; la pantalla lo dice.

## Decisiones del usuario (2026-11-22)
Todas con la opción recomendada (a):
- **U-1** Ventana: los 12 meses que terminan en el mes calculado, incluido (R-1).
- **U-2** Numerador gravadas + exportaciones; no gravadas = exoneradas + inafectas (R-2, R-3; derivada R-2b).
- **U-3** Meses sin PDT: ventas del SIRE marcadas «SIRE» y aviso «provisional» (R-5).
- **U-4** No se sobrescribe lo declarado; manual solo en meses sin declaración (R-5).
- **U-5** No se calcula hasta completar los meses (manual, 0 = sin operaciones) (R-6).
- **U-6** Total 0 → «no determinable» sin IGV estimado; numerador 0 → 0,00 % con aviso (R-4).
- **U-7** Porcentaje a 2 decimales mitad hacia arriba; montos con `redondearSunat` (R-3, R-7).
- **U-8** IGV estimado solo con la fórmula de RF-134 y nota visible (R-7).
- **U-9** Prorrata usada del PDT; si no viene, la ingresa el contador (R-8).
- **U-10** Alerta con diferencia ≥ 0,01 puntos (R-8).
- **U-11** Permiso nuevo `prorrata.gestionar` para Dueño, Administrador y Contador (D-5).
- **U-12** A pedido desde la pantalla; lo guardado se reutiliza (Alcance).
- **U-13** Todos los planes (Alcance).

## Notas para otras specs
- **Adaptador SOL real**: mapear el PDT 621 a `Declaracion621` cuando llegue el layout real. Hasta entonces el layout es provisional y lo sirve el mock.
- **037 (borrado del cliente)**: borrar `declaracion_mensual`, `prorrata_obtencion`, `prorrata_mes_manual` y `prorrata_usada_manual` solo por su camino acotado, nunca con `DELETE` directo (CA-8).
- **013 (ventas)**: separar exportaciones en el layout de ventas para retirar R-2b. Hoy un mes SIRE da exportaciones 0 con aviso (CA-3).
- **Mejora pendiente (no bloquea)**: llevar `fueraDeRango` al contrato `shared` de `MesVista` y marcar el mes en la UI. Hoy el mes muestra el tope ±999,999,999,999.99 sin marca (T24, desvío 4).
- **422 `resumen_fuera_de_rango`** (código de 014, si el IGV de M no cabe con el coeficiente calculado): no está en la tabla HTTP de `plan.md`; falta añadirlo (T24, desvío 5).
