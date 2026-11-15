"use client";

import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Menú desplegable del estilo A (spec 038), sobre Radix: se abre y recorre con teclado. */
export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn("z-50 min-w-48 rounded-control border border-linea bg-hoja p-1 text-sm text-tinta shadow-flotante", className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  peligro = false,
  ...props
}: ComponentProps<typeof MenuPrimitive.Item> & { peligro?: boolean }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-2.5 py-2 outline-none",
        "data-[highlighted]:bg-neutro-fondo data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        peligro && "text-error",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label data-slot="dropdown-menu-label" className={cn("px-2.5 py-1.5 text-xs font-semibold text-tinta-suave", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn("my-1 h-px bg-linea", className)} {...props} />;
}
