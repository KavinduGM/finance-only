// Runs before the app loads so the saved theme is applied without a flash.
(function () {
  var theme = 'dark';
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (e) { /* storage unavailable: keep the default */ }
  document.documentElement.setAttribute('data-theme', theme);
})();
