import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Campo de texto del estilo A (spec 038). Con `aria-invalid` se pinta el borde de error. */
export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-control border border-linea-control bg-hoja px-3 text-sm text-tinta placeholder:text-tinta-suave",
        "focus-visible:border-primario focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primario/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-error aria-invalid:ring-error/15",
        className,
      )}
      {...props}
    />
  );
}
