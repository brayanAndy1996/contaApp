import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Botón del estilo A (spec 038). `asChild` lo convierte en el elemento hijo, por ejemplo un enlace. */
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

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

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
