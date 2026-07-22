import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server on 5173 talks to the FastAPI backend on 127.0.0.1:8000
// (see server/app/main.py's CORS allow-list, which is pinned to this origin).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
