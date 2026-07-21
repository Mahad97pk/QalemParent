// Add your JavaScript here.
//
// This file is loaded on every page via the <script> tag.
// You can use it for interactivity, form handling, animations, etc.

document.addEventListener('DOMContentLoaded', () => {
  // Highlight the current page in the navigation
  const currentPath = window.location.pathname;
  const navLinks = document.querySelectorAll('.nav-links a');

  navLinks.forEach((link) => {
    const href = link.getAttribute('href');
    if (
      href === currentPath ||
      (href === '/' && (currentPath === '/' || currentPath === '/index.html'))
    ) {
      link.style.color = 'var(--color-text)';
      link.style.fontWeight = '600';
    }
  });
});
