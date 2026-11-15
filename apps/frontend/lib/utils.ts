import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Une clases de Tailwind y resuelve conflictos (la última gana): base de los componentes de `components/ui` (spec 038). */
export function cn(...clases: ClassValue[]): string {
  return twMerge(clsx(clases));
}
