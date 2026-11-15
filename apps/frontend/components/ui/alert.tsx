import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * Alerta del estilo A (spec 038). `aviso` y `error` usan `role="alert"` (se anuncian enseguida);
 * `ok` e `info`, `role="status"` (se anuncian sin interrumpir).
 */
export const alertVariants = cva(
  "flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3 text-[13.5px] [&>svg]:mt-0.5 [&>svg]:size-[18px] [&>svg]:shrink-0",
  {
    variants: {
      tono: {
        ok: "border-ok-borde bg-ok-fondo text-ok",
        info: "border-info-borde bg-info-fondo text-info",
        aviso: "border-aviso-borde bg-aviso-fondo text-aviso",
        error: "border-error-borde bg-error-fondo text-error",
      },
    },
    defaultVariants: { tono: "info" },
  },
);

type Tono = NonNullable<VariantProps<typeof alertVariants>["tono"]>;

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

export function AlertTitle({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="alert-title" className={cn("m-0 font-bold", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("[&_p]:m-0", className)} {...props} />;
}
