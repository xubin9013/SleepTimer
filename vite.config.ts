import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const r = (p: string) => resolve(rootDir, p);

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: false },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
    rollupOptions: {
      input: {
        main: r("index.html"),
        countdown: r("countdown.html"),
      },
    },
  },
});
