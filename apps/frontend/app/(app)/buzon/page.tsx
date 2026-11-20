"use client";

import { Suspense } from "react";
import { Bandeja } from "../../../components/buzon/bandeja";
import { MENSAJES_BUZON as M } from "../../../lib/buzon";

// Bandeja de buzones del estudio (spec 024, D-2, D-10): los mensajes de todos los clientes que la persona ve. El permiso
// (`buzon.ver`) y el alcance los valida el backend; el menú solo oculta la entrada. Los filtros viven en la URL, así que
// `useSearchParams()` pide un límite de Suspense.

export default function Pagina() {
  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <Suspense fallback={<p className="m-0 text-sm text-tinta-suave">{M.cargando}</p>}>
        <Bandeja />
      </Suspense>
    </main>
  );
}
