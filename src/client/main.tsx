import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import "@/ui/styles.css";
import { initializeAnalytics } from "./analytics";
import { BrandProvider, initializeBrand } from "@/features/branding/components/client";
import { router } from "./router";

void initializeAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");

await initializeBrand();

createRoot(root).render(
  <StrictMode>
    <BrandProvider>
      <RouterProvider router={router} />
    </BrandProvider>
  </StrictMode>,
);
