import type { ComponentType } from "react";
import type { ContentWidth } from "@/ui";
import { generatedClientRoutes } from "./routes.gen";

export type RouteModule = {
  path: string;
  layout?: "app" | "bare";
  contentWidth?: ContentWidth;
  default: ComponentType;
};

export type ClientRouteDefinition = Omit<RouteModule, "default"> & {
  load: () => Promise<RouteModule>;
};

export const discoveredClientRoutePaths = generatedClientRoutes.map(({ path }) => path);
export const discoveredClientRouteModules: readonly ClientRouteDefinition[] = generatedClientRoutes;
