import type { Config } from "tailwindcss";

// Warm palette, matching the app icon (a sunrise-gradient tile with a terracotta mark):
//   #C2611C amber-orange accent, #241A10 espresso text, #F0D5AC soft amber (borders),
//   #FDF4E7 cream (subtle backgrounds), #FEFBF4 warm off-white surface.
// Red is still reserved for recording, green for success — semantics stay legible even
// though the accent is now warm. Green/red/neutral badges are untouched.
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#C2611C", // warm amber-orange accent
          dark: "#A34E13", // hover / pressed
          light: "#F0D5AC", // soft amber — borders, highlights
          tint: "#FDF4E7", // warm cream — subtle backgrounds
        },
        ink: {
          DEFAULT: "#241A10", // warm espresso — headings, strong text
          soft: "#5A4A3A", // warm taupe — body text
        },
        surface: "#FEFBF4", // warm off-white
      },
    },
  },
  plugins: [],
} satisfies Config;
