import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { ProveedorEstado } from "./estado/store";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ProveedorEstado>
      <App />
    </ProveedorEstado>
  </StrictMode>,
);
