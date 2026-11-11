import type { Autor as AutorDto } from "@contapp/shared";
import { etiquetaAutor } from "../lib/autor";

// Autor con nombre (spec 017, D-12; CA-13). Siempre como texto de React: un nombre con `<script>` se ve literal.

export function Autor({ autor }: { autor: AutorDto | null | undefined }) {
  return <span data-autor>{etiquetaAutor(autor)}</span>;
}
