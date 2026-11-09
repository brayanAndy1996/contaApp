# Spec 015 · Compras (frontend): grilla editable tipo Excel, resumen y acciones masivas

Estado: borrador (2026-11-09; esperando respuesta a P-1 a P-10). Rama `spec/015-compras-frontend` desde `main`. Plan y tareas: se escriben después de aprobada (C va sin `plan.md`, 04 §1.3: el plan cabe en `tasks.md`).
Nivel de riesgo: C (fila 015 de 04 §4). Por 04 §2.1: (1) parcial: el frontend no persiste montos, solo envía cadenas que el servidor valida y recalcula (014 D-5, D-16); (2) no: no maneja credenciales ni cruza estudios; (3) sí: una suma o un cuadre mal pintado no se nota a simple vista; (4) sí: 5.000 filas, selección masiva y ediciones concurrentes. Literal saldría B; se mantiene C porque el dinero y las reglas ya están probados en 010, 011 y 014, y aquí solo hay que mostrar y no inventar cifras. Para no depender de esa suposición, los ayudantes de montos y la edición llevan pruebas propias (CA-17). Ver P-10.
Cubre: RF-061 a RF-071 (la parte de pantalla; RF-060 solo el botón de descarga) · HU-14 a HU-19 · RNF-072 · nota [015] de `ESTADO.md` · consume el contrato de `docs/specs/014-compras-backend/` (DU-10, DU-19, DU-22, DU-23, DU-26).

## Objetivo
Que el contador revise en una sola pantalla las compras del periodo de un cliente, las corrija con teclado como en una hoja de cálculo, las clasifique o excluya una a una o en masa, vea el resumen por casillero frente a la propuesta original y pueda deshacer, sin que el navegador calcule nunca un monto que se guarde.

## Alcance
- Pantalla `/clientes/[clienteId]/compras?periodo=AAAAMM` con enlace desde el detalle del cliente y entre Ventas y Compras (D-1).
- Descarga del periodo (202 + seguimiento del trabajo con `seguirTrabajos`), resumen de lo que trajo y lista de diferencias (`propuestas` y `diferencias`), como en 013.
- Grilla virtualizada con las columnas de RF-061, separación «con IGV» / «sin IGV» / «excluidas», alertas, etiqueta «Proveedor nuevo», filtros y búsqueda (HU-14, HU-19).
- Edición por celda con teclado, total y cuadre en vivo, clasificar, aceptar sugerencias, excluir y restaurar (HU-15, HU-16, HU-17).
- Acciones masivas con informe de rechazadas, deshacer y rehacer (RF-063, RF-065).
- Agregar y descartar compra con formulario (HU-18).
- Resumen por casillero (original, vigente y diferencia), estado del periodo (marcar revisado, reabrir) y exportar a Excel.
- Textos, mensajes por código de error y llamadas a la API en `apps/frontend/lib/compras.ts`; componentes en `apps/frontend/components/compras/`.

## Fuera de alcance
- Modal de la lupa, parser UBL, subida manual de XML y «agregar desde XML» (HU-18 con XML, RF-090 a RF-099): 016. Aquí la columna de la lupa queda reservada (P-6) y el botón «Subir XML» deshabilitado.
- Importar la propuesta desde archivo (014 DU-8), generar el TXT/ZIP y su descarga (012b), auditoría y notificaciones (017), aprendizaje por proveedor (R2).
- Cualquier cambio de backend. Si el contrato de 014 resultara insuficiente, se plantea como pregunta (hoy solo P-5 opción c).
- Pruebas E2E con navegador real: 018. Móvil (RNF-071 exige ≥ 1366 px para esta pantalla).
- Pegar rangos de varias celdas (P-9) y «rellenar hacia abajo».

## Decisiones
- D-1 Ruta y estructura. Una página con el periodo en la URL (como ventas). Permisos desde `GET /acceso/yo`: `clientes.ver` (ver; sin él, mensaje y nada más), `sire.descargar`, `sire.clasificar` y `sire.aprobar_generar`. Ocultar acciones sin permiso es comodidad; el backend vuelve a validar y su 403/409 se muestra tal cual (RNF-007). Cliente archivado: solo lectura.
- D-2 Fronteras. `apps/frontend` solo importa `@contapp/shared` (más las librerías externas que P-1 y P-2 autoricen). Las respuestas se validan con los esquemas de `shared/compras`; si no calzan, error genérico y nada se pinta a medias. Sin `innerHTML`: toda razón social, motivo y glosa del SIRE son texto no confiable que React escapa (014 D-13).
- D-3 Montos. Siempre cadenas decimales; entrada validada con `montoDecimalSchema` (máx. 2 decimales, signo permitido para notas de crédito) antes de enviar; sumas y comparaciones con `decimal.js` (P-2); formato de miles por manipulación de texto (`1,234.56`, negativo con `-`). Prohibidos `number`, `parseFloat`, `parseInt`, `Number()` y `toFixed` sobre montos (prueba estática, como `ventas.estatico.spec.ts`). El ayudante `conMiles(number)` de ventas no se reutiliza.
- D-4 Datos. El listado se pide por cursor en bloques de 1.000 con los filtros del servidor (`vista`, `alertas`, `proveedorNuevo`, `q`) hasta que `siguiente` sea `null`; la grilla es usable desde el primer bloque y un indicador muestra «Cargando…». Cada cambio de filtro cancela la carga anterior y las respuestas viejas se descartan con una secuencia (patrón `useSecuencia` de 013). Tras cada acción se actualiza la fila con la respuesta del servidor y se recarga el resumen; no hay actualización optimista de montos.
- D-5 Grilla. Virtualizada (RNF-031: 5.000 filas fluidas), `role="grid"`, encabezados de casillero agrupados (DG, DGNG, DNG, no gravado, ISC, ICBPER, otros, total), columnas de identidad fijas (P-8), filas con alerta resaltadas con icono y texto además del color. La razón social del SIRE se corta con elipsis y completa en `title`.
- D-6 Edición (P-3). Editables las 10 columnas de monto; el total (Σ), fecha, proveedor y moneda no (014 D-5). Teclado: flechas y Tab/Shift+Tab mueven, Enter o F2 editan, Esc cancela, Enter confirma y baja. Mientras se teclea, el total de la fila es la suma local con `decimal.js` y, tras 300 ms sin teclear, `POST …/calcular` trae el cuadre por celda con su explicación (DU-10); la celda descuadrada se marca en rojo con la explicación visible (no solo color). Si `calcular` falla se mantiene el total local con aviso «cuadre no verificado». Guardar usa `editar` con el `versionBase` de la fila; el descuadre no impide guardar (014 D-5). Filas excluidas y periodos bloqueados son de solo lectura.
- D-7 Clasificar y sugerencias. Clasificar una fila o varias llama a `clasificar` / `masivas/clasificar` y espera la respuesta (el servidor mueve los montos). Los hallazgos de la fila se ven como chips con su explicación (RNF-073) y «Aceptar»: R-ISC pide confirmar; si el servidor responde 422 `requiere_dato` se abre un campo para el `gravado` (R-MIX) o el destino (R-NEW) y se reenvía; 409 `revisar_de_nuevo` o `version_obsoleta` recarga la fila y avisa. En masa solo se ofrece «Aceptar R-RED» (014 D-15, DU-22); las demás reglas se aceptan una a una.
- D-8 Masivas. Casillas por fila, «seleccionar las N filas del filtro actual» (solo cuando la carga terminó; tope de 5.000: más de eso pide filtrar, sin llegar al 400) y barra con clasificar, excluir (motivo opcional), restaurar y aceptar R-RED. Cada ítem lleva el `versionBase` de la fila cargada. Todas son parciales: el diálogo del informe muestra «N aplicadas» y la lista de rechazadas con comprobante y motivo legible por código (`version_obsoleta`, `fila_excluida`, `no_masiva`, `requiere_dato`, `no_encontrada`, …); las `version_obsoleta` se recargan. «Aplicar a todas las del proveedor» es una búsqueda por RUC más seleccionar el filtro (RF-063).
- D-9 Deshacer y rehacer (P-4). Llaman a `POST …/deshacer` y `…/rehacer` del periodo y, al responder, recargan solo las filas de `filas` y las resaltan un momento. 409 `fila_cambiada` muestra «Otra persona cambió estas filas» con los comprobantes de los `ids` (los que estén cargados; el resto por id corto) y un botón «Ver filas» que las resalta; no se reintenta solo (014 DU-26). 409 `nada_que_deshacer` / `nada_que_rehacer` es un aviso, no un error. Agregar, descartar y cambiar el estado del periodo no se deshacen (014 DU-14).
- D-10 Excluir y restaurar (HU-17). Excluir pide motivo opcional (hasta 200); las excluidas viven en la vista «Excluidas», fuera de la lista principal y de los totales, con «Restaurar». Excluir una agregada equivale a descartarla (014 DU-16): se avisa antes. La glosa «zapatilla» sugerida por R-GP se acepta con el mismo botón.
- D-11 Agregar (HU-18, P-7). Formulario validado con `agregarCompraSchema` de `shared` (tipo de cambio solo en USD). 409 `duplicado` avisa «Ya existe en la propuesta» con enlace que ubica la fila existente (también si está excluida). «Descartar» solo en filas `agregada`.
- D-12 Resumen (RF-068, RF-069). Panel con la tabla por casillero (original, vigente, diferencia con signo y texto, no solo color), la partición «con IGV» / «sin IGV» con sus cantidades y el aviso de `filasSinConvertir` (USD sin tipo de cambio utilizable). Es del periodo entero, no del filtro, y lo dice. Se recarga tras cada acción con secuencia anti-respuestas viejas.
- D-13 Estado del periodo (RF-071, 014 D-9, DU-23). Insignia `abierto` / `revisado` / `generado` con quién y cuándo. «Marcar como revisado» (`sire.clasificar`) pide confirmación que avisa del bloqueo. En `revisado` sin `sire.aprobar_generar` la grilla pasa a solo lectura con la explicación; con el permiso se puede editar y «Reabrir». En `generado` nadie edita; «Reabrir» (con `sire.aprobar_generar`) avisa que habrá que generar el archivo de nuevo. Reabrir envía `{ estadoVisto }` con el estado que la pantalla mostraba; 409 `estado_invalido` recarga el estado y avisa.
- D-14 Descarga y trabajos. Igual que 013 D14: elegir periodo, «Descargar», posición en cola con `seguirTrabajos`, al terminar refrescar y mostrar «N nuevas, M distintas» (`distintas` enlaza a `diferencias`: avisan, no cambian nada, 014 D-18); error con «Reintentar»; 409 `credencial_no_configurada` / `periodo_generado` / 403 `periodo_revisado` con mensaje propio.
- D-15 Exportar. «Exportar a Excel» descarga `GET …/compras/exportar.xlsx` del periodo (no del filtro); el error se muestra como aviso.
- D-16 Accesibilidad. Foco visible, `aria-live="polite"` para avisos y errores de acción, `aria-invalid` + descripción en la celda descuadrada, todo operable sin ratón. Escritorio ≥ 1366 px.
- D-17 Pruebas (nivel C, 04 §2.1): vitest + Testing Library con el cliente HTTP simulado; por comportamiento público 1 caso feliz y 1 de error; más lo de CA-17. Corre solo `pnpm --filter @contapp/frontend test`.

## Criterios de aceptación
Los casos usan las formas de `shared/compras` y los datos de 014 (`20700000002-compras-202610.json`: 5 compras, F001-1040 San Juan, F001-2056 mixta, F001-4062 USD).
- [ ] CA-1 (HU-14, RF-061, RF-068): Dado el periodo 202610 descargado, cuando se abre la pantalla, entonces la grilla lista las compras con sus columnas por casillero separadas en «con IGV», «sin IGV» y «excluidas», las filas con hallazgos resaltadas con su explicación, y el resumen del periodo.
- [ ] CA-2 (HU-14, D-4): Dados los filtros «con alertas», «proveedor nuevo» y «excluidas» y la búsqueda por RUC, razón social o serie-número, cuando se aplican, entonces se pide al servidor con esos parámetros, se descartan las respuestas viejas y una razón social `<img src=x onerror=alert(1)>` se ve como texto.
- [ ] CA-3 (RF-060, D-14): Dado un usuario con `sire.descargar`, cuando descarga 202610, entonces ve el trabajo con su posición, al completar se refresca la grilla y se muestran «nuevas» y «distintas» con su lista; un fallo ofrece «Reintentar»; sin el permiso el botón no aparece.
- [ ] CA-4 (HU-16, RF-064, D-6): Dada F001-3064, cuando se edita la BI con el teclado (Enter, escribir, Tab), entonces el total se recalcula al instante con suma exacta, `calcular` marca en rojo con explicación la celda cuyo IGV no cuadra, Enter guarda con un solo `editar`, y un monto con más de 2 decimales no se envía y se explica.
- [ ] CA-5 (D-3): Dada cualquier cifra de la pantalla, entonces ningún monto pasa por `number`, `parseFloat`, `toFixed` ni `innerHTML` (prueba estática sobre `lib/compras.ts` y `components/compras/`), y 0.1 + 0.2 + 0.005 se suma sin error de coma flotante.
- [ ] CA-6 (HU-15, RF-062): Dada F001-3064 en DG, cuando se clasifica como DNG, entonces la fila se actualiza con la respuesta del servidor (BI e IGV en DNG) y el resumen cambia.
- [ ] CA-7 (RF-063, HU-15, D-8): Dadas 12 filas seleccionadas con 2 obsoletas, 1 excluida y 1 con R-ISC sin XML, cuando se aplica «Aceptar R-RED» o «DNG» en masa, entonces sale una sola petición, el informe muestra las aplicadas y las rechazadas con su motivo legible, las obsoletas se recargan, y un solo «Deshacer» revierte la operación.
- [ ] CA-8 (RF-065, D-9): Dado un cambio hecho, cuando se pulsa Deshacer (o el atajo de P-4), entonces solo las filas afectadas se recargan; con 409 `fila_cambiada` se listan los comprobantes que otra persona cambió y no se reintenta; rehacer repone el cambio.
- [ ] CA-9 (HU-17, D-10, caso zapatilla): Dada una compra con glosa «zapatillas», cuando se excluye con motivo, entonces sale de la lista principal y de los totales y aparece en «Excluidas»; «Restaurar» la devuelve; en `generado` el botón no está.
- [ ] CA-10 (D-7, casos San Juan y mixta): Dado F001-1040, cuando se acepta R-ISC con confirmación, entonces BI DG = 0.00, ISC = 770.00 y el resumen muestra DG −770.00 / ISC +770.00 frente a la original. Dado F001-2056 sin XML, aceptar R-MIX recibe 422 `requiere_dato`, se pide el gravado y con 8.97 queda 8.97 en DG y 12.51 en no gravado. Con 409 `revisar_de_nuevo` la fila se recarga y se avisa.
- [ ] CA-11 (HU-18, D-11): Dado el formulario de agregar, cuando se completa una compra nueva, entonces queda marcada «Agregada»; USD exige tipo de cambio; repetir una clave muestra el aviso de duplicado con enlace a la existente; «Descartar» la quita sin contarla como excluida.
- [ ] CA-12 (HU-19, RF-070): Dado un proveedor sin historial en el cliente, entonces su fila muestra «Proveedor nuevo» y queda pendiente hasta clasificarla; el filtro «proveedor nuevo» las lista.
- [ ] CA-13 (RF-071, D-13): Dado el periodo `revisado`, cuando lo abre quien no tiene `sire.aprobar_generar`, entonces la grilla es de solo lectura y lo explica; con el permiso puede editar y reabrir (enviando `estadoVisto`); en `generado` nadie edita y reabrir avisa del reproceso; 409 `estado_invalido` recarga el estado.
- [ ] CA-14 (D-1, D-13): Sin `sire.clasificar` no aparecen acciones de escritura; sin `clientes.ver` solo el mensaje; cliente archivado, solo lectura; un 403/404/409 del servidor se muestra con su mensaje y no deja la pantalla a medias.
- [ ] CA-15 (D-15, caso USD): Dado el resumen con F001-4062 (USD), entonces se convierte o aparece el aviso de `filasSinConvertir`; «Exportar a Excel» descarga el archivo del periodo y un error del servidor se informa.
- [ ] CA-16 (RNF-031, RNF-072, D-5, D-16): Con 5.000 filas simuladas la grilla pinta solo las filas visibles más un margen, el desplazamiento y la edición no se traban, y se opera completa con teclado (flechas, Tab, Enter, F2, Esc, Ctrl+Z).
- [ ] CA-17 (D-2, D-17): Typecheck, lint y `pnpm --filter @contapp/frontend test` en verde; `apps/frontend` solo importa `@contapp/shared` (prueba estática de imports); el ayudante de montos, la edición y la masiva tienen un caso feliz y uno de error cada uno.
- [ ] Casos reales aplicables: San Juan ISC (CA-10), mixta 21.48 / 1.61 (CA-10), zapatilla (CA-9), redondeo USD (CA-15; sintético F001-4062). Boleta 291: no aplica.

## Dependencias
- Specs: 004 (sesión), 005 (permisos y `acceso/yo`), 007a (cliente y archivado), 007b (`seguirTrabajos`, panel de trabajos), 013 (patrón de pantalla, `useSecuencia`, descarga y diferencias), 014 (todas las rutas de compras y los esquemas de `shared/compras`; ya en `main`). Después: 016 (lupa y XML), 018 (E2E).
- Externas: ninguna en R1 (adaptadores en `mock`). Librerías nuevas solo si P-1 o P-2 lo autorizan.

## Preguntas abiertas
Cada una con su opción recomendada; el usuario responde con la letra (como en 014).

- **P-1 · Librerías de la grilla.** 03 §Frontend prevé TanStack Table/Query y React Hook Form, pero 013 se hizo sin ellas (virtualización y estado propios) y no están en `package.json`.
  - (a) Seguir 013: grilla virtualizada y estado propios, sin librerías nuevas; formularios con `useState` + esquemas de `shared`.
  - (b) (Recom.) Agregar solo TanStack Table + TanStack Virtual para la grilla; datos con `api()` y `useSecuencia` como en 013; sin Query ni React Hook Form.
  - (c) Pila completa de 03: Table, Virtual, Query y React Hook Form.
- **P-2 · Suma local con `decimal.js` (DU-10).** `decimal.js` 10.6.0 está en `packages/domain`, no en el frontend.
  - (a) (Recom.) Agregar `decimal.js` 10.6.0 (misma versión) a `apps/frontend`: es una librería externa, no rompe «solo depende de `shared`».
  - (b) Exportar desde `packages/shared` un ayudante de montos (sumar, comparar, formatear) que lleve `decimal.js`; el frontend solo importa `shared`. Toca `shared` y su lint.
  - (c) Sin suma local: el total sale solo de `POST …/calcular` (con retardo de unos 300 ms por celda). Se aparta de DU-10.
- **P-3 · Cuándo se guarda una edición.**
  - (a) Por celda: cada Enter/Tab/clic fuera guarda esa celda (una versión y un paso de deshacer por celda).
  - (b) (Recom.) Por fila: Tab/Enter mueven entre celdas sin guardar; al salir de la fila (Enter en la última, flecha vertical o clic en otra fila) se envía un solo `editar` con todas las celdas cambiadas. Una versión y un Ctrl+Z por fila; Esc descarta la fila.
  - (c) Por borrador: se editan varias filas y un botón «Guardar cambios» las envía todas. Pierde lo editado al cerrar la pestaña y choca más con ediciones concurrentes.
- **P-4 · Alcance de Ctrl+Z / Ctrl+Y.** El deshacer del servidor es por usuario y periodo y sobrevive a recargar (014 D-14), pero la respuesta no dice qué operación revierte.
  - (a) Ctrl+Z y Ctrl+Y siempre llaman al servidor, incluso para operaciones de sesiones anteriores; se resaltan las filas afectadas.
  - (b) (Recom.) El atajo vale solo si hubo una operación propia en esta carga de la pantalla; el botón «Deshacer» de la barra siempre está y, si no hay operación de esta pantalla, pide confirmar («Se revertirá tu última operación de este periodo, hecha antes de abrir esta pantalla»).
- **P-5 · Cómo se ve el destino (DG / DGNG / DNG) de una fila.** La fila no trae un campo `destino`; HU-15 habla de pasar «de DG a DNG».
  - (a) Sin columna: se deduce leyendo las columnas de monto y se clasifica desde el menú de la fila o la barra masiva.
  - (b) (Recom.) Columna «Destino» solo informativa, calculada en pantalla comparando con cero las bases (DG, DGNG, DNG, «Mixta» si hay base en más de una, «Sin base»); sin escribir nada.
  - (c) Pedir a 014 un campo `destino` en `FilaCompraVista` (cambio mínimo de backend y de `shared`).
- **P-6 · Lupa y detalle de la fila (RF-061).** La lupa es de 016, pero el detalle `GET …/:compraId` (original, versiones, hallazgos) ya existe y no tiene consumidor.
  - (a) Solo un icono de lupa deshabilitado con «Disponible con el detalle del comprobante (016)».
  - (b) (Recom.) Lupa deshabilitada más un panel lateral «Historial» de 015, de solo lectura: valor original del SIRE frente al vigente y la lista de versiones (autor, fecha, acción) y hallazgos.
- **P-7 · Dónde se agrega una compra (HU-18, sin XML hasta 016).**
  - (a) (Recom.) Diálogo con el formulario completo (comprobante, proveedor, fecha, moneda, tipo de cambio y las 10 columnas con total en vivo) y «Subir XML» deshabilitado.
  - (b) Fila en blanco al final de la grilla, que se llena como en Excel. Más cercana a la hoja de cálculo, pero con campos de texto (proveedor, razón social) incómodos en celdas.
- **P-8 · Anchura de la grilla (≈ 20 columnas en ≥ 1366 px).**
  - (a) (Recom.) Todas las columnas visibles con desplazamiento horizontal; tipo, comprobante y proveedor fijos a la izquierda y total y acciones fijos a la derecha.
  - (b) Igual que (a), pero con grupos DGNG y DNG plegables (plegados por defecto) para ver más de un vistazo. Riesgo: ocultar montos que importan.
- **P-9 · Pegar desde Excel.**
  - (a) (Recom.) No en R1: se puede pegar un valor en la celda en edición (lo hace el navegador), no rangos de varias celdas.
  - (b) Pegar rangos de varias celdas: una `editar` por fila afectada y, si falla alguna, informe parcial. Más trabajo y más riesgo; sería otra spec.
- **P-10 · Nivel y pruebas.** Por 04 §2.1 literal saldría B (respuestas 3 y 4); 04 §4 fija C.
  - (a) (Recom.) C como en 04 §4, con las pruebas de CA-17 (caso feliz y de error por comportamiento y prueba estática de montos e imports). Sin TDD ni adversarial.
  - (b) B: tester·sonnet escribe primero las pruebas del ayudante de montos y de la edición (TDD), sin adversarial.
