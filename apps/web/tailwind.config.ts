import type { Config } from "tailwindcss";

// Brand palette sampled straight from logo.png:
//   #4F42E0 indigo (the speech balloon + "Meet"), #0E142E navy (the "Sum"),
//   #DCDAFA lavender (the little bar chart), #FEFEFE off-white (background).
// Red/green/amber stay reserved for semantics (recording, failure, success) —
// mixing brand indigo into those would make status unreadable.
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#4F42E0",
          dark: "#3F34C4", // hover / pressed
          light: "#DCDAFA", // lavender accent, highlights
          tint: "#EFEEFD", // subtle backgrounds
        },
        ink: {
          DEFAULT: "#0E142E", // headings, strong text
          soft: "#3B415C", // body text
        },
        surface: "#FBFBFE",
      },
    },
  },
  plugins: [],
} satisfies Config;
