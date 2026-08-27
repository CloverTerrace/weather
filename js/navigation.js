/* Clover Terrace — shared site navigation */
(() => {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;

  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  nav.querySelectorAll('a[data-page]').forEach(link => {
    const target = (link.dataset.page || '').toLowerCase();
    if ((target === 'index.html' && (page === '' || page === 'index.html')) || target === page) {
      link.setAttribute('aria-current', 'page');
    }
  });

  let toastTimer = null;

  function showToast(message) {
    let toast = document.querySelector('.site-nav-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'site-nav-toast';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  nav.querySelectorAll('[data-coming-soon]').forEach(button => {
    button.addEventListener('click', () => {
      showToast(`${button.dataset.comingSoon || button.textContent.trim()} is coming soon.`);
    });
  });
})();
