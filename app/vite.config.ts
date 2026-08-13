import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build works both at a domain root and under the
// /<repo>/ path GitHub Pages serves project sites from.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1200 },
});
