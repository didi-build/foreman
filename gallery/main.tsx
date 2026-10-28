import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/gallery" element={<App />} />
        <Route path="/" element={<Navigate to="/gallery" replace />} />
        <Route path="*" element={<Navigate to="/gallery" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
