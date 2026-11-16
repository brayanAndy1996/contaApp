"use client";

import { ReglasMotor } from "../../../../components/reglas/reglas-motor";
import { MENSAJES_REGLAS as M } from "../../../../lib/reglas";

// Reglas del motor del estudio (spec 021, CA-8, P-8, P-10; RF-089). Solo un Dueño o Administrador con alcance global
// puede cambiarlas; el resto las ve deshabilitadas. El backend valida.

export default function PaginaReglasMotor() {
  return (
    <main className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-xl font-semibold">{M.tituloReglasMotor}</h1>
      <ReglasMotor />
    </main>
  );
}
