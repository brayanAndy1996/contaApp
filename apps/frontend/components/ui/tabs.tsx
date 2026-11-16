"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Pestañas del estilo A (spec 038): subrayado verde en la activa; flechas para recorrerlas (Radix). */
export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-4", className)} {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex flex-wrap gap-1 border-b border-linea", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "-mb-px inline-flex h-10 cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-3.5 text-sm font-semibold text-tinta-suave",
        "hover:text-tinta data-[state=active]:border-primario data-[state=active]:text-primario",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("min-w-0", className)} {...props} />;
}
