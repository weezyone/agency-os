import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Flags standard fetch-on-mount effects (setState from an async
      // callback after data loads); keep as a warning rather than failing CI.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default config;
