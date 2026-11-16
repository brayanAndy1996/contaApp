import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Chip de estado (spec 038). Siempre lleva texto: el color nunca es la única señal (D5). */
export const badgeVariants = cva(
  "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold [&_svg]:size-3",
  {
    variants: {
      tono: {
        neutro: "bg-neutro-fondo text-tinta-media",
        primario: "bg-primario text-white",
        ok: "bg-ok-fondo text-ok",
        info: "bg-info-fondo text-info",
        aviso: "bg-aviso-fondo text-aviso",
        error: "bg-error-fondo text-error",
      },
    },
    defaultVariants: { tono: "neutro" },
  },
);

export function Badge({ className, tono, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tono }), className)} {...props} />;
}
