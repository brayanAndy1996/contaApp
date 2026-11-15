"use client";

import * as LabelPrimitive from "@radix-ui/react-label";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Etiqueta de campo (spec 038). */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("flex flex-col gap-1.5 text-[13px] font-semibold text-tinta-media", className)}
      {...props}
    />
  );
}
