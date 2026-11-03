"use client";

import type { UsoPlanDto } from "@contapp/shared";
import { useEffect, useState } from "react";
import { MENSAJES_PLAN, cargarUso } from "../lib/planes";

// Indicador de uso del plan (spec 006, D7, D8, CA-10). Muestra lo que entrega GET /plan/uso: los
// límites los decide el backend. Sumar activos y pendientes es presentación (D7: ambos cuentan). Si la
// petición falla o el estudio no tiene plan (409 sin_plan), no pinta nada y la pantalla sigue igual.

const FORMATO_FECHA: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "America/Lima",
};

function fechaDePrueba(iso: string | null): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return new Date(iso).toLocaleDateString("es-PE", FORMATO_FECHA);
}

export function UsoPlan() {
  const [uso, setUso] = useState<UsoPlanDto | null>(null);

  useEffect(() => {
    let vigente = true;
    cargarUso()
      .then((datos) => {
        if (vigente) setUso(datos);
      })
      .catch(() => {
        if (vigente) setUso(null);
      });
    return () => {
      vigente = false;
    };
  }, []);

  if (!uso) return null;

  const { plan, estado, pruebaVenceEn, rucs, usuarios } = uso;
  const cuenta = usuarios.usados + usuarios.pendientes;
  const alcanzoRucs = rucs.libres <= 0;
  const alcanzoUsuarios = usuarios.limite !== null && cuenta >= usuarios.limite;
  const vence = estado === "prueba" ? fechaDePrueba(pruebaVenceEn) : null;
  const pendientes =
    usuarios.pendientes > 0
      ? ` (${usuarios.pendientes} ${usuarios.pendientes === 1 ? "pendiente" : "pendientes"})`
      : "";

  return (
    <section
      aria-label="Uso del plan"
      className="flex w-full max-w-xl flex-col gap-2 rounded border p-4 text-sm"
    >
      <p className="font-medium">
        Plan {plan.nombre}
        {estado === "prueba" &&
          ` · periodo de prueba${vence ? `, vence el ${vence}` : ""}`}
      </p>
      <p>
        RUCs: {rucs.usados} de {rucs.limite}
      </p>
      <p>
        Usuarios: {cuenta} de {usuarios.limite ?? "ilimitado"}
        {pendientes}
      </p>
      {(alcanzoRucs || alcanzoUsuarios) && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded bg-amber-50 p-3 text-amber-900"
        >
          {alcanzoRucs && <p>{MENSAJES_PLAN.limiteRucs}</p>}
          {alcanzoUsuarios && <p>{MENSAJES_PLAN.limiteUsuarios}</p>}
          <p>{MENSAJES_PLAN.subirDePlan}</p>
        </div>
      )}
    </section>
  );
}
