import { ESTUDIO } from "../datos/semilla";
import { useDemo } from "../estado/store";
import { ir } from "../ui/comunes";

const DESCRIPCION: Record<string, string> = {
  Administrador: "Ve todo: clientes, credenciales, usuarios, plan y auditoría.",
  Contador: "Revisa y corrige compras y ventas, aprueba y genera archivos.",
  Asistente: "Edita las grillas, pero no aprueba ni genera archivos.",
};

export function Login() {
  const { estado, ingresar } = useDemo();
  return (
    <div className="min-h-screen bg-gradient-to-br from-teal-800 via-teal-700 to-slate-800">
      <div className="bg-amber-400 px-4 py-1 text-center text-xs font-semibold text-amber-950">DEMO · Datos 100 % ficticios · No se conecta a SUNAT</div>
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-10 px-4 py-12 lg:flex-row lg:py-20">
        <div className="flex-1 text-white">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white text-2xl font-black text-teal-800">C</span>
            <span className="text-3xl font-bold">ContApp</span>
          </div>
          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">El SIRE de todos tus clientes, revisado y corregido antes de declarar.</h1>
          <ul className="mt-6 space-y-2 text-teal-50">
            <li>✓ Descarga la propuesta SIRE de compras y ventas en un clic</li>
            <li>✓ Motor de correcciones: ISC mal ubicado, facturas mixtas, redondeos en dólares, proveedores nuevos</li>
            <li>✓ Lupa 🔍 con el XML del comprobante en lenguaje humano</li>
            <li>✓ Prevalidación y archivo TXT/ZIP de reemplazo listo para SUNAT</li>
            <li>✓ Buzones SOL y prorrata de todos tus clientes (R2)</li>
          </ul>
        </div>
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h2 className="text-lg font-bold text-slate-900">Ingresar a la demo</h2>
          <p className="mt-1 text-sm text-slate-500">
            {ESTUDIO.nombre} (ficticio). Elige con qué rol quieres entrar; no necesitas contraseña.
          </p>
          <div className="mt-5 space-y-2.5">
            {estado.usuarios.map((u) => (
              <button
                key={u.id}
                onClick={() => {
                  ingresar(u.id);
                  ir("/");
                }}
                className="flex w-full items-center gap-3 rounded-xl border border-slate-200 p-3 text-left transition hover:border-teal-600 hover:bg-teal-50"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-100 font-bold text-teal-800">{u.nombre[0]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-slate-800">
                    {u.nombre} <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">{u.rol}</span>
                  </span>
                  <span className="block text-xs text-slate-500">{DESCRIPCION[u.rol]}</span>
                </span>
                <span className="text-slate-400">→</span>
              </button>
            ))}
          </div>
          <p className="mt-5 text-[11px] leading-relaxed text-slate-400">
            En el producto real: correo + contraseña, 2FA opcional, sesiones con expiración y aislamiento por estudio (RLS). Las claves SOL se cifran (envelope encryption) y nunca se muestran.
          </p>
        </div>
      </div>
    </div>
  );
}
