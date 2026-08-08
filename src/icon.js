import { platform } from "./platform.js";

let svgTemplate = null;
let svgTemplatePromise = null;
let iconGeneration = 0;

async function getSvgTemplate() {
  if (svgTemplate) return svgTemplate;
  if (!svgTemplatePromise) {
    svgTemplatePromise = fetch(platform.getURL("icons/icon.svg"))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load extension icon (HTTP ${response.status})`);
        const svg = await response.text();
        if (!svg.includes("<svg")) throw new Error("Extension icon is not valid SVG");
        svgTemplate = svg;
        return svg;
      })
      .finally(() => {
        svgTemplatePromise = null;
      });
  }
  return svgTemplatePromise;
}

export async function setActiveIcon(active) {
  const generation = ++iconGeneration;
  const svg = await getSvgTemplate();
  if (generation !== iconGeneration) return;
  const colored = active ? svg.replace("#1a73e8", "#22c55e") : svg;
  const url = "data:image/svg+xml," + encodeURIComponent(colored);
  await platform.setIcon({ path: url });
}
