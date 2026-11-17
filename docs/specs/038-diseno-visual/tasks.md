# Tareas 038 · Diseño visual (estilo A)

Leyenda: rol `arquitecto` · `backend` · `frontend` · `tester` · `adversario` · `devops` | modelo `opus` · `sonnet` · `haiku` | `TDD` pruebas primero | `ADV` ronda adversarial | `∥` puede ir en paralelo con la anterior | estado `[ ]` pendiente · `[~]` en curso · `[x]` hecha

| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Spec, plan y tareas | arquitecto | opus | — | — | — | [x] |
| T2 | Dependencias, fuentes y tokens (`globals.css`, `layout.tsx` raíz) | frontend | sonnet | T1 | — | — | [x] |
| T3 | `lib/utils.ts`, `components.json` y componentes base de `components/ui/` | frontend | sonnet | T2 | — | — | [x] |
| T4 | Pruebas de nivel C de los componentes | tester | sonnet | T3 | — | — | [x] |
| T5 | Verificar fase 1 (CA-1 a CA-4): typecheck, lint, test, build, CI | devops | haiku | T4 | — | — | [x] |
| T6 | Planificar fase 2 pantalla por pantalla, con 021 y 022 ya en `main` | arquitecto | opus | T5, 021 y 022 hechas | — | — | [x] |
| T7 | Base compartida de la fase 2 (`components/ui/`: `Table` sin contenedor, `EncabezadoPagina`, clases comunes) | frontend | sonnet | T6 | — | — | [x] |
| T8 | Marco: layout y menú (lateral en escritorio, barra en celular) | frontend | sonnet | T7, P-4, P-5 | — | — | [x] |
| T9 | ∥ Inicio y auth (ingresar, registro, recuperación, invitación, estudios, inicio, cambiar contraseña) | frontend | sonnet | T7 | — | — | [x] |
| T10 | ∥ Clientes y ficha (listado, nuevo, importar, ficha, credenciales, datos fiscales, reglas del cliente) | frontend | sonnet | T7, P-4 | — | — | [x] |
| T11 | ∥ Compras · grilla (filtros, acciones de fila, barra masiva, informe, historial, Ctrl+Z, avisos «Recordar» y «Según historial») | frontend | sonnet | T7, P-2, P-3, P-6 | — | — | [x] |
| T12 | ∥ Compras · lupa y diálogos (lupa, XML, agregar, excluir, aceptar sugerencia) | frontend | sonnet | T7, P-6 | — | — | [x] |
| T13 | ∥ Compras · página, paneles y «Generar archivo» con su previo | frontend | sonnet | T7, P-3 | — | — | [x] |
| T14 | ∥ Ventas (pantalla, importar y componentes de ventas) | frontend | sonnet | T7, P-2, P-6 | — | — | [x] |
| T15 | ∥ Trabajos y notificaciones (página, campana y panel) | frontend | sonnet | T7, P-6 | — | — | [x] |
| T16 | ∥ Auditoría, equipo y planes/admin | frontend | sonnet | T7 | — | — | [x] |
| T17 | ∥ Reglas del motor | frontend | sonnet | T7 | — | — | [x] |
| T-final | Verificar CA-5 a CA-8: prueba estática de colores, revisión manual 1440/390 px, accesibilidad, E2E y CI; cierre | tester (sonnet) + devops (haiku) | sonnet | T7–T17, P-7 | — | — | [ ] |

## T2 · Dependencias, fuentes y tokens
- **Contexto**: `apps/frontend/package.json`, `apps/frontend/app/globals.css`, `apps/frontend/app/layout.tsx`, `plan.md#tokens-del-estilo-a`.
- **Hacer**: agregar con versión exacta las dependencias de D1 y las fuentes de D3; reescribir `globals.css` con los tokens; importar las fuentes en el `layout.tsx` raíz.
- **Hecho cuando**: la app arranca con fondo `#F6F4EE`, texto Inter y sin modo oscuro automático (CA-1, CA-2).

## T3 · Componentes base
- **Contexto**: `plan.md#componentes`.
- **Hacer**: crear `lib/utils.ts`, `components.json` y los once componentes.
- **Hecho cuando**: typecheck y lint pasan.

## T4 · Pruebas de los componentes
- **Contexto**: `components/ui/*`, `vitest.setup.ts`.
- **Hacer**: `components/ui/ui.spec.tsx` con un caso feliz y uno de error o borde por componente (CA-3).
- **Hecho cuando**: `pnpm --filter @contapp/frontend test ui` pasa.

## T5 · Verificar la fase 1
- **Hacer**: `typecheck`, `lint`, `test` y `build` del frontend; CI en verde en la rama.
- **Hecho cuando**: CA-1 a CA-4 marcados con evidencia.

## Resultados de la fase 1 (2026-11-15)
- T2: dependencias con versión exacta (`@radix-ui/react-*`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `@fontsource-variable/inter`, `inter-tight`, `jetbrains-mono`); tokens en `app/globals.css`; fuentes en `app/layout.tsx`.
- T3: `lib/utils.ts`, `components.json` y once componentes en `components/ui/` (más `index.ts`).
- T4: `components/ui/ui.spec.tsx`, 14 pruebas en verde.
- T5: `lint`, `typecheck`, `test` (96 archivos, 902 pruebas) y `build` del frontend en verde. En un navegador con el sistema en modo oscuro, `body` queda con fondo `#F6F4EE`, texto `#1C1C1C` y «Inter Variable» cargada, sin ninguna petición a Google Fonts (CA-1, CA-2). El CI (E2E incluido) corre al fusionar en `main`.

## Fase 2 · Reglas comunes (T7 a T17)
Rutas relativas a `apps/frontend/`. Cada tarea toca **solo sus archivos** (y archivos nuevos dentro de su carpeta): así T8 a T17 van en paralelo sin fusiones a mano. Ninguna agrega dependencias ni toca `globals.css`, `components/ui/` (salvo T7), `lib/` ni `pruebas/`.
1. **Solo presentación.** No cambian textos visibles, nombres accesibles, roles, `aria-*`, `data-*` (`data-fila`, `data-col`, `data-seccion-titulo`, `data-etiqueta`, `data-edicion`…), `type` de los botones, rutas, lógica ni el orden del DOM que recorren las pruebas. Un mensaje conserva su rol: con `Alert`, el `tono` se elige para que el rol (`alert`/`status`) sea el mismo de hoy; si no calza, queda el `<p role=…>` con clases de tokens. Íconos de `lucide-react` con `aria-hidden`; un botón que pase a solo ícono lleva `aria-label` igual a su texto actual.
2. **Pruebas.** Las existentes no cambian aserciones de comportamiento. Un selector visual (clase) cambia solo si es inevitable, y se justifica en el Resultado de la tarea. Selectores de clase que existen hoy: `app/(app)/layout.spec.tsx:101` (`flex-wrap` en la barra), `components/archivos/panel-generar.spec.tsx:105-106` (`fixed`, `min-[1400px]:w-[30rem]`), `components/compras/grilla-compras.angosta.spec.tsx:68` (`.sticky`), `components/reglas/tabla-reglas-cliente.spec.tsx:353-354` (sin `.overflow-x-auto` ni `min-w-[`), `app/(app)/configuracion/auditoria/page.t18a.spec.tsx:124-126` (`overflow-x-auto`, `min-w-`, `px-2`). jsdom no aplica CSS: un enlace o botón duplicado para «escritorio» y «celular» rompe `getByRole`; se cambia de disposición con CSS sobre el **mismo** elemento.
3. **Componentes interactivos propios** (menú de acciones de la grilla, lupa, diálogos de confirmar, grilla virtualizada, panel de notificaciones) se estilan con tokens y las clases de T7; no se reemplazan por los de Radix salvo que P-6 decida otra cosa. Los botones y campos simples sí pasan a `Button`, `Input`, `Label`, `Select`, `Badge`, `Alert`, `Card`, `Table`.
4. **Colores solo con tokens.** Comando de control sobre los archivos de la tarea (debe salir vacío): `grep -nE "(text|bg|border|ring|outline|divide|fill|stroke)-(red|green|blue|yellow|amber|gray|slate|zinc|neutral|stone|orange|emerald|sky|indigo|black|white)\b|#[0-9a-fA-F]{6}" <archivos>`.
5. **Accesibilidad sin regresión.** Foco visible con el anillo primario (`focus-visible:`; ningún `outline-none` sin su reemplazo), contraste AA usando solo los pares de la tabla de tokens de `plan.md` (sin opacidades sobre texto), objetivos táctiles de 44 px por debajo de 1024 px, nada que dependa solo del color (D5).
6. **Cifras (D7).** Montos con la clase `cifra` de T7 (`tabular-nums`, a la derecha); RUC, serie-número y huellas en `font-mono`. En `components/compras/` y `components/archivos/` sigue prohibido `Number(`, `parseFloat`, `toFixed`, etc. (`compras.estatico.spec.ts`).
7. **Revisión a 1440 y 390 px** de las pantallas de la tarea: guion de Playwright fuera del repo (en el scratchpad) contra `pnpm dev` o la pila E2E; sin desborde horizontal de la página (`document.documentElement.scrollWidth <= innerWidth`), sin texto cortado y con el foco visible al recorrer con Tab. Se anota en el Resultado de la tarea (capturas fuera del repo).
8. **Hecho cuando (común)**: `pnpm --filter @contapp/frontend typecheck` y `lint` pasan; `pnpm --filter @contapp/frontend test <carpetas de la tarea>` pasa sin cambiar aserciones; el comando de la regla 4 sale vacío; `git diff --name-only` solo lista archivos de la tarea; revisión 1440/390 anotada. Commit `feat(038): diseño de <grupo> (Tn)`.

## T7 · Base compartida de la fase 2
- **Contexto**: `plan.md#fase-2--reparto`, `components/ui/table.tsx`, `components/ui/dialog.tsx`, `components/ui/index.ts`, `components/ui/ui.spec.tsx`, `components/reglas/tabla-reglas-cliente.spec.tsx:340-355`, `app/(app)/configuracion/auditoria/page.t18a.spec.tsx:118-127`.
- **Hacer**: `Table` con prop `desplazable` (por defecto `true`; con `false` no envuelve en el contenedor `overflow-x-auto`); `components/ui/encabezado-pagina.tsx` (`EncabezadoPagina`: `h1` con `font-titulo` 40/34 px, descripción y zona de acciones; recibe el `h1` de la pantalla, no agrega otro); `components/ui/clases.ts` con las clases de los componentes propios: `velo` (fondo de diálogo `bg-tinta/70`), `panelDialogo`, `enlace`, `anilloFoco`, `cifra`; exportarlos en `index.ts`.
- **Hecho cuando**: casos nuevos en `ui.spec.tsx` (feliz y borde: `Table desplazable={false}` sin contenedor; `EncabezadoPagina` con un solo `h1` y acciones) y `pnpm --filter @contapp/frontend test ui` pasa. Las demás tareas esperan a T7.

## T8 · Marco: layout y menú
- **Contexto**: `app/(app)/layout.tsx`, `app/(app)/layout.spec.tsx`, `app/(app)/layout-acceso.spec.tsx`, `app/(app)/enlaces-007b.spec.tsx`, `tests/e2e/flujos/alta.e2e.ts:45-55`, `tests/e2e/flujos/equipo.e2e.ts:145-155` y `:248-266`, `tests/e2e/flujos/notificaciones.e2e.ts:340-350`, P-4, P-5. Archivos: `app/(app)/layout.tsx` y nuevos en `components/marco/`.
- **Hacer**: menú lateral desde 1024 px y disposición de celular según P-5, en **un solo** `<nav>` con cada enlace una vez en el DOM (regla 2); selector «Estudio», enlaces por permiso como hoy, la campana (T15 la estila) como entrada «Notificaciones», «Cambiar contraseña» hacia `/cuenta/contrasena`, «Cerrar sesión»; ítem activo con `primario-suave`; aviso y error con su rol. El contenido deja espacio a la barra de celular. No se agrega `<main>` (cada pantalla tiene el suyo).
- **Hecho cuando**: regla 8 con `test "app/(app)/layout" "app/(app)/enlaces"`; prueba nueva (feliz) de que «Cambiar contraseña» lleva a `/cuenta/contrasena`; CA-7 en la parte del menú.

## T9 · Inicio y auth
- **Contexto**: archivos `app/(publico)/{login,registro,registro/confirmar,recuperar,recuperar/nueva,invitacion}/page.tsx`, `app/estudios/page.tsx`, `app/(app)/page.tsx`, `components/primeros-pasos.tsx`, `app/(app)/cuenta/contrasena/page.tsx`; nuevo `app/(publico)/layout.tsx` si hace falta el marco común (tarjeta centrada); sus `*.spec.tsx`; `tests/e2e/soporte/selectores/acceso.ts`.
- **Hacer**: formularios con `Card`, `Label`, `Input`, `Button`; errores con su rol; encabezado «ContApp» de inicio con `EncabezadoPagina` (sigue siendo el `h1` «ContApp»).
- **Hecho cuando**: regla 8 con `test "app/(publico)" app/estudios "app/(app)/page" "app/(app)/cuenta"`.

## T10 · Clientes y ficha
- **Contexto**: `app/(app)/clientes/{page,nuevo/page,importar/page}.tsx`, `app/(app)/clientes/[clienteId]/{page,reglas/page}.tsx`, `components/{credenciales-cliente,datos-fiscales,filtros-clientes}.tsx`, `components/reglas/tabla-reglas-cliente.tsx`, sus `*.spec.tsx`, P-4.
- **Hacer**: listado y filtros con `Table`, `Input`, `Select`, `Badge` (estados con texto); ficha con `EncabezadoPagina` (RUC en mono) y tarjetas para datos fiscales y credenciales (sin mostrar ni registrar secretos: el estilo no cambia qué se muestra); reglas del cliente con `Table desplazable={false}` y sus tarjetas de celular (`data-etiqueta`). Si P-4 = a, «Ventas» en la navegación «Registros del cliente» con una prueba feliz nueva.
- **Hecho cuando**: regla 8 con `test "app/(app)/clientes/page" "app/(app)/clientes/listado" "app/(app)/clientes/nuevo" "app/(app)/clientes/importar" "clientes/[clienteId]/page" credenciales fiscal components/reglas/tabla-reglas-cliente`.

## T11 · Compras · grilla
- **Contexto**: `components/compras/{grilla-compras,acciones-fila-compras,filtros-compras,barra-masiva,informe-masivo,deshacer-compras,historial-compra}.tsx`, `components/reglas/{recordar-proveedor,recordar-tras-clasificar}.tsx`, sus `*.spec.tsx` (incluye `grilla-compras.angosta`, `.ubicar`, `.edicion`, `.historial`, `barra-masiva.historial`), `compras.estatico.spec.ts`, `tests/e2e/soporte/selectores/{compras,reglas}.ts`, P-2, P-3, P-6.
- **Hacer**: cabecera y filas con tokens (sin tocar `ALTO_FILA`, la virtualización ni las columnas fijas salvo lo que diga P-2); chips de estado y avisos («Recordar», «Según historial», R-MIX, R-GP…) con `Badge`/`Alert` y texto; celda en edición con anillo primario; menú de acciones, barra masiva, informe, historial y la confirmación de Ctrl+Z estilados (regla 3); montos con `cifra`, comprobante y RUC en mono.
- **Hecho cuando**: regla 8 con `test components/compras/grilla components/compras/acciones components/compras/filtros components/compras/barra components/compras/informe components/compras/deshacer components/compras/historial components/reglas/recordar compras.estatico`.

## T12 · Compras · lupa y diálogos
- **Contexto**: `components/compras/{lupa-compra,cabecera-lupa,comparacion-xml,items-xml,estado-xml,subir-xml,agregar-desde-xml,agregar-compra,excluir-compra,aceptar-sugerencia}.tsx`, sus `*.spec.tsx` (incluye `lupa-correcciones`, `lupa-compra.historial`), `tests/e2e/soporte/selectores/lupa.ts`, P-6.
- **Hacer**: diálogos con `velo` y `panelDialogo` de T7 (foco inicial, Esc y retorno de foco intactos); comparación XML/SIRE en `Table` con `cifra`; estados del XML con `Badge` y texto; formularios con `Label`/`Input`/`Select`/`Button`.
- **Hecho cuando**: regla 8 con `test components/compras/lupa components/compras/subir components/compras/agregar components/compras/excluir components/compras/aceptar "compras/lupa.avisos"`.

## T13 · Compras · página, paneles y «Generar archivo»
- **Contexto**: `app/(app)/clientes/[clienteId]/compras/page.tsx`, `components/compras/{resumen-compras,estado-periodo,descarga-compras,diferencias-compras,exportar-compras}.tsx`, `components/archivos/{panel-generar,previo-archivo,versiones-archivo}.tsx`, sus `*.spec.tsx` (incluye `page.integracion`, `page.avisos-*`, `previo-archivo.avisos-omitidos`), P-3.
- **Hacer**: `EncabezadoPagina` con periodo y estado; resumen como tarjetas con `cifra`; panel de descarga, diferencias y exportar; panel «Generar archivo» y previo (avisos, «Y N avisos más», excluidas, códigos) con `Card`, `Alert`, `Table`; en celular, lo que decida P-3 para el botón «Generar archivo» (solo CSS). El panel conserva `fixed` sin destino y `min-[1400px]:w-[30rem]` con destino (regla 2). Ventas reutiliza este panel: se revisa también en la pantalla de ventas.
- **Hecho cuando**: regla 8 con `test "clientes/[clienteId]/compras" components/compras/resumen components/compras/estado components/compras/descarga components/compras/diferencias components/compras/exportar components/archivos`.

## T14 · Ventas
- **Contexto**: `app/(app)/clientes/[clienteId]/ventas/page.tsx`, `app/(app)/clientes/[clienteId]/ventas/importar/page.tsx`, `components/ventas/*.tsx`, sus `*.spec.tsx`, `ventas.estatico.spec.ts`, `tests/e2e/soporte/selectores/ventas.ts`, P-2, P-6.
- **Hacer**: lo mismo que T11 a T13 para ventas (grilla, resumen, correlatividad, justificar salto, excluir, agregar, importar), sin tocar `components/archivos/` (es de T13).
- **Hecho cuando**: regla 8 con `test "clientes/[clienteId]/ventas" components/ventas ventas.estatico`.

## T15 · Trabajos y notificaciones
- **Contexto**: `app/(app)/trabajos/page.tsx`, `app/(app)/notificaciones/page.tsx`, `components/notificaciones/{campana,panel-notificaciones,texto-notificacion}.tsx`, sus `*.spec.tsx`, `tests/e2e/soporte/selectores/notificaciones.ts`, P-6.
- **Hacer**: trabajos con `Table` y `Badge` por estado (con texto); campana (nombre `/^Notificaciones/` intacto, contador con texto) y panel con `panelDialogo`; página de notificaciones con `EncabezadoPagina`.
- **Hecho cuando**: regla 8 con `test "app/(app)/trabajos" components/notificaciones`.

## T16 · Auditoría, equipo y planes/admin
- **Contexto**: `app/(app)/configuracion/auditoria/page.tsx`, `app/(app)/usuarios/page.tsx`, `components/{uso-plan,autor}.tsx`, `app/(plataforma)/admin/{page,planes/page}.tsx`, sus `*.spec.tsx`.
- **Hacer**: auditoría con `Table` (conserva contenedor desplazable, `min-w-` y `px-2`: regla 2) y filtros; usuarios e invitaciones con `Table`, `Badge` de rol y `Button`; uso del plan como tarjeta con barras con texto; consola del super-admin y planes con `Card`/`Table`/`Input`.
- **Hecho cuando**: regla 8 con `test "app/(app)/configuracion/auditoria" "app/(app)/usuarios" components/uso-plan components/autor "app/(plataforma)"`.

## T17 · Reglas del motor
- **Contexto**: `app/(app)/configuracion/reglas/page.tsx`, `components/reglas/reglas-motor.tsx`, `components/reglas/reglas-motor.spec.tsx`.
- **Hacer**: `EncabezadoPagina`; lista de reglas con `Table` o `Card`, estado con `Badge` y texto; interruptores y botones con su nombre actual.
- **Hecho cuando**: regla 8 con `test components/reglas/reglas-motor`.

## T-final · Verificar la fase 2 y cerrar
- **Contexto**: `spec.md#criterios-de-aceptación` (CA-5 a CA-8), reglas comunes, Resultados de T7 a T17, P-7.
- **Hacer** (tester, sonnet): `apps/frontend/diseno.estatico.spec.ts` que aplica el comando de la regla 4 a `app/` y `components/` (fuera de `components/ui/` y de las pruebas) para que CA-5 quede fijo; revisión a 1440 y 390 px de todas las rutas (según P-7) con la lista de foco, contraste AA, textos y desborde; lista de defectos → tareas `T-final-a…` al rol frontend. (devops, haiku): `typecheck`, `lint`, `test` y `build` del frontend, `pnpm e2e` completo y CI en verde; `tasks.md` y `ESTADO.md`.
- **Hecho cuando**: CA-5 a CA-8 marcados con evidencia (comando, prueba o captura); la E2E sigue en verde sin cambiar selectores.

## Preguntas abiertas de la fase 2 (decide el usuario)
- **P-1 · Modo oscuro (D4).** (a) **(Recom.)** Fuera de 038: spec propia con su paleta y su revisión de contraste. (b) Fase 3 de 038, después de T-final. (c) Descartarlo: tema claro fijo.
- **P-2 · Densidad de las grillas.** (a) **(Recom.)** Mantener las alturas actuales (compras 52 px por fila, ventas 36 px) y solo estilar: no toca la virtualización, «Ubicar» ni sus pruebas. (b) Compras compacta a 40 px (cambia `ALTO_FILA`; más filas a la vista, revisar pruebas de desplazamiento). (c) Selector de densidad por usuario (comportamiento nuevo: otra spec).
- **P-3 · Compras en celular.** (a) **(Recom.)** Grilla estilada con desplazamiento horizontal como hoy y botón «Generar archivo» fijo abajo (solo CSS); las tarjetas de la maqueta, en una spec aparte. (b) Tarjetas según la maqueta en esta spec (cambia la semántica `grid` y las aserciones de `grilla-compras.angosta.spec.tsx`). (c) Solo estilo, sin tarjetas ni botón fijo.
- **P-4 · «Ventas» desde el menú (CA-7).** Ventas es por cliente, no hay una pantalla global. (a) **(Recom.)** «Ventas» se suma a la navegación «Registros del cliente» de la ficha (Compras · Ventas · Reglas aprendidas) y el menú lleva a Clientes; CA-7 se reescribe así. (b) Pestañas de cliente en un `clientes/[clienteId]/layout.tsx` (Ficha · Compras · Ventas · Reglas) visibles en las cuatro pantallas (cuidar enlaces con el mismo nombre en E2E). (c) «Ventas» en el menú global que abre Clientes para elegir uno.
- **P-5 · Menú en celular.** (a) **(Recom.)** Barra inferior con Clientes, Trabajos, Notificaciones (la campana) y «Más» (Usuarios, Auditoría, Reglas del motor, Estudio, Cambiar contraseña, Cerrar sesión). (b) Barra superior con botón de menú que despliega todo; sin barra inferior. (c) Barra inferior con todos los enlaces y desplazamiento horizontal.
- **P-6 · Diálogos y menús propios.** (a) **(Recom.)** Estilarlos sin cambiarlos por los de Radix (conservan foco, Esc y pruebas); migrarlos, si se quiere, en otra spec. (b) Migrarlos a `Dialog`/`DropdownMenu` de Radix en esta spec, ajustando las pruebas que dependan de su DOM.
- **P-7 · Comprobación de accesibilidad y desborde.** (a) **(Recom.)** Revisión manual guiada: guion de Playwright fuera del repo con capturas a 1440 y 390 px, medición de desborde y lista de foco y contraste; sin dependencias nuevas. (b) Agregar `tests/e2e/flujos/diseno.e2e.ts` al E2E: desborde a 390 px y `@axe-core/playwright` (versión exacta) con la regla de contraste en las pantallas principales. (c) Solo la prueba de desborde en el E2E, sin axe.

## Resultado T6 (2026-11-17)
- Inventario sobre `main` con 021 y 022: 63 archivos de pantalla (`.tsx` sin pruebas, fuera de `components/ui/`) más los 10 de `components/ventas/`, repartidos sin solapes en T8 a T17 (comprobado con `comm` contra `find app components`). Ninguna pantalla usa aún `components/ui/`; hay 57 archivos con colores sueltos (`text-red-600`, `bg-black`, `bg-amber-50`…).
- Orden: T7 primero (base que importan todas); luego T8 a T17 en paralelo; T-final al final. T8, T10, T11, T12, T13, T14 y T15 esperan además las P-n indicadas en su fila.
- Hallazgos que fijan reglas: cinco pruebas con aserciones de clases (regla 2); `Table` siempre envuelve en `overflow-x-auto` y `tabla-reglas-cliente.spec.tsx` exige que no haya (T7 agrega `desplazable`); jsdom no aplica CSS, así que el menú de escritorio y el de celular deben ser el mismo árbol; `Alert` fija el rol por tono (regla 1); «Cambiar contraseña» (`/cuenta/contrasena`) no tiene hoy ningún enlace, y la ficha no enlaza a Ventas (solo Compras y Reglas aprendidas).
- Decisiones abiertas: P-1 a P-7.

## Resultado T7 (2026-11-17)
- `components/ui/table.tsx`: `Table` con `desplazable` (por omisión `true`; con `false` devuelve solo `<table>`, sin `overflow-x-auto`). `components/ui/encabezado-pagina.tsx`: `EncabezadoPagina({ titulo, descripcion?, acciones?, className })`, con un único `h1` (`font-titulo`, 34 px en celular y 40 px desde `md`); `titulo` es el contenido del `h1` que ya tenía la pantalla. `components/ui/clases.ts`: `velo`, `panelDialogo`, `enlace`, `anilloFoco`, `cifra` (solo tokens). Todo exportado en `index.ts`; `dialog.tsx` pasó a usar `velo` y `panelDialogo` (mismo resultado).
- `ui.spec.tsx`: 4 casos nuevos (`Table desplazable={false}` sin contenedor y con él por omisión; `EncabezadoPagina` con un `h1`, descripción y acciones, y solo con título; clases sin colores sueltos). `test ui`: 41 en verde.
- Control: `test` completo del frontend con `TZ=America/Lima` y con `TZ=UTC` (975 pruebas cada uno), `typecheck` y `lint` en verde.
