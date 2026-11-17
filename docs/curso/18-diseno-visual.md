# 18 · Diseño visual: una identidad propia sin romper nada

> Módulo anterior: [17-rendimiento.md](17-rendimiento.md) · Índice: [00-indice.md](00-indice.md)
>
> Cubre la spec **038** (diseño visual, estilo A verde petróleo), fases 1 y 2. Conviene haber leído [01](01-arquitectura-general.md), [12](12-compras.md) y [15](15-pruebas-e2e.md).

## Lo que aprenderás

- Qué son los **tokens de diseño** y cómo Tailwind 4 los convierte en clases con `@theme`.
- Por qué los componentes de **shadcn/ui** se copian al repositorio y cómo funcionan `cva`, `cn` y Radix.
- Por qué las fuentes se **autoalojan** y por qué la app es solo de tema claro.
- Las reglas de **accesibilidad** de la spec: contraste, foco visible, objetivos de 44 px y nada que dependa solo del color.
- Cómo un rediseño completo pasó los **88 E2E sin cambiar un selector**, y por qué se hizo en dos fases.

---

## 1. El problema: Arial, blanco y negro

Hasta la spec 038 la app usaba los estilos por defecto de Next.js: fuente Arial, blanco y negro, y fondo negro si el sistema del usuario estaba en modo oscuro. Funcionaba, pero no era cómodo para pasar horas mirando cifras.

038 le da a ContApp una identidad propia (el **estilo A**, verde petróleo, elegido por el usuario sobre maquetas) **sin cambiar ningún comportamiento**. Es como cambiar el formato de los estados financieros de un cliente: la tipografía, los colores y los márgenes cambian, pero ningún saldo, ninguna cuenta y ninguna nota puede moverse.

Es de nivel de riesgo **C** (spec, «Nivel de riesgo»): no toca montos, permisos, datos ni concurrencia. Por eso las pruebas fueron un caso feliz y uno de error por componente, más todos los E2E de R1 como regresión.

## 2. Tokens: el plan de cuentas de los colores

Un **token de diseño** es un nombre para una decisión visual: `primario` en vez de `#0e4f55`, `tinta-suave` en vez de `#5e5e5e`. Las pantallas usan nombres; el valor vive en un solo lugar.

Es lo mismo que un plan de cuentas: los asientos usan «60 Compras», no «la cuenta donde van las facturas de proveedores». Si mañana cambia el color primario, se cambia una línea, igual que se reclasifica una cuenta sin rehacer los asientos.

En Tailwind 4 los tokens se declaran con `@theme` en CSS, y **cada uno genera clases**. `apps/frontend/app/globals.css:9-50` (fragmento):

```css
@theme {
  --color-primario: #0e4f55;
  --color-primario-hover: #0b4247;
  --color-primario-activo: #082f33;
  --color-primario-suave: #dce9e9;

  --color-papel: #f6f4ee;
  --color-hoja: #ffffff;
  /* … hoja-alterna, linea, linea-control, tinta, tinta-media, tinta-suave, neutro-fondo */

  --color-ok: #1f5e2e;
  --color-ok-fondo: #e3f1e5;
  --color-ok-borde: #a9d3b1;
  /* … info, aviso y error con su fondo y su borde */

  --font-sans: "Inter Variable", "Segoe UI", system-ui, sans-serif;
  --font-titulo: "Inter Tight Variable", "Inter Variable", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, "Cascadia Mono", Consolas, monospace;

  --radius-control: 8px;
  --radius-tarjeta: 16px;
  --radius-dialogo: 20px;

  /* … shadow-tarjeta, shadow-flotante, shadow-dialogo */
}
```

Con eso existen `bg-primario`, `text-tinta-suave`, `border-linea`, `rounded-tarjeta`, `shadow-flotante`… Los nombres están en español, como el dominio (CLAUDE.md). La tabla completa, con el uso de cada token, está en `docs/specs/038-diseno-visual/plan.md`.

Debajo, `globals.css:52-71` fija el tema claro, el foco y las cifras:

```css
:root {
  color-scheme: light;
}

body {
  background: var(--color-papel);
  color: var(--color-tinta);
  font-family: var(--font-sans);
}

/* Montos: dígitos de igual ancho para que las columnas se alineen (D7). */
.cifras {
  font-variant-numeric: tabular-nums;
}

/* Foco visible y consistente en toda la app (D5). */
:focus-visible {
  outline: 2px solid var(--color-primario);
  outline-offset: 2px;
}
```

`tabular-nums` hace que todos los dígitos midan lo mismo: `1,111.11` y `8,888.88` quedan alineados en la columna, como en un libro contable impreso.

### Solo tema claro (D4)

`color-scheme: light` y la ausencia de una regla `prefers-color-scheme: dark` dejan la app **siempre en claro**. El estilo A se diseñó y se revisó en claro; un modo oscuro necesita su propia paleta y su propia revisión de contraste. Antes de 038, la plantilla de Next ponía el fondo negro con el sistema en modo oscuro sin una paleta pensada para eso (spec, «Objetivo»). El usuario dejó el modo oscuro para una spec propia (P-1).

## 3. Fuentes autoalojadas (D3)

`apps/frontend/app/layout.tsx:1-6`:

```ts
import type { Metadata } from "next";
// Fuentes autoalojadas (spec 038, D3): se sirven desde la propia app, sin Google Fonts.
import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
```

Fontsource publica cada fuente como paquete npm con sus archivos `.woff2`. Así:

- La compilación y el CI **no dependen de la red** hacia Google Fonts.
- El navegador del usuario **no envía su IP** a un tercero en cada carga: en una app que maneja datos tributarios de terceros, menos destinatarios es mejor.
- La versión de la fuente queda fija en `package.json`, como cualquier dependencia.

Tres familias, cada una con su trabajo: **Inter** para el texto, **Inter Tight** para los títulos de página y **JetBrains Mono** para RUC, serie-número y huellas SHA-256, donde confundir `0` con `O` o `1` con `l` sí importa (D7).

## 4. shadcn/ui: componentes copiados, no instalados

shadcn/ui no es una librería que se instala: es un catálogo de componentes que **se copian** al repositorio y pasan a ser código propio (D1). Están en `apps/frontend/components/ui/`: `Button`, `Input`, `Label`, `Select`, `Badge`, `Alert`, `Card`, `Table`, `Tabs`, `Dialog`, `DropdownMenu`, más `EncabezadoPagina` y `clases.ts` de la fase 2.

¿Por qué copiar? Porque así se pueden leer, adaptar a los tokens y probar como cualquier otro archivo, sin una dependencia opaca. El plan aclara que no se usó el CLI de shadcn (necesita red hacia su registro); `components.json` queda configurado para quien quiera usarlo más adelante.

Tres piezas los sostienen:

| Pieza | Para qué |
|---|---|
| **Radix** (`@radix-ui/react-*`) | Comportamiento accesible ya resuelto: el diálogo atrapa el foco y cierra con Esc, las pestañas se recorren con flechas, el menú se abre con teclado. |
| **cva** (`class-variance-authority`) | Declarar variantes (`primario`, `peligro`, `sm`, `lg`) como datos, en vez de `if` que arman cadenas de clases. |
| **`cn`** (`clsx` + `tailwind-merge`) | Unir clases y resolver conflictos: si el componente dice `bg-primario` y quien lo usa pasa `bg-error`, gana la última. |

`apps/frontend/lib/utils.ts:1-7`:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Une clases de Tailwind y resuelve conflictos (la última gana): base de los componentes de `components/ui` (spec 038). */
export function cn(...clases: ClassValue[]): string {
  return twMerge(clsx(clases));
}
```

El botón muestra las tres juntas. `apps/frontend/components/ui/button.tsx:7-26`:

```ts
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primario: "bg-primario text-white hover:bg-primario-hover active:bg-primario-activo",
        secundario: "border border-linea-control bg-hoja text-tinta hover:bg-neutro-fondo active:bg-linea",
        terciario: "bg-transparent text-primario hover:bg-primario-suave active:bg-primario-suave",
        peligro: "bg-error text-white hover:brightness-90 active:brightness-75",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-5 text-[15px]",
        icono: "size-10",
      },
    },
    defaultVariants: { variant: "primario", size: "md" },
  },
);
```

Y `button.tsx:30-40`:

```ts
export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type: type ?? "button" })}
      {...props}
    />
  );
}
```

Dos detalles: `type` por defecto es `"button"` (un botón dentro de un formulario no lo envía por accidente) y `asChild` con el `Slot` de Radix permite que un enlace se vea como botón sin anidar `<a>` dentro de `<button>`.

### Diálogos propios: estilar, no reemplazar (P-6)

La grilla de compras, la lupa y los diálogos de confirmar ya tenían su comportamiento probado (foco, teclado, `aria-*`). La fase 2 **no** los cambió por los de Radix: los estiló con clases de tokens. `apps/frontend/components/ui/clases.ts:13-14`:

```ts
/** Anillo de foco primario para controles propios (D5). */
export const anilloFoco = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primario";
```

## 5. Accesibilidad (D5)

La spec fija cuatro reglas:

1. **Contraste AA**: 4,5:1 en texto; 3:1 en bordes de controles. Los pares texto/fondo de la tabla de tokens se eligieron para cumplir 4,5:1.
2. **Foco visible** con el anillo verde petróleo: ningún `outline-none` sin su reemplazo.
3. **Objetivos táctiles de 44 px** por debajo de 1024 px (celular).
4. **Nada depende solo del color**: un chip «Inválida» es rojo **y** dice «Inválida».

El chip lo deja escrito. `apps/frontend/components/ui/badge.tsx:5-7`:

```ts
/** Chip de estado (spec 038). Siempre lleva texto: el color nunca es la única señal (D5). */
export const badgeVariants = cva(
  "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold [&_svg]:size-3",
```

Y la alerta elige el rol según su tono. `apps/frontend/components/ui/alert.tsx:26-36`:

```ts
export function Alert({ className, tono, role, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  const t: Tono = tono ?? "info";
  return (
    <div
      data-slot="alert"
      role={role ?? (t === "aviso" || t === "error" ? "alert" : "status")}
      className={cn(alertVariants({ tono: t }), className)}
      {...props}
    />
  );
}
```

Un lector de pantalla anuncia un `alert` enseguida y un `status` cuando termina de hablar. Un error que bloquea interrumpe; un «guardado» no.

La revisión final (T-final, P-7) recorrió **70 vistas** (35 a 1440 px y 35 a 390 px) sobre el build de producción: 0 pares de texto bajo AA, 0 elementos enfocables sin anillo, 0 desbordes horizontales de página. La primera pasada había encontrado objetivos táctiles de 20 a 42 px (casillas, interruptores, «Quitar» en ventas: T-final-f y g) y un panel de notificaciones cortado en escritorio (T-final-b); la segunda pasada los dio por corregidos.

## 6. Cómo un rediseño completo no rompió los E2E (D6)

La fase 2 tocó **todas** las pantallas de R1 y las de 021. Aun así, los 88 E2E y los 2 de volumen pasaron **sin cambiar un selector**. La razón está en cómo los escribió la spec 018 (módulo [15](15-pruebas-e2e.md)): buscan por **rol, nombre accesible y texto**, y solo usan atributos `data-*` donde no hay nombre. `tests/e2e/soporte/selectores/compras.ts:16-26`:

```ts
/** La grilla de compras (`role="grid"`). */
export const grilla = (page: Page): Locator =>
  page.getByRole("grid", { name: "Compras del periodo" });

/** La fila de un comprobante («F001-3064») en la grilla. */
export const fila = (page: Page, comprobante: string): Locator =>
  grilla(page).getByRole("row").filter({ hasText: comprobante });

/** Todas las filas de compras (no los separadores de sección ni los encabezados). */
export const filasDeCompras = (page: Page): Locator =>
  grilla(page).locator("[data-fila]");
```

Ninguno dice «el `div` verde de la tercera columna». Por eso la regla 1 de la fase 2 (`tasks.md`) prohibía cambiar textos visibles, nombres accesibles, roles, `aria-*`, `data-*` (`data-fila`, `data-col`, `data-seccion-titulo`, `data-etiqueta`…), el `type` de los botones y el orden del DOM. Lo demás (clases, colores, márgenes) podía cambiar libremente.

Es la diferencia entre un auditor que busca «la factura F001-3064 de Ferretería X» y uno que busca «la tercera hoja amarilla del archivador». El primero sigue encontrándola aunque cambies el color de las hojas.

> **Una trampa de jsdom.** Las pruebas unitarias corren en jsdom, que **no aplica CSS**. Si para el celular duplicas un enlace («uno visible en escritorio, otro en celular»), jsdom ve los dos y `getByRole` falla por encontrar dos. La regla 2 de la fase 2 lo prohíbe: el menú cambia de disposición con CSS sobre el **mismo** elemento.

## 7. Dos fases para no pelear con 021 y 022

021 (reglas aprendidas) y 022 (rendimiento) estaban en curso cuando se aprobó 038, y tocaban las mismas pantallas: la grilla, la lupa, la barra masiva y el panel de generar archivo. Fusionar a mano dos ramas que cambian las mismas líneas por motivos distintos es una fuente segura de errores.

La decisión D2 partió el trabajo:

| Fase | Qué tocó | Cuándo |
|---|---|---|
| **1 · Base** | Solo archivos nuevos (`components/ui/`, `lib/utils.ts`, `components.json`) más `globals.css`, el `layout.tsx` raíz y las dependencias del frontend | En paralelo con 021 y 022: ninguna de las dos tocaba esos archivos (comprobado con `git diff --name-only`) |
| **2 · Pantallas** | Todas las pantallas de R1 y las nuevas de 021 | Después de que 021 y 022 estuvieran en `main` |

Dentro de la fase 2, T7 amplió primero la base; luego T8 a T17 fueron en paralelo, **cada una dueña de un grupo de archivos sin solapes** (marco, clientes, compras, ventas, trabajos…). Es como repartir el cierre entre asistentes por cliente y no por tipo de documento: nadie escribe en el libro de otro.

## 8. La prueba estática: colores solo con tokens

¿Cómo se asegura que nadie vuelva a escribir `text-red-600` o `#ff0000` en una pantalla? Con una prueba que lee los archivos. `apps/frontend/diseno.estatico.spec.ts:15-16`:

```ts
const COLOR_SUELTO =
  /(text|bg|border|ring|outline|divide|fill|stroke)-(red|green|blue|yellow|amber|gray|slate|zinc|neutral|stone|orange|emerald|sky|indigo|black|white)\b|#[0-9a-fA-F]{6}/;
```

Revisa `app/` y `components/`, **excepto** `components/ui/` (los componentes base, que sí usan `text-white` sobre `bg-primario`), las pruebas y `app/globals.css`, donde se definen los tokens (`diseno.estatico.spec.ts:35-47`). Además comprueba que revisó más de 70 archivos (`:63-71`): una prueba que no revisa nada pasaría siempre.

Es una **regla convertida en prueba**: la regla 4 de `tasks.md` era un `grep` que cada tarea debía correr a mano; T-final la volvió automática (CA-5).

## Práctica

**A. Pruebas del diseño y de los componentes base** (no necesitan BD ni Redis):

```bash
pnpm --filter @contapp/frontend test diseno.estatico components/ui
#  Test Files  2 passed (2)
#       Tests  22 passed (22)
```

**B. Calcular el contraste de los tokens** (fórmula de luminancia relativa de WCAG 2):

```bash
node -e '
const lum = (h) => { const c = [1,3,5].map(i => parseInt(h.slice(i, i+2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return ((x + 0.05) / (y + 0.05)).toFixed(2); };
console.log("tinta-suave / papel   ", ratio("#5e5e5e", "#f6f4ee"));
console.log("blanco / primario     ", ratio("#ffffff", "#0e4f55"));
console.log("error / error-fondo   ", ratio("#9a2c24", "#f9e1de"));
console.log("aviso / aviso-fondo   ", ratio("#7a4e00", "#fbf0d9"));
console.log("linea-control / hoja  ", ratio("#d9d6cf", "#ffffff"));'
# tinta-suave / papel    5.90
# blanco / primario      9.26
# error / error-fondo    6.11
# aviso / aviso-fondo    6.36
# linea-control / hoja   1.45
```

Los cuatro pares de texto pasan 4,5:1 (el plan anota 5,8:1 para `tinta-suave` sobre `papel`; con esta fórmula da 5,90). El último no es texto: es el borde gris de un campo sobre blanco, y da **1,45:1**, por debajo de los 3:1 que D5 pide para bordes de controles. La revisión T-final midió pares de **texto**; este punto queda como observación para quien retome la accesibilidad (ver ejercicio 5).

**C. Ver cómo `cn` resuelve conflictos** (desde `apps/frontend`, con las dependencias instaladas):

```bash
cd apps/frontend && node -e '
const { twMerge } = require("tailwind-merge"); const { clsx } = require("clsx");
const cn = (...c) => twMerge(clsx(c));
console.log(cn("h-10 px-4 bg-primario text-white", "bg-error"));
console.log(cn("rounded-control", false && "hidden", "rounded-tarjeta"));
console.log(cn("shadow-tarjeta", "shadow-flotante"));
console.log(cn("text-sm text-tinta", "text-tinta-suave"));'
# h-10 px-4 text-white bg-error
# rounded-control rounded-tarjeta
# shadow-flotante
# text-sm text-tinta-suave
```

Los colores y las sombras se resuelven (gana el último). Los **radios con nombre propio no**: `tailwind-merge` no sabe que `control` y `tarjeta` son radios, deja los dos y decide el orden del CSS generado. El plan ya avisaba que `cn` reconoce los tokens «si siguen los prefijos estándar».

**D. Comprobar que las fuentes son locales:**

```bash
cd apps/frontend && ls node_modules/@fontsource-variable/inter/files | wc -l
# 42
grep -rln "fonts.googleapis\|fonts.gstatic" app components lib | wc -l
# 0
```

## Impacto en ContApp

- La app tiene identidad propia y se lee mejor en jornadas largas: fondo papel, cifras alineadas, RUC y series en monoespaciada.
- Cambiar un color es cambiar una línea de `globals.css`; la prueba estática impide que aparezcan colores sueltos.
- El rediseño no cambió ningún comportamiento: las 999 pruebas del frontend y los 88 E2E pasaron sin tocar aserciones ni selectores.
- La accesibilidad quedó medida en 70 vistas, no supuesta.

## Errores comunes

- **«Pongo `text-red-600` para un error, es más rápido.»** La prueba estática falla. Usa `text-error` o el componente `Alert tono="error"`.
- **«Duplico el menú: uno para escritorio, otro para celular.»** Rompe `getByRole` en jsdom y duplica el contenido para lectores de pantalla. Mismo elemento, distinta disposición con CSS.
- **«Le cambio el texto al botón para que quepa en el celular.»** Cambia el nombre accesible y rompe los E2E (D6). Si no cabe, se ajusta el estilo, no el texto.
- **«Paso `className="rounded-tarjeta"` a un `Button` y no cambia.»** `cn` no reemplaza `rounded-control` por `rounded-tarjeta` (práctica C): quedan los dos y decide el orden del CSS.
- **«Agrego `outline-none` porque el anillo se ve feo.»** Sin foco visible, quien usa teclado no sabe dónde está. Si se quita, se reemplaza por `anilloFoco`.
- **«Activo el modo oscuro de Tailwind, es una línea.»** Sin paleta oscura propia y sin revisar contraste, vuelve el problema de antes (P-1, D4).

## Ejercicios

1. ¿Por qué los componentes de shadcn/ui se copian al repo en vez de instalarse como una dependencia más?
2. Un E2E busca el botón «Generar archivo» con `getByRole("button", { name: "Generar archivo" })`. La fase 2 lo pasó a `Button variant="primario"` y le cambió todas las clases. ¿Sigue pasando? ¿Qué lo rompería?
3. ¿Por qué la fase 1 se pudo hacer en paralelo con 021 y 022 y la fase 2 no?
4. ¿Por qué `diseno.estatico.spec.ts` exige haber revisado más de 70 archivos además de no encontrar colores sueltos?
5. `linea-control` sobre `hoja` da 1,45:1. ¿Qué regla de la spec no cumple ese par y por qué la revisión T-final no lo detectó?

<details><summary>Soluciones</summary>

1. Para que sean código propio: se leen, se adaptan a los tokens del estilo A y se prueban como cualquier archivo, sin una dependencia opaca (D1). Además el CLI de shadcn necesita red hacia su registro, y el plan prefirió no depender de ella.
2. Sigue pasando: el rol (`button`) y el nombre accesible («Generar archivo») no cambiaron. Lo rompería cambiar el texto, convertirlo en un `div` con `onClick` (pierde el rol) o dejarlo solo con ícono sin `aria-label` igual al texto anterior (regla 1 de la fase 2).
3. Porque la fase 1 solo agregó archivos nuevos y cambió `globals.css`, el `layout.tsx` raíz y las dependencias, que 021 y 022 no tocaban. La fase 2 tocaba las mismas pantallas que ellas (grilla, lupa, barra masiva, generar archivo) y habría obligado a fusionar a mano (D2).
4. Porque una prueba que revisa cero archivos (por ejemplo, tras mover carpetas) no encontraría colores sueltos y pasaría siempre. Comprobar que el conjunto no está vacío y que incluye `app/` y `components/compras/` evita ese falso verde.
5. D5 pide 3:1 en bordes de controles; 1,45:1 no llega. T-final calculó el contraste de pares de **texto** sobre colores computados (umbral 4,5 y 3 para texto grande), no de bordes, así que este par no entró en la medición. Es una observación para revisar, no un defecto registrado en la spec.

</details>

## Para profundizar

- Specs del proyecto: [038 spec](../specs/038-diseno-visual/spec.md), con su `plan.md` (tabla de tokens y componentes) y `tasks.md` (reglas comunes de la fase 2 y los resultados de T-final).
- Tailwind CSS 4, `@theme` y variables: <https://tailwindcss.com/docs/theme>
- shadcn/ui: <https://ui.shadcn.com/docs>
- class-variance-authority: <https://cva.style/docs>
- tailwind-merge: <https://github.com/dcastil/tailwind-merge>
- Radix Primitives: <https://www.radix-ui.com/primitives/docs/overview/introduction>
- Fontsource: <https://fontsource.org/docs/getting-started/introduction>
- WCAG 2.2, contraste mínimo (1.4.3) y contraste de elementos no textuales (1.4.11): <https://www.w3.org/TR/WCAG22/>
- Playwright, localizadores por rol: <https://playwright.dev/docs/locators>
