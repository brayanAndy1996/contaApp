# Plan 038 · Diseño visual (estilo A)

## Tokens del estilo A

Definidos en `apps/frontend/app/globals.css` con `@theme` de Tailwind 4, de modo que generan utilidades (`bg-primario`, `text-tinta-suave`, `rounded-tarjeta`…). Nombres en español, como el dominio.

| Token | Valor | Uso |
|---|---|---|
| `--color-primario` | `#0E4F55` | Acción principal, enlaces, foco, pestaña activa |
| `--color-primario-hover` | `#0B4247` | Hover del principal |
| `--color-primario-activo` | `#082F33` | Pulsado |
| `--color-primario-suave` | `#DCE9E9` | Fondo de ítem activo del menú, selección |
| `--color-papel` | `#F6F4EE` | Fondo de la app |
| `--color-hoja` | `#FFFFFF` | Tarjetas, tablas, diálogos |
| `--color-hoja-alterna` | `#FAF9F5` | Cabecera de tabla, menú lateral (`#FBFAF7`) |
| `--color-linea` | `#E4E1DA` | Bordes de tarjeta y separadores |
| `--color-linea-control` | `#D9D6CF` | Bordes de campos y botones secundarios |
| `--color-tinta` | `#1C1C1C` | Texto principal (gris 900) |
| `--color-tinta-media` | `#3D3D3D` | Etiquetas (gris 700) |
| `--color-tinta-suave` | `#5E5E5E` | Texto secundario; contraste 5.8:1 sobre papel |
| `--color-neutro-fondo` | `#EDEBE6` | Chip neutro, hover |
| `--color-ok` / `--color-ok-fondo` / `--color-ok-borde` | `#1F5E2E` / `#E3F1E5` / `#A9D3B1` | Éxito, «Verificada», «Abierto» |
| `--color-info` / `--color-info-fondo` / `--color-info-borde` | `#24527A` / `#E3EEF8` / `#B9D2EA` | Información, R-NEW |
| `--color-aviso` / `--color-aviso-fondo` / `--color-aviso-borde` | `#7A4E00` / `#FBF0D9` / `#E7C98E` | Avisos que no bloquean, «Sin responsable», R-MIX |
| `--color-error` / `--color-error-fondo` / `--color-error-borde` | `#9A2C24` / `#F9E1DE` / `#E8B4AE` | Errores que bloquean, «Inválida», R-GP |
| `--font-sans` | Inter | Texto |
| `--font-titulo` | Inter Tight 800 | Títulos de página (40 px escritorio, 34 px celular, `letter-spacing: -0.03em`) |
| `--font-mono` | JetBrains Mono | RUC, serie-número, huellas SHA-256 |
| `--radius-control` / `--radius-tarjeta` / `--radius-dialogo` | 8 px / 16 px / 20 px | |
| `--shadow-tarjeta` / `--shadow-flotante` / `--shadow-dialogo` | suaves, ver CSS | Niveles 1, 2 y 4 de la guía |

Todos los pares texto/fondo de la tabla cumplen AA (4.5:1).

## Componentes (`apps/frontend/components/ui/`)

Copias de shadcn/ui adaptadas a los tokens (no se usa el CLI: requiere red hacia su registro). Cada uno exporta su componente y, si tiene variantes, su función `cva`.

| Archivo | Exporta | Variantes / notas |
|---|---|---|
| `button.tsx` | `Button`, `buttonVariants` | `variant`: `primario` (defecto), `secundario`, `terciario`, `peligro`; `size`: `md` (40 px), `sm` (32 px), `lg` (48 px), `icono`; `asChild` con `@radix-ui/react-slot` |
| `input.tsx` | `Input` | `aria-invalid` pinta el borde de error |
| `label.tsx` | `Label` | `@radix-ui/react-label` |
| `select.tsx` | `Select` | `<select>` nativo estilado (accesible y simple; el de Radix no hace falta) |
| `badge.tsx` | `Badge`, `badgeVariants` | `tono`: `neutro`, `primario`, `ok`, `info`, `aviso`, `error`; con texto siempre |
| `alert.tsx` | `Alert`, `AlertTitle`, `AlertDescription` | `tono`: `ok`, `info`, `aviso`, `error`; `role="alert"` solo en `error` y `aviso`, `role="status"` en el resto |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | |
| `table.tsx` | `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell` | contenedor con `overflow-x: auto`; `TableCell` con prop `numerico` (alineado a la derecha, tabular) |
| `tabs.tsx` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `@radix-ui/react-tabs`; subrayado verde en la activa |
| `dialog.tsx` | `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose` | `@radix-ui/react-dialog`; botón cerrar con `aria-label="Cerrar"` |
| `dropdown-menu.tsx` | `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuSeparator`, `DropdownMenuLabel` | `@radix-ui/react-dropdown-menu` |

`lib/utils.ts` exporta `cn(...clases)` (`clsx` + `tailwind-merge`). `components.json` deja configurado shadcn para quien quiera agregar más componentes con el CLI más adelante.

## Orden de bloqueo con otras specs
- Fase 1: no toca archivos de 021 ni de 022 (comprobado con `git diff --name-only origin/main...origin/spec/021-reglas-aprendidas` y lo mismo con 022, 2026-11-15). Comparte con ellas `pnpm-lock.yaml` solo si alguna agrega dependencias antes de fusionarse; hoy ninguna lo hace.
- Fase 2: se planifica pantalla por pantalla al desbloquearse, partiendo de `main` con 021 y 022 ya dentro.

## Riesgos
- **Los E2E y las pruebas unitarias buscan por rol, nombre y texto**: la fase 2 conserva esos contratos (D6). Si una prueba tiene que cambiar, es señal de que se cambió comportamiento y se revisa.
- **Tailwind 4 y `tailwind-merge` 3**: `cn` reconoce las utilidades generadas por los tokens de `@theme` si siguen los prefijos estándar (`bg-`, `text-`, `border-`, `rounded-`, `shadow-`).
