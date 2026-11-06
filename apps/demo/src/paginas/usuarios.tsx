import { ESTUDIO, PERMISOS_ROL } from "../datos/semilla";
import { useDemo } from "../estado/store";
import { Encabezado, Insignia, Kpi, Tarjeta } from "../ui/comunes";

const TODOS = ["clientes.gestionar", "clientes.asignar", "credenciales.editar", "sire.editar", "sire.aprobar_generar", "usuarios.gestionar", "auditoria.ver"];

export function Usuarios() {
  const { estado } = useDemo();
  const activos = estado.clientes.filter((c) => c.activo).length;
  return (
    <>
      <Encabezado titulo="Usuarios y plan" subtitulo={`${ESTUDIO.nombre} · ${ESTUDIO.plan}`} />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi etiqueta="RUC usados" valor={`${activos}/${ESTUDIO.limiteRucs}`} tono={activos >= ESTUDIO.limiteRucs - 1 ? "ambar" : undefined} nota="Límite del plan" />
        <Kpi etiqueta="Usuarios" valor={`${estado.usuarios.length}/${ESTUDIO.limiteUsuarios}`} />
        <Kpi etiqueta="Revisión de buzones" valor="6 h" nota={ESTUDIO.frecuenciaBuzon} />
        <Kpi etiqueta="Estado de la suscripción" valor="Activa" tono="verde" nota="Demo: sin cobro" />
      </div>
      <Tarjeta titulo="Usuarios del estudio">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Usuario</th>
                <th className="px-4 py-2">Rol</th>
                <th className="px-4 py-2">Clientes asignados</th>
              </tr>
            </thead>
            <tbody>
              {estado.usuarios.map((u) => (
                <tr key={u.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">
                    <div className="font-medium">{u.nombre}</div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                  </td>
                  <td className="px-4 py-2"><Insignia tono="teal">{u.rol}</Insignia></td>
                  <td className="px-4 py-2 text-xs text-slate-600">{estado.clientes.filter((c) => c.responsable === u.nombre).map((c) => c.razonSocial).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tarjeta>
      <Tarjeta className="mt-5" titulo="Permisos por rol (el estudio puede crear roles propios)">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left">Permiso</th>
                {Object.keys(PERMISOS_ROL).map((r) => <th key={r} className="px-4 py-2">{r}</th>)}
              </tr>
            </thead>
            <tbody>
              {TODOS.map((p) => (
                <tr key={p} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-mono text-xs">{p}</td>
                  {Object.values(PERMISOS_ROL).map((l, i) => <td key={i} className="px-4 py-2 text-center">{l.includes(p) ? "✓" : <span className="text-slate-300">—</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tarjeta>
    </>
  );
}
