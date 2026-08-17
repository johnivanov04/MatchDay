import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Mounting a component into jsdom, with no testing library in between.
 *
 * The container is attached to `document.body` because React delegates events
 * to the root container: an element rendered into a detached node receives no
 * `onChange` or `onClick`, and every interaction test would silently do
 * nothing.
 */
export interface Rendered {
  readonly container: HTMLElement;
  /**
   * Renders the same tree again with new props, into the same root.
   *
   * For components whose props come from a Server Component and therefore
   * *change underneath them* — a `router.refresh()` landing, say. Mounting a
   * second root would reset the state that behaviour is about.
   */
  rerender(node: ReactNode): Promise<void>;
  unmount(): void;
}

export async function render(node: ReactNode): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.append(container);

  let root: Root | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });

  return {
    container,
    async rerender(next: ReactNode) {
      await act(async () => {
        root?.render(next);
      });
    },
    unmount() {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

/** Dispatches a bubbling native event and lets React flush. */
export async function fire(target: Element, event: Event): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

export async function click(target: Element): Promise<void> {
  await fire(target, new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * Selects a file in a native file input.
 *
 * `input.files` is read-only in jsdom, so it is redefined. `change` is the
 * event React maps `onChange` to for file inputs — text inputs use `input`,
 * which is why this cannot be one shared helper.
 */
export async function chooseFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
    writable: false,
  });
  await fire(input, new Event('change', { bubbles: true }));
}

/** Lets pending promises and their `act` updates settle. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function text(container: HTMLElement): string {
  return container.textContent ?? '';
}
