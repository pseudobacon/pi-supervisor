/**
 * model-picker — wraps pi's internal ModelSelectorComponent for use in
 * the /supervise model command. Shows the same model selector the user
 * sees when pressing Ctrl+P in pi, with search and API-key availability.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRuntime, ModelSelectorComponent } from "@earendil-works/pi-coding-agent";

/**
 * Open the interactive model picker.
 * Returns the selected Model, or null if the user cancelled.
 */
export async function pickModel(
  ctx: ExtensionContext,
  currentProvider?: string,
  currentModelId?: string
): Promise<Model<any> | null> {
  // Resolve the currently-selected supervisor model (to pre-highlight it)
  const currentModel =
    currentProvider && currentModelId
      ? ctx.modelRegistry.find(currentProvider, currentModelId)
      : undefined;

  return ctx.ui.custom<Model<any> | null>(async (tui, _theme, _kb, done) => {
    // pi 1.5.0: the selector takes the model runtime (catalogue + auth), not a
    // settings manager. The default construction reads the same auth.json and
    // models.json under the agent dir the host uses; no network refresh.
    const modelRuntime = await ModelRuntime.create();
    const component = new ModelSelectorComponent(
      tui,
      currentModel,
      modelRuntime,
      [], // no scoped-model cycling — we want the full model list
      (model) => done(model),
      () => done(null)
    );

    // Give focus so the search input is active immediately
    component.focused = true;

    return {
      render: (width) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data) => {
        component.handleInput(data);
        tui.requestRender();
      },
      dispose: () => component.dispose(),
    };
  });
}
