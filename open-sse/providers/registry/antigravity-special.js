import antigravity from "./antigravity.js";

export default {
  ...antigravity,
  id: "antigravity-special",
  priority: 25,
  alias: "ags",
  uiAlias: "ags",
  display: {
    ...antigravity.display,
    name: "Antigravity Special",
    color: "#EC4899",
  },
};
