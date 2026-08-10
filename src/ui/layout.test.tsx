import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell, type ContentWidth } from "./layout";

const widthClass: Record<ContentWidth, string> = {
  compact: "max-w-6xl",
  standard: "max-w-[90rem]",
  wide: "max-w-[100rem]",
  canvas: "max-w-[110rem]",
};

describe("AppShell content widths", () => {
  it.each(Object.entries(widthClass) as [ContentWidth, string][]) (
    "renders the %s workspace cap",
    (contentWidth, expectedClass) => {
      const markup = renderToStaticMarkup(
        <AppShell sidebar={<span>Navigation</span>} contentWidth={contentWidth}>
          <span>Workspace</span>
        </AppShell>,
      );

      expect(markup).toContain(expectedClass);
    },
  );
});
