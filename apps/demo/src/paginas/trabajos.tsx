import { useState } from "react";
import { useDemo } from "../estado/store";
import { Encabezado, Insignia, Tarjeta, Vacio, fechaCorta } from "../ui/comunes";

const TONO = { en_cola: "gris", ejecutando: "azul", completado: "verde", fallido: "rojo" } as const;
const TEXTO = { en_cola: "En cola", ejecutando: "Ejecutando", completado: "Completado", fallido: "Fallido" } as const;

export function Trabajos() {
  const { estado } = useDemo();
  return (
    <>
      <Encabezado titulo="Trabajos en segundo plano" subtitulo="Lo que en el producto ejecuta el worker con BullMQ: descargas SIRE, XML, verificación de credenciales, buzones y envíos. Aquí se simula con tiempos de espera." />
      <Tarjeta>
        {estado.trabajos.length === 0 ? (
          <Vacio titulo="Sin trabajos todavía" icono="⚙">Descarga una propuesta SIRE o verifica una credencial para verlos aquí.</Vacio>
        ) : (
          <ul className="divide-y divide-slate-100">
            {estado.trabajos.map((t) => (
              <li key={t.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-800">{t.tipo}</span>
                  <Insignia tono={TONO[t.estado]}>{TEXTO[t.estado]}</Insignia>
                  {t.cliente && <span className="text-xs text-slate-500">{t.cliente}</span>}
                  <span className="ml-auto text-xs text-slate-400">{fechaCorta(t.inicio)}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full transition-all ${t.estado === "fallido" ? "bg-red-500" : t.estado === "completado" ? "bg-emerald-500" : "bg-sky-500"}`} style={{ width: `${(t.paso / t.pasos.length) * 100}%` }} />
                </div>
                <div className="mt-1 text-xs text-slate-500">{t.detalle ?? t.pasos[Math.min(t.paso, t.pasos.length - 1)]}</div>
              </li>
            ))}
          </ul>
        )}
      </Tarjeta>
    </>
  );
}

export function TrabajosFlotantes() {
  const { estado } = useDemo();
  const [oculto, setOculto] = useState(false);
  const activos = estado.trabajos.filter((t) => t.estado === "ejecutando" || t.estado === "en_cola");
  if (activos.length === 0 || oculto) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-700">
        <span>⟳ {activos.length} trabajo(s) en curso</span>
        <button className="text-slate-400 hover:text-slate-700" onClick={() => setOculto(true)}>✕</button>
      </div>
      {activos.map((t) => (
        <div key={t.id} className="mb-2 last:mb-0">
          <div className="truncate text-xs text-slate-700">{t.tipo} {t.cliente && <span className="text-slate-400">· {t.cliente}</span>}</div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-sky-500 transition-all duration-500" style={{ width: `${(t.paso / t.pasos.length) * 100}%` }} />
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500">{t.pasos[Math.min(t.paso, t.pasos.length - 1)]}</div>
        </div>
      ))}
    </div>
  );
}
