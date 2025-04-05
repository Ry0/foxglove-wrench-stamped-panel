import { ExtensionContext } from "@foxglove/extension";

import { initExamplePanel } from "./WrenchPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "Wrench ", initPanel: initExamplePanel });
}
