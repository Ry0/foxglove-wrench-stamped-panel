import { ExtensionContext } from "@foxglove/extension";

import { initExamplePanel } from "./WrenchStampedPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "WrenchStamped ", initPanel: initExamplePanel });
}
