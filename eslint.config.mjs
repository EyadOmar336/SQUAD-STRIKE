import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const nextConfigs = nextCoreWebVitals.map((config) => {
  if (config.rules) {
    const rules = { ...config.rules };
    for (const key of Object.keys(rules)) {
      if (key.startsWith("react-hooks/")) {
        rules[key] = "warn";
      }
    }
    return { ...config, rules };
  }
  return config;
});

export default defineConfig([
  ...nextConfigs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
