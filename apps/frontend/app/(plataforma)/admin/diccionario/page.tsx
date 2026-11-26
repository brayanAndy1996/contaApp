"use client";

import Link from "next/link";
import { DiccionarioGlobal } from "../../../../components/gastos/diccionario-global";
import { Button, EncabezadoPagina } from "../../../../components/ui";
import { MENSAJES } from "../../../../lib/acceso";
import { MENSAJES_GASTOS as M } from "../../../../lib/gastos";
import { useAccesoPlataforma } from "../../../../lib/plataforma";

// Diccionario global de gastos no deducibles (spec 027, R-6, D-2, D-3): pantalla del super-admin de plataforma. Sin acceso
// (403 de /plataforma/yo) solo se muestra el aviso: ni formulario, ni datos, ni acciones. El servidor valida cada cambio.

export default function AdminDiccionario() {
  const acceso = useAccesoPlataforma();

  if (acceso === undefined) return <main className="p-4 text-tinta-suave sm:p-6">{M.cargandoPagina}</main>;
  if (acceso !== "admin") {
    return (
      <main className="p-4 sm:p-6">
        <p className="m-0 text-tinta-media">{acceso === "sin_permiso" ? MENSAJES.sinPermiso : MENSAJES.errorGeneral}</p>
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
      <EncabezadoPagina
        titulo={M.tituloPaginaDiccionario}
        acciones={
          <nav>
            <Button asChild variant="secundario" className="max-lg:h-11">
              <Link href="/admin">{M.enlaceEstudios}</Link>
            </Button>
          </nav>
        }
      />
      <DiccionarioGlobal />
    </main>
  );
}
