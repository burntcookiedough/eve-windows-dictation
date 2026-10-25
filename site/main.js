const repo = 'burntcookiedough/eve-windows-dictation';

fetch(`https://api.github.com/repos/${repo}/releases?per_page=1`)
  .then((response) => (response.ok ? response.json() : []))
  .then(([release]) => {
    if (!release) return;
    document.querySelectorAll('[data-version]').forEach((el) => { el.textContent = release.tag_name; });
    document.querySelectorAll('[data-download]').forEach((el) => { el.href = release.html_url; });
  })
  .catch(() => {});

const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  reveals.forEach((el) => observer.observe(el));
} else {
  reveals.forEach((el) => el.classList.add('is-visible'));
}
