import { platform } from "./platform.js";

let svgTemplate = null;

async function getSvgTemplate() {
  if (svgTemplate) return svgTemplate;
  const res = await fetch(platform.getURL("icons/icon.svg"));
  svgTemplate = await res.text();
  return svgTemplate;
}

export async function setActiveIcon(active) {
  const svg = await getSvgTemplate();
  const colored = active ? svg.replace("#1a73e8", "#22c55e") : svg;
  const url = "data:image/svg+xml," + encodeURIComponent(colored);
  await platform.setIcon({ path: url });
}
