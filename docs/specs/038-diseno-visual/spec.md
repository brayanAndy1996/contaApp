# Spec 038 · Diseño visual (estilo A, verde petróleo)

Estado: hecha (2026-11-17). Fase 1 y fase 2 hechas; CA-1 a CA-8 verificados (T-final, dos pasadas en navegador sobre el build de producción). Decisiones del usuario: estilo A, shadcn/ui, dos fases (2026-11-15) y P-1 a P-7 de la fase 2 (2026-11-17).
Nivel de riesgo: C — responde «sí» solo a (3) en casos aislados (un estado mal coloreado podría pasar inadvertido). No toca montos, permisos, datos ni concurrencia: solo la presentación. Pruebas después: un caso feliz y uno de error por componente público, más los E2E de R1 como regresión.
Cubre: RNF de usabilidad y accesibilidad de `docs/02-requerimientos.md` (presentación de todas las pantallas de R1) · notas de la guía de uso (`docs/guia/12-un-mes-de-punta-a-punta.md`, «Detalles de pantalla que vas a notar»).

## Objetivo
Hoy la app usa Tailwind con los estilos por defecto de Next.js (fuente Arial, blanco y negro, fondo negro si el sistema está en modo oscuro). Esta spec le da a ContApp una identidad visual propia, legible para trabajar muchas horas con cifras, sin cambiar ningún comportamiento: el estilo A elegido por el usuario sobre las maquetas del lienzo de diseño (2026-11-15).

## Alcance
**Fase 1 · Base (sin conflictos con las specs en curso)**
- Tokens de diseño en `apps/frontend/app/globals.css` (Tailwind 4, `@theme`): colores, tipografía, radios, sombras y espaciado del estilo A (tabla en `plan.md`).
- Tema claro fijo: se quita el cambio automático a fondo negro (D4).
- Fuentes autoalojadas con Fontsource: Inter (texto), Inter Tight (títulos), JetBrains Mono (RUC, series, huellas) (D3).
- shadcn/ui configurado (`components.json`, `lib/utils.ts` con `cn`) y componentes base en `apps/frontend/components/ui/`: `Button`, `Input`, `Label`, `Select` nativo estilado, `Badge` (chips de estado), `Alert`, `Card`, `Table`, `Tabs`, `Dialog`, `DropdownMenu`.
- Pruebas de nivel C de cada componente.

**Fase 2 · Pantallas (después de que 021 y 022 estén en `main`)**
- Marco de la app: menú lateral en escritorio y barra inferior en celular, con «Ventas», «Notificaciones» y «Cambiar contraseña» siempre accesibles.
- Aplicar los componentes a: ingresar, registro y recuperación; inicio; clientes y ficha; credenciales; trabajos; usuarios; compras (grilla, resumen, barra masiva, historial); ventas; lupa; generar archivo; auditoría; notificaciones; consola del super-admin; y las pantallas nuevas de reglas que trae 021.
- Diseño de celular de las pantallas principales según las maquetas (compras como tarjetas, «Generar archivo» fijo abajo). Las tarjetas de compras dependen de P-3: cambian la semántica de la grilla y sus pruebas de 390 px.

## Fuera de alcance
- Cambios de comportamiento, rutas, textos de negocio o permisos. Si una pantalla necesita un cambio de comportamiento (por ejemplo, sincronizar el periodo con la dirección), va en otra spec.
- Modo oscuro (D4): pregunta abierta para una spec futura.
- La demo navegable (`apps/demo`, rama `claude/nice-tesla-xqx40o`).

## Decisiones
- D1 (usuario 2026-11-15) **shadcn/ui** como base de componentes. Revierte la decisión de 2026-11-04 («sin shadcn», nota de `docs/03-arquitectura.md`): esta es la spec que lo necesita. Los componentes se copian al repo (no es una dependencia opaca) y se estilan con los tokens del estilo A. Dependencias exactas: `@radix-ui/react-*` (slot, dialog, dropdown-menu, tabs, label), `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` (íconos).
- D2 (usuario 2026-11-15) **Dos fases.** La fase 1 solo agrega archivos nuevos y cambia `globals.css`, el `layout.tsx` raíz y las dependencias del frontend, que 021 y 022 no tocan. La fase 2 toca las mismas pantallas que 021 (grilla, lupa, barra masiva, menú) y 022 (panel de generar archivo): empieza cuando las dos estén en `main`, para no fusionar a mano sus cambios.
- D3 **Fuentes autoalojadas** (Fontsource, npm): sin depender de Google Fonts al compilar ni en el CI, y sin enviar la IP de los usuarios a terceros.
- D4 **Tema claro fijo** en esta spec. El estilo A se diseñó en claro; el modo oscuro necesita su propia paleta y revisión de contraste.
- D5 **Accesibilidad**: contraste AA (4.5:1 en texto, 3:1 en bordes de controles), foco visible con anillo verde petróleo, objetivos táctiles de 44 px en celular, nada que dependa solo del color (los chips llevan texto).
- D6 **No romper los E2E**: se conservan nombres accesibles, roles, textos visibles y atributos `data-*` que usan `tests/e2e/soporte/selectores/` (por ejemplo `data-fila`, `data-col`, `data-seccion-titulo`).
- D7 **Cifras**: `font-variant-numeric: tabular-nums` en montos; RUC, series y huellas en monoespaciada.

## Criterios de aceptación
**Fase 1**
- [x] CA-1: `globals.css` define los tokens del estilo A (colores, fuentes, radios, sombras) como variables de Tailwind 4, y la app ya no cambia a fondo negro con el sistema en modo oscuro.
- [x] CA-2: Las tres fuentes se cargan desde el propio servidor (sin peticiones a Google Fonts) y `body` usa Inter.
- [x] CA-3: Existen los componentes base de `components/ui/` con sus variantes (botón principal, secundario, terciario, peligro y tamaños; chips ok/aviso/error/info/neutro; alertas de los cuatro tipos), y cada uno tiene pruebas de nivel C: un caso feliz y uno de error o borde (botón deshabilitado no dispara; diálogo se cierra con Esc y devuelve el foco; pestañas se recorren con flechas; menú se abre con teclado).
- [ ] CA-4: `pnpm --filter @contapp/frontend typecheck`, `lint`, `test` y `build` pasan, y el CI (incluido E2E) queda en verde: la fase 1 no cambia ninguna pantalla salvo el fondo y la fuente.

**Fase 2** (detallada en `tasks.md`, T7 a T17 y T-final)
- [ ] CA-5: Todas las pantallas de R1 y las de 021 usan los componentes y tokens; ninguna usa colores sueltos.
- [ ] CA-6: Los 89+ E2E pasan sin cambiar sus selectores (D6); las pruebas unitarias existentes no cambian aserciones de comportamiento (un selector visual solo si es inevitable y está justificado), y la revisión manual a 1440 px y 390 px no muestra desbordes.
- [ ] CA-7: «Ventas», «Notificaciones» y «Cambiar contraseña» se alcanzan desde el menú en escritorio y en celular (cómo se llega a «Ventas», que es por cliente, según P-4).
- [ ] CA-8: Accesibilidad sin regresión en todas las pantallas: foco visible, contraste AA (D5) y los mismos textos y nombres accesibles de antes.
- [ ] Casos reales aplicables: ninguno (no cambia cálculos). Las maquetas usan los datos de prueba (mixta, San Juan, zapatilla) solo como contenido.

## Dependencias
- Specs: 021 y 022 en `main` antes de la fase 2.
- Externas: ninguna. Referencia visual: lienzo de diseño «ContApp: pantallas principales», estilo A.

## Preguntas abiertas
Ninguna. Decisiones del usuario sobre la fase 2 (2026-11-17), todas la opción (a) recomendada:
- **P-1:** modo oscuro en una spec propia (fuera de 038).
- **P-2:** las grillas mantienen sus alturas actuales (compras 52 px, ventas 36 px).
- **P-3:** compras en celular: grilla estilada con desplazamiento horizontal y «Generar archivo» fijo abajo; tarjetas en otra spec.
- **P-4:** «Ventas» en la ficha del cliente, junto a Compras y Reglas (se reescribe CA-7).
- **P-5:** menú en celular: barra inferior con Clientes, Trabajos, Notificaciones y «Más».
- **P-6:** diálogos y menús propios se estilan sin cambiarlos por los de Radix.
- **P-7:** accesibilidad y desbordes con revisión manual guiada (guion de Playwright fuera del repo).
