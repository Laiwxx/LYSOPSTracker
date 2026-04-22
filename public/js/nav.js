// nav.js — Mobile sidebar toggle (hamburger menu)
(function() {
  'use strict';
  var topbar = document.querySelector('.topbar');
  var sidebar = document.querySelector('.tasks-sidebar');
  if (!topbar || !sidebar) return;

  // Create hamburger button
  var btn = document.createElement('button');
  btn.className = 'nav-hamburger';
  btn.setAttribute('aria-label', 'Open menu');
  btn.innerHTML = '<span></span>';
  topbar.insertBefore(btn, topbar.firstChild);

  // Create overlay
  var overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);

  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  btn.addEventListener('click', function() {
    if (sidebar.classList.contains('open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  overlay.addEventListener('click', closeSidebar);

  // Close on escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeSidebar();
  });

  // Close sidebar when a nav link is clicked (mobile)
  sidebar.addEventListener('click', function(e) {
    if (e.target.closest('a') && window.innerWidth <= 768) {
      closeSidebar();
    }
  });
  // ── Sales nav visibility (only for authorised users) ──
  var salesLink = document.getElementById('nav-sales');
  if (salesLink) {
    fetch('/api/auth/me').then(function(r) { return r.json(); }).then(function(me) {
      var allowed = ['Lai Wei Xiang', 'Janessa', 'Alex Chew'];
      if (me && me.name && allowed.indexOf(me.name) !== -1) {
        salesLink.style.display = '';
      }
    }).catch(function() {});
  }
})();
