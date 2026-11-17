"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePuede } from "../lib/acceso";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Card, CardTitle, enlace } from "./ui";

// Primeros pasos del estudio (spec 006, Ratificaciones de T4): la tarjeta sale cuando GET /clientes
// devuelve lista vacía. Cada enlace depende de su permiso (solo oculta: el backend valida). Mientras
// cargan los permisos o si la carga de clientes falla o hay clientes, no aparece nada.

const ENLACE = cn(
  enlace,
  "max-lg:inline-flex max-lg:min-h-11 max-lg:items-center",
);

export function PrimerosPasos() {
  const puedeClientes = usePuede("clientes.ver");
  const puedeEquipo = usePuede("usuarios.gestionar");
  const [sinClientes, setSinClientes] = useState(false);

  useEffect(() => {
    let vigente = true;
    api<unknown[]>("/clientes")
      .then((r) => {
        if (vigente && r.ok && Array.isArray(r.datos) && r.datos.length === 0) {
          setSinClientes(true);
        }
      })
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, []);

  const cargando = puedeClientes === undefined || puedeEquipo === undefined;
  if (!sinClientes || cargando || (!puedeClientes && !puedeEquipo)) return null;

  return (
    <Card
      aria-labelledby="primeros-pasos"
      className="w-full max-w-xl gap-3 text-sm"
    >
      <CardTitle id="primeros-pasos">Primeros pasos</CardTitle>
      <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-tinta-suave">
        {puedeClientes && (
          <li>
            <Link href="/clientes" className={ENLACE}>
              Agrega tu primer cliente
            </Link>
          </li>
        )}
        {puedeEquipo && (
          <li>
            <Link href="/usuarios" className={ENLACE}>
              Invita a tu equipo
            </Link>
          </li>
        )}
      </ul>
    </Card>
  );
}
