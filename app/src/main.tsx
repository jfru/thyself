import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initDiagnostics } from "./lib/diagnostics";
import "./styles/globals.css";

initDiagnostics();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
