import { cn } from "../../lib/utils";
import { anilloFoco } from "../ui";

// Estilo común de las entradas del menú (spec 038): lo usan los enlaces del menú y la campana, para que se vean igual
// (alto, alineación, hover y foco).

/** Entrada de la barra inferior: ícono sobre texto en celular; fila en el menú lateral. */
export const entradaBarra = cn(
  "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-tinta-media hover:bg-neutro-fondo",
  "max-lg:min-w-11 max-lg:flex-1 max-lg:flex-col max-lg:justify-center max-lg:gap-0.5 max-lg:px-1 max-lg:text-xs",
  anilloFoco,
);

/** Entrada del grupo secundario («Más» en celular): siempre en fila. */
export const entradaGrupo = cn(
  "flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-sm font-semibold text-tinta-media hover:bg-neutro-fondo",
  anilloFoco,
);
