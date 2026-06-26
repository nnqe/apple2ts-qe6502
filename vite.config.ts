import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
// Uncomment to enable HTTPS for localhost
// import basicSsl from "@vitejs/plugin-basic-ssl"

type CpuCoreName = "ct" | "qe" | "qe-rw"

const DefaultCore: CpuCoreName = "ct"

const parseCoreValue = (value: string | undefined): CpuCoreName => {
  switch ((value ?? "").trim().toLowerCase()) {
    case "ct":
      return "ct"
    case "qe":
      return "qe"
    case "qe-rw":
      return "qe-rw"
    default:
      return DefaultCore
  }
}

const getCoreFromNpmScriptArgs = (): CpuCoreName => {
  const separatorIndex = process.argv.indexOf("--")
  if (separatorIndex < 0) return DefaultCore

  const coreArg = process.argv.slice(separatorIndex + 1)
    .find(value => value.startsWith("--core="))

  return parseCoreValue(coreArg?.slice("--core=".length))
}

const selectedCore = getCoreFromNpmScriptArgs()

// https://vitejs.dev/config/
// The define 'process.env' is a hack so that process.env.<env var> works properly.
export default defineConfig({
  base: "./",  // This makes all paths relative
  plugins: [react(),
    // Uncomment all these lines to enable HTTPS for localhost
    // basicSsl({
    //   /** name of certification */
    //   name: "test",
    //   /** custom trust domains */
    //   domains: ["*.custom.com"],
    //   /** custom certification directory */
    //   certDir: "/Users/.../.devServer/cert",
    // })
  ],
  server: {
    host: true,
    port: 6502,
  },
  build: {
    chunkSizeWarningLimit: 1500,
    sourcemap: true
  },
  worker: {
    format: "es",
  },
  define: {
    "process.env.npm_config_urlparam": JSON.stringify(process.env.npm_config_urlparam),
    "process.env.apple2ts_cpu_core": JSON.stringify(selectedCore),
  }
})
