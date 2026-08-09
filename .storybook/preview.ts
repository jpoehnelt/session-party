import type { Preview } from "@storybook/react-vite";
import "../src/ui/styles.css";

const preview: Preview = {
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "canvas",
      values: [
        { name: "canvas", value: "#faf9f7" },
        { name: "surface", value: "#fffefc" },
      ],
    },
    a11y: {
      test: "error",
    },
  },
  tags: ["autodocs"],
};

export default preview;
