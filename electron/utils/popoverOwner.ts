// Personal build (Natively Z): fresh owner link for the overlay popovers on Windows.
//
// Seen on Windows during a meeting: the settings and model popovers, owned by the
// overlay, stopped getting the mouse-DOWN of every click (hover, move and mouse-up
// still arrived), so no button in them could be pressed. Re-setting the same owner
// did not help, and neither did the hidden detach/attach the model popover already
// does on every close/open. Detaching and re-attaching while the popover is ON
// SCREEN fixed both at once, and it stayed fixed across later opens. So it runs
// right after each show. The exact trigger was not reproduced in a fresh instance.
//
// macOS is untouched: there the popovers are AppKit child panels and re-parenting
// a visible one reorders it.
//
// Pure, platform injected (see __tests__/popoverOwner.test.mjs).

export interface OwnedPopoverLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  setParentWindow(parent: any): void;
}

export function refreshPopoverOwner(
  win: OwnedPopoverLike | null | undefined,
  owner: { isDestroyed(): boolean } | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  if (!owner || owner.isDestroyed()) return false;
  win.setParentWindow(null);
  win.setParentWindow(owner);
  return true;
}
