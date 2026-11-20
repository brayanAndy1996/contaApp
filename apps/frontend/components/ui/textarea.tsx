import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Área de texto del estilo A (spec 038): mismo borde, foco y error que `Input`. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full min-w-0 rounded-control border border-linea-control bg-hoja px-3 py-2 text-sm text-tinta placeholder:text-tinta-suave",
        "focus-visible:border-primario focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primario/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-error aria-invalid:ring-error/15",
        className,
      )}
      {...props}
    />
  );
}
