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
| T18 | Ajustes de integración de la fase 2 (velos, barra inferior, campana, ventas) | frontend | sonnet | T8–T17 | — | — | [x] |
| T-final | Verificar CA-5 a CA-8: prueba estática de colores, revisión manual 1440/390 px, accesibilidad, E2E y CI; cierre | tester (sonnet) + devops (haiku) | sonnet | T7–T17, P-7 | — | — | [~] |

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

### Resultado T-final · parte tester (2026-11-17)
- **CA-5 · cumplido.** `apps/frontend/diseno.estatico.spec.ts` (4 pruebas, en verde) aplica el patrón de la regla 4 a `app/` y `components/` (79 archivos; fuera de `components/ui/`, de las pruebas y de `app/globals.css`, que es donde se definen los tokens) y exige cero hallazgos; una prueba comprueba que el patrón sí detecta `text-red-600`, `bg-black/30`, `#ff0000`… y deja pasar los tokens.
- **CA-6 (parte manual) · cumplido con reservas.** Sin desborde horizontal de la página en ninguna de las 34 vistas a 1440 ni a 390 px (la grilla horizontal de compras se revisó también desplazada a la derecha) (`scrollWidth <= clientWidth`; incluye lupa, historial, menú de acciones, barra masiva, informe, «Generar archivo» de compras y ventas, campana, «Más»). Reservas: T-final-c a T-final-e (texto cortado). Las E2E y los 983 casos unitarios los corre devops (aquí no se tocaron selectores ni pruebas existentes). **Hallazgo previo: `next build` falla (T-final-a), así que `pnpm e2e` (que compila) no puede pasar hasta corregirlo.**
- **CA-7 · cumplido, con defecto en escritorio.** Ventas: ficha del cliente → «Registros del cliente» → «Ventas» (`/clientes/:id/ventas`) en 1440 y 390. Cambiar contraseña: menú lateral (1440) y «Más» (390) → `/cuenta/contrasena`. Notificaciones: campana → «Ver todas» → `/notificaciones` en 390; en 1440 el enlace queda fuera de pantalla con el ratón (T-final-b); solo se llega con teclado.
- **CA-8 · cumplido.** En las 34 vistas × 2 anchos: 0 pares de texto bajo AA (cálculo propio sobre colores computados de texto y fondo, umbral 4,5 y 3 para texto grande; la comprobación se validó con un caso gris `#aaa` que sí marca 2,32), 0 elementos enfocables sin anillo al recorrer con Tab (hasta 30 Tab por vista; en diálogos, solo dentro del diálogo), 0 textos sueltos en inglés (texto visible, `placeholder`, `aria-label`, `title`, `alt`). Los mismos nombres accesibles (las E2E los usan; el guion localizó por ellos los botones «Ver comprobante F001-2056», «Acciones…», «Historial de…», «Seleccionar…»). Pendiente aparte: el objetivo táctil de 44 px (regla 5) tiene excepciones menores (T-final-f, T-final-g).
- **Pendientes de T11, T14 y T18 · revisados a 390 px.** Botones de la fila de compras: 44×44 px dentro de filas de 52 px (correcto). Botón fijo «Generar archivo»: bottom 775 px sobre la barra inferior (top 791 px, alto 53 px, `--alto-barra-inferior: 53px`): correcto, sin solape; pero su panel queda fuera de vista (T-final-d). Panel de la campana en celular: se abre hacia arriba, dentro del viewport (left 16, right 374, bottom 783 < barra 791): correcto. Chips recortados en la columna Comprobante: **confirmado** (T-final-e). Botón «Quitar» de ventas (fila manual): el área táctil mide 42 px (T-final-g).
- **No revisado:** el aviso «Recordar» tras clasificar (la compra ya estaba clasificada por la corrida previa; lo cubre la E2E `reglas.e2e.ts`) y el modo producción (la revisión se hizo con `next dev`; las capturas muestran la insignia de desarrollo de Next, que no es del producto). El `403 /api/plataforma/yo` de `/estudios` es esperado (usuario sin rol de plataforma).
- **Cómo repetirlo:** guion `revision.mjs` y capturas (1440 y 390) en el scratchpad `.../scratchpad/t-final-038/` (fuera del repo, P-7a).

**Defectos (tareas para el rol frontend)**
- **T-final-a · ALTA · `next build` falla.** `Route "/clientes/[clienteId]": usePathname() in a Client Component outside of <Suspense>` (`CLIENT_HOOK_DYNAMIC`); sale con código 1 al generar páginas estáticas (13/27), y el mismo error se ve en la consola de todas las rutas de `(app)`. Ruta: todas las de `(app)`; ancho: cualquiera. Evidencia: `build.log` del scratchpad. Archivo probable: `components/marco/menu-principal.tsx:70` (`usePathname`) y su uso en `app/(app)/layout.tsx:31`; envolver el menú en `<Suspense>` o leer la ruta de otro modo, sin cambiar el DOM que ven las pruebas.
- **T-final-b · ALTA · el panel de la campana se corta en escritorio.** Ruta: cualquiera de `(app)`; 1440 px: el panel (384 px) abre con `left = -157` y queda cortado por el borde izquierdo (textos y «Ver todas» fuera de pantalla; Playwright no puede hacer clic en «Ver todas»). Captura: `capturas/1440-notificaciones-campana-vp.png`. Archivo probable: `components/notificaciones/panel-notificaciones.tsx:229` (`absolute right-0` con la campana dentro del menú lateral de 256 px; abrir hacia la derecha desde `lg`). En 390 px está bien.
- **T-final-c · MEDIA · «Historial de la compra» más ancho que la pantalla en celular.** Ruta: `/clientes/:id/compras`, botón «Historial de F001-3064»; 390 px: el panel mide 447 px y queda con `left = -58` (títulos y versiones cortados por la izquierda). Captura: `capturas/390-historial-panel.png`. Archivo probable: `components/compras/historial-compra.tsx:75` (`w-[28rem] max-w-full`) y su contenedor en `components/compras/grilla-compras.tsx`; usar `max-w-[100vw]` o `w-full max-w-md`.
- **T-final-d · MEDIA · «Generar archivo» de compras no muestra el panel en celular.** Ruta: `/clientes/:id/compras`; 390 px: al pulsar el botón fijo el panel se pinta en el flujo al final de la página (`top ≈ 3117 px`), `scrollY` sigue en 0 y el foco queda en el botón: no se ve ningún cambio. En ventas el panel es `fixed` y sí se ve. Capturas: `capturas/390-generar-panel.png`, `390-compras-generar-archivo-vp.png`. Archivo probable: `components/archivos/panel-generar.tsx` (clase con destino, línea ~47) y `app/(app)/clientes/[clienteId]/compras/page.tsx:767` (ranura); desplazar el panel a la vista y/o llevarle el foco al abrir.
- **T-final-e · MEDIA · texto cortado en la grilla de compras.** Rutas: `/clientes/:id/compras`; 1440 y 390 px: columna Comprobante (156 px) con contenido de 194 px: el chip «Con alerta: R-MIX, R-NEW» se corta («R-MIX, R-»); el encabezado «Ver comprobante» se ve «Ver ...» (116 > 56 px) y «Por clasificar» se ve «Por clas» en Destino. Capturas: `capturas/1440-compras-grilla.png`, `390-compras-grilla.png`. Archivo probable: `components/compras/grilla-compras.tsx` (anchos de columna y chips) sin tocar `ALTO_FILA` ni la virtualización (P-2); quizá `title`/envoltura del chip o ancho mayor de la columna.
- **T-final-f · BAJA · objetivos táctiles menores de 44 px a 390 px (regla 5).** Casillas de selección de compras (20×20), de clientes (24×24) y de filtros; interruptores de «Reglas del motor» (20×20); «Cerrar» del informe masivo (77×40); enlace «Descargar plantilla» de importar clientes (123×20); selector «Plan» y campo «RUCs adicionales» de `/admin` (40 px). Las casillas con `label` envolvente no se cuentan. Archivos probables: `components/compras/grilla-compras.tsx`, `components/compras/informe-masivo.tsx`, `app/(app)/clientes/page.tsx` (listado), `components/reglas/reglas-motor.tsx`, `app/(app)/clientes/importar/page.tsx`, `app/(plataforma)/admin/page.tsx`.
- **T-final-g · BAJA · área táctil de «Quitar» en ventas = 42 px, no 44.** Ruta: `/clientes/:id/ventas`, fila de venta manual; 390 px: el `before` mide 52×42 (el borde de 1 px resta 2 px a `-inset-y-2` sobre un botón de 28 px). Archivo probable: `components/ventas/grilla-ventas.tsx:48` (`-inset-y-[9px]`).
- **T-final-h · BAJA · la campana no se ve como los demás ítems del menú.** Ruta: cualquiera de `(app)`; 1440 px: botón con borde y solo ícono y contador, desalineado respecto de los enlaces con texto; 390 px: ícono sin la etiqueta «Notificaciones» que sí tienen «Clientes», «Trabajos» y «Más». Archivos probables: `components/notificaciones/campana.tsx`, `components/marco/menu-principal.tsx`. Es solo estética (el nombre accesible es correcto).
- **Observación (sin tarea):** en 390 px la barra masiva aparece al final de la grilla (`top ≈ 2407 px`), no a la vista tras seleccionar filas. No cambió con 038 (no era fija antes); se deja a criterio de P-3.

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

## Resultado T18 (2026-11-17)
- Velos: `Ventana` de `acciones-fila-compras.tsx` y el envoltorio de `AgregarCompra` ya usaban `velo` (T11 y T13 lo habían resuelto); búsqueda en `app/` y `components/` de `bg-black`, `bg-white`, `/30` e `inset-0` sin tokens: vacía (solo `velo` en `components/ui/clases.ts`). Sin cambios.
- `--alto-barra-inferior`: `menu-principal.tsx` la define en `<html>` con el alto medido de la `<nav>` (`getBoundingClientRect`, `ResizeObserver` y `resize`), `0px` desde 1024 px (menú lateral) y la quita al desmontarse. `app/(app)/layout.tsx` usa la variable en el relleno inferior (con la fórmula anterior como valor por omisión).
- Ventas: `<main>` con `pb-28 md:pb-6` (igual que compras).
- Campana: contenedor con `lg:ml-auto` (sin `ml-auto` en celular). Panel: bajo 1024 px se abre hacia arriba (`max-lg:bottom-full mb-2 mt-0`), con alto máximo y `overflow-y-auto`; bajo 640 px (fijo) queda sobre la barra con `bottom-[calc(var(--alto-barra-inferior,4.5rem)+0.5rem)]`. Escritorio igual.
- Botones de fila de ventas: bajo 1024 px, pseudo-elemento `before` de 44 px de alto (`-inset-y-2` sobre el botón de 28 px); el tamaño visual y el alto de fila (36 px) no cambian. Limitación: con filas de 36 px las áreas de dos filas contiguas se solapan 8 px (en el hueco entre botones); cada botón conserva su propio recuadro visible y las tres acciones piden confirmación, pero no es un objetivo de 44 px libre de solapes. La primera y la última fila quedan recortadas por el contenedor desplazable.
- Pruebas nuevas (5, sin cambiar aserciones): `components/marco/menu-principal.spec.tsx` (2), `components/notificaciones/campana.barra-inferior.spec.tsx` (2), `components/ventas/grilla-ventas.tactil.spec.tsx` (1), `ventas/page.espacio-barra.spec.tsx` (1). Total: 983 en verde con `TZ=America/Lima` y con `TZ=UTC`; `typecheck`, `lint` y el comando de la regla 4 sobre `apps/frontend`: limpios.
- Pendiente de T-final: la revisión visual a 390 px (altura real de la barra, panel de la campana y botón fijo) no se hizo aquí.
