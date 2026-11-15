import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Tabla del estilo A (spec 038). Va dentro de un contenedor con desplazamiento horizontal propio. */
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("bg-hoja-alterna", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn(className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("font-bold", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-neutro-fondo hover:bg-hoja-alterna data-[state=selected]:bg-primario-suave/40", className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn("whitespace-nowrap border-b border-linea px-3 py-2.5 text-left text-xs font-semibold text-tinta-suave", className)}
      {...props}
    />
  );
}

/** `numerico`: alinea a la derecha con dígitos de igual ancho (montos, D7). */
export function TableCell({ className, numerico = false, ...props }: ComponentProps<"td"> & { numerico?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-3 py-3 align-middle", numerico && "cifras whitespace-nowrap text-right", className)}
      {...props}
    />
  );
}
