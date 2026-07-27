import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

if (/Macintosh|Mac OS X/.test(navigator.userAgent)) {
  document.documentElement.dataset.platform = "darwin";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
