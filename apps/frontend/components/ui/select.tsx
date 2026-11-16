import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** `<select>` nativo con el estilo A (spec 038): accesible por defecto y sin dependencias. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-10 w-full min-w-0 rounded-control border border-linea-control bg-hoja px-3 text-sm text-tinta",
        "focus-visible:border-primario focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primario/20",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-error",
        className,
      )}
      {...props}
    />
  );
}
