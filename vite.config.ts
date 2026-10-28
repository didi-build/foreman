import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "gallery",
  build: {
    outDir: "../dist/gallery",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
