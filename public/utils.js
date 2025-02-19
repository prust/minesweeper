// utils (shared between client & server)
let _ = await import(typeof global == 'undefined' ? 'underscore' : './vendor/underscore-esm-1.13.7.mjs');

export function assert(val, msg) {
  if (!val)
    throw new Error(`Assertion failed${msg ? `: ${msg}` : ''}`);
}
assert.equal = function(actual, expected, msg) {
  if (actual != expected)
    throw new Error(`Expected ${actual} to equal ${expected} ${msg || ''}`);
}

// DOM-related
export function $(id) {
  return document.getElementById(id);
}
export function $$(selector) {
  return document.querySelector(selector);
}

// equivalent to _.defer() but async/await compatible
export async function defer() {
  return timeout(1);
}

export async function timeout(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
