import { saludoSchema } from "@contapp/shared";
import { PrimerosPasos } from "../../components/primeros-pasos";
import { UsoPlan } from "../../components/uso-plan";

export default function Home() {
  const saludo = saludoSchema.parse({ mensaje: "ContApp" });

  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-6">
      <h1 className="text-3xl font-semibold">{saludo.mensaje}</h1>
      <UsoPlan />
      <PrimerosPasos />
    </main>
  );
}
