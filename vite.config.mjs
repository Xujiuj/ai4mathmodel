import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageInfo from "./package.json" with { type: "json" };

export default defineConfig({
  base: "./",
  define: {
    "globalThis.__MATH_MODEL_APP_VERSION__": JSON.stringify(packageInfo.version),
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 900,
  },
});
