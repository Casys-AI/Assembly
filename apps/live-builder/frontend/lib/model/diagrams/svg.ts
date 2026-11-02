/** Export the complete filtered/folded scene, independent of pan/zoom.
 * Computed styles make the file standalone without host CSS. */
export function diagramSvg(
  svg: SVGSVGElement,
  width: number,
  height: number,
): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll("*")];
  const copies = [copy, ...copy.querySelectorAll("*")];
  const properties = [
    "fill",
    "stroke",
    "stroke-width",
    "stroke-dasharray",
    "stroke-linejoin",
    "stroke-linecap",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "letter-spacing",
    "paint-order",
    "text-anchor",
  ];
  originals.forEach((element, i) => {
    const style = getComputedStyle(element);
    for (const property of properties) {
      copies[i].setAttribute(property, style.getPropertyValue(property));
    }
    copies[i].removeAttribute("tabindex");
    copies[i].removeAttribute("role");
  });
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("viewBox", `-24 -24 ${width + 48} ${height + 48}`);
  copy.setAttribute("width", String(width + 48));
  copy.setAttribute("height", String(height + 48));
  copy.removeAttribute("class");
  copy.removeAttribute("style");
  copy.querySelector("[data-diagram-world]")?.removeAttribute("transform");
  const background = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "rect",
  );
  background.setAttribute("x", "-24");
  background.setAttribute("y", "-24");
  background.setAttribute("width", String(width + 48));
  background.setAttribute("height", String(height + 48));
  background.setAttribute("fill", "#f6f5f2");
  copy.insertBefore(background, copy.firstChild);
  return new XMLSerializer().serializeToString(copy);
}
export function downloadDiagramSvg(
  svg: SVGSVGElement,
  width: number,
  height: number,
  title: string,
): void {
  const url = URL.createObjectURL(
    new Blob([diagramSvg(svg, width, height)], {
      type: "image/svg+xml;charset=utf-8",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${
    title.replace(/[^A-Za-z0-9._-]+/g, "-") || "model-view"
  }.svg`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
