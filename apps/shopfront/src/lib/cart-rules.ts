// Cart rules shared by the server (actions, cart page) and the browser
// (quantity steppers), so both cap and price the same way.

// Most of one product a customer can have in the cart.
export const MAX_PER_LINE = 10;
// Different products in one cart; keeps the cookie small.
export const MAX_LINES = 20;

export const FREE_SHIPPING_CENTS = 7500;
export const SHIPPING_CENTS = 600;

export const shippingFor = (subtotalCents: number) =>
  subtotalCents === 0 || subtotalCents >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;
