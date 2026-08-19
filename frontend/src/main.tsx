import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/theme.css";
import "./styles/app.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root bulunamadı");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
