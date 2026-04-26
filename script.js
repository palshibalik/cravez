/* ═══════════════════════════════════════════════════════
   Cravez — client script (Vanilla JS)
   ═══════════════════════════════════════════════════════ */

// ─── State ─────────────────────────────────────────────────────────────────
const state = {
  user: JSON.parse(localStorage.getItem('cravez_user')) || null,
  token: localStorage.getItem('cravez_token') || null,
  theme: 'light',

  restaurants: [],
  selectedRestaurant: null,
  menu: [],
  cart: {},
  currentOrderId: null,
  ws: null,
  discountStatus: { applied: false, amount: 0, code: '' },

  // Geolocation
  userLocation: { lat: 28.6139, lng: 77.2090 },
  locationSet: false,
  deliveryRangeKM: 8,

  // Tracking
  leafletMap: null,
  riderMarker: null,
  destMarker: null,
  routeLine: null,
  routeCoords: [],
  travelTimer: null,
  riderAnimId: null,
  targetPct: 0,
  renderPct: 0,

  // UI state
  isSignUp: false,
  isLoadingRestaurants: false,

  // Router
  currentPage: 'home',
};

const ORDER_STATUSES = [
  { key: 'placed',     label: 'Order Placed',          progress: 10 },
  { key: 'confirmed',  label: 'Confirmed by Restaurant',progress: 25 },
  { key: 'preparing',  label: 'Preparing your food',    progress: 50 },
  { key: 'picked_up',  label: 'Rider picked up',        progress: 70 },
  { key: 'on_the_way', label: 'On the way',             progress: 85 },
  { key: 'delivered',  label: 'Delivered',              progress: 100 },
];

const TAX_RATE    = 0.05;
const DELIVERY_FEE = 40;

// ─── Diverse Food Image Pool ───────────────────────────────────────────────
const FOOD_IMAGES = [
  'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400',
  'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400',
  'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400',
  'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=400',
  'https://images.unsplash.com/photo-1559847844-5315695dadae?w=400',
  'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400',
  'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=400',
  'https://images.unsplash.com/photo-1476224203421-9ac39bcb3327?w=400',
  'https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=400',
  'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=400',
  'https://images.unsplash.com/photo-1484980972926-edee96e0960d?w=400',
  'https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=400',
];

function getFoodImage(index) {
  return FOOD_IMAGES[index % FOOD_IMAGES.length];
}

// ─── Video Cinema Engine ──────────────────────────────────────────────────
const HERO_VIDEOS = [
  'hero-1.mp4',
  'hero-2.mp4',
  'hero-3.mp4',
  'hero-4.mp4'
];
let currentVideoIdx = 0;

function initVideoRotator() {
  const v1 = document.getElementById('video-primary');
  const v2 = document.getElementById('video-secondary');
  if (!v1 || !v2) return;

  v1.src = HERO_VIDEOS[0];
  v1.classList.add('active');

  // Cross-fade every 8 seconds
  setInterval(() => {
    const nextIdx = (currentVideoIdx + 1) % HERO_VIDEOS.length;
    const active = v1.classList.contains('active') ? v1 : v2;
    const next   = v1.classList.contains('active') ? v2 : v1;

    next.src = HERO_VIDEOS[nextIdx];
    next.onloadeddata = () => {
      active.classList.remove('active');
      next.classList.add('active');
      currentVideoIdx = nextIdx;
    };
  }, 8000);
}

// ─── Initialization ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  updateAuthUI();
  if (state.token) fetchProfile();
  initRouter();
  initScrollListener();
  initScrollThread();
  initVideoRotator();
  initBento3D();
  
  // Stealth Navbar for Cinema Home
  window.addEventListener('scroll', () => {
    const top = window.pageYOffset;
    if (state.currentPage === 'home') {
      if (top < 100) {
        document.body.classList.add('home-at-top');
      } else {
        document.body.classList.remove('home-at-top');
      }
    } else {
      document.body.classList.remove('home-at-top');
    }
  });

  if (state.currentPage === 'home') {
    renderElitePicks();
    renderTrendingFood(); // New function
    initBento3D(); // Initialize 3D effects and live data
  }
  
  if (!state.locationSet) {
    const locOverlay = document.getElementById('location-overlay');
    if (locOverlay) locOverlay.style.display = 'flex';
  } else {
    loadRestaurants();
  }

  initScrollReveal(); 
});

// ─── 3D Bento Engine ───────────────────────────────────────────────────────
function initBento3D() {
  const container = document.querySelector('.bento-3d-grid');
  if (!container || container.dataset.initialized) return;
  container.dataset.initialized = "true";

  const items = document.querySelectorAll('.bento-3d-item');
  items.forEach(item => {
    const card = item.querySelector('.bento-3d-card');
    if (!card) return;
    
    item.addEventListener('mousemove', (e) => {
      const rect = item.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      
      const rotateX = ((y - centerY) / centerY) * -10; // Max 10deg
      const rotateY = ((x - centerX) / centerX) * 10;
      
      card.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    });

    item.addEventListener('mouseleave', () => {
      card.style.transform = `rotateX(0deg) rotateY(0deg)`;
    });
  });

  // Simulated Live Data Updates
  setInterval(() => {
    const orderCount = document.querySelector('.trend-stats strong');
    if (orderCount) {
      const current = parseFloat(orderCount.textContent.replace('k+', ''));
      const next = (current + 0.01).toFixed(2);
      orderCount.textContent = `${next}k+`;
    }
  }, 3000);

  // Vibe Selector Logic
  const chips = document.querySelectorAll('.vibe-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      notify(`Vibe set to: ${chip.textContent}`, 'success');
    });
  });

  // Simple Countdown Timer
  let seconds = 4 * 3600 + 12 * 60;
  const timerEl = document.querySelector('.countdown-timer');
  if (timerEl) {
    setInterval(() => {
      seconds--;
      if (seconds < 0) seconds = 3600 * 5;
      const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
      const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
      const s = (seconds % 60).toString().padStart(2, '0');
      timerEl.textContent = `${h}:${m}:${s}`;
    }, 1000);
  }
}

// ─── Hash-based SPA Router ─────────────────────────────────────────────────
function initRouter() {
  window.addEventListener('hashchange', handleRoute);
  handleRoute(); // Run on page load
}

function handleRoute() {
  const hash = window.location.hash || '#/home';
  const parts = hash.replace('#/', '').split('/');
  const page = parts[0] || 'home';
  const param = parts[1] || null;

  if (page === 'menu' && param) {
    if (state.locationSet && state.restaurants.length) {
      selectRestaurant(param, true);
    } else {
      state._pendingRoute = { page, param };
      _showPageEl('home');
    }
  } else if (page === 'tracking' && param) {
    lookupOrderByParam(param);
  } else if (page === 'track-lookup') {
    _showPageEl('track-lookup');
  } else if (page === 'browse') {
    _showPageEl('browse');
    if (state.locationSet && !state.restaurants.length) loadRestaurants();
  } else if (page === 'all-restaurants') {
    _showPageEl('all-restaurants');
    loadAllRestaurants();
  } else if (page === 'home' || page === '') {
    _showPageEl('home');
  } else {
    _showPageEl(page);
  }
}

function navigate(page, param) {
  const hash = param ? `#/${page}/${param}` : `#/${page}`;
  window.location.hash = hash; // triggers hashchange → handleRoute
}

// Internal: actually swap the visible page element
function _showPageEl(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(`page-${name}`);
  if (el) el.classList.add('active');

  state.currentPage = name;

  // Mobile nav active state
  document.querySelectorAll('.m-nav-item').forEach(btn => {
    btn.classList.remove('active');
    const txt = btn.querySelector('span')?.textContent?.toLowerCase();
    if (name === 'home' && txt === 'home') btn.classList.add('active');
    if (name === 'track-lookup' && txt === 'orders') btn.classList.add('active');
    if (name === 'browse' && txt === 'browse') btn.classList.add('active');
    if (name === 'all-restaurants' && txt === 'brands') btn.classList.add('active');
  });

  // Nav search bar visibility
  const navSearch = document.getElementById('nav-search-container');
  navSearch.style.display = name === 'menu' ? 'flex' : 'none';

  if (name === 'home') {
    // Cinema mode logic if needed
    initScrollReveal();
    initBento3D(); // Refresh 3D logic
  }

  if (name === 'browse') {
     if (state.locationSet && !state.restaurants.length) loadRestaurants();
     initScrollReveal();
  }
  if (name === 'track-lookup') {
    loadUserOrders();
  }
  if (name === 'tracking' && state.leafletMap) {
    setTimeout(() => state.leafletMap.invalidateSize(), 300);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Global scroll helper for Hero
function scrollToContent() {
  window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
}

// Public helper used by onclick handlers
function showPage(name) {
  navigate(name);
}

function initScrollListener() {
  const nav = document.querySelector('.navbar');
  const toggleStealth = () => {
    // Stealth logo on home at top
    if (state.currentPage === 'home' && window.scrollY < 100) {
      document.body.classList.add('home-at-top');
    } else {
      document.body.classList.remove('home-at-top');
    }

    if (window.scrollY > 50) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  };
  window.addEventListener('scroll', toggleStealth);
  toggleStealth();
}

// ─── Scroll-based Thread Animation ─────────────────────────────────────────
function initScrollThread() {
  const paths   = document.querySelectorAll('.anim-dash');
  const overlay = document.querySelector('.food-float-overlay');
  const svg     = document.querySelector('.food-thread-svg');
  if (!paths.length || !overlay || !svg) return;

  let renderedPct = 0;
  let rafId       = null;
  const LERP_SPEED = 0.08;
  const TARGET_LEAD_PX = 160;

  function getCenter(className) {
    const el = document.querySelector(className);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const or = svg.getBoundingClientRect();
    return {
      x: (r.left - or.left) + r.width / 2,
      y: (r.top - or.top) + r.height / 2
    };
  }

  function buildPath() {
    const homePage = document.getElementById('page-home');
    if (!homePage || (homePage.style.display === 'none' && !homePage.classList.contains('active'))) return;
    const W = svg.clientWidth || overlay.offsetWidth;
    const H = svg.clientHeight || overlay.scrollHeight || overlay.offsetHeight;
    if (W < 100 || H < 100) { setTimeout(buildPath, 200); return; }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const b = getCenter('.ffo-burger');
    const t = getCenter('.ffo-taco');
    const p = getCenter('.ffo-pizza');
    if (!b || !t || !p || b.y < 200) { setTimeout(buildPath, 400); return; }
    svg.dataset.burgerY = b.y;
    svg.dataset.pizzaY  = p.y;
    const d = `M ${b.x} ${b.y} 
               C ${b.x} ${b.y + (t.y - b.y) * 0.5}, ${t.x} ${t.y - (t.y - b.y) * 0.5}, ${t.x} ${t.y}
               C ${t.x} ${t.y + (p.y - t.y) * 0.5}, ${p.x} ${p.y - (p.y - t.y) * 0.5}, ${p.x} ${p.y}`;
    paths.forEach(path => {
      path.setAttribute('d', d);
      const length = path.getTotalLength();
      if (length > 0) {
        path.style.strokeDasharray = length;
        path.dataset.length = length;
      }
    });
    applyToPath(renderedPct);
  }

  function calcTarget() {
    const bY = parseFloat(svg.dataset.burgerY);
    const pY = parseFloat(svg.dataset.pizzaY);
    if (isNaN(bY) || isNaN(pY)) return 0;
    const targetY = (window.scrollY + window.innerHeight) - TARGET_LEAD_PX;
    if (targetY <= bY) return 0;
    if (targetY >= pY) return 1;
    return (targetY - bY) / (pY - bY);
  }

  function applyToPath(pct) {
    paths.forEach(path => {
      const length = parseFloat(path.dataset.length);
      if (!length) return;
      path.style.strokeDashoffset = length - length * pct;
    });
  }

  function tick() {
    if (state.currentPage !== 'home') { rafId = null; return; }
    const target = calcTarget();
    renderedPct += (target - renderedPct) * LERP_SPEED;
    if (Math.abs(target - renderedPct) > 0.0001) {
      applyToPath(renderedPct);
      rafId = requestAnimationFrame(tick);
    } else {
      applyToPath(target);
      rafId = null;
    }
  }

  window.addEventListener('scroll', () => { if (!rafId) rafId = requestAnimationFrame(tick); });
  window.addEventListener('load', () => setTimeout(buildPath, 1000));
  window.addEventListener('resize', () => {
    clearTimeout(window.buildPathTimeout);
    window.buildPathTimeout = setTimeout(buildPath, 300);
  });
  document.addEventListener('navigated', e => {
    if (e.detail.pageId === 'home') setTimeout(buildPath, 600);
  });
  setTimeout(buildPath, 500);
}

// ─── Scroll Reveal Engine ──────────────────────────────────────────────────
function initScrollReveal() {
  const revealElements = document.querySelectorAll('.reveal');
  
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('active');
      }
      // Optionally remove 'active' to re-trigger
      // else { entry.target.classList.remove('active'); }
    });
  }, {
    threshold: 0.1, // Trigger when 10% is visible
    rootMargin: '0px 0px -20px 0px' 
  });

  revealElements.forEach(el => observer.observe(el));
}

// ─── Utilities ─────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.innerHTML = `<span>${msg}</span>`;
  t.className = `toast-pro show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast-pro'), 3000);
}

/** Wrapper for professional notifications */
function notify(msg, type = 'info') {
  showToast(msg, type);
}

function calcDistanceKM(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Theme ─────────────────────────────────────────────────────────────────
// Enforcing permanent light theme, removing toggle logic
function initTheme() {
  document.body.classList.remove('dark-mode');
  state.theme = 'light';
}

// ─── Auth ──────────────────────────────────────────────────────────────────
function updateAuthUI() {
  const authSection   = document.getElementById('nav-auth-section');
  const profileAvatar = document.getElementById('nav-profile-avatar');
  if (state.token && state.user) {
    authSection.style.display   = 'none';
    profileAvatar.style.display = 'flex';
    profileAvatar.textContent   = state.user.name.charAt(0).toUpperCase();
    
    // Update profile modal fields if open
    const initials = document.getElementById('profile-initials');
    if (initials) initials.textContent = state.user.name.charAt(0).toUpperCase();
    const nameLarge = document.getElementById('profile-name-large');
    if (nameLarge) nameLarge.textContent = state.user.name;
    const emailSmall = document.getElementById('profile-email-small');
    if (emailSmall) emailSmall.textContent = state.user.email;
    const phoneVal = document.getElementById('profile-phone-val');
    if (phoneVal) phoneVal.textContent = state.user.phone || 'Not provided';
    const addrVal = document.getElementById('profile-addr-val');
    if (addrVal) addrVal.textContent = state.user.address || 'No address saved';
  } else {
    authSection.style.display   = 'block';
    profileAvatar.style.display = 'none';
  }
}

function showAuthModal() {
  state.isSignUp = false;
  document.getElementById('auth-modal').style.display = 'flex';
  updateAuthModalContent();
}
function hideAuthModal() { document.getElementById('auth-modal').style.display = 'none'; }
function hideProfileModal() { document.getElementById('profile-modal').style.display = 'none'; }
function toggleAuthMode()  { state.isSignUp = !state.isSignUp; updateAuthModalContent(); }

function updateAuthModalContent() {
  const title       = document.getElementById('auth-title');
  const actionBtn   = document.getElementById('auth-action-btn');
  const toggleText  = document.querySelector('#auth-modal .text-sm');
  const signupFields = document.getElementById('auth-signup-fields');
  if (state.isSignUp) {
    title.textContent      = 'Join Cravez';
    actionBtn.textContent  = 'Create Account';
    toggleText.textContent = 'Already have an account? Sign In';
    signupFields.style.display = 'block';
  } else {
    title.textContent      = 'Welcome Back';
    actionBtn.textContent  = 'Sign In';
    toggleText.textContent = "Don't have an account? Sign Up";
    signupFields.style.display = 'none';
  }
}

async function handleAuthAction() {
  const email    = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-password').value;
  const name     = document.getElementById('auth-name').value;
  const errorEl  = document.getElementById('auth-error');
  errorEl.style.display = 'none';

  const url  = state.isSignUp ? '/api/auth/register' : '/api/auth/login';
  const body = state.isSignUp ? { name, email, password } : { email, password };

  try {
    const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Auth failed');

    state.token = data.token;
    state.user  = data.user;
    localStorage.setItem('cravez_token', data.token);
    localStorage.setItem('cravez_user', JSON.stringify(data.user));
    updateAuthUI();
    hideAuthModal();
    notify(`Welcome, ${state.user.name}!`, 'success');
    if (state.locationSet) loadRestaurants();
  } catch (err) {
    errorEl.textContent   = err.message;
    errorEl.style.display = 'block';
  }
}

function handleLogout() {
  state.token = null; state.user = null;
  localStorage.removeItem('cravez_token');
  localStorage.removeItem('cravez_user');
  updateAuthUI();
  hideProfileModal();
  notify('Logged out successfully');
  navigate('home');
}

async function fetchProfile() {
  try {
    const res = await fetch('/api/user/profile', { headers: { Authorization: `Bearer ${state.token}` } });
    if (res.ok) {
      state.user = await res.json();
      localStorage.setItem('cravez_user', JSON.stringify(state.user));
      updateAuthUI();
    }
  } catch (e) {}
}

function showProfileModal() {
  if (!state.user) return;
  document.getElementById('profile-modal').style.display = 'flex';
  updateAuthUI(); // Refreshes modal fields
  document.getElementById('profile-veg-only').checked = !!state.user.veg_only;
}

async function updateProfilePref() {
  const vegOnly = document.getElementById('profile-veg-only').checked;
  try {
    const res = await fetch('/api/user/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ veg_only: vegOnly }),
    });
    if (res.ok) {
      state.user.veg_only = !!vegOnly;
      localStorage.setItem('cravez_user', JSON.stringify(state.user));
      notify('Preferences updated');
      if (state.locationSet) loadRestaurants();
    }
  } catch (e) { notify('Failed to update preferences', 'error'); }
}

async function loadUserOrders() {
  const listEl = document.getElementById('order-history-list');
  if (!listEl) return;

  if (!state.token) {
    listEl.innerHTML = `
      <div class="no-orders-state">
        <svg class="no-orders-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"/></svg>
        <h3>Sign in to view your orders</h3>
        <p>Your order history will appear here after logging in.</p>
        <button class="btn btn-primary mt-6" onclick="showAuthModal()">Sign In</button>
      </div>`;
    return;
  }

  listEl.innerHTML = '<div class="no-orders-state"><h3>Loading your history...</h3></div>';
  try {
    const res = await fetch('/api/user/orders', { headers: { Authorization: `Bearer ${state.token}` } });
    const orders = await res.json();
    
    if (!orders.length) {
      listEl.innerHTML = `
        <div class="no-orders-state">
           <svg class="no-orders-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"/></svg>
           <h3>No orders found</h3>
           <p>Hungry? Explore restaurants near you!</p>
           <button class="btn btn-primary mt-6" onclick="showPage('home')">Browse Food</button>
        </div>`;
      return;
    }

    listEl.innerHTML = orders.map(o => `
      <div class="order-card-pro" data-order-id="${o.id}" style="cursor:pointer;">
        <div class="flex-between mb-4">
          <span class="status-pill-id">${o.status.toUpperCase()}</span>
          <span class="text-xs text-muted">${new Date(o.date).toLocaleDateString()}</span>
        </div>
        <h4 class="mb-1">${o.restaurantName}</h4>
        <p class="text-sm text-muted mb-4">${o.items.map(i => `${i.qty}x ${i.name}`).join(', ')}</p>
        <div class="flex-between pt-4 border-t">
          <span class="font-bold">₹${o.total}</span>
          <span class="btn-text">Track &rarr;</span>
        </div>
      </div>`).join('');

    listEl.querySelectorAll('.order-card-pro[data-order-id]').forEach(card => {
      card.addEventListener('click', () => lookupOrderByParam(card.dataset.orderId));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="no-orders-state"><h3>Failed to load history</h3><p>Please try again later.</p></div>';
  }
}

// ─── Location ──────────────────────────────────────────────────────────────
function requestLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => { state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; proceedWithLocation(); },
      ()  => { notify('Permission denied. Using default location.', 'error'); proceedWithLocation(); }
    );
  } else { proceedWithLocation(); }
}

function proceedWithLocation() {
  state.locationSet = true;
  document.getElementById('location-overlay').style.display = 'none';
  // Force reload — clear lock so real GPS coords trigger a fresh fetch
  state.isLoadingRestaurants = false;
  loadRestaurants();
}

function dismissLocation() {
  state.locationSet = true; // Fix: Allow menu navigation after dismissal
  document.getElementById('location-overlay').style.display = 'none';
  if (!state.restaurants.length) loadRestaurants();
}

// ─── Restaurants ──────────────────────────────────────────────────────────
const CLIENT_FALLBACK_RESTAURANTS = [
  { id:'f1', name:'The Gourmet Hub',  cuisine:'Continental, Italian', eta:'25-30', rating:4.8, isVeg:false, image:'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=600&q=80', location:{lat:28.6139,lng:77.2090}, distance:'1.2', category:'pizza',   featuredItems:['Pasta Carbonara','Neapolitan Pizza','Tiramisu'] },
  { id:'f2', name:'Spicy Garden',     cuisine:'Indian, Mughlai',      eta:'15-20', rating:4.5, isVeg:true,  image:'https://images.unsplash.com/photo-1517244681291-03ef738c8d93?w=600&q=80', location:{lat:28.6239,lng:77.2190}, distance:'2.5', category:'biryani', featuredItems:['Paneer Tikka','Butter Kulcha','Dal Makhani'] },
  { id:'f3', name:'Burger Lab',       cuisine:'Fast Food, American',  eta:'10-15', rating:4.2, isVeg:false, image:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&q=80', location:{lat:28.6039,lng:77.1990}, distance:'0.8', category:'burger',  featuredItems:['Mega Crunch Burger','Cheesy Fries','Vanilla Shake'] },
  { id:'f4', name:'Green Bowl Cafe',  cuisine:'Salads, Healthy',      eta:'20-25', rating:4.7, isVeg:true,  image:'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=80', location:{lat:28.6339,lng:77.2290}, distance:'3.1', category:'healthy',  featuredItems:['Quinoa Salad','Avocado Toast','Green Smoothie'] },
  { id:'f5', name:'Dragon Palace',    cuisine:'Chinese, Asian',       eta:'20-30', rating:4.3, isVeg:false, image:'https://images.unsplash.com/photo-1552566626-52f8b828add9?w=600&q=80', location:{lat:28.6099,lng:77.2150}, distance:'1.8', category:'chinese',  featuredItems:['Kung Pao Chicken','Hakka Noodles','Spring Rolls'] },
  { id:'f6', name:'Choco Heaven',     cuisine:'Desserts, Cafe',       eta:'15-20', rating:4.6, isVeg:true,  image:'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=600&q=80', location:{lat:28.6180,lng:77.2050}, distance:'0.5', category:'dessert',  featuredItems:['Death by Chocolate','Gulab Jamun','NY Cheesecake'] },
];

async function loadRestaurants() {
  if (state.isLoadingRestaurants) return;
  state.isLoadingRestaurants = true;
  renderSkeletons();
  try {
    const res = await fetch(`/api/restaurants?lat=${state.userLocation.lat}&lng=${state.userLocation.lng}`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    state.restaurants = (data && data.length > 0) ? data : CLIENT_FALLBACK_RESTAURANTS;
    
    if (state._pendingRoute) {
      const { page, param } = state._pendingRoute;
      state._pendingRoute = null;
      if (page === 'menu') selectRestaurant(param, true);
    }
  } catch (err) {
    console.warn('Restaurant API unavailable, showing fallback data');
    state.restaurants = CLIENT_FALLBACK_RESTAURANTS;
  } finally {
    const topBrandsGrid = document.getElementById('top-brands-grid');
    if (topBrandsGrid) renderTopBrands(state.restaurants);
    
    renderRestaurants(state.restaurants);
    renderElitePicks();
    if (typeof renderTrendingFood === 'function') renderTrendingFood();
    state.isLoadingRestaurants = false;
  }
}

async function loadAllRestaurants() {
  const grid = document.getElementById('all-restaurants-grid');
  grid.innerHTML = Array(6).fill(0).map(() => `
    <div class="restaurant-card">
      <div class="skeleton skeleton-card"></div>
      <div class="restaurant-body">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text" style="width:40%"></div>
      </div>
    </div>`).join('');
  
  try {
    const res = await fetch('/api/restaurants/brands');
    if (!res.ok) throw new Error('API error');
    const brands = await res.json();
    renderAllRestaurants(brands);
  } catch (err) {
    grid.innerHTML = '<div class="no-results"><p>Failed to load brands. Please try again.</p></div>';
  }
}

function renderAllRestaurants(brands) {
  state.allBrands = brands; // store in state for selection
  const grid = document.getElementById('all-restaurants-grid');
  grid.innerHTML = brands.map(r => {
    const bgUrl = r.image;
    let coverHtml = `<div class="restaurant-cover" style="background-image: url('${bgUrl}')">`;
    if (r.brandLogo) {
      coverHtml += `<div style="position:absolute; top:12px; left:12px; background:white; padding:6px; border-radius:8px; box-shadow:0 4px 10px rgba(0,0,0,0.15);">
        <img src="${r.brandLogo}" style="height:32px; width:auto; object-fit:contain;">
      </div>`;
    }
    coverHtml += `<div class="restaurant-time">${r.eta} MINS</div></div>`;

    return `
      <div class="restaurant-card" onclick="selectRestaurantFromBrand('${r.id}')">
        ${coverHtml}
        <div class="restaurant-body">
          <div class="restaurant-name">
            <span>${r.name}</span>
            <span class="restaurant-rating">★ ${r.rating}</span>
          </div>
          <div class="restaurant-cuisine">${r.cuisine}</div>
          <div class="mt-2 text-sm text-light">Delivery Fee: ₹40 • Top picks: ${r.featuredItems?.slice(0,2).join(', ')}</div>
        </div>
      </div>
    `;
  }).join('');
}

function selectRestaurantFromBrand(id) {
  const r = state.allBrands.find(b => b.id === id);
  if (r) selectRestaurantFromData(r);
}

async function selectRestaurantFromData(r) {
  state.selectedRestaurant = r;
  state.cart = {};
  state.discountStatus = { applied: false, amount: 0, code: '' };

  const category = r.category || '';
  const nameParam = encodeURIComponent(r.name || '');

  try {
    const res = await fetch(`/api/restaurants/${r.id}/menu?category=${category}&name=${nameParam}`);
    if (!res.ok) throw new Error('menu fetch failed');
    state.menu = await res.json();
    renderMenu();
    navigate('menu', r.id);
  } catch {
    notify('Failed to load menu', 'error');
  }
}

function renderSkeletons() {
  const grid = document.getElementById('restaurant-grid');
  grid.innerHTML = Array(6).fill(0).map(() => `
    <div class="restaurant-card">
      <div class="skeleton skeleton-card"></div>
      <div class="restaurant-body">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text" style="width:40%"></div>
      </div>
    </div>`).join('');
}

// ─── Utilities for Dynamic Images & Logos ──────────────────────────────────
const BRAND_LOGOS = {
  'mcdonalds': 'https://upload.wikimedia.org/wikipedia/commons/3/36/McDonald%27s_Golden_Arches.svg',
  'mcdonald': 'https://upload.wikimedia.org/wikipedia/commons/3/36/McDonald%27s_Golden_Arches.svg',
  'subway': 'https://upload.wikimedia.org/wikipedia/commons/5/5c/Subway_2016_logo.svg',
  'domino': 'https://upload.wikimedia.org/wikipedia/commons/7/74/Dominos_pizza_logo.svg',
  'burger king': 'https://upload.wikimedia.org/wikipedia/commons/8/85/Burger_King_logo_%281999%29.svg',
  'kfc': 'https://upload.wikimedia.org/wikipedia/en/b/bf/KFC_logo.svg',
  'pizza hut': 'https://upload.wikimedia.org/wikipedia/sco/d/d2/Pizza_Hut_logo.svg',
  'starbucks': 'https://upload.wikimedia.org/wikipedia/en/d/d3/Starbucks_Corporation_Logo_2011.svg'
};

function getRestaurantImageHelper(r) {
  const nameLabel = r.name.toLowerCase();
  for (const [brand, logo] of Object.entries(BRAND_LOGOS)) {
    if (nameLabel.includes(brand)) return logo;
  }
  // Use a reliable random image from the unsplash source or local food images
  return r.image || getFoodImage(Math.floor(Math.random() * 10));
}

// ─── Elite Picks ───────────────────────────────────────────────────────────
function renderElitePicks() {
  const container = document.getElementById('elite-restaurants-list');
  if (!container) return;

  if (!state.restaurants.length) {
    container.innerHTML = '<div class="text-center w-full" style="padding: 40px; color: var(--color-text-light);">Casting the culinary net...</div>';
    return;
  }
  
  // Highlighting top 4 places
  const elite = [...state.restaurants].sort((a,b) => b.rating - a.rating).slice(0, 4);
  
  container.innerHTML = elite.map(r => {
    const isLogo = Object.keys(BRAND_LOGOS).some(brand => r.name.toLowerCase().includes(brand));
    const bgStyle = isLogo ? 'background-size: contain; background-color: #f8f9fa;' : 'background-size: cover;';
    
    return `
      <div class="elite-card" onclick="selectRestaurant('${r.id}')" style="cursor: pointer;">
        <div style="height: 180px; background-image: url('${getRestaurantImageHelper(r)}'); ${bgStyle} background-position: center; background-repeat: no-repeat;"></div>
        <div style="padding: 20px;">
          <h3 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 6px;">${r.name}</h3>
          <p style="color: var(--color-text-muted); font-size: 0.9rem; margin-bottom: 12px;">${r.cuisine}</p>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="background: var(--color-primary); color: white; padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold;">★ ${r.rating}</span>
            <span style="font-size: 0.85rem; font-weight: 600; color: var(--color-text-light);">${r.eta} mins</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Top Brands Section ────────────────────────────────────────────────────
function renderTopBrands(restaurants) {
  const container = document.getElementById('top-brands-section');
  if (!container) return;

  // Pick top 3 by rating
  const topBrands = [...restaurants]
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 3);

  if (!topBrands.length) { container.style.display = 'none'; return; }
  container.style.display = 'block';

  document.getElementById('top-brands-grid').innerHTML = topBrands.map(r => `
    <div class="top-brand-card" onclick="selectRestaurant('${r.id}')">
      <div class="top-brand-cover" style="background-image: url('${r.image}')">
        <div class="top-brand-overlay">
          <span class="top-brand-badge">⭐ ${r.rating}</span>
        </div>
      </div>
      <div class="top-brand-body">
        <div class="top-brand-name">${r.name}</div>
        <div class="top-brand-meta">${r.cuisine} · ${r.eta} mins · ${r.distance} km away</div>
      </div>
    </div>`).join('');
}

// ─── Restaurant Grid ───────────────────────────────────────────────────────
function renderRestaurants(restaurants) {
  const grid  = document.getElementById('restaurant-grid');
  const noRes = document.getElementById('no-results');
  const searchLabel = document.getElementById('search-results-label');

  const q = (document.getElementById('hero-search').value || '').toLowerCase().trim();
  const vegOnly = !!document.getElementById('veg-only-toggle').checked;

  let filtered = restaurants.filter(r => {
    const matchText = !q || 
      r.name.toLowerCase().includes(q) || 
      r.cuisine.toLowerCase().includes(q) || 
      (r.featuredItems && r.featuredItems.some(item => item.toLowerCase().includes(q)));
    
    const matchVeg  = !vegOnly || r.isVeg;
    return matchText && matchVeg;
  });

  if (searchLabel) {
    searchLabel.innerHTML = q ? `Found <strong>${filtered.length}</strong> results for "${q}"` : '';
    searchLabel.style.display = q ? 'block' : 'none';
  }

  if (!filtered.length) {
    grid.innerHTML = '';
    noRes.style.display = 'block';
    return;
  }
  noRes.style.display = 'none';

  grid.innerHTML = filtered.map(r => {
    const isLogo = Object.keys(BRAND_LOGOS).some(brand => r.name.toLowerCase().includes(brand));
    const bgStyle = isLogo ? 'background-size: contain; background-color: #f8f9fa;' : 'background-size: cover;';

    return `
      <div class="restaurant-card" onclick="selectRestaurant('${r.id}')">
        <div class="restaurant-cover" style="background-image: url('${getRestaurantImageHelper(r)}'); ${bgStyle}">
          <span class="restaurant-time">${r.eta} MIN</span>
          <span class="restaurant-dist">${r.distance} KM</span>
        </div>
        <div class="restaurant-body">
          <div class="restaurant-name">
            <span>${r.name}</span>
            <span class="restaurant-rating">★ ${r.rating}</span>
          </div>
          <div class="restaurant-cuisine">${r.cuisine}</div>
        </div>
      </div>`;
  }).join('');
}

// ─── Search & Filter ───────────────────────────────────────────────────────
function runFilters() {
  if (state.currentPage !== 'browse') return;
  renderRestaurants(state.restaurants);
}

function focusSearch() { 
  navigate('browse');
}

let searchDebounce;
function onHeroSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    const val = (document.getElementById('hero-search').value || '').trim();
    if (val.length > 0) {
      if (state.currentPage !== 'browse') navigate('browse');
      const globalEl = document.getElementById('global-search');
      if (globalEl) globalEl.value = val;
      runFilters();
    }
  }, 300);
}

function syncSearchAndFilter(v) {
  if (state.currentPage !== 'browse') navigate('browse');
  
  setTimeout(() => {
    const heroEl = document.getElementById('hero-search');
    if (heroEl) heroEl.value = v;
    const globalEl = document.getElementById('global-search');
    if (globalEl) globalEl.value = v;
    runFilters();
    document.getElementById('restaurant-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

function handleSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    const val = document.getElementById('global-search').value;
    const heroEl = document.getElementById('hero-search');
    if (heroEl) heroEl.value = val;
    runFilters();
  }, 300);
}

function toggleVegOnly() { runFilters(); }

// ─── Menu & Ordering ───────────────────────────────────────────────────────
async function selectRestaurant(id, fromRouter = false) {
  if (fromRouter && state.selectedRestaurant?.id === id && state.menu.length > 0) {
    _showPageEl('menu');
    return;
  }

  state.selectedRestaurant = state.restaurants.find(r => r.id === id);

  if (!state.selectedRestaurant) {
    notify('Loading restaurant…');
    try {
      const res = await fetch(`/api/restaurants?lat=${state.userLocation.lat}&lng=${state.userLocation.lng}`);
      if (!res.ok) throw new Error('API error');
      state.restaurants = await res.json();
      state.selectedRestaurant = state.restaurants.find(r => r.id === id);
      renderTopBrands(state.restaurants);
      renderRestaurants(state.restaurants);
    } catch {
      if (!state.restaurants.length) state.restaurants = CLIENT_FALLBACK_RESTAURANTS;
      state.selectedRestaurant = state.restaurants.find(r => r.id === id);
    }
    if (!state.selectedRestaurant) { notify('Restaurant not found', 'error'); return; }
  }

  state.cart = {};
  state.discountStatus = { applied: false, amount: 0, code: '' };

  const category = state.selectedRestaurant.category || '';
  const nameParam = encodeURIComponent(state.selectedRestaurant.name || '');

  try {
    const res = await fetch(`/api/restaurants/${id}/menu?category=${category}&name=${nameParam}`);
    if (!res.ok) throw new Error('menu fetch failed');
    state.menu = await res.json();
    renderMenu();
    
    if (!fromRouter) {
      navigate('menu', id);
    } else {
      _showPageEl('menu');
    }
  } catch {
    notify('Failed to load menu', 'error');
  }
}

function renderMenu() {
  const r = state.selectedRestaurant;
  document.getElementById('menu-restaurant-name').textContent = r.name;

  const ratingCount = Math.floor(Math.random() * 3000) + 500; 
  const priceForTwo = Math.floor(r.rating * 100 + 150);
  document.getElementById('menu-restaurant-meta').innerHTML = `
    <span>${r.cuisine}</span>
    <span class="meta-dot">·</span>
    <span>${r.eta} mins</span>
    <span class="meta-dot">·</span>
    <span>★ ${r.rating} <span class="meta-rating-count">(${ratingCount.toLocaleString()} ratings)</span></span>
    <span class="meta-dot">·</span>
    <span>₹${priceForTwo} for two</span>`;

  const addrEl = document.getElementById('menu-restaurant-address');
  if (addrEl && r.location) {
    addrEl.textContent = `📍 ${r.location.lat.toFixed(4)}, ${r.location.lng.toFixed(4)} — ${r.distance} km from you`;
  }

  const vegOnly      = document.getElementById('menu-veg-only').checked;
  let filteredMenu   = vegOnly ? state.menu.filter(i => i.isVeg) : state.menu;

  document.getElementById('menu-items').innerHTML = filteredMenu.map((item, idx) => {
    const qty      = state.cart[item.id] || 0;
    const imgUrl   = getFoodImage(idx);
    return `
    <div class="menu-item-card">
      <div class="menu-item-img-wrap">
        <img class="menu-item-img" src="${imgUrl}" alt="${item.name}" loading="lazy" onerror="this.style.display='none'">
      </div>
      <div class="menu-item-info">
        <div class="item-veg-tag ${item.isVeg ? 'veg' : 'non-veg'}"><span></span></div>
        <div class="menu-item-name">${item.name}</div>
        <div class="menu-item-price">₹${item.price}</div>
        <div class="menu-item-desc">${item.desc}</div>
      </div>
      <div class="menu-item-action">
        ${qty === 0
          ? `<button class="add-btn" onclick="updateCart('${item.id}', 1)">Add</button>`
          : `<div class="qty-control">
               <button class="qty-btn" onclick="updateCart('${item.id}', -1)">−</button>
               <span class="qty-num">${qty}</span>
               <button class="qty-btn" onclick="updateCart('${item.id}', 1)">+</button>
             </div>`
        }
      </div>
    </div>`;
  }).join('');
  renderCart();
}

function filterMenu() { renderMenu(); }

function updateCart(itemId, delta) {
  state.cart[itemId] = Math.max(0, (state.cart[itemId] || 0) + delta);
  if (state.cart[itemId] === 0) delete state.cart[itemId];
  renderMenu();
}

function renderCart() {
  const entries  = Object.entries(state.cart);
  const hasItems = entries.length > 0;
  document.getElementById('cart-empty').style.display   = hasItems ? 'none'  : 'block';
  document.getElementById('cart-content').style.display = hasItems ? 'block' : 'none';
  if (!hasItems) return;

  let subtotal = 0;
  document.getElementById('cart-items').innerHTML = entries.map(([itemId, qty]) => {
    const item      = state.menu.find(i => i.id === itemId);
    const itemTotal = item.price * qty;
    subtotal += itemTotal;
    return `
      <div class="cart-item">
        <div style="flex:1">
          <div class="cart-item-name">${item.isVeg ? '🟢' : '🔴'} ${item.name}</div>
          <div class="text-sm text-muted">Qty: ${qty}</div>
        </div>
        <span class="cart-item-price">₹${itemTotal}</span>
      </div>`;
  }).join('');

  const tax      = Math.round(subtotal * TAX_RATE);
  const discount = state.discountStatus.applied ? state.discountStatus.amount : 0;
  document.getElementById('discount-row').style.display    = discount > 0 ? 'flex' : 'none';
  document.getElementById('bill-discount').textContent     = `-₹${discount}`;
  document.getElementById('bill-subtotal').textContent     = `₹${subtotal}`;
  document.getElementById('bill-tax').textContent          = `₹${tax}`;
  document.getElementById('cart-final-total').textContent  = `₹${Math.max(0, subtotal + DELIVERY_FEE + tax - discount)}`;
  document.getElementById('bill-delivery').textContent     = `₹${DELIVERY_FEE}`;
}

function applyCoupon() {
  const code = document.getElementById('coupon-code').value.trim().toUpperCase();
  if (code === 'WELCOME50' || code === 'DEV50') {
    if (!Object.keys(state.cart).length) return notify('Add items first', 'error');
    state.discountStatus = { applied: true, amount: 50, code };
    notify('Coupon applied! 🎉', 'success');
  } else {
    state.discountStatus = { applied: false, amount: 0, code: '' };
    notify('Invalid coupon code', 'error');
  }
  renderCart();
}

let checkoutMap, checkoutMarker;

async function reverseGeocode(lat, lng) {
  const addrEl = document.getElementById('delivery-address');
  addrEl.placeholder = 'Resolving address...';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
    const data = await res.json();
    const address = data.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    addrEl.value = address;
    state.tempAddress = address;
    state.tempCoords = { lat, lng };
  } catch (e) {
    addrEl.value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

async function locateMe() {
  if (!navigator.geolocation) return notify('Geolocation not supported', 'error');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    if (checkoutMap && checkoutMarker) {
      checkoutMap.setView([lat, lng], 16);
      checkoutMarker.setLatLng([lat, lng]);
    }
    await reverseGeocode(lat, lng);
  }, () => notify('Could not get location — drag the pin to set address', 'error'));
}

function showCheckoutForm() {
  if (!state.user) {
    notify('Please Sign In to order!', 'info');
    showAuthModal();
    return;
  }
  document.getElementById('checkout-form').style.display = 'block';
  document.getElementById('checkout-btn').style.display  = 'none';
  document.getElementById('delivery-phone').value        = state.user.phone || '';

  goToDeliveryStep();

  setTimeout(() => {
    const mapEl = document.getElementById('checkout-location-map');
    if (!mapEl) return;
    if (checkoutMap) { checkoutMap.remove(); checkoutMap = null; checkoutMarker = null; }

    const lat = state.user.lat || state.userLocation.lat;
    const lng = state.user.lng || state.userLocation.lng;
    state.tempCoords = { lat, lng };

    checkoutMap = L.map('checkout-location-map', { zoomControl: false, attributionControl: false })
      .setView([lat, lng], 15);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(checkoutMap);

    checkoutMarker = L.marker([lat, lng], {
      draggable: true,
      icon: L.divIcon({
        html: '<div class="drop-pin">📍</div>',
        className: 'map-drop-pin-icon',
        iconSize: [40, 40], iconAnchor: [20, 40]
      })
    }).addTo(checkoutMap);

    checkoutMarker.on('dragend', async e => {
      const p = e.target.getLatLng();
      state.tempCoords = { lat: p.lat, lng: p.lng };
      await reverseGeocode(p.lat, p.lng);
    });
    reverseGeocode(lat, lng);
  }, 150);
}

function goToPaymentStep() {
  const phone   = document.getElementById('delivery-phone').value.trim();
  const address = document.getElementById('delivery-address').value.trim();
  const normalizedPhone = phone.replace(/\s/g, '').replace(/^\+91/, '');
  if (!phone || normalizedPhone.length < 7) return notify('Enter a valid phone number', 'error');
  if (address === 'Resolving address...') return notify('Please wait — fetching your address', 'error');
  if (!address && state.tempCoords) {
    document.getElementById('delivery-address').value = `${state.tempCoords.lat.toFixed(5)}, ${state.tempCoords.lng.toFixed(5)}`;
  }
  document.getElementById('checkout-step-1').style.display = 'none';
  document.getElementById('checkout-step-2').style.display = 'block';
}

function goToDeliveryStep() {
  document.getElementById('checkout-step-1').style.display = 'block';
  document.getElementById('checkout-step-2').style.display = 'none';
}

function selectPayment(method) {
  state.paymentMethod = method;
  document.querySelectorAll('.payment-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.method === method);
  });
}

async function placeOrder() {
  if (!state.paymentMethod) state.paymentMethod = 'upi';
  const phone   = document.getElementById('delivery-phone').value.trim();
  const address = document.getElementById('delivery-address').value.trim();
  if (!state.tempCoords) { notify('Please confirm delivery location', 'error'); goToDeliveryStep(); return; }

  const items = Object.entries(state.cart).map(([itemId, qty]) => {
    const menuItem = state.menu.find(i => i.id === itemId);
    return menuItem ? { ...menuItem, qty } : null;
  }).filter(Boolean);

  showPaymentSimulation();
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({
        restaurantId: state.selectedRestaurant.id,
        realRestaurantName: state.selectedRestaurant.name,
        restaurantLocation: state.selectedRestaurant.location,
        items, address, phone,
        lat: state.tempCoords.lat, lng: state.tempCoords.lng,
        paymentMethod: state.paymentMethod
      }),
    });
    await new Promise(r => setTimeout(r, 2000));
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    hidePaymentSimulation();
    notify('Order placed!', 'success');
    state.cart = {}; renderCart();
    startTracking(data.orderId, data.order);
  } catch (err) { hidePaymentSimulation(); notify('Transaction failed', 'error'); }
}

function showPaymentSimulation() {
  const overlay = document.createElement('div');
  overlay.id = 'payment-sim-overlay';
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="payment-sim-card"><div class="spinner"></div><h3>Securing Transaction...</h3></div>`;
  document.body.appendChild(overlay);
}
function hidePaymentSimulation() { document.getElementById('payment-sim-overlay')?.remove(); }

// ─── Tracking ──────────────────────────────────────────────────────────────
async function fetchOSRMRoute(rLoc, uLoc) {
  try {
    const res  = await fetch(`https://router.project-osrm.org/route/v1/driving/${rLoc.lng},${rLoc.lat};${uLoc.lng},${uLoc.lat}?overview=full&geometries=geojson`);
    const data = await res.json();
    return data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
  } catch { return [[rLoc.lat, rLoc.lng], [uLoc.lat, uLoc.lng]]; }
}

async function startTracking(orderId, order) {
  state.currentOrderId = orderId;
  navigate('tracking', orderId);
  document.getElementById('tracking-order-items').innerHTML = order.items.map(i =>
    `<div class="flex justify-between mb-2"><span>${i.qty}x ${i.name}</span><strong>₹${i.price * i.qty}</strong></div>`
  ).join('');
  document.getElementById('tracking-total').textContent = `₹${order.total}`;
  document.getElementById('tracking-restaurant-name').textContent = order.restaurant.name;

  state.routeCoords = await fetchOSRMRoute(order.restaurant.location, state.userLocation);
  initLeafletMap(order.restaurant.location, state.userLocation, state.routeCoords);
  renderTrackingUI(order);
  connectSSE(orderId);
}

function initLeafletMap(restLoc, userLoc, routeCoords) {
  if (state.leafletMap) state.leafletMap.remove();
  state.leafletMap = L.map('real-map-container', { zoomControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(state.leafletMap);
  L.marker([restLoc.lat, restLoc.lng], { icon: L.divIcon({ html: '🍴', className: 'map-emoji-icon' }) }).addTo(state.leafletMap);
  state.destMarker = L.marker([userLoc.lat, userLoc.lng], { icon: L.divIcon({ html: '📍', className: 'map-emoji-icon' }) }).addTo(state.leafletMap);
  state.routeLine  = L.polyline(routeCoords, { color: 'var(--color-primary)', weight: 5 }).addTo(state.leafletMap);
  state.riderMarker = L.marker(routeCoords[0], { icon: L.divIcon({ html: '🛵', className: 'map-rider-icon' }) }).addTo(state.leafletMap);
  state.leafletMap.fitBounds(state.routeLine.getBounds());
}

function startRiderLoop() {
  if (state.riderAnimId) return;
  const loop = () => {
    state.renderPct += (state.targetPct - state.renderPct) * 0.03;
    animateRiderAlongRoute(state.renderPct);
    state.riderAnimId = requestAnimationFrame(loop);
  };
  loop();
}

function animateRiderAlongRoute(pct) {
  if (!state.riderMarker || !state.routeCoords.length) return;
  const idx = Math.floor((pct/100) * (state.routeCoords.length-1));
  state.riderMarker.setLatLng(state.routeCoords[idx]);
}

function renderTrackingUI(order) {
  const s = ORDER_STATUSES.find(x => x.key === order.status) || ORDER_STATUSES[0];
  document.getElementById('current-status-label').textContent = s.label;
  document.getElementById('progress-bar-fill').style.width = `${s.progress}%`;

  if (order.status === 'on_the_way') {
    state.targetPct = 50; startRiderLoop();
  }
  document.getElementById('order-timeline').innerHTML = [...order.history].reverse().map(h => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div>
        <div class="timeline-label">${h.label}</div>
        <div class="timeline-time">${new Date(h.time).toLocaleTimeString()}</div>
      </div>
    </div>`).join('');
}

async function lookupOrderByParam(id) {
  try {
    const res = await fetch(`/api/orders/${id}`);
    if (!res.ok) throw new Error('Not found');
    const order = await res.json();
    startTracking(id, order);
  } catch { notify('Order not found', 'error'); }
}

function connectSSE(orderId) {
  // Close any existing SSE connection
  if (state.ws) { state.ws.close(); state.ws = null; }

  const es = new EventSource(`/api/orders/${orderId}/stream`);
  state.ws = es; // reuse state.ws slot for cleanup

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'STATUS_UPDATE') renderTrackingUI(data.order);
      if (data.type === 'ERROR') console.warn('SSE error:', data.message);
    } catch {}
  };

  es.onerror = () => {
    es.close();
    state.ws = null;
    // Reconnect after 4 s if still on tracking page
    if (state.currentPage === 'tracking') setTimeout(() => connectSSE(orderId), 4000);
  };
}

function renderTrendingFood() {
  const grid = document.getElementById('trending-food-list');
  if (!grid) return;
  const trendingItems = [
    { name: 'Spicy Paneer Burger', price: 189, image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400' },
    { name: 'Classic Margherita', price: 299, image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400' }
  ];
  grid.innerHTML = trendingItems.map(item => `
    <div class="trending-item" onclick="navigate('browse')">
      <img src="${item.image}" class="trending-img" alt="${item.name}">
      <div class="trending-name">${item.name}</div>
      <div class="trending-price">₹${item.price}</div>
    </div>`).join('');
}
