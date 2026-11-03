"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePuede } from "../lib/acceso";
import { api } from "../lib/api";

// Primeros pasos del estudio (spec 006, Ratificaciones de T4): la tarjeta sale cuando GET /clientes
// devuelve lista vacía. Cada enlace depende de su permiso (solo oculta: el backend valida). Mientras
// cargan los permisos o si la carga de clientes falla o hay clientes, no aparece nada.

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
    <section
      aria-labelledby="primeros-pasos"
      className="flex w-full max-w-xl flex-col gap-2 rounded border p-4 text-sm"
    >
      <h2 id="primeros-pasos" className="text-base font-medium">
        Primeros pasos
      </h2>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {puedeClientes && (
          <li>
            <Link href="/clientes" className="underline">
              Agrega tu primer cliente
            </Link>
          </li>
        )}
        {puedeEquipo && (
          <li>
            <Link href="/usuarios" className="underline">
              Invita a tu equipo
            </Link>
          </li>
        )}
      </ul>
    </section>
  );
}
