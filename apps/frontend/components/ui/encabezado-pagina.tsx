import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

type Props = Omit<ComponentProps<"header">, "title"> & {
  /** Contenido del único `h1` de la pantalla: reemplaza al `h1` que ya tenía, no agrega otro. */
  titulo: ReactNode;
  descripcion?: ReactNode;
  /** Zona de acciones (botones, enlaces) a la derecha en escritorio y debajo en celular. */
  acciones?: ReactNode;
};

/** Encabezado de página del estilo A (spec 038): título 40 px (34 px en celular), descripción y acciones. */
export function EncabezadoPagina({ titulo, descripcion, acciones, className, ...props }: Props) {
  return (
    <header
      data-slot="encabezado-pagina"
      className={cn("flex flex-col gap-4 md:flex-row md:items-end md:justify-between", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="m-0 font-titulo text-[34px] font-extrabold leading-tight tracking-tight text-tinta md:text-[40px]">{titulo}</h1>
        {descripcion ? <p className="m-0 text-sm text-tinta-suave">{descripcion}</p> : null}
      </div>
      {acciones ? (
        <div data-slot="encabezado-pagina-acciones" className="flex flex-wrap items-center gap-2">
          {acciones}
        </div>
      ) : null}
    </header>
  );
}
