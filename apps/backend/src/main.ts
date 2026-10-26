import { crearApp } from "./app.js";

const app = await crearApp();
await app.listen(process.env.PORT ?? 4000);
