import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Tarjeta del estilo A (spec 038): fondo blanco, borde suave y sombra de nivel 1. */
export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn("flex min-w-0 flex-col gap-4 rounded-tarjeta border border-linea bg-hoja p-6 shadow-tarjeta", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("m-0 font-titulo text-lg font-bold", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("m-0 text-sm text-tinta-suave", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("flex flex-col gap-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex flex-wrap items-center gap-2", className)} {...props} />;
}
