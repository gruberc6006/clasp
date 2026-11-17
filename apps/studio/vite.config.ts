import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Packages are consumed as TypeScript source straight from the workspace, so
// there is no separate build step for them.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  build: { target: "es2022", sourcemap: true },
});
