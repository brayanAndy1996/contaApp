"use client";

import { useEffect, useState } from "react";
import { MENSAJES_PLAN, cargarUso, type ResultadoUso } from "../lib/planes";
import { MENSAJES_REGISTRO } from "../lib/registro";

// Indicador de uso del plan (spec 006, D7, D8, D14, CA-10). Muestra lo que entrega GET /plan/uso: los
// límites los decide el backend. Sumar activos y pendientes es presentación (D7: ambos cuentan). Si la
// petición falla, no pinta nada y la pantalla sigue igual. Con 409 sin_plan (estudio sin suscripción, D14) muestra
// el aviso de sin plan en lugar de la región de uso.

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
  const [resultado, setResultado] = useState<ResultadoUso | null>(null);

  useEffect(() => {
    let vigente = true;
    cargarUso()
      .then((r) => {
        if (vigente) setResultado(r);
      })
      .catch(() => {
        if (vigente) setResultado({ estado: "sin_datos" });
      });
    return () => {
      vigente = false;
    };
  }, []);

  if (!resultado || resultado.estado === "sin_datos") return null;

  if (resultado.estado === "sin_plan") {
    return (
      <div
        role="status"
        className="w-full max-w-xl rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
      >
        <p>{MENSAJES_REGISTRO.sinPlan}</p>
      </div>
    );
  }

  const { plan, estado, pruebaVenceEn, rucs, usuarios } = resultado.uso;
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
