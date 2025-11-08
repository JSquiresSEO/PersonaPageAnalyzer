// content.js
//
// This script is injected into the active webpage.
// It returns an object containing the page's HTML content,
// as well as the viewport's width and height.

({
  html: document.body.outerHTML,
  width: window.innerWidth,
  height: window.innerHeight
});
