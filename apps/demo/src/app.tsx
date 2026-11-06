import { useState } from "react";
import type { ReactNode } from "react";
import { ESTUDIO, PERMISOS_ROL } from "./datos/semilla";
import { useDemo } from "./estado/store";
import { Auditoria } from "./paginas/auditoria";
import { Buzones } from "./paginas/buzones";
import { ClienteDetalle } from "./paginas/cliente-detalle";
import { ClienteImportar } from "./paginas/cliente-importar";
import { ClienteNuevo } from "./paginas/cliente-nuevo";
import { Clientes } from "./paginas/clientes";
import { Guia } from "./paginas/guia";
import { Login } from "./paginas/login";
import { Panel } from "./paginas/panel";
import { Periodo } from "./paginas/periodo";
import { Prorrata } from "./paginas/prorrata";
import { Trabajos, TrabajosFlotantes } from "./paginas/trabajos";
import { Usuarios } from "./paginas/usuarios";
import { Boton, fechaCorta, ir, useRuta } from "./ui/comunes";

const MENU: { ruta: string; texto: string; icono: string; seccion?: string; r2?: boolean }[] = [
  { ruta: "", texto: "Panel", icono: "▦" },
  { ruta: "clientes", texto: "Clientes", icono: "🏢" },
  { ruta: "trabajos", texto: "Trabajos", icono: "⚙" },
  { ruta: "buzones", texto: "Buzones SOL", icono: "✉", r2: true },
  { ruta: "prorrata", texto: "Prorrata e IGV", icono: "％", r2: true },
  { ruta: "auditoria", texto: "Auditoría", icono: "🛡" },
  { ruta: "usuarios", texto: "Usuarios y plan", icono: "👥" },
  { ruta: "guia", texto: "Guía de la demo", icono: "❓" },
];

function Rutas({ ruta }: { ruta: string[] }) {
  const [a, b, c] = ruta;
  if (!a) return <Panel />;
  if (a === "clientes") {
    if (!b) return <Clientes />;
    if (b === "nuevo") return <ClienteNuevo />;
    if (b === "importar") return <ClienteImportar />;
    if (c === "ventas" || c === "compras" || c === "generar") return <Periodo clienteId={b} vista={c} />;
    return <ClienteDetalle clienteId={b} />;
  }
  if (a === "trabajos") return <Trabajos />;
  if (a === "buzones") return <Buzones />;
  if (a === "prorrata") return <Prorrata clienteId={b} />;
  if (a === "auditoria") return <Auditoria />;
  if (a === "usuarios") return <Usuarios />;
  if (a === "guia") return <Guia />;
  return <Panel />;
}

function Campana() {
  const { estado, marcarNotificacionesLeidas } = useDemo();
  const [abierto, setAbierto] = useState(false);
  const sinLeer = estado.notificaciones.filter((n) => !n.leida).length;
  return (
    <div className="relative">
      <button
        onClick={() => {
          setAbierto(!abierto);
          if (!abierto) setTimeout(marcarNotificacionesLeidas, 1500);
        }}
        className="relative rounded-md p-2 text-slate-600 hover:bg-slate-100"
        aria-label="Notificaciones"
      >
        🔔
        {sinLeer > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{sinLeer}</span>}
      </button>
      {abierto && (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-xl" onMouseLeave={() => setAbierto(false)}>
          <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold">Notificaciones</div>
          <ul className="max-h-96 overflow-y-auto">
            {estado.notificaciones.length === 0 && <li className="px-4 py-6 text-center text-sm text-slate-500">Sin notificaciones</li>}
            {estado.notificaciones.map((n) => (
              <li key={n.id}>
                <a href={n.enlace ?? "#/"} onClick={() => setAbierto(false)} className={`flex gap-2 border-b border-slate-50 px-4 py-2.5 text-sm hover:bg-slate-50 ${n.leida ? "text-slate-500" : "text-slate-800"}`}>
                  <span>{n.tipo === "alerta" ? "⚠️" : n.tipo === "exito" ? "✅" : "ℹ️"}</span>
                  <span className="flex-1">
                    {n.texto}
                    <span className="block text-[11px] text-slate-400">{fechaCorta(n.fecha)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Layout({ children, ruta }: { children: ReactNode; ruta: string[] }) {
  const { usuario, salir, reiniciar, estado } = useDemo();
  const [menu, setMenu] = useState(false);
  const criticos = estado.mensajes.filter((m) => m.critico && !m.atendido).length;
  const activa = ruta[0] ?? "";
  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-30 bg-amber-400 px-4 py-1 text-center text-xs font-semibold text-amber-950">
        DEMO · Datos 100 % ficticios · No se conecta a SUNAT · Lo que hagas se guarda solo en este navegador
      </div>
      <div className="flex">
        <aside className={`fixed inset-y-0 left-0 z-40 w-64 transform border-r border-slate-200 bg-white pt-6 transition lg:sticky lg:top-6 lg:h-[calc(100vh-1.5rem)] lg:translate-x-0 ${menu ? "translate-x-0" : "-translate-x-full"}`}>
          <div className="flex h-full flex-col">
            <a href="#/" className="flex items-center gap-2.5 px-5 pb-5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-700 text-lg font-black text-white">C</span>
              <span>
                <span className="block text-base font-bold leading-tight text-slate-900">ContApp</span>
                <span className="block text-[11px] leading-tight text-slate-500">{ESTUDIO.nombre}</span>
              </span>
            </a>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
              {MENU.map((m) => (
                <a
                  key={m.ruta}
                  href={`#/${m.ruta}`}
                  onClick={() => setMenu(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${activa === m.ruta ? "bg-teal-50 text-teal-800" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}
                >
                  <span className="w-5 text-center">{m.icono}</span>
                  <span className="flex-1">{m.texto}</span>
                  {m.ruta === "buzones" && criticos > 0 && <span className="rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">{criticos}</span>}
                  {m.r2 && <span className="rounded bg-violet-100 px-1 text-[9px] font-bold text-violet-700">R2</span>}
                </a>
              ))}
            </nav>
            <div className="border-t border-slate-100 p-4">
              <div className="text-sm font-semibold text-slate-800">{usuario?.nombre}</div>
              <div className="text-xs text-slate-500">
                {usuario?.rol} · {usuario?.email}
              </div>
              <div className="mt-3 flex gap-2">
                <Boton chico onClick={salir}>
                  Salir
                </Boton>
                <Boton
                  chico
                  variante="fantasma"
                  onClick={() => {
                    if (confirm("¿Reiniciar la demo? Se borran todos los cambios hechos en este navegador.")) {
                      reiniciar();
                      ir("/");
                    }
                  }}
                >
                  ↺ Reiniciar demo
                </Boton>
              </div>
            </div>
          </div>
        </aside>
        {menu && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setMenu(false)} />}
        <div className="min-w-0 flex-1">
          <header className="sticky top-6 z-20 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-2.5 backdrop-blur sm:px-6">
            <button className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setMenu(true)} aria-label="Menú">
              ☰
            </button>
            <div className="hidden text-sm text-slate-500 sm:block">
              {ESTUDIO.plan} · {estado.clientes.filter((c) => c.activo).length}/{ESTUDIO.limiteRucs} RUC
            </div>
            <div className="flex-1" />
            <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600 md:inline">Permisos: {PERMISOS_ROL[usuario?.rol ?? "Asistente"].length}</span>
            <Campana />
          </header>
          <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">{children}</main>
        </div>
      </div>
      <TrabajosFlotantes />
    </div>
  );
}

export function App() {
  const ruta = useRuta();
  const { usuario } = useDemo();
  if (!usuario) return <Login />;
  return (
    <Layout ruta={ruta}>
      <Rutas ruta={ruta} />
    </Layout>
  );
}

