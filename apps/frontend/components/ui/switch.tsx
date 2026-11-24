import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { anilloFoco } from "./clases";

type Props = Omit<ComponentProps<"button">, "role" | "onChange" | "children"> & {
  checked: boolean;
  onCheckedChange?: (valor: boolean) => void;
};

/**
 * Interruptor del estilo A (spec 038), con `role="switch"` y `aria-checked`. Sin dependencias nuevas: es un botón con
 * la pista y la perilla dibujadas con tokens. Su nombre accesible sale de una `<label htmlFor>` o de `aria-label`.
 * El área táctil mide 44 px de alto (`min-h-11`).
 */
export function Switch({ checked, onCheckedChange, className, disabled, ...props }: Props) {
  return (
    <button
      type="button"
      role="switch"
      data-slot="switch"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-control disabled:cursor-not-allowed disabled:opacity-45",
        anilloFoco,
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-6 w-11 items-center rounded-full border border-linea-control p-0.5 transition-colors",
          checked ? "justify-end border-primario bg-primario" : "justify-start bg-neutro-fondo",
        )}
      >
        <span className="size-5 rounded-full bg-hoja shadow-tarjeta" />
      </span>
    </button>
  );
}
