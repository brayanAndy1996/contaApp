import { useEffect, useState } from "react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------- enrutador por hash
export function useRuta(): string[] {
  const leer = () => window.location.hash.replace(/^#\/?/, "").split("?")[0]!.split("/").filter(Boolean);
  const [ruta, setRuta] = useState<string[]>(leer);
  useEffect(() => {
    const f = () => {
      setRuta(leer());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return ruta;
}

export function ir(ruta: string) {
  window.location.hash = ruta.startsWith("#") ? ruta : `#${ruta}`;
}

// ---------------------------------------------------------------- formato (sin number para dinero)
/** "12345.60" → "12,345.60" con manipulación de texto. */
export function soles(v: string, simbolo = true): string {
  const neg = v.startsWith("-");
  const [ent, dec = "00"] = (neg ? v.slice(1) : v).split(".");
  const conMiles = ent!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${simbolo ? "S/ " : ""}${conMiles}.${dec.padEnd(2, "0")}`;
}

export function periodoTexto(p: string): string {
  const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Setiembre", "Octubre", "Noviembre", "Diciembre"];
  return `${meses[Number(p.slice(4)) - 1]} ${p.slice(0, 4)}`;
}

export function fechaCorta(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("es-PE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function fechaDoc(f: string): string {
  const [a, m, d] = f.split("-");
  return `${d}/${m}/${a}`;
}

// ---------------------------------------------------------------- componentes
type Variante = "primario" | "secundario" | "peligro" | "fantasma" | "exito";

const VARIANTES: Record<Variante, string> = {
  primario: "bg-teal-700 text-white hover:bg-teal-800 shadow-sm",
  secundario: "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 shadow-sm",
  peligro: "bg-white text-red-700 border border-red-200 hover:bg-red-50",
  fantasma: "text-slate-600 hover:bg-slate-100",
  exito: "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm",
};

export function Boton({
  children,
  variante = "secundario",
  chico,
  className = "",
  ...props
}: { children: ReactNode; variante?: Variante; chico?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${chico ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm"} ${VARIANTES[variante]} ${className}`}
    >
      {children}
    </button>
  );
}

const TONOS = {
  gris: "bg-slate-100 text-slate-700 ring-slate-200",
  verde: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  rojo: "bg-red-50 text-red-700 ring-red-200",
  ambar: "bg-amber-50 text-amber-800 ring-amber-200",
  azul: "bg-sky-50 text-sky-700 ring-sky-200",
  violeta: "bg-violet-50 text-violet-700 ring-violet-200",
  teal: "bg-teal-50 text-teal-700 ring-teal-200",
};
export type Tono = keyof typeof TONOS;

export function Insignia({ children, tono = "gris", title }: { children: ReactNode; tono?: Tono; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${TONOS[tono]}`}>
      {children}
    </span>
  );
}

export function Tarjeta({ children, className = "", titulo, accion }: { children: ReactNode; className?: string; titulo?: ReactNode; accion?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {titulo && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">{titulo}</h3>
          {accion}
        </header>
      )}
      {children}
    </section>
  );
}

export function Modal({ abierto, alCerrar, titulo, children, ancho = "max-w-lg", pie }: { abierto: boolean; alCerrar: () => void; titulo: ReactNode; children: ReactNode; ancho?: string; pie?: ReactNode }) {
  useEffect(() => {
    if (!abierto) return;
    const f = (e: KeyboardEvent) => e.key === "Escape" && alCerrar();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [abierto, alCerrar]);
  if (!abierto) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && alCerrar()}>
      <div className={`my-auto w-full ${ancho} rounded-xl bg-white shadow-2xl`}>
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-3.5">
          <div className="min-w-0 flex-1">{typeof titulo === "string" ? <h2 className="text-base font-semibold text-slate-900">{titulo}</h2> : titulo}</div>
          <button onClick={alCerrar} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Cerrar">
            ✕
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {pie && <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 rounded-b-xl">{pie}</footer>}
      </div>
    </div>
  );
}

export function Campo({ etiqueta, children, ayuda }: { etiqueta: string; children: ReactNode; ayuda?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{etiqueta}</span>
      {children}
      {ayuda && <span className="text-xs text-slate-500">{ayuda}</span>}
    </label>
  );
}

export const claseInput = "rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20";

export function Vacio({ titulo, children, icono = "📭" }: { titulo: string; children?: ReactNode; icono?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="text-3xl">{icono}</div>
      <div className="font-semibold text-slate-800">{titulo}</div>
      {children && <div className="max-w-md text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Encabezado({ titulo, subtitulo, acciones, migas }: { titulo: ReactNode; subtitulo?: ReactNode; acciones?: ReactNode; migas?: { texto: string; ruta?: string }[] }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {migas && (
          <nav className="mb-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
            {migas.map((m, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span>/</span>}
                {m.ruta ? (
                  <a href={`#${m.ruta}`} className="hover:text-teal-700 hover:underline">
                    {m.texto}
                  </a>
                ) : (
                  <span>{m.texto}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{titulo}</h1>
        {subtitulo && <p className="mt-1 text-sm text-slate-500">{subtitulo}</p>}
      </div>
      {acciones && <div className="flex flex-wrap gap-2">{acciones}</div>}
    </div>
  );
}

export function Kpi({ etiqueta, valor, nota, tono }: { etiqueta: string; valor: ReactNode; nota?: ReactNode; tono?: "rojo" | "verde" | "ambar" }) {
  const color = tono === "rojo" ? "text-red-700" : tono === "verde" ? "text-emerald-700" : tono === "ambar" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{etiqueta}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{valor}</div>
      {nota && <div className="mt-1 text-xs text-slate-500">{nota}</div>}
    </div>
  );
}

export function Pestanas({ items, activa }: { items: { id: string; texto: ReactNode; ruta: string }[]; activa: string }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {items.map((t) => (
        <a
          key={t.id}
          href={`#${t.ruta}`}
          className={`-mb-px whitespace-nowrap border-b-2 px-3.5 py-2 text-sm font-medium ${t.id === activa ? "border-teal-700 text-teal-800" : "border-transparent text-slate-500 hover:text-slate-800"}`}
        >
          {t.texto}
        </a>
      ))}
    </div>
  );
}

export function Aviso({ tono = "azul", children, titulo }: { tono?: "azul" | "ambar" | "rojo" | "verde"; children: ReactNode; titulo?: ReactNode }) {
  const c = {
    azul: "border-sky-200 bg-sky-50 text-sky-900",
    ambar: "border-amber-200 bg-amber-50 text-amber-900",
    rojo: "border-red-200 bg-red-50 text-red-900",
    verde: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tono];
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${c}`}>
      {titulo && <div className="mb-0.5 font-semibold">{titulo}</div>}
      {children}
    </div>
  );
}
