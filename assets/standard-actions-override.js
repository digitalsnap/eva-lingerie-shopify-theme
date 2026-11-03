/**
 * Eva overrides for Shopify.actions:
 * - openCart: open the Eva cart drawer (fall back to /cart when absent).
 * Cart update events keep Shopify's default target (document), where the drawer listens for them.
 */

function init() {
  const actions = window.Shopify?.actions;
  if (!actions) return;

  actions.openCart.configure({
    async handler() {
      /** @type {HTMLElement & {showDialog?: () => void} | null} */
      const drawer = document.getElementById('eva-cart-drawer');

      if (drawer?.showDialog) {
        drawer.showDialog();
      } else {
        window.location.href = Theme.routes.cart_url || '/cart';
      }
    },
  });
}

// Run immediately if the standard-actions bundle has already attached
// `Shopify.actions`; otherwise wait for DOMContentLoaded, which fires after
// all module scripts have executed regardless of document order.
if (window.Shopify?.actions) {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init, { once: true });
}
