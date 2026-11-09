# Plan 015 · Compras (frontend): grilla editable tipo Excel, resumen y acciones masivas

Referencias: `spec.md` (D = decisiones, P = decisiones del usuario, CA = criterios). Nivel C: sin TDD ni adversarial; el frontend escribe las pruebas mínimas de CA-17 junto con cada pieza y una prueba manual contra el sistema completo cierra la implementación (P-10). Sin cambios de backend, `shared` ni BD: todo el contrato es el de 014 (`docs/specs/014-compras-backend/plan.md#contratos`) y los esquemas de `packages/shared/src/compras/`.

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| modificar | `apps/frontend/package.json` · `pnpm-lock.yaml` | `@tanstack/react-table` 9.3.1, `@tanstack/react-virtual` 3.14.22 y `decimal.js` 10.6.0, versiones exactas sin `^` (P-1, P-2) |
| crear | `apps/frontend/lib/montos-compras.ts` | único archivo que importa `decimal.js`: `sumar`, `iguales`, `conMiles`, `validarMonto`, `destinoDe` (P-5) |
| crear | `apps/frontend/lib/compras.ts` | cliente HTTP de todas las rutas, validación de respuestas con `shared`, `cargarPeriodo` por cursor, `MENSAJES_COMPRAS` por código, tipo `ContextoCompras` |
| crear | `apps/frontend/lib/secuencia.ts` | `useSecuencia` (descarta respuestas viejas), copia del que 013 deja dentro de `ventas/page.tsx:76`; 013 no se toca |
| crear | `apps/frontend/lib/edicion-compras.ts` | estado puro de la edición por fila (borrador, celdas cambiadas, total local, cuadre, debounce de `calcular`) (P-3, D-6) |
| crear | `apps/frontend/pruebas/compras.ts` | soporte de pruebas: filas de 014 (5 compras de `20700000002-compras-202610`), generador de 5.000 filas, `fetch` simulado, permisos |
| crear | `apps/frontend/compras.estatico.spec.ts` | CA-5 y CA-17: sin `number`/`parseFloat`/`parseInt`/`Number(`/`toFixed`/`toLocaleString`/`innerHTML` sobre montos, `decimal.js` solo en `lib/montos-compras.ts`, solo `@contapp/shared` |
| crear | `apps/frontend/app/(app)/clientes/[clienteId]/compras/page.tsx` | pantalla: periodo en la URL, permisos, estado, ensamblado (D-1) |
| crear | `apps/frontend/components/compras/{descarga-compras,diferencias-compras,resumen-compras,estado-periodo,exportar-compras}.tsx` | descarga con trabajo, diferencias, resumen por casillero, estado del periodo, Excel (D-12 a D-15) |
| crear | `apps/frontend/components/compras/{grilla-compras.tsx,columnas-compras.ts,filtros-compras.tsx}` | grilla TanStack Table + Virtual, columnas por casillero y fijas, filtros (D-4, D-5, P-8) |
| crear | `apps/frontend/components/compras/{acciones-fila-compras,aceptar-sugerencia,excluir-compra}.tsx` | clasificar, sugerencias, excluir, restaurar y descartar (D-7, D-10) |
| crear | `apps/frontend/components/compras/{barra-masiva,informe-masivo,deshacer-compras}.tsx` | masivas, informe de rechazadas, deshacer y rehacer (D-8, D-9, P-4) |
| crear | `apps/frontend/components/compras/{agregar-compra,historial-compra}.tsx` | diálogo de agregar (P-7) y panel «Historial» (P-6) |
| modificar | `apps/frontend/app/(app)/clientes/[clienteId]/page.tsx` · `…/ventas/page.tsx` | enlaces a Compras y entre Ventas y Compras (D-1); solo agregar el enlace |
| crear | `*.spec.ts(x)` junto a cada pieza | pruebas mínimas: 1 caso feliz y 1 de error por comportamiento (D-17) |

Reutiliza de 013 y 007b: `api`, `cargarYo`/`tiene`, `seguirTrabajos`, `components/ventas/confirmar-accion.tsx` y el patrón de `descarga-ventas.tsx` (`useSecuencia` se copia a `lib/secuencia.ts` porque en ventas no se exporta). `conMiles(number)` de ventas no se usa (D-3).

## Contratos
Todo bajo `/clientes/:clienteId/periodos/:periodo/compras` (tabla completa en el plan de 014). El frontend llama: `POST /descargar` · `GET /?cursor&limite&vista&alertas&proveedorNuevo&q` · `GET /resumen` · `GET /exportar.xlsx` · `GET /propuestas` y `/propuestas/:id/diferencias` · `GET /:compraId` · `POST /:compraId/{clasificar,editar,calcular,sugerencias/aceptar,excluir,restaurar,descartar}` · `POST /` (agregar) · `POST /masivas/{clasificar,aceptar,excluir,restaurar}` · `POST /deshacer` y `/rehacer` · `POST /estado/{revisar,reabrir}`. Los errores traen `{codigo}`; `MENSAJES_COMPRAS` da el texto en español por código. Permisos desde `GET /acceso/yo`.

Tipos internos que otras piezas consumen (en `lib/compras.ts`, para que las piezas se escriban en paralelo):
- `ContextoCompras { clienteId, periodo, permisos: { ver, descargar, clasificar, aprobarGenerar }, estado: 'abierto'|'revisado'|'generado', soloLectura: null | string, recargarFila(id), recargarFilas(ids), recargarResumen() }`. `soloLectura` lleva el motivo legible (cliente archivado, `revisado` sin `sire.aprobar_generar`, `generado`); las piezas de escritura no se muestran o se deshabilitan con ese texto.
- `GrillaCompras` (props): `filas: FilaCompraVista[]`, `cargando`, `seleccion: Set<string>` y `alCambiarSeleccion`, `resaltadas: Set<string>`, `soloLectura`, `alGuardarFila(id, versionBase, cambios)`, `renderAcciones(fila)`, `alAbrirHistorial(id)`.
- `lib/montos-compras.ts`: `sumar(cadenas: string[]): string`, `iguales(a, b): boolean`, `conMiles(m: string): string`, `validarMonto(texto): { ok: true, valor: string } | { ok: false, motivo }` (usa `montoDecimalSchema`), `destinoDe(montos): 'DG'|'DGNG'|'DNG'|'Mixta'|'Sin base'`. Entradas y salidas son cadenas; ningún `number` cruza la frontera.
- `lib/edicion-compras.ts`: `iniciarEdicion(fila)`, `cambiarCelda(estado, columna, texto)`, `totalLocal(estado)`, `cambiosParaEnviar(estado)` (solo las celdas distintas del original), `aplicarCuadre(estado, cuadre)`.

## Decisiones
- Grilla propia sobre TanStack Table (modelo de columnas y filas) + Virtual (ventana de filas y de columnas); la navegación por teclado, `role="grid"` y la edición se escriben encima — así se cumple P-1 sin introducir Query ni formularios de terceros. TanStack Table 9 cambia su API respecto de la 8: el frontend lee los tipos instalados en `node_modules` antes de escribir, no la memoria.
- Todo monto es una cadena; `decimal.js` vive en un solo archivo (`lib/montos-compras.ts`) y la prueba estática prohíbe importarlo en cualquier otro — así la regla de CA-5 se comprueba mirando un archivo.
- La carga por cursor (bloques de 1.000) y la secuencia anti-respuestas viejas se reúnen en `cargarPeriodo` — evita que cada filtro reimplemente la cancelación.
- Edición por fila (P-3): el estado del borrador es puro (`edicion-compras.ts`) y se prueba sin DOM; la celda solo lo dibuja.
- Componentes de acciones sin conocer la página: reciben `ContextoCompras` y llaman a `lib/compras.ts`; la página los ensambla al final (tarea de ensamblado). Eso permite escribirlos en paralelo sin editar el mismo archivo.
- «Deshacer» recuerda en memoria si esta pantalla hizo una operación (P-4): el atajo Ctrl+Z consulta ese indicador; el botón de la barra no.
- Sin `innerHTML` y sin `dangerouslySetInnerHTML`: razón social, motivo y glosa del SIRE se pintan como texto de React; `title` solo con cadenas.
- Todo texto fijo y cada mensaje por código están en `lib/compras.ts` (`MENSAJES_COMPRAS`), como `MENSAJES_VENTAS` — una sola fuente para las pruebas y la revisión.

## Riesgos
- TanStack Table 9 (versión reciente) con React 19.3 y Next 16.4: si la integración falla dos veces, la tarea sube de modelo (04 §3.3); se detecta en la tarea de grilla con una prueba de 5.000 filas.
- Rendimiento de 5.000 filas × ≈ 20 columnas: la virtualización de filas y de columnas, y filas de alto fijo; la prueba cuenta nodos pintados y la prueba manual mide el desplazamiento.
- Atajos de teclado que chocan con el navegador (Ctrl+Z dentro de un campo de texto): dentro de la celda en edición Ctrl+Z deshace el texto del campo; el deshacer del servidor solo actúa con el foco en la grilla.
- Carreras (filtros, acciones, cuadre tardío): cada petición lleva su secuencia y la respuesta vieja se descarta; el cuadre de `calcular` tardío no pisa la fila que ya salió de edición.
- Un monto con más de 2 decimales pegado o tecleado: se bloquea antes de enviar y se explica; el servidor igualmente responde 400 y se muestra su mensaje.
- Contrato de 014 insuficiente para alguna pantalla: se plantea como pregunta al orquestador; no se toca backend desde 015.
