// 购物车 + 匿名 userId：购物车持久化在 localStorage，userId 在 sessionStorage（多轮上下文用）。

const CART_KEY = 'shop_cart';
const UID_KEY = 'uid';

export function getUserId() {
  let id = sessionStorage.getItem(UID_KEY);
  if (!id) {
    id = 'u_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(UID_KEY, id);
  }
  return id;
}

export function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

export function cartCount() {
  return getCart().reduce((n, i) => n + i.qty, 0);
}

export function cartTotal() {
  return getCart().reduce((s, i) => s + i.price * i.qty, 0);
}

export function addToCart(product, qty = 1) {
  const cart = getCart();
  const found = cart.find((i) => i.id === product.id);
  if (found) found.qty += qty;
  else cart.push({ id: product.id, name: product.name, price: product.price, pic: product.pic || '', brand: product.brand || '', qty });
  saveCart(cart);
  return cart;
}

export function setQty(id, qty) {
  const cart = getCart();
  const it = cart.find((i) => i.id === id);
  if (!it) return cart;
  if (qty <= 0) return removeFromCart(id);
  it.qty = qty;
  saveCart(cart);
  return cart;
}

export function removeFromCart(id) {
  const cart = getCart().filter((i) => i.id !== id);
  saveCart(cart);
  return cart;
}

export function clearCart() {
  localStorage.removeItem(CART_KEY);
}
