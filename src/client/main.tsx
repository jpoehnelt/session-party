import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import posthog from "posthog-js";
import { RouterProvider } from "react-router/dom";
import "@/ui/styles.css";
import { router } from "./router";

posthog.init("phc_oLnzedUCyVJw8SFt7g44ARPDoEDLofo68BjmkcnGMAwx", {
  api_host: "https://k.hf.dev",
  defaults: "2026-05-30",
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
