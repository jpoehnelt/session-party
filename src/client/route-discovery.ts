import type { ComponentType } from "react";
import type { ContentWidth } from "@/ui";

export type RouteModule = {
  path: string;
  layout?: "app" | "bare";
  contentWidth?: ContentWidth;
  default: ComponentType;
};

const routeModules = import.meta.glob(
  [
    "../features/*/routes/*.tsx",
    "!../features/*/routes/*.test.tsx",
    "!../features/*/routes/*.test.ts",
    "!../features/*/routes/*.browser.tsx",
    "!../features/*/routes/*.stories.tsx",
    "!../features/*/routes/*.stories.ts",
  ],
  {
    eager: true,
  },
) as Record<string, RouteModule>;

export const discoveredClientRoutePaths = Object.keys(routeModules);
export const discoveredClientRouteModules = Object.values(routeModules);
