import { saludoSchema } from "@contapp/shared";

export default function Home() {
  const saludo = saludoSchema.parse({ mensaje: "ContApp" });

  return (
    <main className="flex flex-1 items-center justify-center">
      <h1 className="text-3xl font-semibold">{saludo.mensaje}</h1>
    </main>
  );
}
