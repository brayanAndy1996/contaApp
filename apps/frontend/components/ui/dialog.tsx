"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { panelDialogo, velo } from "./clases";

/**
 * Diálogo del estilo A (spec 038), sobre Radix: atrapa el foco, se cierra con Esc y devuelve el foco
 * al control que lo abrió.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  mostrarCerrar = true,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { mostrarCerrar?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className={velo} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(panelDialogo, className)}
        {...props}
      >
        {children}
        {mostrarCerrar ? (
          <DialogPrimitive.Close
            aria-label="Cerrar"
            className="absolute right-4 top-4 grid size-9 cursor-pointer place-items-center rounded-control text-tinta-suave hover:bg-neutro-fondo hover:text-tinta"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1 pr-8", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("m-0 font-titulo text-xl font-extrabold tracking-tight", className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description data-slot="dialog-description" className={cn("m-0 text-sm text-tinta-suave", className)} {...props} />
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex flex-wrap justify-end gap-2", className)} {...props} />;
}
