import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset URLs: the same build works on a domain root or a subpath (GitHub Pages).
  base: "./",
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5186,
    strictPort: true,
    // M3 live API; harmless when it isn't running.
    proxy: { "/api": "http://127.0.0.1:8091" },
  },
  preview: { host: "127.0.0.1", port: 5187, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
});
