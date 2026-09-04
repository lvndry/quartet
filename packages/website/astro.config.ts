import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

export default defineConfig({
  // The one domain-bearing constant on the site. Canonical URLs, the sitemap and the
  // absolute links in llms.txt all derive from it, so a move is this line.
  site: "https://quartet-chat.vercel.app",
  trailingSlash: "never",
  build: { format: "file" },
  integrations: [
    sitemap({
      serialize: (item) => ({
        ...item,
        url: item.url.replace(/index\.html$/, "").replace(/\.html$/, ""),
      }),
    }),
  ],
  markdown: {
    shikiConfig: { theme: "css-variables" },
  },
});
