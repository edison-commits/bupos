import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BasicUniformPOS",
    short_name: "BUPOS",
    description: "Web-first retail POS",
    start_url: "/register",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#0f766e",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
