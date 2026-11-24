"use client";

import { GastosEstudio } from "../../../../components/gastos/gastos-estudio";
import { ReglasMotor } from "../../../../components/reglas/reglas-motor";
import { EncabezadoPagina } from "../../../../components/ui";
import { MENSAJES_REGLAS as M } from "../../../../lib/reglas";

// Reglas del motor del estudio (spec 021, CA-8, P-8, P-10; RF-089). Solo un Dueño o Administrador con alcance global
// puede cambiarlas; el resto las ve deshabilitadas. El backend valida. Spec 027: debajo de los interruptores, la sección
// «Gastos no deducibles» (umbral y diccionario del estudio).

export default function PaginaReglasMotor() {
  return (
    <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <EncabezadoPagina titulo={M.tituloReglasMotor} />
      <ReglasMotor />
      <GastosEstudio />
    </main>
  );
}
